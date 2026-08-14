import { sql } from "drizzle-orm";

// Additive, idempotent table creation for the Mahjong Score module — mirrors
// the existing ensureStaffTable()/ensureLocationColumns() pattern in
// authUtils.ts. This exists as a safety net so the feature works even before
// a proper Drizzle migration has been run against the production database.
// It NEVER touches the existing bookings/members/staff tables.
export async function ensureMahjongTables(db: any) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mahjong_games (
      id serial PRIMARY KEY,
      booking_id integer NOT NULL,
      table_id text NOT NULL,
      table_name text NOT NULL,
      location text NOT NULL DEFAULT 'surabaya',
      status text NOT NULL DEFAULT 'waiting_for_players',
      winner_player_id integer,
      started_at timestamp,
      ended_at timestamp,
      created_at timestamp DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mahjong_players (
      id serial PRIMARY KEY,
      game_id integer NOT NULL,
      seat_number integer NOT NULL,
      name text NOT NULL,
      wa_number text DEFAULT '',
      member_id integer,
      joined_at timestamp DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mahjong_events (
      id serial PRIMARY KEY,
      game_id integer NOT NULL,
      player_id integer NOT NULL,
      event_type text NOT NULL,
      points integer NOT NULL,
      related_player_id integer,
      metadata text,
      created_at timestamp DEFAULT now()
    )
  `);
}

// Additive safety net: the pre-existing `members` table referenced by
// schema.ts (and by the Mahjong host/join flow's WhatsApp-number lookup)
// was never actually provisioned in some environments. This mirrors the
// CREATE TABLE IF NOT EXISTS pattern above -- it never touches or drops
// any existing member data, it only creates the table if missing.
export async function ensureMembersTable(db: any) {
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS members (
              id serial PRIMARY KEY,
                    wa_number text NOT NULL UNIQUE,
                          name text NOT NULL DEFAULT '',
                                notes text DEFAULT '',
                                      created_at timestamp DEFAULT now()
                                          )
                                            `);
}

// Additive safety net: adds the session_id column used to group consecutive
// games at the same table (same 4 players continuing without a break, via
// the "same players?" prompt in mahjong.html) into one running point total.
// Existing games/events are left untouched -- rows with session_id = NULL
// are simply treated as their own single-game session by the API.
export async function ensureSessionIdColumn(db: any) {
    await db.execute(sql`ALTER TABLE mahjong_games ADD COLUMN IF NOT EXISTS session_id integer`);
}

// Additive safety net: adds the scoring_system column so hosts can choose,
// per game, between the legacy "china" flat house rules and the newer
// "hongkong" fan-table system. Existing rows (all pre-dating this feature)
// default to 'hongkong' going forward; the column default also covers any
// environment where the migration runs before a Drizzle push.
export async function ensureScoringSystemColumn(db: any) {
    await db.execute(sql`ALTER TABLE mahjong_games ADD COLUMN IF NOT EXISTS scoring_system text NOT NULL DEFAULT 'hongkong'`);
}

