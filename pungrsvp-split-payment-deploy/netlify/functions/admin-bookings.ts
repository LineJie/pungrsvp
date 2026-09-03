import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings, bookingPayments } from "../../db/schema.js";
import { eq, desc, and, inArray } from "drizzle-orm";
import { ensureLocationColumns, ensureBookingPaymentsTable } from "../../db/authUtils.js";

// Booking yang paymentMethod = 'split' (mixed payment) tidak punya rincian
// metode di kolom bookings itu sendiri — rinciannya ada di tabel terpisah
// booking_payments. Fungsi ini nempelin rincian itu sebagai `splitPayments`
// di tiap booking split, supaya Tutup Kasir & laporan bisa pecah omsetnya
// per metode yang sebenarnya dipakai, bukan cuma dihitung sebagai "split".
async function attachSplitPayments(rows: any[]) {
    const splitIds = rows.filter(r => r.paymentMethod === "split").map(r => r.id);
    if (splitIds.length === 0) return rows;
    const payRows = await db.select().from(bookingPayments).where(inArray(bookingPayments.bookingId, splitIds));
    const byBooking: Record<number, { method: string; amount: number }[]> = {};
    payRows.forEach((p: any) => {
        (byBooking[p.bookingId] ||= []).push({ method: p.method, amount: p.amount });
    });
    return rows.map(r => r.paymentMethod === "split" ? { ...r, splitPayments: byBooking[r.id] || [] } : r);
}

export default async (req: Request) => {
    await ensureLocationColumns(db);
    await ensureBookingPaymentsTable(db);

    if (req.method === "GET") {
          const url = new URL(req.url);
          const date = url.searchParams.get("date");
          const id = url.searchParams.get("id");
          const location = url.searchParams.get("location");

      if (id) {
              const rows = await db.select().from(bookings).where(eq(bookings.id, parseInt(id)));
              return Response.json(await attachSplitPayments(rows));
      }

      if (date) {
              const whereClause = location ? and(eq(bookings.date, date), eq(bookings.location, location)) : eq(bookings.date, date);
              const rows = await db.select().from(bookings)
                .where(whereClause)
                .orderBy(bookings.time);
              return Response.json(await attachSplitPayments(rows));
      }

      const rows = location
            ? await db.select().from(bookings).where(eq(bookings.location, location)).orderBy(desc(bookings.createdAt))
              : await db.select().from(bookings).orderBy(desc(bookings.createdAt));
          return Response.json(await attachSplitPayments(rows));
    }
    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/admin/bookings" };
