// Pung Pung Mahjong Score — centralized scoring engine.
//
// This is the ONE authoritative place where Mahjong Score points are
// calculated. Netlify Functions call these pure functions to compute
// points server-side before writing game_events rows. Do NOT duplicate
// this math in the frontend or in any other backend file — the frontend
// should only render numbers that the server already computed.
//
// Pung Pung now supports TWO scoring systems, chosen by the host when a
// game is created (mahjong_games.scoring_system):
//
// - "china": the original flat house-rules system. Only Zimo (self-draw)
//   wins are valid. See the CHINA STYLE section below.
// - "taiwan" (default): a simplified Taiwanese-style point table. Both Zimo
//   (self-draw) and Hu (win off a discard) are valid. See the TAIWAN STYLE
//   section below.
//
// Kong scoring (calculateKongScore) is shared by both systems — Kong is an
// immediate in-play bonus independent of which win-scoring style is used.

export type ScoringSystem = "china" | "taiwan";

export type EventType =
    | "ZIMO"
  | "FLOWER"
  | "SEASON"
  | "LAST_CARD"
  | "WIN_MODE"
  | "FAN_COMBO"
  | "KONG_FROM_DISCARD"
  | "KONG_FROM_WALL"
  | "DRAW_GAME"
  | "CORRECTION"
  | "LOSER_PAYMENT";

export interface ScoredEvent {
    eventType: EventType;
    points: number;
    label: string;
    metadata?: Record<string, unknown>;
}

export function sumPoints(points: number[]): number {
    return points.reduce((a, b) => a + b, 0);
}

// ─── Shared: Kong (both systems) ───────────────────────────────────────

export type KongType = "KONG_FROM_DISCARD" | "KONG_FROM_WALL";

export interface KongScoreDelta {
    playerId: number;
    points: number;
    eventType: EventType;
    relatedPlayerId?: number;
    label: string;
}

/**
 * Kong from discard: konger +5, the player whose discard was taken -5.
 * Kong from wall: konger +6, the other three seated players -2 each
 * (nets to 0 across the table).
 */
export function calculateKongScore(
    type: KongType,
    kongerId: number,
    allPlayerIds: number[],
    discardedByPlayerId?: number
  ): KongScoreDelta[] {
    if (!allPlayerIds.includes(kongerId)) {
          throw new Error("Konger must be a seated player in this game");
    }

  if (type === "KONG_FROM_DISCARD") {
        if (discardedByPlayerId === undefined || discardedByPlayerId === null) {
                throw new Error("Kong from discard requires the discarding player");
        }
        if (discardedByPlayerId === kongerId) {
                throw new Error("A player cannot Kong their own discard");
        }
        if (!allPlayerIds.includes(discardedByPlayerId)) {
                throw new Error("Discarding player must be seated in this game");
        }
        return [
          { playerId: kongerId, points: 5, eventType: "KONG_FROM_DISCARD", relatedPlayerId: discardedByPlayerId, label: "Kong from Discard" },
          { playerId: discardedByPlayerId, points: -5, eventType: "KONG_FROM_DISCARD", relatedPlayerId: kongerId, label: "Discard Taken for Kong" },
              ];
  }

  if (type === "KONG_FROM_WALL") {
        const others = allPlayerIds.filter((id) => id !== kongerId);
        if (others.length !== 3) {
                throw new Error("Kong from wall requires exactly 4 seated players");
        }
        return [
          { playerId: kongerId, points: 6, eventType: "KONG_FROM_WALL", label: "Kong from Wall" },
                ...others.map((id) => ({ playerId: id, points: -2, eventType: "KONG_FROM_WALL" as EventType, relatedPlayerId: kongerId, label: "Kong from Wall (Other Player)" })),
              ];
  }

  throw new Error("Invalid Kong type");
}

// ─── CHINA STYLE (original flat house rules) ───────────────────────────
// - Only Zimo (self-draw) is a valid win. HU from discard is not allowed.
// - Zhong / Red Dragon is a Joker substitute inside a hand (no automatic
//   +5). Zhong drawn as a LAST CARD bonus is a different event and is
//   worth +5, same as any other Honour tile.
// - Zimo win payment: the winner's hand value (Zimo +1, Flower/Season
//   tiles, Last Card Bonus draws — see calculateWinScore) is what EACH of
//   the 3 losing players owes the winner, individually reduced by that
//   loser's own Flower/Season defense tiles (floored at 0). The winner's
//   actual point gain is the SUM of what all 3 losers actually pay — this
//   REPLACES the raw hand value as the winner's score for the win.

export type BonusTileNumber = 1 | 2 | 3 | 4;
export type NumberTileValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type HonourTile =
    | "east"
  | "south"
  | "west"
  | "north"
  | "green_dragon"
  | "white_dragon"
  | "zhong";

