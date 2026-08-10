import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { ensureLocationColumns } from "../../db/authUtils.js";

export default async (req: Request) => {
    await ensureLocationColumns(db);

    if (req.method === "GET") {
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
