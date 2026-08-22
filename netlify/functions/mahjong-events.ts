import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { mahjongGames, mahjongPlayers, mahjongEvents, staff } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { verifyPassword } from "../../db/authUtils.js";
import { ensureMahjongTables, ensureSessionIdColumn, ensureScoringSystemColumn, ensureActionGroupColumn } from "../../db/mahjongUtils.js";
import { randomUUID } from "node:crypto";
import {
  calculateWinScore,
  calculateAllLoserPayments,
  calculateHandFan,
  calculateFanWinPayments,
  calculateKongScore,
  type LastCardDraw,
  type LoserDefenseInput,
  type FanComboKey,
  type SeatWind,
  type WinMode,
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

function parseMeta(e: any): any {
  try { return e.metadata ? JSON.parse(e.metadata) : {}; } catch { return {}; }
}

// Staff auth check -- ANY logged-in staff (admin or kasir), not just Super
// Admin. Same header pattern as the isSuperAdminReq() checks in
// bookings.ts/promos.ts/staff.ts (client sends the credentials it collected
// at login on every request), but this one also accepts regular `staff`
// table rows, not only the superadmin env-var login. Used to gate score
// corrections, undo, and player-name fixes below -- mahjong.html itself has
// no login of its own, so these actions require the staff panel login
// (added in this same change) to have succeeded first.
const SUPERADMIN_USERNAME = "tere";
async function checkStaffReq(req: Request): Promise<{ ok: boolean; name: string }> {
  const u = req.headers.get("x-auth-username") || "";
  const p = req.headers.get("x-auth-password") || "";
  if (!u || !p) return { ok: false, name: "" };
  const superadminPw = process.env.SUPERADMIN_PASSWORD;
  if (superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw) {
    return { ok: true, name: "Super Admin" };
  }
  const rows = await db.select().from(staff).where(eq(staff.username, u));
  if (rows.length && verifyPassword(p, rows[0].passwordHash)) {
    return { ok: true, name: rows[0].name || u };
  }
  return { ok: false, name: "" };
}

// All scoring math lives in db/mahjongScoring.ts (the single authoritative
// engine). This function only: validates the request against the current
// game/player state, calls the engine for whichever scoring_system this
// game was created with, and persists the resulting events. The client
// NEVER sends point values — only the raw facts of what happened.

async function loadGame(gameId: number) {
  const [game] = await db.select().from(mahjongGames).where(eq(mahjongGames.id, gameId));
  if (!game) return null;
  const players = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.gameId, gameId));
  players.sort((a, b) => a.seatNumber - b.seatNumber);
  return { game, players };
}

