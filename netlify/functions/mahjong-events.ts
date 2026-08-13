import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { mahjongGames, mahjongPlayers, mahjongEvents } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { ensureMahjongTables, ensureSessionIdColumn } from "../../db/mahjongUtils.js";
import {
  calculateWinScore,
  calculateKongScore,
    calculateAllLoserPayments,
    type LoserDefenseInput,
  type LastCardDraw,
  type KongType,
} from "../../db/mahjongScoring.js";

// Leaderboard display code: derived from the last 4 digits of the player's
// WhatsApp number (kept partially masked for privacy on a public leaderboard).
// Falls back to a deterministic code generated from the player's name when
// no WhatsApp number is on file, so two players who share the same display
// name can still be told apart.
function leaderboardCode(name: string, waNumber: string): string {
const digits = (waNumber || "").replace(/\D/g, "");
if (digits.length >= 4) return digits.slice(-4);
const s = (name || "").trim().toLowerCase();
let hash = 0;
for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
return String(hash % 10000).padStart(4, "0");
}

// All scoring math lives in db/mahjongScoring.ts (the single authoritative
// engine). This function only: validates the request against the current
// game/player state, calls the engine, and persists the resulting events.
// The client NEVER sends point values — only the raw facts of what happened.

async function loadGame(gameId: number) {
  const [game] = await db.select().from(mahjongGames).where(eq(mahjongGames.id, gameId));
  if (!game) return null;
  const players = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.gameId, gameId));
  players.sort((a, b) => a.seatNumber - b.seatNumber);
  return { game, players };
}

async function insertEvent(gameId: number, playerId: number, eventType: string, points: number, relatedPlayerId?: number | null, metadata?: unknown) {
  const [row] = await db.insert(mahjongEvents).values({
    gameId, playerId, eventType, points,
    relatedPlayerId: relatedPlayerId ?? null,
    metadata: metadata !== undefined ? JSON.stringify(metadata) : null,
  }).returning();
  return row;
}

function identityKey(p: any) {
    return p.waNumber ? `wa:${p.waNumber}` : `name:${(p.name || "").trim().toLowerCase()}`;
}

// Live "still playing at this table" totals accumulate across every game
// that shares the same session_id (every consecutive game started via the
// "same 4 players?" continuation flow in mahjong.html), matched per-player
// by WhatsApp number (or name when no phone was given). This is purely a
// display-layer aggregation -- individual mahjong_events rows are never
// rewritten, so per-game history/stats/leaderboard queries below are
// completely unaffected by this.
async function loadSessionAccumulated(game: any, currentPlayers: any[]) {
    const sessionId = game.sessionId || game.id;
    const sessionGames = await db.select().from(mahjongGames).where(eq(mahjongGames.sessionId, sessionId));
    const gameIds = sessionGames.length ? sessionGames.map((g: any) => g.id) : [game.id];
    const sessionPlayers = await db.select().from(mahjongPlayers).where(inArray(mahjongPlayers.gameId, gameIds));
    const sessionEvents = await db.select().from(mahjongEvents).where(inArray(mahjongEvents.gameId, gameIds));
    sessionEvents.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const scoreboard = currentPlayers.map((p: any) => {
          const myKey = identityKey(p);
          const matchIds = sessionPlayers.filter((sp: any) => identityKey(sp) === myKey).map((sp: any) => sp.id);
          const total = sessionEvents.filter((e: any) => matchIds.includes(e.playerId)).reduce((s: number, e: any) => s + e.points, 0);
          return { ...p, total };
    });

    return { scoreboard, sessionEvents, sessionGamesCount: gameIds.length };
}

function scoreboardFromEvents(players: any[], events: any[]) {
  return players.map((p) => ({
    ...p,
    total: events.filter((e) => e.playerId === p.id).reduce((sum, e) => sum + e.points, 0),
  }));
}

