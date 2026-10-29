import type { Config } from "@netlify/functions";
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { staff } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { verifyPassword } from "../../db/authUtils.js";
import { ensureMembersTable } from "../../db/mahjongUtils.js";
import { ensureMemberPackageTables, isBaliBranch, todayWita } from "../../db/memberPackages.js";

// API Paket Member. Aturan akses:
//   - Katalog paket (buat/ubah)        : Super Admin saja
//   - Jual paket ke member             : admin (cabang Bali) atau Super Admin
//   - Cari member / lihat sisa jam     : admin & kasir (dipakai POS saat checkout)
//   - Void / koreksi jam               : Super Admin saja (selalu tercatat di ledger)
// Auth memakai pola yang sama dengan bookings.ts (header x-auth-username/password).

const SUPERADMIN_USERNAME = "tere";

type Actor = { username: string; role: "superadmin" | "admin" | "kasir"; location: string };

async function authActor(req: Request): Promise<Actor | null> {
  const u = req.headers.get("x-auth-username");
  const p = req.headers.get("x-auth-password");
  if (!u || !p) return null;
  const superPw = process.env.SUPERADMIN_PASSWORD;
  if (superPw && u === SUPERADMIN_USERNAME && p === superPw) {
    return { username: u, role: "superadmin", location: "all" };
  }
  const rows = await db.select().from(staff).where(eq(staff.username, u));
  if (!rows.length || (rows[0].role !== "admin" && rows[0].role !== "kasir")) return null;
  if (!verifyPassword(p, rows[0].passwordHash)) return null;
  return { username: u, role: rows[0].role as "admin" | "kasir", location: rows[0].location };
}

const rowsOf = (r: any): any[] => (r && r.rows) ? r.rows : (Array.isArray(r) ? r : []);

// Nomor WA ditulis macam-macam (0812…, +62 812…, 62812…). Cocokkan lewat
// versi digit-only dengan kedua awalan supaya tidak terbentuk member ganda.
function waVariants(input: string): string[] {
  const d = (input || "").replace(/\D/g, "");
  if (!d) return [];
  if (d.startsWith("62")) return [d, "0" + d.slice(2)];
  if (d.startsWith("0")) return [d, "62" + d.slice(1)];
  return [d];
}

async function findMemberByWa(wa: string): Promise<{ id: number; wa_number: string; name: string } | null> {
  const v = waVariants(wa);
  if (!v.length) return null;
  const list = sql.join(v.map(x => sql`${x}`), sql`, `);
  const r = await db.execute(sql`
    SELECT id, wa_number, name FROM members
    WHERE regexp_replace(wa_number, '[^0-9]', '', 'g') IN (${list}) LIMIT 1
  `);
  return rowsOf(r)[0] || null;
}

// Alasan yang sama dipakai di tiga tempat (cari, ringkasan, potong) supaya
// definisi "paket aktif" tidak pernah beda-beda.
const ACTIVE_PKG = (today: string) =>
  sql`status = 'active' AND remaining_hours > 0 AND expires_at >= ${today}`;