async function insertEvent(gameId: number, playerId: number, eventType: string, points: number, relatedPlayerId?: number | null, metadata?: unknown, actionGroup?: string | null) {
  const [row] = await db.insert(mahjongEvents).values({
    gameId, playerId, eventType, points,
    relatedPlayerId: relatedPlayerId ?? null,
    metadata: metadata !== undefined ? JSON.stringify(metadata) : null,
    actionGroup: actionGroup ?? null,
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

export default async (req: Request) => {
  await ensureMahjongTables(db);
    await ensureSessionIdColumn(db);
    await ensureScoringSystemColumn(db);
    await ensureActionGroupColumn(db);
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
          scoringSystem: g.scoringSystem,
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
      // Zimo count spans both scoring systems: China style records a plain
      // "ZIMO" event; Hong Kong style records "WIN_MODE" with mode=ZIMO.
      const zimoCount = events.filter((e) => e.eventType === "ZIMO").length
        + events.filter((e) => e.eventType === "WIN_MODE" && parseMeta(e).mode === "ZIMO").length;
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
      const location = url.searchParams.get("location"); // surabaya | denpasar | absent/all = every branch
      const includeStats = url.searchParams.get("includeStats");

      let games = await db.select().from(mahjongGames).where(inArray(mahjongGames.status, ["finished_win", "draw"]));
      if (location && location !== "all") games = games.filter((g) => g.location === location);

      const now = Date.now();
      const cutoff = period === "week" ? now - 7 * 24 * 60 * 60 * 1000
        : period === "month" ? now - 30 * 24 * 60 * 60 * 1000
        : 0;
      if (cutoff) games = games.filter((g) => new Date((g.endedAt || g.createdAt) as any).getTime() >= cutoff);

      const gameIds = games.map((g) => g.id);
      if (!gameIds.length) return Response.json(includeStats ? { players: [], stats: null } : []);

      const gameById = new Map<number, (typeof games)[number]>(games.map((g) => [g.id, g]));
      const players = await db.select().from(mahjongPlayers).where(inArray(mahjongPlayers.gameId, gameIds));
      const events = await db.select().from(mahjongEvents).where(inArray(mahjongEvents.gameId, gameIds));

      // One aggregate row per player identity (matched by WA number, or by
      // name when no phone was given -- same matching rule used elsewhere).
      type PlayerAgg = {
        name: string;
        waNumber: string;
        score: number;
        gameIdsPlayed: Set<number>;
        sessionIds: Set<number>;
        wins: number;
        results: { endedAt: number; won: boolean }[];
      };
      const totalsByKey: Record<string, PlayerAgg> = {};

      players.forEach((p) => {
        const g = gameById.get(p.gameId);
        if (!g) return;
        const key = p.waNumber ? `wa:${p.waNumber}` : `name:${p.name.toLowerCase()}`;
        if (!totalsByKey[key]) {
          totalsByKey[key] = { name: p.name, waNumber: p.waNumber || "", score: 0, gameIdsPlayed: new Set(), sessionIds: new Set(), wins: 0, results: [] };
        }
        const agg = totalsByKey[key];
        const playerTotal = events.filter((e) => e.playerId === p.id).reduce((s, e) => s + e.points, 0);
        const won = g.status === "finished_win" && g.winnerPlayerId === p.id;
        agg.score += playerTotal;
        agg.gameIdsPlayed.add(g.id);
        agg.sessionIds.add(g.sessionId || g.id);
        if (won) agg.wins += 1;
        agg.results.push({ endedAt: new Date((g.endedAt || g.createdAt) as any).getTime(), won });
      });

      const ranked = Object.values(totalsByKey)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map((r) => {
          const gamesCount = r.gameIdsPlayed.size;
          const chronological = r.results.slice().sort((a, b) => a.endedAt - b.endedAt);
          const form = chronological.slice(-5).map((res) => (res.won ? "W" : "L"));
          return {
            name: r.name,
            waNumber: r.waNumber,
            code: leaderboardCode(r.name, r.waNumber),
            score: r.score,
            wins: r.wins,
            games: gamesCount,
            winPct: gamesCount ? Math.round((r.wins / gamesCount) * 100) : 0,
            sessions: r.sessionIds.size,
            avgPerGame: gamesCount ? Math.round((r.score / gamesCount) * 10) / 10 : 0,
            form,
          };
        });

      if (!includeStats) return Response.json(ranked);

      // "Hero" stats aggregated across the whole filtered period + branch --
      // total sessions/games/hours, who's on the hottest current win streak,
      // and the single biggest win (largest LOSER_PAYMENT collected in one game).
      const allSessionIds = new Set(games.map((g) => g.sessionId || g.id));
      let hoursMs = 0;
      games.forEach((g) => {
        if (g.startedAt && g.endedAt) hoursMs += new Date(g.endedAt as any).getTime() - new Date(g.startedAt as any).getTime();
      });

      let hotStreak: { name: string; count: number } | null = null;
      Object.values(totalsByKey).forEach((r) => {
        const newestFirst = r.results.slice().sort((a, b) => b.endedAt - a.endedAt);
        let streak = 0;
        for (const res of newestFirst) {
          if (!res.won) break;
          streak++;
        }
        if (streak > 0 && (!hotStreak || streak > hotStreak.count)) hotStreak = { name: r.name, count: streak };
      });

      let biggestWin: { name: string; amount: number } | null = null;
      events
        .filter((e) => e.eventType === "LOSER_PAYMENT" && e.points > 0)
        .forEach((e) => {
          if (biggestWin && e.points <= biggestWin.amount) return;
          const p = players.find((pl) => pl.id === e.playerId);
          if (p) biggestWin = { name: p.name, amount: e.points };
        });

      return Response.json({
        players: ranked,
        stats: {
          sessions: allSessionIds.size,
          games: gameIds.length,
          hours: Math.round((hoursMs / 3600000) * 10) / 10,
          hotStreak,
          biggestWin,
        },
      });
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

    // recordWin/recordKong only make sense while a game is actively being
    // played. correction/undo/renamePlayer are staff-only fixes that must
    // stay available AFTER a game finishes too -- that's usually exactly
    // when a mistake gets noticed (checking the leaderboard, a customer
    // pointing out their name is wrong, etc).
    if ((action === "recordWin" || action === "recordKong") && game.status !== "active") {
      return Response.json({ error: "This game is not active — scoring is not allowed" }, { status: 409 });
    }
    const allPlayerIds = players.map((p) => p.id);
    const scoringSystem = game.scoringSystem === "china" ? "china" : "hongkong";

    // Record a win. Branches on this game's scoring_system:
    // - "china": legacy flat house rules -- Zimo (self-draw) only, plus
    //   Joker/Flower/Season/Last-Card bonuses and per-loser defense tiles.
    // - "hongkong" (default): Hong Kong Old Style fan table -- host picks
    //   the winner, ZIMO or HU (+ discarder if HU), and every fan pattern
    //   that applies (including which wind for the two wind patterns).
    if (action === "recordWin") {
      const actionGroup = randomUUID();
      if (scoringSystem === "china") {
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

        // These individual events are recorded at 0 points -- they exist so the
        // winner's tile breakdown (Zimo/Flower/Season/Last Card) stays visible
        // in history, but result.total is NOT credited directly to the winner.
        // result.total is only the PAYMENT BENCHMARK each loser owes; the
        // winner's actual score comes from the LOSER_PAYMENT event below.
        const inserted = [];
        for (const ev of result.events) {
          inserted.push(await insertEvent(game.id, winnerPlayerId, ev.eventType, 0, null, { label: ev.label, handValue: ev.points, ...ev.metadata }, actionGroup));
        }

        const losers = players.filter((p) => p.id !== winnerPlayerId);
        const defenseByPlayer = new Map((loserDefenses as any[]).map((d) => [d.playerId, d]));
        const { results: loserResults, winnerGain } = calculateAllLoserPayments(
          result.total,
          losers.map((l) => ({
            playerId: l.id,
            existingFlowers: defenseByPlayer.get(l.id)?.existingFlowers || [],
            existingSeasons: defenseByPlayer.get(l.id)?.existingSeasons || [],
          })) as LoserDefenseInput[]
        );
        for (const r of loserResults) {
          if (r.payment > 0 || r.defenseValue > 0) {
            inserted.push(await insertEvent(game.id, r.playerId, "LOSER_PAYMENT", -r.payment, winnerPlayerId, { label: r.label }, actionGroup));
          }
        }
        if (winnerGain > 0) {
          inserted.push(await insertEvent(game.id, winnerPlayerId, "LOSER_PAYMENT", winnerGain, null, { label: `Collected ${winnerGain} from losers (hand value ${result.total})` }, actionGroup));
        }
        await db.update(mahjongGames)
          .set({ status: "finished_win", winnerPlayerId, endedAt: new Date() })
          .where(eq(mahjongGames.id, game.id));

        const { scoreboard } = await loadSessionAccumulated(game, players);
        return Response.json({ events: inserted, total: winnerGain, scoreboard }, { status: 201 });
      }

      // Hong Kong Old Style
      const { winnerPlayerId, mode, comboKeys = [], discarderId, windSelections = {} } = body as {
        winnerPlayerId: number;
        mode: WinMode;
        comboKeys: FanComboKey[];
        discarderId?: number;
        windSelections?: Partial<Record<FanComboKey, SeatWind>>;
      };
      if (!allPlayerIds.includes(winnerPlayerId)) {
        return Response.json({ error: "winnerPlayerId must be a seated player" }, { status: 400 });
      }

      let hand;
      try {
        hand = calculateHandFan(comboKeys, windSelections);
      } catch (e: any) {
        return Response.json({ error: e.message || "Invalid combo selection" }, { status: 400 });
      }

      const opponents = players.filter((p) => p.id !== winnerPlayerId);
      let payment;
      try {
        payment = calculateFanWinPayments(mode, hand.totalPoints, opponents.map((o) => o.id), discarderId);
      } catch (e: any) {
        return Response.json({ error: e.message || "Invalid win data" }, { status: 400 });
      }

      // Each selected pattern (and the win mode itself) is recorded at 0
      // points -- purely informational, so the winning hand's fan breakdown
      // and Zimo/Hu mode stay visible in history/stats. The actual score
      // movement comes from the LOSER_PAYMENT events below.
      const inserted = [];
      inserted.push(await insertEvent(game.id, winnerPlayerId, "WIN_MODE", 0, mode === "HU" ? discarderId ?? null : null, {
        mode,
        label: mode === "ZIMO" ? "Menang Zimo (tarik sendiri)" : "Menang Hu (dari buangan)",
      }, actionGroup));
      for (const ev of hand.events) {
        inserted.push(await insertEvent(game.id, winnerPlayerId, ev.eventType, 0, null, { label: ev.label, ...ev.metadata }, actionGroup));
      }

      for (const r of payment.results) {
        if (r.payment > 0) {
          inserted.push(await insertEvent(game.id, r.playerId, "LOSER_PAYMENT", -r.payment, winnerPlayerId, { label: r.label }, actionGroup));
        }
      }
      inserted.push(await insertEvent(game.id, winnerPlayerId, "LOSER_PAYMENT", payment.winnerGain, null, {
        label: `Menang ${hand.totalFan} fan (${hand.totalPoints} poin) via ${mode === "ZIMO" ? "Zimo" : "Hu"}`,
      }, actionGroup));

      await db.update(mahjongGames)
        .set({ status: "finished_win", winnerPlayerId, endedAt: new Date() })
        .where(eq(mahjongGames.id, game.id));

      const { scoreboard } = await loadSessionAccumulated(game, players);
      return Response.json({ events: inserted, totalFan: hand.totalFan, total: payment.winnerGain, scoreboard }, { status: 201 });
    }

    // Record a Kong (from discard or from wall) during active play. Shared
    // by both scoring systems -- Kong is an in-play bonus independent of
    // which win-scoring style the game uses.
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
      const actionGroup = randomUUID();
      const inserted = [];
      for (const d of deltas) {
        inserted.push(await insertEvent(game.id, d.playerId, d.eventType, d.points, d.relatedPlayerId, { label: d.label }, actionGroup));
      }
  const { scoreboard } = await loadSessionAccumulated(game, players);
        return Response.json({ events: inserted, scoreboard }, { status: 201 });
    }

    // Staff-only correction (admin or kasir) — always additive, never edits
    // or deletes history. Requires x-auth-username/x-auth-password headers
    // from a successful staff login (mahjong.html's staff panel).
    if (action === "correction") {
      const staffCheck = await checkStaffReq(req);
      if (!staffCheck.ok) {
        return Response.json({ error: "Login staff diperlukan untuk koreksi skor" }, { status: 403 });
      }
      const { playerId, points, note } = body;
      if (!allPlayerIds.includes(playerId) || typeof points !== "number") {
        return Response.json({ error: "playerId and numeric points are required" }, { status: 400 });
      }
      if (!note || !String(note).trim()) {
        return Response.json({ error: "Alasan koreksi wajib diisi" }, { status: 400 });
      }
      const actionGroup = randomUUID();
      const row = await insertEvent(game.id, playerId, "CORRECTION", points, null, { note: note.trim(), performedBy: staffCheck.name }, actionGroup);
    const { scoreboard } = await loadSessionAccumulated(game, players);
          return Response.json({ event: row, scoreboard }, { status: 201 });
    }

    // Staff-only undo — reverses the most recent scoring ACTION (every row
    // inserted together by one recordWin/recordKong/correction call, grouped
    // by action_group), not just the last single event row. Implemented as a
    // mirrored insert with negated points (eventType "UNDO"), never a delete
    // -- so the original mistake AND the fact it was undone both stay
    // visible in the audit trail. If the undone action was the one that
    // finished the game (a win), the game is reopened back to "active".
    if (action === "undo") {
      const staffCheck = await checkStaffReq(req);
      if (!staffCheck.ok) {
        return Response.json({ error: "Login staff diperlukan untuk undo" }, { status: 403 });
      }
      const allEvents = await db.select().from(mahjongEvents).where(eq(mahjongEvents.gameId, game.id));
      const alreadyUndone = new Set(
        allEvents.filter((e: any) => e.eventType === "UNDO").map((e: any) => parseMeta(e).undoneGroup).filter(Boolean)
      );
      const candidates = allEvents.filter((e: any) => e.eventType !== "UNDO" && e.actionGroup && !alreadyUndone.has(e.actionGroup));
      if (!candidates.length) {
        return Response.json({ error: "Tidak ada aksi yang bisa di-undo" }, { status: 409 });
      }
      let targetGroup = "";
      let targetTime = -Infinity;
      for (const e of candidates) {
        const t = new Date(e.createdAt as any).getTime();
        if (t > targetTime) { targetTime = t; targetGroup = e.actionGroup as string; }
      }
      const groupEvents = candidates.filter((e: any) => e.actionGroup === targetGroup);
      const newActionGroup = randomUUID();
      const inserted = [];
      for (const e of groupEvents) {
        inserted.push(await insertEvent(
          game.id, e.playerId, "UNDO", -e.points, e.relatedPlayerId,
          { undoneGroup: targetGroup, undoneEventId: e.id, undoneLabel: parseMeta(e).label || parseMeta(e).note || e.eventType, performedBy: staffCheck.name },
          newActionGroup
        ));
      }
      // Reopen the game if the undone action was the one that finished it.
      const finishedTypes = new Set(["LOSER_PAYMENT", "WIN_MODE"]);
      const wasWinAction = groupEvents.some((e: any) => finishedTypes.has(e.eventType));
      let reopened = false;
      if (wasWinAction && game.status !== "active") {
        await db.update(mahjongGames)
          .set({ status: "active", winnerPlayerId: null, endedAt: null })
          .where(eq(mahjongGames.id, game.id));
        reopened = true;
      }
      const { scoreboard } = await loadSessionAccumulated({ ...game, ...(reopened ? { status: "active" } : {}) }, players);
      return Response.json({
        events: inserted,
        scoreboard,
        undone: { label: parseMeta(groupEvents[0]).label || parseMeta(groupEvents[0]).note || groupEvents[0].eventType, reopened },
      }, { status: 201 });
    }

    // Staff-only player-name/WA fix — for typos made when a host or player
    // typed their own name/number in at join time. Only touches the
    // mahjong_players row (display identity), never rewrites any
    // mahjong_events row. Note for whoever reads history later: if this
    // player continues into further games in the same "same 4 players?"
    // session AFTER the rename, their score keeps accumulating correctly
    // (matched going forward on the corrected name/WA); games already
    // played earlier in the session under the OLD name still show that old
    // name in that game's own history, which is expected/harmless.
    if (action === "renamePlayer") {
      const staffCheck = await checkStaffReq(req);
      if (!staffCheck.ok) {
        return Response.json({ error: "Login staff diperlukan untuk edit nama" }, { status: 403 });
      }
      const { playerId, name, waNumber } = body;
      if (!allPlayerIds.includes(playerId) || !name || !String(name).trim()) {
        return Response.json({ error: "playerId and non-empty name are required" }, { status: 400 });
      }
      const updateData: any = { name: String(name).trim() };
      if (typeof waNumber === "string") updateData.waNumber = waNumber.trim();
      await db.update(mahjongPlayers).set(updateData).where(eq(mahjongPlayers.id, playerId));
      const refreshed = await db.select().from(mahjongPlayers).where(eq(mahjongPlayers.gameId, game.id));
      refreshed.sort((a: any, b: any) => a.seatNumber - b.seatNumber);
      const { scoreboard } = await loadSessionAccumulated(game, refreshed);
      return Response.json({ players: refreshed, scoreboard }, { status: 201 });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/mahjong/events" };
