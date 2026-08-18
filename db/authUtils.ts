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

export async function ensureStaffTable(db: any) {
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
}

export async function ensurePromosTable(db: any) {
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
}

export async function ensureLocationColumns(db: any) {
        await db.execute(sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'surabaya'`);
        await db.execute(sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'surabaya'`);
}
