import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";

export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = (stored || "").split(":");
    if (!salt || !hash) return false;
    const hashBuf = Buffer.from(hash, "hex");
    const derived = scryptSync(password, salt, 64);
    return hashBuf.length === derived.length && timingSafeEqual(hashBuf, derived);
}

let _ensureStaffTableReady = false;
export async function ensureStaffTable(db: any) {
    if (_ensureStaffTableReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS staff (
              id serial PRIMARY KEY,
                    name text NOT NULL,
                          username text NOT NULL UNIQUE,
                                password_hash text NOT NULL,
                                      role text NOT NULL DEFAULT 'admin',
                                            created_at timestamp DEFAULT now()
                                                )
                                                  `);
    _ensureStaffTableReady = true;
}

let _ensurePromosTableReady = false;
export async function ensurePromosTable(db: any) {
    if (_ensurePromosTableReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS promos (
              id serial PRIMARY KEY,
                    location text NOT NULL DEFAULT 'surabaya',
                          name text NOT NULL,
                                type text NOT NULL,
                                      value integer NOT NULL,
                                            active boolean NOT NULL DEFAULT true,
                                                  created_by text DEFAULT '',
                                                        created_at timestamp DEFAULT now()
                                                            )
                                                              `);
    _ensurePromosTableReady = true;
}

// Metode pembayaran dikelola Super Admin saja (POST/PATCH digate di
// payment-methods.ts, pola sama seperti promos.ts). Staff hanya baca (GET)
// buat isi tombol pilihan bayar di POS. `key` dipakai sebagai value yang
// disimpan di bookings.paymentMethod (jadi tidak berubah walau label diedit).
let _ensurePaymentMethodsTableReady = false;
export async function ensurePaymentMethodsTable(db: any) {
    if (_ensurePaymentMethodsTableReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS payment_methods (
              id serial PRIMARY KEY,
                    key text NOT NULL UNIQUE,
                          label text NOT NULL,
                                emoji text NOT NULL DEFAULT '💳',
                                      active boolean NOT NULL DEFAULT true,
                                            sort_order integer NOT NULL DEFAULT 0,
                                                  created_by text DEFAULT '',
                                                        created_at timestamp DEFAULT now()
                                                            )
                                                              `);
    // Seed metode default sekali saja, supaya tunai/QRIS/debit yang sudah
    // dipakai di data lama tetap konsisten dan tidak hilang dari daftar.
    await db.execute(sql`
        INSERT INTO payment_methods (key, label, emoji, sort_order)
        VALUES ('tunai', 'Tunai', '💵', 1), ('qris', 'QRIS', '📱', 2), ('debit', 'Debit BCA', '💳', 3)
        ON CONFLICT (key) DO NOTHING
    `);
    _ensurePaymentMethodsTableReady = true;
}

// Jam operasional per cabang per hari. Seed di bawah = jam yang berlaku saat
// ini (Agustus 2026):
//   Surabaya: Minggu-Kamis 10:00-22:00, Jumat-Sabtu 10:00-24:00
//   Denpasar: Senin-Kamis 10:00-21:00, Jumat-Minggu 10:00-22:00
// Super Admin bisa ubah kapan saja lewat tab "Jam Operasional" tanpa perlu
// deploy ulang — ON CONFLICT DO NOTHING supaya seed tidak menimpa perubahan
// yang sudah dibuat superadmin di run berikutnya.
// Daftar meja — seed sekali dengan 8 meja yang sudah ada sekarang (5
// Surabaya @ Rp50rb/jam, 3 Denpasar: Spring & Winter @ Rp50rb/jam otomatis,
// Autumn @ Rp30rb/jam manual) supaya booking lama & tarif yang sudah
// berjalan tidak berubah. Setelah ini, Super Admin nambah/ubah meja lewat
// tab "Kelola Meja" — ON CONFLICT DO NOTHING supaya seed tidak menimpa
// perubahan yang sudah dibuat.
let _ensureVenueTablesTableReady = false;
export async function ensureVenueTablesTable(db: any) {
    if (_ensureVenueTablesTableReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS venue_tables (
            id serial PRIMARY KEY,
            table_key text NOT NULL UNIQUE,
            name text NOT NULL,
            type text NOT NULL DEFAULT 'matic',
            hourly_rate integer NOT NULL DEFAULT 50000,
            floor text NOT NULL,
            location text NOT NULL DEFAULT 'surabaya',
            capacity text DEFAULT '4 orang',
            emoji text DEFAULT '🀄',
            notes text DEFAULT '',
            active boolean NOT NULL DEFAULT true,
            sort_order integer NOT NULL DEFAULT 0,
            created_by text DEFAULT '',
            created_at timestamp DEFAULT now()
        )
    `);
    await db.execute(sql`
        INSERT INTO venue_tables (table_key, name, type, hourly_rate, floor, location, capacity, emoji, notes, sort_order)
        VALUES
            ('1', 'Bamboo Table', 'matic', 50000, 'Lantai 2', 'surabaya', '4 orang', '🎋', '', 1),
            ('2', 'Orchid Table', 'matic', 50000, 'Lantai 2', 'surabaya', '4 orang', '🌸', '', 2),
            ('3', 'Lotus Table', 'matic', 50000, 'Lantai 2', 'surabaya', '4 orang', '🪷', '', 3),
            ('4', 'Sakura Table', 'matic', 50000, 'Lantai 2', 'surabaya', '4 orang', '🌺', '', 4),
            ('5', 'Dragon Table', 'matic', 50000, 'Lantai 1', 'surabaya', '4 orang', '🐉', '', 5),
            ('b1', 'Spring Table', 'matic', 50000, 'Denpasar, Bali', 'denpasar', '4 orang', '🌱', '', 6),
            ('b2', 'Winter Table', 'matic', 50000, 'Denpasar, Bali', 'denpasar', '4 orang', '❄️', '', 7),
            ('b3', 'Autumn Table', 'manual', 30000, 'Denpasar, Bali', 'denpasar', '4 orang', '🍂', '', 8)
        ON CONFLICT (table_key) DO NOTHING
    `);
    _ensureVenueTablesTableReady = true;
}

