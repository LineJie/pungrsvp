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
// - "hongkong" (default): the Hong Kong Old Style fan table. Both Zimo
//   (self-draw) and Hu (win off a discard) are valid. See the HONG KONG
//   STYLE section below.
//
// Kong scoring (calculateKongScore) is shared by both systems — Kong is an
// immediate in-play bonus independent of which win-scoring style is used.

export type ScoringSystem = "china" | "hongkong";

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

// ─── HONG KONG OLD STYLE (fan table) ───────────────────────────────────
// - A winning hand is scored by picking every pattern ("fan") it matches
//   from FAN_TABLE below and summing the fan values. No upper cap — fan
//   keeps stacking. Minimum to win is 1 fan (see calculateHandFan).
// - Conversion: 1 fan = 1 point. (Was 1 fan = 10 points during design —
//   changed to 1:1 for the Aug 17 "81 poin" promo period; revisit later.)
// - Zimo (self-draw win): all 3 opponents each pay the full point total
//   to the winner (winner collects 3x the point total).
// - Hu (win off another player's discard): only the discarder pays the
//   full point total to the winner; the other two players pay nothing.
// - Pong of Seat Wind / Prevailing Wind: the host must also record which
//   wind (East/South/West/North) applies — this is purely informational
//   (does not change the fan value) but keeps the "bandar" / seat-wind
//   basis auditable in history. No automatic dealer/round rotation yet.

export type FanComboKey =
    | "REGULAR_WIN" | "CONCEALED_HAND" | "PONG_DRAGON" | "PONG_SEAT_WIND" | "PONG_PREVAILING_WIND"
  | "ALL_SIMPLES" | "KONG_IN_HAND" | "ALL_CHI" | "ALL_TYPES" | "HALF_OUTSIDE" | "ALL_PONG"
  | "MIXED_STRAIGHT" | "FULL_OUTSIDE" | "HALF_FLUSH" | "PURE_STRAIGHT" | "SHIFTED_SEQUENCES"
  | "THREE_CONCEALED_PONG" | "SEVEN_PAIRS" | "FULL_FLUSH" | "FOUR_CONCEALED_PONG" | "THIRTEEN_ORPHANS";

export interface FanComboInfo { label: string; fan: number; }

// Keep in sync with the Fan Guide page (kombinasi.html) — same 21 patterns,
// same fan values. That page is the player-facing reference for this table.
export const FAN_TABLE: Record<FanComboKey, FanComboInfo> = {
    REGULAR_WIN: { label: "Regular Win", fan: 1 },
    CONCEALED_HAND: { label: "Concealed Hand", fan: 1 },
    PONG_DRAGON: { label: "Pong of Dragon", fan: 1 },
    PONG_SEAT_WIND: { label: "Pong of Seat Wind", fan: 1 },
    PONG_PREVAILING_WIND: { label: "Pong of Prevailing Wind", fan: 1 },
    ALL_SIMPLES: { label: "All Simples", fan: 1 },
    KONG_IN_HAND: { label: "Kong", fan: 1 },
    ALL_CHI: { label: "All Chi / Sequences", fan: 1 },
    ALL_TYPES: { label: "All Types", fan: 2 },
    HALF_OUTSIDE: { label: "Half Outside", fan: 2 },
    ALL_PONG: { label: "All Pong / Triplets", fan: 3 },
    MIXED_STRAIGHT: { label: "Mixed Straight", fan: 3 },
    FULL_OUTSIDE: { label: "Full Outside", fan: 3 },
    HALF_FLUSH: { label: "Half Flush", fan: 4 },
    PURE_STRAIGHT: { label: "Pure Straight", fan: 4 },
    SHIFTED_SEQUENCES: { label: "Shifted Sequences", fan: 4 },
    THREE_CONCEALED_PONG: { label: "Three Concealed Pong", fan: 4 },
    SEVEN_PAIRS: { label: "Seven Pairs", fan: 5 },
    FULL_FLUSH: { label: "Full Flush", fan: 6 },
    FOUR_CONCEALED_PONG: { label: "Four Concealed Pong", fan: 11 },
    THIRTEEN_ORPHANS: { label: "Thirteen Orphans", fan: 13 },
};

// 1 fan = 1 point (Aug 2026 "81 poin" promo period).
export const POINTS_PER_FAN = 1;

export type SeatWind = "east" | "south" | "west" | "north";
export const SEAT_WIND_LABELS: Record<SeatWind, string> = {
    east: "Timur", south: "Selatan", west: "Barat", north: "Utara",
};
// Fan patterns that require a wind to be specified alongside them.
const WIND_COMBO_KEYS: FanComboKey[] = ["PONG_SEAT_WIND", "PONG_PREVAILING_WIND"];

export interface FanComboEvent {
    eventType: "FAN_COMBO";
    points: 0;
    label: string;
    metadata: { comboKey: FanComboKey; fan: number; wind?: SeatWind };
}

/**
 * Sum the fan value of every selected pattern for a winning hand (Hong
 * Kong style). Throws if nothing is selected — minimum to win is 1 fan, so
 * the host must tick at least one pattern (usually "Regular Win" if
 * nothing fancier applies). Also throws if "Pong of Seat Wind" and/or
 * "Pong of Prevailing Wind" is selected without its matching wind.
 */
export function calculateHandFan(
    comboKeys: FanComboKey[],
    windSelections?: Partial<Record<FanComboKey, SeatWind>>
  ): { events: FanComboEvent[]; totalFan: number; totalPoints: number } {
    const uniq = Array.from(new Set(comboKeys || []));
    if (!uniq.length) {
          throw new Error("Pilih minimal 1 pola (minimal 1 fan) untuk menang");
    }
    const events: FanComboEvent[] = uniq.map((key) => {
          const info = FAN_TABLE[key];
          if (!info) {
                  throw new Error(`Pola tidak dikenal: ${key}`);
          }
          const metadata: FanComboEvent["metadata"] = { comboKey: key, fan: info.fan };
          if (WIND_COMBO_KEYS.includes(key)) {
                  const wind = windSelections ? windSelections[key] : undefined;
                  if (!wind) {
                            throw new Error(`Pilih arah angin untuk ${info.label} (mata angin bandar/duduk)`);
                  }
                  metadata.wind = wind;
          }
          return { eventType: "FAN_COMBO", points: 0, label: info.label, metadata };
    });
    const totalFan = events.reduce((sum, e) => sum + e.metadata.fan, 0);
    return { events, totalFan, totalPoints: totalFan * POINTS_PER_FAN };
}

export type WinMode = "ZIMO" | "HU";

export interface FanWinPaymentResult {
    playerId: number;
    payment: number;
    label: string;
}

/**
 * Who pays what once the winning hand's point total is known (Hong Kong
 * style). Zimo (self-draw): all 3 opponents each pay the full amount.
 * Hu (win off a discard): only the discarder pays the full amount.
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
