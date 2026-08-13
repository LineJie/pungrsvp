import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { ensureLocationColumns } from "../../db/authUtils.js";

// Super Admin auth check (same pattern as netlify/functions/staff.ts) — used
// to gate the admin-correction and void-transaction paths in PATCH below,
// which are the only ways to modify a booking after it has been checked out.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

function generateCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "PP-";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

async function sendEmailNotification(booking: any) {
    const ADMIN_EMAIL = "Bananaleaf.west@gmail.com";
    const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
    if (!SENDGRID_KEY) return;
    const subject = `[Pung Pung] Booking Baru: ${booking.customerName} — ${booking.date} ${booking.time}`;
    const body = `Booking baru masuk!\n\nKode : ${booking.bookingCode}\nNama : ${booking.customerName}\nTanggal : ${booking.date}\nJam : ${booking.time} WIB\nMeja : ${booking.tableName} (${booking.floor})\nDurasi : ${booking.duration} jam\nTotal Est: Rp ${(50000 * booking.duration).toLocaleString('id-ID')}\nStatus : MENUNGGU PEMBAYARAN`;
    await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
                  personalizations: [{ to: [{ email: ADMIN_EMAIL }] }],
                  from: { email: "noreply@pungpung-mahjong.netlify.app", name: "Pung Pung Mahjong" },
                  subject, content: [{ type: "text/plain", value: body }],
          }),
    });
}

