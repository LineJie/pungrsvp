import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { eq, and, lt, sql, notLike } from "drizzle-orm";

// Scheduled function: auto-cancel pending bookings older than 2 hours
// Netlify akan jalankan ini setiap 30 menit otomatis
// KECUALI booking yang notes-nya mengandung tag [SKIP_AUTO_CANCEL]
// (di-set admin lewat tombol "🔒 Kecualikan dari Auto-cancel" di admin.html)
export default async (req: Request) => {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  try {
    // Cancel semua booking pending yang dibuat lebih dari 2 jam lalu,
    // KECUALI yang ditandai admin untuk dikecualikan
    const cancelled = await db
      .update(bookings)
      .set({ 
        status: "cancelled",
        notes: sql`CASE WHEN notes = '' OR notes IS NULL THEN 'Auto-cancelled: tidak ada pembayaran dalam 2 jam' ELSE notes || ' | Auto-cancelled: tidak ada pembayaran dalam 2 jam' END`
      })
      .where(
        and(
          eq(bookings.status, "pending"),
          lt(bookings.createdAt, twoHoursAgo),
          notLike(bookings.notes, '%[SKIP_AUTO_CANCEL]%')
        )
      )
      .returning({ id: bookings.id, customerName: bookings.customerName });

    console.log(`Auto-cancelled ${cancelled.length} pending bookings`);
    return Response.json({ 
      ok: true, 
      cancelled: cancelled.length,
      items: cancelled.map(b => `#${b.id} ${b.customerName}`)
    });
  } catch (e) {
    console.error("Auto-cancel error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
};

// CATATAN: "schedule" dan "path" tidak bisa dipakai bersamaan di Config.
// Function scheduled ini berjalan otomatis lewat cron, tidak perlu path HTTP manual.
export const config: Config = {
  schedule: "0 */2 * * *", // Setiap 2 jam (sebelumnya 30 menit — hemat ~75% DB compute)
};