export default async (req: Request) => {
  await ensureMahjongTables(db);
    await ensureSessionIdColumn(db);
  const url = new URL(req.url);

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const gameId = url.searchParams.get("gameId");
    const historyWa = url.searchParams.get("historyWa");
    const statsWa = url.searchParams.get("statsWa");
    const leaderboard = url.searchParams.get("leaderboard");

    if (gameId) {
      const data = await loadGame(parseInt(gameId));
      if (!data) return Response.json({ error: "Game not found" }, { status: 404 });
          const { scoreboard, sessionEvents, sessionGamesCount } = await loadSessionAccumulated(data.game, data.players);
          return Response.json({ game: data.game, players: scoreboard, events: sessionEvents, sessionGamesCount });
    }

    if (historyWa) {
      const myPlayers = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.waNumber, historyWa));
      const gameIds = [...new Set(myPlayers.map((p) => p.gameId))];
      if (!gameIds.length) return Response.json([]);
      const games = await db.select().from(mahjongGames).where(inArray(mahjongGames.id, gameIds));
      const finished = games.filter((g) => g.status === "finished_win" || g.status === "draw");
      const events = await db.select().from(mahjongEvents).where(inArray(mahjongEvents.gameId, finished.map((g) => g.id)));
      const history = finished.map((g) => {
        const myPlayer = myPlayers.find((p) => p.gameId === g.id)!;
        const myTotal = events.filter((e) => e.playerId === myPlayer.id).reduce((s, e) => s + e.points, 0);
        return {
          gameId: g.id,
          tableName: g.tableName,
          location: g.location,
          date: g.endedAt || g.createdAt,
          score: myTotal,
          result: g.status === "draw" ? "DRAW" : g.winnerPlayerId === myPlayer.id ? "WIN" : "LOSE",
        };
      }).sort((a, b) => new Date(b.date as any).getTime() - new Date(a.date as any).getTime());
      return Response.json(history);
    }

    if (statsWa) {
      const myPlayers = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.waNumber, statsWa));
      const gameIds = [...new Set(myPlayers.map((p) => p.gameId))];
      if (!gameIds.length) {
        return Response.json({ gamesPlayed: 0, zimoCount: 0, kongCount: 0, wins: 0, draws: 0, highestScore: 0, totalScore: 0 });
      }
      const games = await db.select().from(mahjongGames).where(inArray(mahjongGames.id, gameIds));
      const finished = games.filter((g) => g.status === "finished_win" || g.status === "draw");
      const myPlayerIds = myPlayers.map((p) => p.id);
      const events = await db.select().from(mahjongEvents).where(inArray(mahjongEvents.playerId, myPlayerIds));

      const wins = finished.filter((g) => g.status === "finished_win" && myPlayers.some((p) => p.gameId === g.id && p.id === g.winnerPlayerId)).length;
      const draws = finished.filter((g) => g.status === "draw").length;
      const zimoCount = events.filter((e) => e.eventType === "ZIMO").length;
      const kongCount = events.filter((e) => e.eventType === "KONG_FROM_DISCARD" || e.eventType === "KONG_FROM_WALL").length;

      const perGameScore: Record<number, number> = {};
      events.forEach((e) => { perGameScore[e.gameId] = (perGameScore[e.gameId] || 0) + e.points; });
      const scores = finished.map((g) => perGameScore[g.id] || 0);
      const highestScore = scores.length ? Math.max(...scores) : 0;
      const totalScore = scores.reduce((a, b) => a + b, 0);

      return Response.json({
        gamesPlayed: finished.length, zimoCount, kongCount, wins, draws, highestScore, totalScore,
      });
    }

    if (leaderboard) {
      const period = url.searchParams.get("period") || "all"; // week | month | all
      const location = url.searchParams.get("location");
      let games = await db.select().from(mahjongGames).where(inArray(mahjongGames.status, ["finished_win", "draw"]));
      if (location) games = games.filter((g) => g.location === location);

      const now = Date.now();
      const cutoff = period === "week" ? now - 7 * 24 * 60 * 60 * 1000
        : period === "month" ? now - 30 * 24 * 60 * 60 * 1000
        : 0;
      if (cutoff) games = games.filter((g) => new Date((g.endedAt || g.createdAt) as any).getTime() >= cutoff);

      const gameIds = games.map((g) => g.id);
      if (!gameIds.length) return Response.json([]);
      const players = await db.select().from(mahjongPlayers).where(inArray(mahjongPlayers.gameId, gameIds));
      const events = await db.select().from(mahjongEvents).where(inArray(mahjongEvents.gameId, gameIds));

      const totalsByKey: Record<string, { name: string; waNumber: string; score: number }> = {};
      players.forEach((p) => {
        const key = p.waNumber ? `wa:${p.waNumber}` : `name:${p.name.toLowerCase()}`;
        const playerTotal = events.filter((e) => e.playerId === p.id).reduce((s, e) => s + e.points, 0);
        if (!totalsByKey[key]) totalsByKey[key] = { name: p.name, waNumber: p.waNumber || "", score: 0 };
        totalsByKey[key].score += playerTotal;
      });
      const ranked = Object.values(totalsByKey)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((r) => ({ ...r, code: leaderboardCode(r.name, r.waNumber) }));
      return Response.json(ranked);
    }

    return Response.json({ error: "Missing query parameter" }, { status: 400 });
  }

  // ── POST: record a scoring event ────────────────────────────────────
  if (req.method === "POST") {
    const body = await req.json();
    const { gameId, action } = body;
    if (!gameId || !action) return Response.json({ error: "gameId and action are required" }, { status: 400 });

    const data = await loadGame(parseInt(gameId));
    if (!data) return Response.json({ error: "Game not found" }, { status: 404 });
    const { game, players } = data;

    if (game.status !== "active") {
      return Response.json({ error: "This game is not active — scoring is not allowed" }, { status: 409 });
    }
    const allPlayerIds = players.map((p) => p.id);

    // Record a Zimo win: base Zimo + existing Flower/Season + Last Card Bonus.
    // Only self-draw wins are supported — there is intentionally no
    // "Hu from discard" action anywhere in this API.
    if (action === "recordWin") {
            const { winnerPlayerId, handContainsJoker, existingFlowers = [], existingSeasons = [], lastCardDraws = [], loserDefenses = [] } = body;
      if (!allPlayerIds.includes(winnerPlayerId)) {
        return Response.json({ error: "winnerPlayerId must be a seated player" }, { status: 400 });
      }
      let result;
      try {
        result = calculateWinScore({
          handContainsJoker: !!handContainsJoker,
          existingFlowers,
          existingSeasons,
          lastCardDraws: lastCardDraws as LastCardDraw[],
        });
      } catch (e: any) {
        return Response.json({ error: e.message || "Invalid win data" }, { status: 400 });
      }

      const inserted = [];
      for (const ev of result.events) {
        inserted.push(await insertEvent(game.id, winnerPlayerId, ev.eventType, ev.points, null, { label: ev.label, ...ev.metadata }));
      }

            const losers = players.filter((p) => p.id !== winnerPlayerId);
            const defenseByPlayer = new Map(loserDefenses.map((d) => [d.playerId, d]));
            const { results: loserResults, winnerGain } = calculateAllLoserPayments(
                      losers.map((l) => ({
                                  playerId: l.id,
                                  existingFlowers: defenseByPlayer.get(l.id)?.existingFlowers || [],
                                  existingSeasons: defenseByPlayer.get(l.id)?.existingSeasons || [],
                      }))
                    );
            for (const r of loserResults) {
                      if (r.payment > 0 || r.defenseValue > 0) {
                                  inserted.push(await insertEvent(game.id, r.playerId, "LOSER_PAYMENT", -r.payment, winnerPlayerId, { label: r.label }));
                      }
            }
            if (winnerGain > 0) {
                      inserted.push(await insertEvent(game.id, winnerPlayerId, "LOSER_PAYMENT", winnerGain, null, { label: `Collected ${winnerGain} from losers` }));
            }
      await db.update(mahjongGames)
        .set({ status: "finished_win", winnerPlayerId, endedAt: new Date() })
        .where(eq(mahjongGames.id, game.id));

          const { scoreboard } = await loadSessionAccumulated(game, players);
              return Response.json({ events: inserted, total: result.total + winnerGain, scoreboard }, { status: 201 });
    }

    // Record a Kong (from discard or from wall) during active play.
    if (action === "recordKong") {
      const { type, kongerId, discardedByPlayerId } = body as { type: KongType; kongerId: number; discardedByPlayerId?: number };
      if (!allPlayerIds.includes(kongerId)) {
        return Response.json({ error: "kongerId must be a seated player" }, { status: 400 });
      }
      let deltas;
      try {
        deltas = calculateKongScore(type, kongerId, allPlayerIds, discardedByPlayerId);
      } catch (e: any) {
        return Response.json({ error: e.message || "Invalid Kong data" }, { status: 400 });
      }
      const inserted = [];
      for (const d of deltas) {
        inserted.push(await insertEvent(game.id, d.playerId, d.eventType, d.points, d.relatedPlayerId, { label: d.label }));
      }
  const { scoreboard } = await loadSessionAccumulated(game, players);
        return Response.json({ events: inserted, scoreboard }, { status: 201 });
    }

    // Admin-only correction — always additive, never edits/deletes history.
    if (action === "correction") {
      const { playerId, points, note } = body;
      if (!allPlayerIds.includes(playerId) || typeof points !== "number") {
        return Response.json({ error: "playerId and numeric points are required" }, { status: 400 });
      }
      const row = await insertEvent(game.id, playerId, "CORRECTION", points, null, { note: note || "" });
    const { scoreboard } = await loadSessionAccumulated(game, players);
          return Response.json({ event: row, scoreboard }, { status: 201 });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/mahjong/events" };
