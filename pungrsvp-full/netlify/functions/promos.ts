import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { promos } from "../../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { ensurePromosTable } from "../../db/authUtils.js";

// Super Admin auth check — identical pattern to bookings.ts / staff.ts.
// Only Super Admin (username "tere") can create or edit promos. Staff can
// still READ the list (GET) so the POS dropdown can show active promos for
// their branch — read access is not gated because it's not sensitive and
// staff need it to do the checkout.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

const VALID_TYPES = ["free_hours", "percent_off", "flat_off"];
const VALID_LOCATIONS = ["surabaya", "denpasar"];

export default async (req: Request) => {
    await ensurePromosTable(db);
    const url = new URL(req.url);

    if (req.method === "GET") {
          const location = url.searchParams.get("location");
          const activeParam = url.searchParams.get("active"); // "true" | "false" | absent (= all)

      const conditions = [];
          if (location) conditions.push(eq(promos.location, location));
          if (activeParam === "true") conditions.push(eq(promos.active, true));
          if (activeParam === "false") conditions.push(eq(promos.active, false));

      const rows = conditions.length
            ? await db.select().from(promos).where(and(...conditions)).orderBy(desc(promos.createdAt))
              : await db.select().from(promos).orderBy(desc(promos.createdAt));
          return Response.json(rows);
    }

    if (req.method === "POST") {
          if (!isSuperAdminReq(req)) {
                  return Response.json({ error: "Hanya Super Admin yang bisa membuat promo" }, { status: 403 });
          }
          const body = await req.json();
          const { name, location, type, value } = body;

      if (!name || !String(name).trim()) return Response.json({ error: "Nama promo wajib diisi" }, { status: 400 });
          if (!VALID_LOCATIONS.includes(location)) return Response.json({ error: "Lokasi tidak valid" }, { status: 400 });
          if (!VALID_TYPES.includes(type)) return Response.json({ error: "Tipe promo tidak valid" }, { status: 400 });
          const numValue = parseInt(value);
          if (!Number.isFinite(numValue) || numValue <= 0) return Response.json({ error: "Nilai promo harus angka positif" }, { status: 400 });
          if (type === "percent_off" && numValue > 100) return Response.json({ error: "Persen diskon maksimal 100" }, { status: 400 });

      const [row] = await db.insert(promos).values({
              name: String(name).trim(),
              location,
              type,
              value: numValue,
              active: true,
              createdBy: req.headers.get("x-auth-username") || "",
          }).returning();
          return Response.json(row, { status: 201 });
    }

    if (req.method === "PATCH") {
          if (!isSuperAdminReq(req)) {
                  return Response.json({ error: "Hanya Super Admin yang bisa mengubah promo" }, { status: 403 });
          }
          const id = parseInt(url.searchParams.get("id") || "");
          if (!id) return Response.json({ error: "id required" }, { status: 400 });
          const body = await req.json();

      const updateData: any = {};
          if (typeof body.active === "boolean") updateData.active = body.active;
          if (body.name !== undefined) updateData.name = String(body.name).trim();
          if (body.location !== undefined) {
                  if (!VALID_LOCATIONS.includes(body.location)) return Response.json({ error: "Lokasi tidak valid" }, { status: 400 });
                  updateData.location = body.location;
          }
          if (body.type !== undefined) {
                  if (!VALID_TYPES.includes(body.type)) return Response.json({ error: "Tipe promo tidak valid" }, { status: 400 });
                  updateData.type = body.type;
          }
          if (body.value !== undefined) {
                  const numValue = parseInt(body.value);
                  if (!Number.isFinite(numValue) || numValue <= 0) return Response.json({ error: "Nilai promo harus angka positif" }, { status: 400 });
                  updateData.value = numValue;
          }

      if (Object.keys(updateData).length === 0) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });

      const [row] = await db.update(promos).set(updateData).where(eq(promos.id, id)).returning();
          if (!row) return Response.json({ error: "Promo not found" }, { status: 404 });
          return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/promos" };
