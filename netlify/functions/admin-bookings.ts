import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings, staff } from "../../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { ensureLocationColumns, verifyPassword } from "../../db/authUtils.js";

// Data booking lengkap (nama, kontak, pembayaran) hanya untuk staff yang sudah
// login: superadmin, admin, atau kasir. Akun "viewer" sengaja tidak termasuk.
const SUPERADMIN_USERNAME = "tere";
async function isFullAccessReq(req: Request): Promise<boolean> {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    if (!u || !p) return false;
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    if (u === SUPERADMIN_USERNAME && superadminPw && p === superadminPw) return true;
    const rows = await db.select().from(staff).where(eq(staff.username, u));
    if (!rows.length || rows[0].role === "viewer") return false;
    return verifyPassword(p, rows[0].passwordHash);
}

export default async (req: Request) => {
    await ensureLocationColumns(db);

    if (req.method === "GET") {
          if (!(await isFullAccessReq(req))) {
                return Response.json({ error: "Login staff diperlukan" }, { status: 401 });
          }
          const url = new URL(req.url);
          const date = url.searchParams.get("date");
          const id = url.searchParams.get("id");
          const location = url.searchParams.get("location");

      if (id) {
              const rows = await db.select().from(bookings).where(eq(bookings.id, parseInt(id)));
              return Response.json(rows);
      }

      if (date) {
              const whereClause = location ? and(eq(bookings.date, date), eq(bookings.location, location)) : eq(bookings.date, date);
              const rows = await db.select().from(bookings)
                .where(whereClause)
                .orderBy(bookings.time);
              return Response.json(rows);
      }

      const rows = location
            ? await db.select().from(bookings).where(eq(bookings.location, location)).orderBy(desc(bookings.createdAt))
              : await db.select().from(bookings).orderBy(desc(bookings.createdAt));
          return Response.json(rows);
    }
    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/admin/bookings" };
