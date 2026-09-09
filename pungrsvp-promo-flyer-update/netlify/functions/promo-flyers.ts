import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { promoFlyers } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { ensurePromoFlyersTable } from "../../db/authUtils.js";

// Super Admin auth check — identical pattern to promos.ts / bookings.ts.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
  const u = req.headers.get("x-auth-username");
  const p = req.headers.get("x-auth-password");
  const superadminPw = process.env.SUPERADMIN_PASSWORD;
  return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

const VALID_LOCATIONS = ["surabaya", "denpasar"];

// Hari ini dalam format YYYY-MM-DD, dihitung di WIB/WITA-agnostic (pakai
// waktu server cukup buat keperluan on/off flyer, beda beberapa jam di
// tengah malam nggak signifikan buat popup marketing).
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// Satu flyer dianggap AKTIF kalau:
//  - manualOverride === true  → paksa nyala, abaikan tanggal
//  - manualOverride === false → paksa mati, abaikan tanggal
//  - manualOverride === null  → nyala kalau hari ini ada di antara start/end
function isFlyerActive(f: typeof promoFlyers.$inferSelect): boolean {
  if (f.manualOverride === true) return true;
  if (f.manualOverride === false) return false;
  const today = todayStr();
  return today >= f.startDate && today <= f.endDate;
}

export default async (req: Request) => {
  await ensurePromoFlyersTable(db);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const location = url.searchParams.get("location");
    const activeOnly = url.searchParams.get("active") === "true";

    let rows = await db.select().from(promoFlyers);
    if (location) rows = rows.filter((f) => f.location === location);
    if (activeOnly) rows = rows.filter(isFlyerActive);

    // Sertakan status aktif terhitung di tiap baris — admin.html pakai ini
    // buat nunjukin badge "🟢 Aktif sekarang" vs "⏳ Terjadwal" vs "⚪ Mati",
    // tanpa perlu ngitung ulang logic tanggal di client.
    const withStatus = rows.map((f) => ({ ...f, isActiveNow: isFlyerActive(f) }));
    return Response.json(withStatus);
  }

  if (req.method === "POST") {
    if (!isSuperAdminReq(req)) {
      return Response.json({ error: "Hanya Super Admin yang bisa membuat flyer promo" }, { status: 403 });
    }
    const body = await req.json();
    const { imageUrl, linkUrl, location, startDate, endDate } = body;

    if (!imageUrl || !String(imageUrl).trim()) return Response.json({ error: "URL gambar wajib diisi" }, { status: 400 });
    if (!VALID_LOCATIONS.includes(location)) return Response.json({ error: "Lokasi tidak valid" }, { status: 400 });
    if (!startDate || !endDate) return Response.json({ error: "Tanggal mulai & selesai wajib diisi" }, { status: 400 });
    if (String(startDate) > String(endDate)) return Response.json({ error: "Tanggal mulai harus sebelum tanggal selesai" }, { status: 400 });

    const [row] = await db.insert(promoFlyers).values({
      imageUrl: String(imageUrl).trim(),
      linkUrl: linkUrl ? String(linkUrl).trim() : "",
      location,
      startDate: String(startDate),
      endDate: String(endDate),
      manualOverride: null,
      createdBy: req.headers.get("x-auth-username") || "",
    }).returning();
    return Response.json(row, { status: 201 });
  }

  if (req.method === "PATCH") {
    if (!isSuperAdminReq(req)) {
      return Response.json({ error: "Hanya Super Admin yang bisa mengubah flyer promo" }, { status: 403 });
    }
    const id = parseInt(url.searchParams.get("id") || "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const body = await req.json();

    const updateData: any = {};
    if (body.imageUrl !== undefined) updateData.imageUrl = String(body.imageUrl).trim();
    if (body.linkUrl !== undefined) updateData.linkUrl = String(body.linkUrl).trim();
    if (body.location !== undefined) {
      if (!VALID_LOCATIONS.includes(body.location)) return Response.json({ error: "Lokasi tidak valid" }, { status: 400 });
      updateData.location = body.location;
    }
    if (body.startDate !== undefined) updateData.startDate = String(body.startDate);
    if (body.endDate !== undefined) updateData.endDate = String(body.endDate);
    // manualOverride: kirim null eksplisit dari client buat "ikutin tanggal lagi"
    if ("manualOverride" in body) updateData.manualOverride = body.manualOverride;

    if (Object.keys(updateData).length === 0) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });

    const [row] = await db.update(promoFlyers).set(updateData).where(eq(promoFlyers.id, id)).returning();
    if (!row) return Response.json({ error: "Flyer not found" }, { status: 404 });
    return Response.json(row);
  }

  if (req.method === "DELETE") {
    if (!isSuperAdminReq(req)) {
      return Response.json({ error: "Hanya Super Admin yang bisa menghapus flyer promo" }, { status: 403 });
    }
    const id = parseInt(url.searchParams.get("id") || "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const [row] = await db.delete(promoFlyers).where(eq(promoFlyers.id, id)).returning();
    if (!row) return Response.json({ error: "Flyer not found" }, { status: 404 });
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/promo-flyers" };
