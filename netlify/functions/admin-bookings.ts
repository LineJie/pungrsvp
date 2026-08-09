import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { eq, desc } from "drizzle-orm";

export default async (req: Request) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    const id = url.searchParams.get("id");

    if (id) {
      const rows = await db.select().from(bookings).where(eq(bookings.id, parseInt(id)));
      return Response.json(rows);
    }

    if (date) {
      const rows = await db.select().from(bookings)
        .where(eq(bookings.date, date))
        .orderBy(bookings.time);
      return Response.json(rows);
    }

    const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt));
    return Response.json(rows);
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/admin/bookings" };