let _ensureOperatingHoursTableReady = false;
export async function ensureOperatingHoursTable(db: any) {
    if (_ensureOperatingHoursTableReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS operating_hours (
              id serial PRIMARY KEY,
                    location text NOT NULL,
                          day_of_week integer NOT NULL,
                                open_hour integer NOT NULL DEFAULT 10,
                                      close_hour integer NOT NULL DEFAULT 22,
                                            updated_by text DEFAULT '',
                                                  updated_at timestamp DEFAULT now(),
                                                        UNIQUE(location, day_of_week)
                                                            )
                                                              `);
    const rows: Array<[string, number, number, number]> = [
        ['surabaya', 0, 10, 22], ['surabaya', 1, 10, 22], ['surabaya', 2, 10, 22],
        ['surabaya', 3, 10, 22], ['surabaya', 4, 10, 22], ['surabaya', 5, 10, 24], ['surabaya', 6, 10, 24],
        ['denpasar', 0, 10, 22], ['denpasar', 1, 10, 21], ['denpasar', 2, 10, 21],
        ['denpasar', 3, 10, 21], ['denpasar', 4, 10, 21], ['denpasar', 5, 10, 22], ['denpasar', 6, 10, 22],
    ];
    for (const [location, dayOfWeek, openHour, closeHour] of rows) {
        await db.execute(sql`
            INSERT INTO operating_hours (location, day_of_week, open_hour, close_hour)
            VALUES (${location}, ${dayOfWeek}, ${openHour}, ${closeHour})
            ON CONFLICT (location, day_of_week) DO NOTHING
        `);
    }
    _ensureOperatingHoursTableReady = true;
}

let _ensureLocationColumnsReady = false;
export async function ensureLocationColumns(db: any) {
    if (_ensureLocationColumnsReady) return;
        await db.execute(sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'surabaya'`);
        await db.execute(sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'surabaya'`);
    _ensureLocationColumnsReady = true;
}

// Bootstrap untuk fitur "Acara Main Bareng" (community sessions, per-seat
// pricing). Dua tabel: sesi (meja + jam + harga/orang) dan peserta (nama +
// jumlah orang + status bayar, banyak peserta per sesi).
let _ensureCommunityTablesReady = false;
export async function ensureCommunityTables(db: any) {
    if (_ensureCommunityTablesReady) return;
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS community_sessions (
            id serial PRIMARY KEY,
            date text NOT NULL,
            time text NOT NULL,
            duration integer NOT NULL,
            table_id text NOT NULL,
            table_name text NOT NULL,
            floor text NOT NULL,
            location text NOT NULL DEFAULT 'surabaya',
            price_per_person integer NOT NULL,
            max_seats integer NOT NULL DEFAULT 4,
            notes text DEFAULT '',
            status text NOT NULL DEFAULT 'open',
            created_by text DEFAULT '',
            created_at timestamp DEFAULT now()
        )
    `);
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS community_participants (
            id serial PRIMARY KEY,
            session_id integer NOT NULL,
            name text NOT NULL,
            num_people integer NOT NULL DEFAULT 1,
            contact text DEFAULT '',
            paid boolean NOT NULL DEFAULT false,
            created_at timestamp DEFAULT now()
        )
    `);
    _ensureCommunityTablesReady = true;
}
