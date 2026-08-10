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
