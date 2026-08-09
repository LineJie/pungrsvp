import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { bookings } from "../../db/schema.js";
import { eq, and, lt, sql } from "drizzle-orm";

// Scheduled function: auto-checkout sesi yang kasir lupa checkout
// dan sudah lewat hari (checkinAt bukan hari ini lagi).
//
// PENTING: Auto-checkout TIDAK pakai jam "sekarang" sebagai jam pulang,
// karena itu akan bikin durasi salah (misal check-in jam 20:00, function
// jalan jam 02:00 = kelihatan main 6 jam padahal sebenarnya lebih cepat).
//
// Sebagai gantinya: checkout di-set ke jam tutup venue pada HARI CHECK-IN
// (23:00 WIB untuk estimasi wajar), lalu ditandai dengan catatan khusus
// supaya admin tahu ini perlu dicek/dikoreksi manual lewat "Lihat Struk".
export default async (req: Request) => {
  const now = new Date();

  try {
    // Ambil semua booking checked_in yang checkinAt-nya BUKAN hari ini (WIB)
    const activeSessions = await db
      .select()
      .from(bookings)
      .where(eq(bookings.status, "checked_in"));

    const nowWIB = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const todayWIB = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth()+1).padStart(2,'0')}-${String(nowWIB.getDate()).padStart(2,'0')}`;

    let autoCheckedOut = 0;
    const items: string[] = [];

    for (const b of activeSessions) {
      if (!b.checkinAt) continue;

      const checkinDate = new Date(b.checkinAt);
      const checkinWIB = new Date(checkinDate.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
      const checkinDayStr = `${checkinWIB.getFullYear()}-${String(checkinWIB.getMonth()+1).padStart(2,'0')}-${String(checkinWIB.getDate()).padStart(2,'0')}`;

      // Skip kalau masih hari yang sama (belum lewat hari)
      if (checkinDayStr === todayWIB) continue;

      // Sudah lewat hari — auto-checkout di jam 23:00 WIB pada hari check-in
      const estimatedCheckout = new Date(checkinWIB);
      estimatedCheckout.setHours(23, 0, 0, 0);

      // Kalau check-in sendiri sudah lewat jam 23:00, checkout = 1 jam setelah checkin (minimum)
      if (estimatedCheckout <= checkinWIB) {
        estimatedCheckout.setTime(checkinWIB.getTime() + 60 * 60 * 1000);
      }

      const diffMins = Math.round((estimatedCheckout.getTime() - checkinWIB.getTime()) / 60000);
      const billableHours = Math.max(1, Math.ceil((diffMins - 10) / 60));
      const totalRp = billableHours * 50000;

      const existingNotes = b.notes || "";
      const newNotes = existingNotes
        ? existingNotes + " [AUTO-CHECKOUT: lupa checkout, estimasi jam tutup — cek ulang di struk]"
        : "[AUTO-CHECKOUT: lupa checkout, estimasi jam tutup — cek ulang di struk]";

      await db
        .update(bookings)
        .set({
          status: "completed",
          checkoutAt: estimatedCheckout,
          actualDuration: diffMins, // durasi ASLI, bukan yang sudah dibulatkan
          totalPaid: totalRp,
          paymentMethod: b.paymentMethod || "belum diisi",
          notes: newNotes,
        })
        .where(eq(bookings.id, b.id));

      autoCheckedOut++;
      items.push(`#${b.id} ${b.customerName} (${b.tableName})`);
    }

    console.log(`Auto-checkout ${autoCheckedOut} sesi yang lupa checkout`);
    return Response.json({
      ok: true,
      autoCheckedOut,
      items,
    });
  } catch (e) {
    console.error("Auto-checkout error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
};

export const config: Config = {
  schedule: "0 1 * * *", // Setiap hari jam 01:00 (cek sesi yang lupa checkout dari hari sebelumnya)
};