export const HONOUR_LABELS: Record<HonourTile, string> = {
    east: "East",
    south: "South",
    west: "West",
    north: "North",
    green_dragon: "Green Dragon",
    white_dragon: "White Dragon",
    zhong: "Zhong / Red Dragon",
};

/** Zimo (self-draw win) is always worth exactly +1 (China style). */
export function calculateZimoScore(): ScoredEvent {
    return { eventType: "ZIMO", points: 1, label: "Zimo (Self-Draw)" };
}

function assertBonusTileNumber(n: unknown): asserts n is BonusTileNumber {
  if (n !== 1 && n !== 2 && n !== 3 && n !== 4) {
        throw new Error("Tile number must be 1, 2, 3, or 4");
  }
}

function assertNumberTileValue(n: unknown): asserts n is NumberTileValue {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 9) {
        throw new Error("Number tile value must be an integer from 1 to 9");
  }
}

/** An existing Flower tile already owned at the moment of winning. */
export function calculateFlowerScore(tileNumber: BonusTileNumber): ScoredEvent {
    assertBonusTileNumber(tileNumber);
    return { eventType: "FLOWER", points: tileNumber, label: `Flower ${tileNumber}`, metadata: { tileNumber } };
}

/** An existing Season tile already owned at the moment of winning. */
export function calculateSeasonScore(tileNumber: BonusTileNumber): ScoredEvent {
    assertBonusTileNumber(tileNumber);
    return { eventType: "SEASON", points: tileNumber, label: `Season ${tileNumber}`, metadata: { tileNumber } };
}

/**
 * Number of Last Card bonus draws a Zimo winner receives (China style).
 * Hand WITH Joker (Zhong used as substitute) -> 1 draw.
 * Hand WITHOUT Joker -> 2 draws.
 */
export function getLastCardDrawCount(handContainsJoker: boolean): 1 | 2 {
    return handContainsJoker ? 1 : 2;
}

export type BonusTileKind = "number" | "flower" | "season" | "honour";

export interface LastCardDraw {
    kind: BonusTileKind;
    tileNumber?: BonusTileNumber | NumberTileValue; // required for number / flower / season
  honourTile?: HonourTile; // required for honour (includes zhong)
}

/**
 * Score one Last Card Bonus draw (China style).
 * - Number tile N: +N points (N = the tile's printed number, 1-9).
 * - Flower N / Season N: +N points.
 * - Any Honour tile (East/South/West/North/Green/White) or Zhong drawn AS A
 *   LAST CARD: +5 points. This is distinct from Zhong used as a Joker
 *   inside the winning hand, which never scores +5 by itself.
 */
export function calculateLastCardScore(draw: LastCardDraw): ScoredEvent {
    if (draw.kind === "number") {
          assertNumberTileValue(draw.tileNumber);
          return { eventType: "LAST_CARD", points: draw.tileNumber, label: `Last Card — Number Tile ${draw.tileNumber}`, metadata: { kind: "number", tileNumber: draw.tileNumber } };
    }
    if (draw.kind === "flower") {
          assertBonusTileNumber(draw.tileNumber);
          return { eventType: "LAST_CARD", points: draw.tileNumber, label: `Last Card — Flower ${draw.tileNumber}`, metadata: { kind: "flower", tileNumber: draw.tileNumber } };
    }
    if (draw.kind === "season") {
          assertBonusTileNumber(draw.tileNumber);
          return { eventType: "LAST_CARD", points: draw.tileNumber, label: `Last Card — Season ${draw.tileNumber}`, metadata: { kind: "season", tileNumber: draw.tileNumber } };
    }
    if (draw.kind === "honour") {
          if (!draw.honourTile || !(draw.honourTile in HONOUR_LABELS)) {
                  throw new Error("Invalid honour tile");
          }
          return { eventType: "LAST_CARD", points: 5, label: `Last Card — ${HONOUR_LABELS[draw.honourTile]}`, metadata: { kind: "honour", honourTile: draw.honourTile } };
    }
    throw new Error("Invalid Last Card draw kind");
}

export interface WinScoreInput {
    handContainsJoker: boolean;
    existingFlowers: BonusTileNumber[];
    existingSeasons: BonusTileNumber[];
    lastCardDraws: LastCardDraw[];
}

/**
 * Full Zimo win calculation (China style): base Zimo (+1) + all Flower/
 * Season tiles already owned + Last Card Bonus draw(s). Validates that the
 * number of Last Card draws matches the Joker rule before scoring anything.
 *
 * NOTE: total here is used purely as the PAYMENT BENCHMARK for
 * calculateAllLoserPayments() below — it is not credited to the winner
 * directly.
 */
