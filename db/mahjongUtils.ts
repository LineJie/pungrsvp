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
