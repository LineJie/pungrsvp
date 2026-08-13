import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const bookings = pgTable("bookings", {
  id: serial().primaryKey(),
  bookingCode: text("booking_code").notNull().default(""),
  customerName: text("customer_name").notNull(),
  customerContact: text("customer_contact").default(""),
  date: text().notNull(),
  time: text().notNull(),           // original booking time
  tableId: text("table_id").notNull(),
  tableName: text("table_name").notNull(),
  floor: text().notNull(),
  duration: integer().notNull(),    // original booked duration
  notes: text().default(""),
  status: text().notNull().default("pending"), // pending | confirmed | checked_in | completed | cancelled
  checkinAt: timestamp("checkin_at"),          // actual checkin timestamp
  checkoutAt: timestamp("checkout_at"),        // actual checkout timestamp
  actualDuration: integer("actual_duration"),  // actual minutes played
  paymentMethod: text("payment_method").default(""), // tunai | qris | debit
  totalPaid: integer("total_paid").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  location: text().notNull().default("surabaya"), // surabaya | denpasar
});

export const members = pgTable("members", {
    id: serial().primaryKey(),
    waNumber: text("wa_number").notNull().unique(),
    name: text().notNull().default(""),
    notes: text().default(""),
    createdAt: timestamp("created_at").defaultNow(),
});


export const staff = pgTable("staff", {
    id: serial().primaryKey(),
    name: text().notNull(),
    username: text().notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text().notNull().default("admin"), // admin | kasir
    createdAt: timestamp("created_at").defaultNow(),
  location: text().notNull().default("surabaya"), // surabaya | denpasar | all (superadmin)
});


// ─── Mahjong Score module (additive) ──────────────────────────────────────
// These tables are new and do not modify bookings/members/staff in any way.
// A mahjong_games row is anchored to an existing booking (booking_id), so we
// reuse the existing table/session/customer concepts instead of duplicating
// them. Scores are event-sourced: mahjong_events stores every individual
// scoring event (never just a running total), so totals can always be
// reconstructed and audited.

export const mahjongGames = pgTable("mahjong_games", {
  id: serial().primaryKey(),
  bookingId: integer("booking_id").notNull(), // FK -> bookings.id (the checked-in table/session this game belongs to)
    sessionId: integer("session_id"), // groups consecutive games at the same table with the same 4 players ("same players" continuation flow) into one running point total; self-referencing (defaults to this game's own id when not continuing a previous session)
  tableId: text("table_id").notNull(),
  tableName: text("table_name").notNull(),
  location: text().notNull().default("surabaya"),
  status: text().notNull().default("waiting_for_players"),
  // waiting_for_players | ready | active | finished_win | draw | cancelled
  winnerPlayerId: integer("winner_player_id"), // FK -> mahjong_players.id, set only when status = finished_win
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const mahjongPlayers = pgTable("mahjong_players", {
  id: serial().primaryKey(),
  gameId: integer("game_id").notNull(), // FK -> mahjong_games.id
  seatNumber: integer("seat_number").notNull(), // 1-4, exactly 4 players per game
  name: text().notNull(),
  waNumber: text("wa_number").default(""), // optional — when present, used to match/upsert the existing members table
  memberId: integer("member_id"), // FK -> members.id when matched by wa_number (reuses existing customer record, never duplicates)
  joinedAt: timestamp("joined_at").defaultNow(),
});

export const mahjongEvents = pgTable("mahjong_events", {
  id: serial().primaryKey(),
  gameId: integer("game_id").notNull(), // FK -> mahjong_games.id
  playerId: integer("player_id").notNull(), // FK -> mahjong_players.id
  eventType: text("event_type").notNull(),
  // ZIMO | FLOWER | SEASON | LAST_CARD | KONG_FROM_DISCARD | KONG_FROM_WALL | DRAW_GAME | CORRECTION
  points: integer().notNull(),
  relatedPlayerId: integer("related_player_id"), // e.g. the discarder in a KONG_FROM_DISCARD event
  metadata: text(), // JSON-encoded string with event-specific details (tile numbers, honour tile, notes, etc.)
  createdAt: timestamp("created_at").defaultNow(),
});
