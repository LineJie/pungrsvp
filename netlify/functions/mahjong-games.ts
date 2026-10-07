import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings, communitySessions, members, mahjongGames, mahjongPlayers, mahjongEvents } from "../../db/schema.js";
import { eq, and, inArray, ne } from "drizzle-orm";
import { ensureMahjongTables, ensureMembersTable, ensureSessionIdColumn, ensureScoringSystemColumn, ensureCommunityGameColumns } from "../../db/mahjongUtils.js";
import { ensureCommunityTables } from "../../db/authUtils.js";

// Game lifecycle for Pung Pung Mahjong Score.
// A game is always anchored to an existing booking (the checked-in table
// session) OR to an open Acara Main Bareng session (community_sessions) —
// we never invent a separate "table" or "customer" concept here.
//
// Statuses: waiting_for_players -> ready -> active -> finished_win | draw
//           (or -> cancelled at any point before finished)

const OPEN_STATUSES = ["waiting_for_players", "ready", "active"];
const MAX_PLAYERS = 4;

async function upsertMemberByWa(name: string, waNumber?: string): Promise<number | null> {
  const wa = (waNumber || "").trim();
  if (!wa) return null;
  const existing = await db.select({ id: members.id }).from(members).where(eq(members.waNumber, wa));
      if (existing.length) return existing[0].id;
      const [row] = await db.insert(members).values({ waNumber: wa, name: name || "" }).returning({ id: members.id });
  return row.id;
}

async function getGameWithPlayers(gameId: number) {
  const [game] = await db.select().from(mahjongGames).where(eq(mahjongGames.id, gameId));
  if (!game) return null;
  const players = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.gameId, gameId));
  players.sort((a, b) => a.seatNumber - b.seatNumber);
  return { game, players };
}

// Dipakai kalau row game-nya sudah di-load di request yang sama, supaya tidak
// select game yang sama dua kali (endpoint ini di-poll lobi tiap beberapa detik).
async function withPlayers(game: typeof mahjongGames.$inferSelect) {
  const players = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.gameId, game.id));
  players.sort((a, b) => a.seatNumber - b.seatNumber);
  return { game, players };
}

