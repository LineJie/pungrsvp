// Pung Pung Mahjong Score — centralized scoring engine.
//
// This is the ONE authoritative place where Mahjong Score points are
// calculated. Netlify Functions call these pure functions to compute
// points server-side before writing game_events rows. Do NOT duplicate
// this math in the frontend or in any other backend file — the frontend
// should only render numbers that the server already computed.
//
// Official Pung Pung house rules (see product spec):
// - Only Zimo (self-draw) is a valid win. HU from discard is not allowed.
// - Zhong / Red Dragon is a Joker substitute inside a hand (no automatic
//   +5). Zhong drawn as a LAST CARD bonus is a different event and is
//   worth +5, same as any other Honour tile.
// - Kong from discard: konger +5, discarder -5.
// - Kong from wall: konger +6, other three players -2 each (nets to 0).
// - Zimo win payment: the winner's hand value (Zimo +1, Flower/Season
//   tiles, Last Card Bonus draws - see calculateWinScore) is what EACH of
//   the 3 losing players owes the winner, individually reduced by that
//   loser's own Flower/Season defense tiles (floored at 0 - defense can
//   never turn into a gain). The winner's actual point gain from the win
//   is the SUM of what all 3 losers actually end up paying - this
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

export type EventType =
  | "ZIMO"
  | "FLOWER"
  | "SEASON"
  | "LAST_CARD"
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

/** Zimo (self-draw win) is always worth exactly +1. */
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
 * Number of Last Card bonus draws a Zimo winner receives.
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
 * Score one Last Card Bonus draw.
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

export function sumPoints(points: number[]): number {
  return points.reduce((a, b) => a + b, 0);
}

export interface WinScoreInput {
  handContainsJoker: boolean;
  existingFlowers: BonusTileNumber[];
  existingSeasons: BonusTileNumber[];
  lastCardDraws: LastCardDraw[];
}

/**
 * Full Zimo win calculation: base Zimo (+1) + all Flower/Season tiles
 * already owned + Last Card Bonus draw(s). Validates that the number of
 * Last Card draws matches the Joker rule before scoring anything.
 * Kong events are scored separately via calculateKongScore whenever a Kong
 * happens during play - they are not part of this function.
 *
 * NOTE: total here is used purely as the PAYMENT BENCHMARK for
 * calculateAllLoserPayments() below - it is not credited to the winner
 * directly. See the house-rules note at the top of this file.
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
// calculateWinScore().total (Kong points are never part of it). The
// defense reduces that base payment but never reverses it into a gain --
// it floors at zero.
export function calculateLoserPayment(baseAmount: number, defense: LoserDefenseInput): LoserPaymentResult {
      const defenseValue = sumPoints([...defense.existingFlowers, ...defense.existingSeasons]);
      const payment = Math.max(0, baseAmount - defenseValue);
      const label = defenseValue > 0
        ? `Owed ${baseAmount} (winner's hand value), defended with tiles worth ${defenseValue} (paid ${payment})`
                  : `Owed ${baseAmount} to the winner (winner's hand value)`;
      return { playerId: defense.playerId, payment, defenseValue, label };
}

// All 3 losing players' payments for one Zimo win. baseAmount is the
// winner's hand value (calculateWinScore().total). The winner's actual
// point gain for the win is winnerGain -- the sum of what all 3 losers
// actually pay. This REPLACES the raw hand value as the winner's score;
// it is not added on top of it.
export function calculateAllLoserPayments(baseAmount: number, defenses: LoserDefenseInput[]): { results: LoserPaymentResult[]; winnerGain: number } {
      const results = defenses.map((d) => calculateLoserPayment(baseAmount, d));
      const winnerGain = sumPoints(results.map((r) => r.payment));
      return { results, winnerGain };
}

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