export function calculateWinScore(input: WinScoreInput): { events: ScoredEvent[]; total: number } {
    const expected = getLastCardDrawCount(input.handContainsJoker);
    if (input.lastCardDraws.length !== expected) {
          throw new Error(
                  `Expected exactly ${expected} Last Card draw(s) for a ${input.handContainsJoker ? "Joker" : "non-Joker"} hand, got ${input.lastCardDraws.length}`
                );
    }

  const events: ScoredEvent[] = [calculateZimoScore()];
    input.existingFlowers.forEach((n) => events.push(calculateFlowerScore(n)));
    input.existingSeasons.forEach((n) => events.push(calculateSeasonScore(n)));
    input.lastCardDraws.forEach((d) => events.push(calculateLastCardScore(d)));

  return { events, total: sumPoints(events.map((e) => e.points)) };
}

export interface LoserDefenseInput {
    playerId: number;
    existingFlowers: BonusTileNumber[];
    existingSeasons: BonusTileNumber[];
}

export interface LoserPaymentResult {
    playerId: number;
    payment: number; // what this loser actually pays the winner (>= 0)
  defenseValue: number; // sum of their own Flower/Season points
  label: string;
}

// One losing player's payment after their own Flower/Season defense is
// applied. baseAmount is the Zimo winner's hand value from
// calculateWinScore().total. The defense reduces that base payment but
// never reverses it into a gain -- it floors at zero.
export function calculateLoserPayment(baseAmount: number, defense: LoserDefenseInput): LoserPaymentResult {
    const defenseValue = sumPoints([...defense.existingFlowers, ...defense.existingSeasons]);
    const payment = Math.max(0, baseAmount - defenseValue);
    const label = defenseValue > 0
      ? `Owed ${baseAmount} (winner's hand value), defended with tiles worth ${defenseValue} (paid ${payment})`
          : `Owed ${baseAmount} to the winner (winner's hand value)`;
    return { playerId: defense.playerId, payment, defenseValue, label };
}

// All 3 losing players' payments for one Zimo win (China style). The
// winner's actual point gain is winnerGain — the sum of what all 3 losers
// actually pay. This REPLACES the raw hand value as the winner's score.
export function calculateAllLoserPayments(baseAmount: number, defenses: LoserDefenseInput[]): { results: LoserPaymentResult[]; winnerGain: number } {
    const results = defenses.map((d) => calculateLoserPayment(baseAmount, d));
    const winnerGain = sumPoints(results.map((r) => r.payment));
    return { results, winnerGain };
}

// ─── TAIWAN STYLE (simplified point table) ──────────────────────────────
// - Every win is worth a base Wu (1 point), plus whichever of these apply:
//     Zimo (self-draw)         +2
//     Pong of Naga (Dragon)    +2 each  (up to 3 — Red/Green/White)
//     Kong of Naga (Dragon)    +4 each
//     Pong of Angin (Wind)     +2 each  (up to 4 — E/S/W/N)
//     Kong of Angin (Wind)     +4 each
//   No other patterns are scored in this house system (deliberately much
//   simpler than the old Hong Kong fan table it replaced).
// - Payment mechanic is the same as before: Zimo (self-draw) — all 3
//   opponents each pay the full point total; Hu (win off a discard) — only
//   the discarder pays the full point total. See calculateFanWinPayments
//   below, unchanged.

export const TAIWAN_WU_POINTS = 1;
export const TAIWAN_ZIMO_BONUS = 2;
export const TAIWAN_NAGA_PONG_POINTS = 2;
export const TAIWAN_NAGA_KONG_POINTS = 4;
export const TAIWAN_ANGIN_PONG_POINTS = 2;
export const TAIWAN_ANGIN_KONG_POINTS = 4;

export interface TaiwanHandInput {
    mode: WinMode;
    pongNaga: number;  // count of Dragon triplets in the hand, 0-3 (Red/Green/White)
    kongNaga: number;  // count of Dragon quads in the hand, 0-3
    pongAngin: number; // count of Wind triplets in the hand, 0-4 (E/S/W/N)
    kongAngin: number; // count of Wind quads in the hand, 0-4
}

function assertCount(n: unknown, max: number, label: string): number {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) {
          throw new Error(`${label} harus angka bulat 0-${max}`);
    }
    return n;
}

/**
 * Full win calculation (Taiwan style): base Wu (+1), Zimo bonus (+2, only
 * if self-draw), plus every Naga/Angin Pong/Kong the host counted in the
 * winning hand. Each component is recorded as its own 0-point FAN_COMBO
 * event (so the breakdown stays visible in history) — the real point
 * movement happens via calculateFanWinPayments() downstream, same as
 * before.
 */