export default async (req: Request) => {
  await ensureMahjongTables(db);
  await ensureMembersTable(db);
    await ensureSessionIdColumn(db);
    await ensureScoringSystemColumn(db);
    await ensureCommunityGameColumns(db);
  const url = new URL(req.url);

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    const bookingId = url.searchParams.get("bookingId");
    const communitySessionId = url.searchParams.get("communitySessionId");
    const tableId = url.searchParams.get("tableId");
    const location = url.searchParams.get("location");
    const status = url.searchParams.get("status"); // e.g. "active" for admin monitoring

    if (id) {
      const data = await getGameWithPlayers(parseInt(id));
      if (!data) return Response.json({ error: "Game not found" }, { status: 404 });
      return Response.json(data);
    }

    if (bookingId || communitySessionId) {
            const anchorCond = communitySessionId
              ? eq(mahjongGames.communitySessionId, parseInt(communitySessionId))
              : eq(mahjongGames.bookingId, parseInt(bookingId as string));
            const rows = await db.select().from(mahjongGames)
              .where(and(anchorCond, inArray(mahjongGames.status, OPEN_STATUSES)));
            if (!rows.length) return Response.json({ error: "No active game for this booking" }, { status: 404 });
            const data = await withPlayers(rows[0]);
            // Defensive cleanup: a "ghost" game (host row insert failed after the
            // game row was created) should never block a fresh Create Game attempt.
            if (data && data.players.length === 0 && data.game.status === "waiting_for_players") {
                      await db.update(mahjongGames).set({ status: "cancelled", endedAt: new Date() }).where(eq(mahjongGames.id, data.game.id));
                      return Response.json({ error: "No active game for this booking" }, { status: 404 });
            }
            return Response.json(data);
    }

    if (tableId) {
      // Used when a customer scans/opens the table's Mahjong link and wants
      // to join whatever game is currently open at that table.
      const conditions = [eq(mahjongGames.tableId, tableId), inArray(mahjongGames.status, OPEN_STATUSES)];
      if (location) conditions.push(eq(mahjongGames.location, location));
      const rows = await db.select().from(mahjongGames).where(and(...conditions));
      if (!rows.length) return Response.json({ error: "No open game at this table" }, { status: 404 });
      const data = await withPlayers(rows[0]);
      return Response.json(data);
    }

    // Admin monitoring list
    const conditions = [];
    if (status === "active") conditions.push(inArray(mahjongGames.status, OPEN_STATUSES));
    else if (status) conditions.push(eq(mahjongGames.status, status));
    if (location) conditions.push(eq(mahjongGames.location, location));
    const games = conditions.length
      ? await db.select().from(mahjongGames).where(and(...conditions))
      : await db.select().from(mahjongGames);
    // Hanya ambil pemain dari game yang memang ditampilkan (bukan seluruh tabel).
    const listedGameIds = games.map((g) => g.id);
    const allPlayers = listedGameIds.length
      ? await db.select().from(mahjongPlayers).where(inArray(mahjongPlayers.gameId, listedGameIds))
      : [];
    const result = games.map((g) => ({
      ...g,
      players: allPlayers.filter((p) => p.gameId === g.id).sort((a, b) => a.seatNumber - b.seatNumber),
    }));
    return Response.json(result);
  }

  // ── POST: create a new game ─────────────────────────────────────────
  if (req.method === "POST") {
    const body = await req.json();
    const { bookingId, communitySessionId, hostName, hostWaNumber, sessionId, scoringSystem } = body;
    if ((!bookingId && !communitySessionId) || !hostName) {
      return Response.json({ error: "bookingId (atau communitySessionId) and hostName are required" }, { status: 400 });
    }
    const resolvedScoringSystem = scoringSystem === "china" ? "china" : "taiwan";

    // Anchor game: booking biasa yang sudah check-in, ATAU sesi Acara Main
    // Bareng yang masih "open". Keduanya menghasilkan meja + cabang yang sama
    // untuk game, jadi leaderboard (yang hanya membaca mahjong_games/players/
    // events) otomatis ikut menghitung game acara bareng.
    let anchor: { bookingId: number | null; communitySessionId: number | null; tableId: string; tableName: string; location: string };
    if (communitySessionId) {
      await ensureCommunityTables(db);
      const [cs] = await db.select().from(communitySessions).where(eq(communitySessions.id, parseInt(communitySessionId)));
      if (!cs) return Response.json({ error: "Acara tidak ditemukan" }, { status: 404 });
      if (cs.status !== "open") {
        return Response.json({ error: "Acara ini sudah ditutup/dibatalkan, tidak bisa mulai permainan baru" }, { status: 409 });
      }
      anchor = { bookingId: null, communitySessionId: cs.id, tableId: cs.tableId, tableName: cs.tableName, location: cs.location || "surabaya" };
    } else {
      const [booking] = await db.select().from(bookings).where(eq(bookings.id, parseInt(bookingId)));
      if (!booking) return Response.json({ error: "Booking not found" }, { status: 404 });
      if (booking.status !== "checked_in") {
        return Response.json({ error: "Table must be checked in before starting a Mahjong game" }, { status: 409 });
      }
      anchor = { bookingId: booking.id, communitySessionId: null, tableId: booking.tableId, tableName: booking.tableName, location: booking.location || "surabaya" };
    }

    const existingOpen = await db.select().from(mahjongGames)
      .where(and(
        anchor.communitySessionId !== null
          ? eq(mahjongGames.communitySessionId, anchor.communitySessionId)
          : eq(mahjongGames.bookingId, anchor.bookingId as number),
        inArray(mahjongGames.status, OPEN_STATUSES)));
    if (existingOpen.length) {
      const data = await getGameWithPlayers(existingOpen[0].id);
      return Response.json({ error: "A game already exists for this table", game: data }, { status: 409 });
    }

    const [game] = await db.insert(mahjongGames).values({
      bookingId: anchor.bookingId,
      communitySessionId: anchor.communitySessionId,
      tableId: anchor.tableId,
      tableName: anchor.tableName,
      location: anchor.location,
      scoringSystem: resolvedScoringSystem,
      status: "waiting_for_players",
        sessionId: sessionId || null,
    }).returning();
    if (!game.sessionId) {
        await db.update(mahjongGames).set({ sessionId: game.id }).where(eq(mahjongGames.id, game.id));
        game.sessionId = game.id;
    }

    // The host's player row is created in a second statement after the
        // game row above — if it fails partway (e.g. a transient DB hiccup),
        // roll back the just-created game row so we never leave an orphaned
        // "ghost" game with 0 players stuck in waiting_for_players.
        try {
                const memberId = await upsertMemberByWa(hostName, hostWaNumber);
                const [player] = await db.insert(mahjongPlayers).values({
                          gameId: game.id,
                          seatNumber: 1,
                          name: hostName,
                          waNumber: hostWaNumber || "",
                          memberId,
                }).returning();

                return Response.json({ game, players: [player] }, { status: 201 });
        } catch (e: any) {
                await db.delete(mahjongGames).where(eq(mahjongGames.id, game.id));
return Response.json({ error: "Could not create game, please try again" }, { status: 500 });
        }
  }

  // ── PATCH: join / start / finish / cancel ───────────────────────────
  if (req.method === "PATCH") {
    const id = parseInt(url.searchParams.get("id") || "");
    const action = url.searchParams.get("action");
    if (!id || !action) return Response.json({ error: "id and action are required" }, { status: 400 });

    const data = await getGameWithPlayers(id);
    if (!data) return Response.json({ error: "Game not found" }, { status: 404 });
    const { game, players } = data;

    if (action === "join") {
      if (!OPEN_STATUSES.includes(game.status) || game.status === "active") {
        return Response.json({ error: "This game can no longer accept new players" }, { status: 409 });
      }
      if (players.length >= MAX_PLAYERS) {
        return Response.json({ error: "This game already has 4 players" }, { status: 409 });
      }
      const body = await req.json();
      const { name, waNumber } = body;
      if (!name) return Response.json({ error: "name is required" }, { status: 400 });

      const memberId = await upsertMemberByWa(name, waNumber);
      const seatNumber = players.length + 1;
      const [player] = await db.insert(mahjongPlayers).values({
        gameId: game.id, seatNumber, name, waNumber: waNumber || "", memberId,
      }).returning();

      const newCount = players.length + 1;
      if (newCount >= MAX_PLAYERS) {
        await db.update(mahjongGames).set({ status: "ready" }).where(eq(mahjongGames.id, game.id));
      }
      const refreshed = await getGameWithPlayers(game.id);
      return Response.json({ ...refreshed, joined: player }, { status: 201 });
    }

    if (action === "start") {
      if (game.status !== "ready" || players.length !== MAX_PLAYERS) {
        return Response.json({ error: "Need exactly 4 players before starting" }, { status: 409 });
      }
      await db.update(mahjongGames).set({ status: "active", startedAt: new Date() }).where(eq(mahjongGames.id, game.id));
      return Response.json(await getGameWithPlayers(game.id));
    }

    if (action === "finish") {
      if (game.status !== "active") {
        return Response.json({ error: "Only an active game can be finished" }, { status: 409 });
      }
      const body = await req.json().catch(() => ({}));
      const { winnerPlayerId } = body;
      if (!winnerPlayerId || !players.some((p) => p.id === winnerPlayerId)) {
        return Response.json({ error: "winnerPlayerId must be one of the seated players" }, { status: 400 });
      }
      await db.update(mahjongGames)
        .set({ status: "finished_win", winnerPlayerId, endedAt: new Date() })
        .where(eq(mahjongGames.id, game.id));
      return Response.json(await getGameWithPlayers(game.id));
    }

    if (action === "draw") {
      if (game.status !== "active") {
        return Response.json({ error: "Only an active game can be marked as a draw" }, { status: 409 });
      }
      await db.update(mahjongGames).set({ status: "draw", endedAt: new Date() }).where(eq(mahjongGames.id, game.id));
      // Record a zero-point DRAW_GAME event per player for a clean audit trail.
      // Existing Kong points already recorded during the game remain valid and untouched.
      for (const p of players) {
        await db.insert(mahjongEvents).values({
          gameId: game.id, playerId: p.id, eventType: "DRAW_GAME", points: 0,
          metadata: JSON.stringify({ reason: "wall_exhausted" }),
        });
      }
      return Response.json(await getGameWithPlayers(game.id));
    }

    if (action === "cancel") {
      if (game.status === "finished_win" || game.status === "draw" || game.status === "cancelled") {
        return Response.json({ error: "Game already finished" }, { status: 409 });
      }
      await db.update(mahjongGames).set({ status: "cancelled", endedAt: new Date() }).where(eq(mahjongGames.id, game.id));
      return Response.json(await getGameWithPlayers(game.id));
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/mahjong/games" };