export default async (req: Request) => {
    await ensureLocationColumns(db);
    const url = new URL(req.url);

    if (req.method === "GET") {
          const date = url.searchParams.get("date");
          const code = url.searchParams.get("code");
          const location = url.searchParams.get("location");

      if (code) {
              const rows = await db.select().from(bookings).where(eq(bookings.bookingCode, code.toUpperCase()));
              if (!rows.length) return Response.json({ error: "Kode booking tidak ditemukan" }, { status: 404 });
              return Response.json(rows[0]);
      }

      if (!date) return Response.json({ error: "date param required" }, { status: 400 });
          const whereClause = location ? and(eq(bookings.date, date), eq(bookings.location, location)) : eq(bookings.date, date);
          const rows = await db.select().from(bookings).where(whereClause);
          const active = rows.filter(r => r.status !== "cancelled");
          return Response.json(active);
    }

    if (req.method === "POST") {
          const body = await req.json();
          const { customerName, customerContact, date, time, tableId, tableName, floor, duration, notes, status, checkinAt, location } = body;
          if (!customerName || !date || !time || !tableId) {
                  return Response.json({ error: "Missing required fields" }, { status: 400 });
          }
          const loc = location === "denpasar" ? "denpasar" : "surabaya";

      // Double booking check — berlaku untuk SEMUA cara booking dibuat
      // (online/pending, input manual admin, maupun walk-in), supaya meja
      // yang sama di jam yang sama di LOKASI yang sama tidak bisa di-double-book.
      {
              const existing = await db.select().from(bookings).where(and(eq(bookings.date, date), eq(bookings.location, loc)));
              const startHour = parseInt(time);
              const newEnd = startHour + (duration || 2);
              const conflict = existing.find(b => {
                        if (b.tableId !== tableId) return false;
                        if (b.status === "cancelled") return false;
                        const bStart = parseInt(b.time);
                        const bEnd = bStart + (b.duration || 1);
                        return startHour < bEnd && newEnd > bStart;
              });
              if (conflict) {
                        return Response.json({
                                    error: "Meja sudah dipesan pada jam tersebut",
                                    conflictTime: conflict.time
                        }, { status: 409 });
              }
      }

      const bookingCode = generateCode();
          const insertData: any = {
                  bookingCode, customerName,
                  customerContact: customerContact || "",
                  date, time, tableId, tableName, floor,
                  duration: duration || 2,
                  notes: notes || "",
                  status: status || "pending",
                  location: loc,
          };
          if (checkinAt) insertData.checkinAt = new Date(checkinAt);

      const [row] = await db.insert(bookings).values(insertData).returning();
          if (status !== "checked_in") sendEmailNotification(row).catch(() => {});
          return Response.json(row, { status: 201 });
    }

    if (req.method === "DELETE") {
          const id = parseInt(url.searchParams.get("id") || "");
          if (!id) return Response.json({ error: "id required" }, { status: 400 });
          await db.delete(bookings).where(eq(bookings.id, id));
          return Response.json({ ok: true });
    }

    if (req.method === "PATCH") {
          const id = parseInt(url.searchParams.get("id") || "");
          if (!id) return Response.json({ error: "id required" }, { status: 400 });
          const body = await req.json();

        // Super Admin correction / void — the ONLY path allowed to touch a booking
        // that has already been checked out (status === "completed"). Everything
        // below this block is unreachable for these two request shapes.
        if (body.adminCorrection === true || body.voidCorrection === true) {
            if (!isSuperAdminReq(req)) {
                return Response.json({ error: "Hanya Super Admin yang bisa mengoreksi data checkout" }, { status: 403 });
            }
            if (body.voidCorrection === true) {
                const [voided] = await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, id)).returning();
                if (!voided) return Response.json({ error: "Booking not found" }, { status: 404 });
                return Response.json(voided);
            }
            const correctionData: any = {};
            if (body.tableId) correctionData.tableId = body.tableId;
            if (body.tableName) correctionData.tableName = body.tableName;
            if (body.floor) correctionData.floor = body.floor;
            if (body.notes !== undefined) correctionData.notes = body.notes;
            if (body.paymentMethod !== undefined) correctionData.paymentMethod = body.paymentMethod;
            if (body.checkinAt) correctionData.checkinAt = new Date(body.checkinAt);
            if (body.checkoutAt) correctionData.checkoutAt = new Date(body.checkoutAt);
            if (typeof body.totalPaid === "number") correctionData.totalPaid = Math.max(0, Math.round(body.totalPaid));
            if (typeof body.actualDuration === "number") correctionData.actualDuration = Math.max(0, Math.round(body.actualDuration));
            const [corrected] = await db.update(bookings).set(correctionData).where(eq(bookings.id, id)).returning();
            if (!corrected) return Response.json({ error: "Booking not found" }, { status: 404 });
            return Response.json(corrected);
        }

      const isCheckoutAttempt = body.status === "completed" || body.checkoutAt || body.totalPaid !== undefined;
          const isReschedule = body.date || body.time || body.tableId;

      let existing: any = null;
          if (isCheckoutAttempt || isReschedule) {
                  [existing] = await db.select().from(bookings).where(eq(bookings.id, id));
          }

      // Cegah checkout ganda (lihat catatan sebelumnya).
      if (isCheckoutAttempt) {
              if (existing && existing.status === "completed") {
                        return Response.json({
                                    error: "Booking ini sudah checkout sebelumnya dan tidak bisa diproses ulang. Hubungi admin jika perlu koreksi."
                        }, { status: 409 });
              }
      }

      // Cegah bentrok jadwal saat MENGEDIT booking (bukan cuma saat bikin baru).
      if (isReschedule && existing) {
              const newDate = body.date || existing.date;
              const newTime = body.time || existing.time;
              const newTableId = body.tableId || existing.tableId;
              const newDuration = body.duration || existing.duration;
              const sameSlot = await db.select().from(bookings).where(and(eq(bookings.date, newDate), eq(bookings.location, existing.location)));
              const startHour = parseInt(newTime);
              const newEnd = startHour + newDuration;
              const conflict = sameSlot.find(b => {
                        if (b.id === id) return false; // jangan bentrok sama diri sendiri
                                                     if (b.tableId !== newTableId) return false;
                        if (b.status === "cancelled") return false;
                        const bStart = parseInt(b.time);
                        const bEnd = bStart + (b.duration || 1);
                        return startHour < bEnd && newEnd > bStart;
              });
              if (conflict) {
                        return Response.json({
                                    error: "Meja sudah dipesan pada jam tersebut",
                                    conflictTime: conflict.time
                        }, { status: 409 });
              }
      }

      const updateData: any = {};
          if (body.status) updateData.status = body.status;
          if (body.date) updateData.date = body.date;
          if (body.time) updateData.time = body.time;
          if (body.tableId) updateData.tableId = body.tableId;
          if (body.tableName) updateData.tableName = body.tableName;
          if (body.floor) updateData.floor = body.floor;
          if (body.duration) updateData.duration = body.duration;
          if (body.notes !== undefined) updateData.notes = body.notes;
          if (body.checkinAt) updateData.checkinAt = new Date(body.checkinAt);
          if (body.paymentMethod) updateData.paymentMethod = body.paymentMethod;

      // Total & durasi aktual saat checkout DIHITUNG ULANG DI SERVER, bukan
      // dipercaya mentah dari klien — supaya totalPaid tidak bisa dimanipulasi
      // lewat request yang diedit/di-tamper (mis. dari console browser).
      if (body.status === "completed" || body.checkoutAt) {
              const checkoutAt = body.checkoutAt ? new Date(body.checkoutAt) : new Date();
              const checkinAt = existing?.checkinAt ? new Date(existing.checkinAt) : checkoutAt;
              const diffMins = Math.max(0, Math.round((checkoutAt.getTime() - checkinAt.getTime()) / 60000));
              const billableHours = Math.max(1, Math.ceil((diffMins - 10) / 60));
              updateData.checkoutAt = checkoutAt;
              updateData.actualDuration = diffMins; // durasi ASLI, bukan yang sudah dibulatkan
            updateData.totalPaid = billableHours * 50000;
      }

      const [row] = await db.update(bookings).set(updateData).where(eq(bookings.id, id)).returning();
          return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/bookings" };
