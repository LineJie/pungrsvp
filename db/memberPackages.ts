import { sql } from "drizzle-orm";

// ─── Paket Member (additive) ───────────────────────────────────────────────
// Tiga tabel, tidak menyentuh bookings/members/staff yang sudah ada:
//
//  member_package_plans  = KATALOG paket per bulan (dibuat Super Admin). Ada 4
//                          jenis & isinya berubah tiap bulan, jadi tiap baris =
//                          satu paket di satu periode (mis. "Paket A — 2026-11").
//  member_packages       = paket yang DIBELI member. Isinya SNAPSHOT dari katalog
//                          (nama, jam awal, harga, expired) — jadi mengubah
//                          katalog bulan depan tidak merusak paket yang sudah
//                          dibeli. `remaining_hours` = sisa jam saat ini.
//  member_package_usage  = LEDGER setiap pergerakan jam (potong / kembali /
//                          koreksi). Sisa jam bisa diaudit & dihitung ulang
//                          dari sini, sama pola event-sourced di mahjong_events.
//
// Aturan bisnis (diputuskan Tere, Okt 2026):
//   - bayar paket di depan, jam dipotong saat CHECKOUT dengan metode "member"
//   - potong per jam penuh (pakai billableHours yang sudah dihitung bookings.ts)
//   - sisa jam HANGUS setelah expires_at
//   - member boleh punya >1 paket aktif → potong yang expired-nya paling dekat dulu
//   - hanya berlaku di cabang Bali (denpasar + tunu); dibeli lewat admin
//
// Pola bootstrap: sama dengan ensureX lain — sekali per warm container.

let _ensureMemberPackagesReady = false;
export async function ensureMemberPackageTables(db: any) {
  if (_ensureMemberPackagesReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_package_plans (
      id serial PRIMARY KEY,
      name text NOT NULL,
      period text NOT NULL,
      total_hours integer NOT NULL,
      price integer NOT NULL DEFAULT 0,
      expires_at text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_by text DEFAULT '',
      created_at timestamp DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_packages (
      id serial PRIMARY KEY,
      member_id integer NOT NULL,
      plan_id integer,
      plan_name text NOT NULL,
      period text NOT NULL DEFAULT '',
      total_hours integer NOT NULL,
      remaining_hours integer NOT NULL,
      price_paid integer NOT NULL DEFAULT 0,
      payment_method text DEFAULT '',
      expires_at text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      location text NOT NULL DEFAULT 'denpasar',
      sold_by text DEFAULT '',
      notes text DEFAULT '',
      purchased_at timestamp DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_package_usage (
      id serial PRIMARY KEY,
      member_package_id integer NOT NULL,
      booking_id integer,
      kind text NOT NULL,
      hours integer NOT NULL,
      created_by text DEFAULT '',
      notes text DEFAULT '',
      created_at timestamp DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_member_packages_member ON member_packages (member_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_member_usage_booking ON member_package_usage (booking_id)`);
  _ensureMemberPackagesReady = true;
}

// Paket member hanya untuk cabang Bali (denpasar + tunu).
export function isBaliBranch(loc: unknown): boolean {
  return loc === "denpasar" || loc === "tunu";
}

// Tanggal hari ini (YYYY-MM-DD) di zona WITA — dipakai membandingkan expires_at.
// Paket berlaku SAMPAI akhir hari expires_at (inklusif).
export function todayWita(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(at);
}

export type DeductResult =
  | { ok: true; parts: { memberPackageId: number; hours: number }[] }
  | { ok: false; error: string; available: number };

// Potong `hours` jam dari paket aktif milik member, urut expired terdekat dulu.
// Tidak ada transaksi DB di driver ini, jadi setiap potongan memakai UPDATE
// bersyarat (remaining_hours >= n) supaya dua checkout bersamaan tidak bisa
// membuat sisa jam minus; kalau ada langkah gagal, potongan sebelumnya
// dikembalikan (compensating refund).
export async function deductMemberHours(
  db: any,
  opts: { memberId: number; hours: number; bookingId: number; atDate: string; by: string }
): Promise<DeductResult> {
  const { memberId, hours, bookingId, atDate, by } = opts;

  // Idempotensi: kalau booking ini sudah pernah dipotong, jangan potong lagi.
  const already: any = await db.execute(sql`
    SELECT COALESCE(SUM(CASE WHEN kind = 'deduct' THEN hours ELSE -hours END), 0)::int AS net
    FROM member_package_usage WHERE booking_id = ${bookingId} AND kind IN ('deduct', 'refund')
  `);
  const alreadyNet = Number((already.rows ?? already)[0]?.net ?? 0);
  if (alreadyNet > 0) return { ok: false, error: "Jam member untuk booking ini sudah pernah dipotong", available: 0 };

  const pk: any = await db.execute(sql`
    SELECT id, remaining_hours FROM member_packages
    WHERE member_id = ${memberId} AND status = 'active' AND remaining_hours > 0 AND expires_at >= ${atDate}
    ORDER BY expires_at ASC, id ASC
  `);
  const packages: { id: number; remaining_hours: number }[] = pk.rows ?? pk;
  const available = packages.reduce((s, p) => s + Number(p.remaining_hours), 0);
  if (available < hours) {
    return { ok: false, error: `Sisa jam member tidak cukup (butuh ${hours} jam, tersedia ${available} jam)`, available };
  }

  const done: { memberPackageId: number; hours: number }[] = [];
  let left = hours;
  for (const p of packages) {
    if (left <= 0) break;
    const take = Math.min(left, Number(p.remaining_hours));
    const upd: any = await db.execute(sql`
      UPDATE member_packages SET remaining_hours = remaining_hours - ${take}
      WHERE id = ${p.id} AND remaining_hours >= ${take} AND status = 'active'
      RETURNING id
    `);
    if (!(upd.rows ?? upd).length) {
      // Paket ini baru saja dipakai transaksi lain — batalkan yang sudah terpotong.
      await refundParts(db, done, bookingId, by, "rollback: potong jam gagal di tengah");
      return { ok: false, error: "Sisa jam berubah saat diproses, coba lagi", available };
    }
    await db.execute(sql`
      INSERT INTO member_package_usage (member_package_id, booking_id, kind, hours, created_by)
      VALUES (${p.id}, ${bookingId}, 'deduct', ${take}, ${by})
    `);
    done.push({ memberPackageId: p.id, hours: take });
    left -= take;
  }
  return { ok: true, parts: done };
}

// Kembalikan jam yang tadi dipotong (dipakai untuk rollback kalau update
// booking gagal setelah jam terlanjur dipotong).
export async function refundParts(
  db: any,
  parts: { memberPackageId: number; hours: number }[],
  bookingId: number,
  by: string,
  note: string
) {
  for (const part of parts) {
    await db.execute(sql`UPDATE member_packages SET remaining_hours = remaining_hours + ${part.hours} WHERE id = ${part.memberPackageId}`);
    await db.execute(sql`
      INSERT INTO member_package_usage (member_package_id, booking_id, kind, hours, created_by, notes)
      VALUES (${part.memberPackageId}, ${bookingId}, 'refund', ${part.hours}, ${by}, ${note})
    `);
  }
}
