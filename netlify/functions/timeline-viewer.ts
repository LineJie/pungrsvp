import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { staff, bookings, communitySessions, venueTables, operatingHours } from "../../db/schema.js";
import { eq, and, asc } from "drizzle-orm";
import {
    verifyPassword, ensureStaffTable, ensureLocationColumns, ensureCommunityTables,
    ensureVenueTablesTable, ensureOperatingHoursTable,
} from "../../db/authUtils.js";
import { isValidBranch } from "../../db/branches.js";

// Endpoint KHUSUS akun role "viewer" (mis. pemilik tempat Tunu): hanya bisa
// melihat blok terisi/kosong per meja untuk SATU cabang miliknya.
//
// Kenapa endpoint terpisah, bukan pakai /api/bookings: GET /api/bookings
// publik dan mengembalikan nama + kontak pelanggan. Di sini server sendiri
// yang memangkas datanya — yang keluar HANYA meja, jam mulai, durasi, dan
// jenis blok. Tidak ada nama, kontak, catatan, harga, status bayar, kode
// booking, ataupun metode pembayaran. Cabang diambil dari akun, BUKAN dari
// parameter request, jadi tidak bisa diganti ke cabang lain.
//
// Read-only: selain GET ditolak.

const BRANCH_NAMES: Record<string, string> = {
    surabaya: "Surabaya",
    denpasar: "The Magendra, Denpasar",
    tunu: "Tunu, Denpasar",
};

export default async (req: Request) => {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    if (!u || !p) return Response.json({ error: "Login diperlukan" }, { status: 401 });

    await ensureStaffTable(db);
    await ensureLocationColumns(db);

    const rows = await db.select().from(staff).where(eq(staff.username, u));
    if (!rows.length || !verifyPassword(p, rows[0].passwordHash)) {
        return Response.json({ error: "Username atau password salah" }, { status: 401 });
    }
    const account = rows[0];
    if (account.role !== "viewer") {
        return Response.json({ error: "Halaman ini hanya untuk akun viewer" }, { status: 403 });
    }
    const location = account.location;
    if (!isValidBranch(location)) {
        return Response.json({ error: "Akun belum terhubung ke cabang" }, { status: 403 });
    }

    const date = new URL(req.url).searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json({ error: "Parameter date (YYYY-MM-DD) wajib" }, { status: 400 });
    }

    await ensureCommunityTables(db);
    await ensureVenueTablesTable(db);
    await ensureOperatingHoursTable(db);

    const tableRows = (await db.select().from(venueTables)
        .where(and(eq(venueTables.location, location), eq(venueTables.active, true)))
        .orderBy(asc(venueTables.sortOrder), asc(venueTables.id)))
        .map(t => ({ key: t.tableKey, name: t.name, floor: t.floor, emoji: t.emoji || "🀄", type: t.type }));

    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const [hours] = await db.select().from(operatingHours)
        .where(and(eq(operatingHours.location, location), eq(operatingHours.dayOfWeek, dow)));

    const bookingRows = await db.select().from(bookings)
        .where(and(eq(bookings.date, date), eq(bookings.location, location)));
    const sessionRows = await db.select().from(communitySessions)
        .where(and(eq(communitySessions.date, date), eq(communitySessions.location, location)));

    // Hanya field jadwal yang dipetakan keluar — sengaja whitelist, bukan
    // menyaring field sensitif, supaya kolom baru di masa depan tidak ikut bocor.
    const blocks = [
        ...bookingRows
            .filter(b => b.status !== "cancelled")
            .map(b => ({ tableKey: b.tableId, time: b.time, duration: b.duration || 1, kind: "booking" as const })),
        ...sessionRows
            .filter(s => s.status !== "cancelled")
            .map(s => ({ tableKey: s.tableId, time: s.time, duration: s.duration, kind: "event" as const })),
    ];

    return Response.json({
        location,
        locationName: BRANCH_NAMES[location] || location,
        date,
        openHour: hours ? hours.openHour : 10,
        closeHour: hours ? hours.closeHour : 22,
        tables: tableRows,
        blocks,
    }, { headers: { "Cache-Control": "no-store" } });
};

export const config: Config = { path: "/api/timeline-viewer" };