export function calculateTaiwanHandScore(input: TaiwanHandInput): { events: FanComboEvent[]; totalPoints: number } {
    const pongNaga = assertCount(input.pongNaga, 3, "Pong Naga");
    const kongNaga = assertCount(input.kongNaga, 3, "Kong Naga");
    const pongAngin = assertCount(input.pongAngin, 4, "Pong Mata Angin");
    const kongAngin = assertCount(input.kongAngin, 4, "Kong Mata Angin");
    if (pongNaga + kongNaga > 3) throw new Error("Total Pong + Kong Naga maksimal 3 (cuma ada 3 jenis Naga)");
    if (pongAngin + kongAngin > 4) throw new Error("Total Pong + Kong Mata Angin maksimal 4 (cuma ada 4 arah mata angin)");

  const events: FanComboEvent[] = [
        { eventType: "FAN_COMBO", points: 0, label: "Wu (Menang)", metadata: { comboKey: "WU" as FanComboKey, fan: TAIWAN_WU_POINTS } },
  ];
    if (input.mode === "ZIMO") {
          events.push({ eventType: "FAN_COMBO", points: 0, label: "Zimo (Tarik Sendiri)", metadata: { comboKey: "ZIMO" as FanComboKey, fan: TAIWAN_ZIMO_BONUS } });
    }
    for (let i = 0; i < pongNaga; i++) events.push({ eventType: "FAN_COMBO", points: 0, label: "Pong Naga", metadata: { comboKey: "PONG_NAGA" as FanComboKey, fan: TAIWAN_NAGA_PONG_POINTS } });
    for (let i = 0; i < kongNaga; i++) events.push({ eventType: "FAN_COMBO", points: 0, label: "Kong Naga", metadata: { comboKey: "KONG_NAGA" as FanComboKey, fan: TAIWAN_NAGA_KONG_POINTS } });
    for (let i = 0; i < pongAngin; i++) events.push({ eventType: "FAN_COMBO", points: 0, label: "Pong Mata Angin", metadata: { comboKey: "PONG_ANGIN" as FanComboKey, fan: TAIWAN_ANGIN_PONG_POINTS } });
    for (let i = 0; i < kongAngin; i++) events.push({ eventType: "FAN_COMBO", points: 0, label: "Kong Mata Angin", metadata: { comboKey: "KONG_ANGIN" as FanComboKey, fan: TAIWAN_ANGIN_KONG_POINTS } });

  const totalPoints = TAIWAN_WU_POINTS
        + (input.mode === "ZIMO" ? TAIWAN_ZIMO_BONUS : 0)
        + pongNaga * TAIWAN_NAGA_PONG_POINTS
        + kongNaga * TAIWAN_NAGA_KONG_POINTS
        + pongAngin * TAIWAN_ANGIN_PONG_POINTS
        + kongAngin * TAIWAN_ANGIN_KONG_POINTS;

  return { events, totalPoints };
}

export type WinMode = "ZIMO" | "HU";

export interface FanComboEvent {
    eventType: "FAN_COMBO";
    points: 0;
    label: string;
    metadata: { comboKey: FanComboKey; fan: number };
}

export type FanComboKey = "WU" | "ZIMO" | "PONG_NAGA" | "KONG_NAGA" | "PONG_ANGIN" | "KONG_ANGIN";

export interface FanWinPaymentResult {
    playerId: number;
    payment: number;
    label: string;
}

/**
 * Who pays what once the winning hand's point total is known. Zimo
 * (self-draw): all 3 opponents each pay the full amount. Hu (win off a
 * discard): only the discarder pays the full amount. This mechanic is
 * shared by every scoring system that produces a single totalPoints number
 * (unchanged from before the Taiwan-style switch).
 */
export function calculateFanWinPayments(
    mode: WinMode,
    totalPoints: number,
    opponentIds: number[],
    discarderId?: number | null
  ): { results: FanWinPaymentResult[]; winnerGain: number } {
    if (opponentIds.length !== 3) {
          throw new Error("A win requires exactly 3 opponents");
    }
    if (mode === "ZIMO") {
          const results = opponentIds.map((id) => ({
                  playerId: id,
                  payment: totalPoints,
                  label: `Zimo — bayar ${totalPoints} poin`,
          }));      
          return { results, winnerGain: totalPoints * opponentIds.length };
    }
    if (mode === "HU") {
          if (discarderId === undefined || discarderId === null || !opponentIds.includes(discarderId)) {
                  throw new Error("Hu (menang dari buangan) perlu playerId lawan yang buang");
          }
          const results = opponentIds.map((id) =>
                  id === discarderId
                                                  ? { playerId: id, payment: totalPoints, label: `Buang untuk Hu — bayar ${totalPoints} poin` }
                    : { playerId: id, payment: 0, label: `Tidak kena (bukan yang buang)` }
                                              );
          return { results, winnerGain: totalPoints };
    }
    throw new Error("Mode menang tidak valid — harus ZIMO atau HU");
}