export default async (req: Request) => {
  await ensureMembersTable(db);
  await ensureMemberPackageTables(db);

  const actor = await authActor(req);
  if (!actor) return Response.json({ error: "Login diperlukan" }, { status: 401 });
  const isSuper = actor.role === "superadmin";

  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "";
  const today = todayWita();

  // ── KATALOG PAKET ───────────────────────────────────────────────────────
  if (view === "plans") {
    if (req.method === "GET") {
      const period = url.searchParams.get("period");
      const showAll = isSuper && url.searchParams.get("all") === "1";
      const r = await db.execute(sql`
        SELECT * FROM member_package_plans
        WHERE (${showAll} OR active = true)
          AND (${period || null}::text IS NULL OR period = ${period || null})
        ORDER BY period DESC, sort_order ASC, id ASC
      `);
      return Response.json(rowsOf(r));
    }

    if (!isSuper) return Response.json({ error: "Hanya Super Admin yang bisa mengelola katalog paket" }, { status: 403 });

    if (req.method === "POST") {
      const b = await req.json();
      const name = String(b.name || "").trim();
      const period = String(b.period || "");
      const expiresAt = String(b.expiresAt || "");
      const totalHours = parseInt(b.totalHours);
      const price = parseInt(b.price);
      if (!name) return Response.json({ error: "Nama paket wajib diisi" }, { status: 400 });
      if (!/^\d{4}-\d{2}$/.test(period)) return Response.json({ error: "Periode harus format YYYY-MM" }, { status: 400 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return Response.json({ error: "Tanggal expired harus format YYYY-MM-DD" }, { status: 400 });
      if (!(totalHours > 0)) return Response.json({ error: "Jumlah jam harus lebih dari 0" }, { status: 400 });
      if (!(price >= 0)) return Response.json({ error: "Harga tidak valid" }, { status: 400 });
      const sortOrder = Number.isFinite(parseInt(b.sortOrder)) ? parseInt(b.sortOrder) : 0;
      const r = await db.execute(sql`
        INSERT INTO member_package_plans (name, period, total_hours, price, expires_at, sort_order, created_by)
        VALUES (${name}, ${period}, ${totalHours}, ${price}, ${expiresAt}, ${sortOrder}, ${actor.username})
        RETURNING *
      `);
      return Response.json(rowsOf(r)[0], { status: 201 });
    }

    if (req.method === "PATCH") {
      const id = parseInt(url.searchParams.get("id") || "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const b = await req.json();
      // Mengubah katalog TIDAK mengubah paket yang sudah dibeli (itu snapshot).
      const r = await db.execute(sql`
        UPDATE member_package_plans SET
          name = COALESCE(${b.name !== undefined ? String(b.name).trim() : null}, name),
          total_hours = COALESCE(${b.totalHours !== undefined ? parseInt(b.totalHours) : null}, total_hours),
          price = COALESCE(${b.price !== undefined ? parseInt(b.price) : null}, price),
          expires_at = COALESCE(${b.expiresAt !== undefined ? String(b.expiresAt) : null}, expires_at),
          active = COALESCE(${typeof b.active === "boolean" ? b.active : null}, active)
        WHERE id = ${id} RETURNING *
      `);
      const row = rowsOf(r)[0];
      if (!row) return Response.json({ error: "Paket tidak ditemukan" }, { status: 404 });
      return Response.json(row);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // ── CARI MEMBER + SISA JAM (dipakai POS saat checkout) ──────────────────
  if (view === "member" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return Response.json([]);
    const digits = q.replace(/\D/g, "");
    const variants = digits.length >= 4 ? waVariants(q) : [];
    const like = `%${q.toLowerCase()}%`;
    const waCond = variants.length
      ? sql`OR regexp_replace(wa_number, '[^0-9]', '', 'g') IN (${sql.join(variants.map(x => sql`${x}`), sql`, `)})`
      : sql``;
    const mr = await db.execute(sql`
      SELECT id, wa_number, name FROM members
      WHERE lower(name) LIKE ${like} ${waCond}
      ORDER BY name ASC LIMIT 10
    `);
    const members = rowsOf(mr);
    if (!members.length) return Response.json([]);
    const ids = sql.join(members.map((m: any) => sql`${m.id}`), sql`, `);
    const pr = await db.execute(sql`
      SELECT id, member_id, plan_name, period, total_hours, remaining_hours, expires_at, location
      FROM member_packages
      WHERE member_id IN (${ids}) AND ${ACTIVE_PKG(today)}
      ORDER BY expires_at ASC, id ASC
    `);
    const pkgs = rowsOf(pr);
    return Response.json(members.map((m: any) => {
      const mine = pkgs.filter((p: any) => p.member_id === m.id);
      return {
        id: m.id, name: m.name, waNumber: m.wa_number,
        remainingHours: mine.reduce((s: number, p: any) => s + Number(p.remaining_hours), 0),
        packages: mine,
      };
    }));
  }

  // ── RIWAYAT PAKET + LEDGER SATU MEMBER ──────────────────────────────────
  if (view === "packages" && req.method === "GET") {
    const memberId = parseInt(url.searchParams.get("memberId") || "");
    if (!memberId) return Response.json({ error: "memberId required" }, { status: 400 });
    const pr = await db.execute(sql`SELECT * FROM member_packages WHERE member_id = ${memberId} ORDER BY purchased_at DESC`);
    const packages = rowsOf(pr);
    let usage: any[] = [];
    if (packages.length) {
      const ids = sql.join(packages.map((p: any) => sql`${p.id}`), sql`, `);
      usage = rowsOf(await db.execute(sql`SELECT * FROM member_package_usage WHERE member_package_id IN (${ids}) ORDER BY created_at DESC`));
    }
    return Response.json({
      packages: packages.map((p: any) => ({
        ...p,
        expired: p.expires_at < today,
        // Jam hangus = sisa jam di paket yang sudah lewat expired.
        forfeitedHours: p.status === "active" && p.expires_at < today ? Number(p.remaining_hours) : 0,
      })),
      usage,
    });
  }

  // ── LAPORAN PENJUALAN PAKET (untuk Tutup Kasir / laporan) ───────────────
  if (view === "sales" && req.method === "GET") {
    if (actor.role === "kasir") return Response.json({ error: "Khusus admin" }, { status: 403 });
    const from = url.searchParams.get("from") || today;
    const to = url.searchParams.get("to") || from;
    const loc = url.searchParams.get("location") || "";
    const r = await db.execute(sql`
      SELECT mp.id, mp.plan_name, mp.period, mp.total_hours, mp.price_paid, mp.payment_method, mp.location,
             mp.sold_by, mp.purchased_at, mp.status, m.name AS member_name, m.wa_number
      FROM member_packages mp JOIN members m ON m.id = mp.member_id
      WHERE (mp.purchased_at AT TIME ZONE 'Asia/Makassar')::date BETWEEN ${from}::date AND ${to}::date
        AND mp.status <> 'void'
        AND (${loc} = '' OR mp.location = ${loc})
      ORDER BY mp.purchased_at DESC
    `);
    return Response.json(rowsOf(r));
  }

  // ── JUAL PAKET KE MEMBER (admin) ────────────────────────────────────────
  if (view === "purchase" && req.method === "POST") {
    if (actor.role === "kasir") return Response.json({ error: "Penjualan paket hanya bisa dilakukan admin" }, { status: 403 });
    const b = await req.json();
    // Admin akun Bali boleh pindah Magendra/Tunu, jadi cabang dari klien dipakai
    // selama valid Bali; admin non-Bali selalu ditolak oleh isBaliBranch di bawah.
    const location = (isSuper || isBaliBranch(actor.location)) ? String(b.location || actor.location) : actor.location;
    if (!isBaliBranch(location)) {
      return Response.json({ error: "Paket member hanya berlaku di cabang Bali (Denpasar / Tunu)" }, { status: 400 });
    }
    const wa = String(b.waNumber || "").trim();
    const name = String(b.name || "").trim();
    const planId = parseInt(b.planId);
    if (!wa || !waVariants(wa).length) return Response.json({ error: "Nomor WhatsApp member wajib diisi" }, { status: 400 });
    if (!planId) return Response.json({ error: "Pilih paket" }, { status: 400 });
    if (!b.paymentMethod) return Response.json({ error: "Pilih metode pembayaran" }, { status: 400 });

    const plan = rowsOf(await db.execute(sql`SELECT * FROM member_package_plans WHERE id = ${planId}`))[0];
    if (!plan || !plan.active) return Response.json({ error: "Paket tidak tersedia" }, { status: 400 });
    if (plan.expires_at < today) return Response.json({ error: "Paket ini sudah lewat tanggal expired" }, { status: 400 });

    // Member: pakai yang sudah ada, kalau belum ada dibuat (nama wajib untuk member baru).
    let member = await findMemberByWa(wa);
    if (!member) {
      if (!name) return Response.json({ error: "Nama wajib diisi untuk member baru" }, { status: 400 });
      const ins = await db.execute(sql`INSERT INTO members (wa_number, name) VALUES (${wa}, ${name}) RETURNING id, wa_number, name`);
      member = rowsOf(ins)[0];
    }

    // SNAPSHOT: harga yang dibayar, jam & expired disalin dari katalog saat ini.
    const r = await db.execute(sql`
      INSERT INTO member_packages
        (member_id, plan_id, plan_name, period, total_hours, remaining_hours, price_paid,
         payment_method, expires_at, location, sold_by, notes)
      VALUES
        (${member!.id}, ${plan.id}, ${plan.name}, ${plan.period}, ${plan.total_hours}, ${plan.total_hours},
         ${plan.price}, ${String(b.paymentMethod)}, ${plan.expires_at}, ${location}, ${actor.username},
         ${String(b.notes || "")})
      RETURNING *
    `);
    return Response.json({ ...rowsOf(r)[0], memberName: member!.name }, { status: 201 });
  }

  // ── VOID / KOREKSI JAM (Super Admin) ────────────────────────────────────
  if (view === "package" && req.method === "PATCH") {
    if (!isSuper) return Response.json({ error: "Hanya Super Admin yang bisa void/koreksi paket" }, { status: 403 });
    const id = parseInt(url.searchParams.get("id") || "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const b = await req.json();
    const note = String(b.note || "").trim();
    if (!note) return Response.json({ error: "Alasan wajib diisi" }, { status: 400 });
    const pkg = rowsOf(await db.execute(sql`SELECT * FROM member_packages WHERE id = ${id}`))[0];
    if (!pkg) return Response.json({ error: "Paket tidak ditemukan" }, { status: 404 });

    if (b.action === "void") {
      await db.execute(sql`UPDATE member_packages SET status = 'void', remaining_hours = 0 WHERE id = ${id}`);
      await db.execute(sql`
        INSERT INTO member_package_usage (member_package_id, kind, hours, created_by, notes)
        VALUES (${id}, 'void', ${Number(pkg.remaining_hours)}, ${actor.username}, ${note})
      `);
      return Response.json({ ok: true });
    }
    if (b.action === "adjust") {
      const delta = parseInt(b.hours); // positif = tambah jam, negatif = kurangi
      if (!delta) return Response.json({ error: "Jumlah jam koreksi tidak valid" }, { status: 400 });
      const upd = await db.execute(sql`
        UPDATE member_packages SET remaining_hours = remaining_hours + ${delta}
        WHERE id = ${id} AND remaining_hours + ${delta} >= 0 RETURNING remaining_hours
      `);
      if (!rowsOf(upd).length) return Response.json({ error: "Sisa jam tidak boleh minus" }, { status: 400 });
      await db.execute(sql`
        INSERT INTO member_package_usage (member_package_id, kind, hours, created_by, notes)
        VALUES (${id}, 'adjust', ${delta}, ${actor.username}, ${note})
      `);
      return Response.json({ ok: true, remainingHours: rowsOf(upd)[0].remaining_hours });
    }
    return Response.json({ error: "action harus 'void' atau 'adjust'" }, { status: 400 });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/member-packages" };
