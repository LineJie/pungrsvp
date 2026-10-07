import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { communitySessions, communityParticipants, staff, bookings } from "../../db/schema.js";
import { eq, and } from "drizzle-orm";
import { ensureCommunityTables, ensureLocationColumns, verifyPassword } from "../../db/authUtils.js";
import { normalizeBranch } from "../../db/branches.js";

// Auth: TIDAK superadmin-only — tab "Acara Bareng" kelihatan buat semua staff
// (admin & kasir), jadi siapa pun yang sudah login sah boleh buat sesi /
// tambah peserta / tutup sesi. Superadmin (tere) juga otomatis lolos.
const SUPERADMIN_USERNAME = "tere";
async function isAuthedStaffReq(req: Request): Promise<boolean> {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    if (!u || !p) return false;
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    if (u === SUPERADMIN_USERNAME && superadminPw && p === superadminPw) return true;
    const rows = await db.select().from(staff).where(eq(staff.username, u));
    if (!rows.length) return false;
    return verifyPassword(p, rows[0].passwordHash);
}

// Kode sesi acara: "OP-" + 6 karakter (alfabet sama dengan kode booking biasa
// "PP-XXXXXX", tanpa karakter yang mirip). Awalan OP- membedakannya dari
// booking biasa di mahjong.html (OP = open play). Dicek unik ke DB.
async function generateSessionCode(): Promise<string> {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 8; attempt++) {
        let code = "OP-";
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        const dup = await db.select({ id: communitySessions.id }).from(communitySessions).where(eq(communitySessions.bookingCode, code));
        if (!dup.length) return code;
    }
    throw new Error("Gagal membuat kode acara, coba lagi");
}

// Cek bentrok jadwal terhadap booking MEJA BIASA (tabel bookings) untuk
// tableId/location/date yang sama — supaya sesi Acara Main Bareng tidak bisa
// dibuat di meja yang sudah dipakai booking biasa di jam yang sama, dan
// sebaliknya (dicek balik di bookings.ts).
async function hasRegularBookingConflict(tableId: string, location: string, date: string, startHour: number, endHour: number) {
    const existing = await db.select().from(bookings).where(and(eq(bookings.date, date), eq(bookings.location, location)));
    return existing.some(b => {
        if (b.tableId !== tableId || b.status === "cancelled") return false;
        const bStart = parseInt(b.time);
        const bEnd = bStart + (b.duration || 1);
        return startHour < bEnd && endHour > bStart;
    });
}

// Cek bentrok terhadap sesi Acara Main Bareng LAIN yang masih "open" di meja
// & jam yang sama (mis. staff tidak sengaja bikin sesi dobel di meja yang
// sama).
async function hasCommunitySessionConflict(tableId: string, location: string, date: string, startHour: number, endHour: number, excludeId?: number) {
    const existing = await db.select().from(communitySessions).where(and(eq(communitySessions.date, date), eq(communitySessions.location, location)));
    return existing.some(s => {
        if (s.id === excludeId) return false;
        if (s.tableId !== tableId || s.status !== "open") return false;
        const sStart = parseInt(s.time);
        const sEnd = sStart + s.duration;
        return startHour < sEnd && endHour > sStart;
    });
}

export default async (req: Request) => {
    await ensureCommunityTables(db);
    await ensureLocationColumns(db);
    const url = new URL(req.url);
    const resource = url.searchParams.get("resource"); // null = sessions, "participants" = participants

    // ─── PARTICIPANTS ───────────────────────────────────────────────────
    if (resource === "participants") {
        if (req.method === "GET") {
            const sessionId = parseInt(url.searchParams.get("sessionId") || "");
            if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
            const rows = await db.select().from(communityParticipants).where(eq(communityParticipants.sessionId, sessionId));
            return Response.json(rows);
        }

        if (req.method === "POST") {
            if (!(await isAuthedStaffReq(req))) {
                return Response.json({ error: "Sesi login sudah habis, silakan login ulang" }, { status: 403 });
            }
            const body = await req.json();
            const { sessionId, name, numPeople, contact } = body;
            const sid = parseInt(sessionId);
            if (!sid || !name || !String(name).trim()) {
                return Response.json({ error: "Nama peserta wajib diisi" }, { status: 400 });
            }
            const [session] = await db.select().from(communitySessions).where(eq(communitySessions.id, sid));
            if (!session) return Response.json({ error: "Sesi tidak ditemukan" }, { status: 404 });
            if (session.status !== "open") {
                return Response.json({ error: "Sesi ini sudah ditutup/dibatalkan, tidak bisa tambah peserta" }, { status: 409 });
            }
            const num = Math.max(1, parseInt(numPeople) || 1);
            const [row] = await db.insert(communityParticipants).values({
                sessionId: sid, name: String(name).trim(), numPeople: num, contact: contact || "",
            }).returning();
            return Response.json(row, { status: 201 });
        }

        if (req.method === "PATCH") {
            if (!(await isAuthedStaffReq(req))) {
                return Response.json({ error: "Sesi login sudah habis, silakan login ulang" }, { status: 403 });
            }
            const id = parseInt(url.searchParams.get("id") || "");
            if (!id) return Response.json({ error: "id required" }, { status: 400 });
            const body = await req.json();
            const updateData: any = {};
            if (typeof body.paid === "boolean") updateData.paid = body.paid;
            if (body.name !== undefined) updateData.name = String(body.name).trim();
            if (body.numPeople !== undefined) updateData.numPeople = Math.max(1, parseInt(body.numPeople) || 1);
            if (body.contact !== undefined) updateData.contact = body.contact;
            if (!Object.keys(updateData).length) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });
            const [row] = await db.update(communityParticipants).set(updateData).where(eq(communityParticipants.id, id)).returning();
            if (!row) return Response.json({ error: "Peserta tidak ditemukan" }, { status: 404 });
            return Response.json(row);
        }

        if (req.method === "DELETE") {
            if (!(await isAuthedStaffReq(req))) {
                return Response.json({ error: "Sesi login sudah habis, silakan login ulang" }, { status: 403 });
            }
            const id = parseInt(url.searchParams.get("id") || "");
            if (!id) return Response.json({ error: "id required" }, { status: 400 });
            await db.delete(communityParticipants).where(eq(communityParticipants.id, id));
            return Response.json({ ok: true });
        }

        return new Response("Method not allowed", { status: 405 });
    }

    // ─── SESSIONS ───────────────────────────────────────────────────────
    if (req.method === "GET") {
        // Lookup by kode acara (dipakai mahjong.html, sama seperti /api/bookings?code=).
        const code = url.searchParams.get("code");
        if (code) {
            const rows = await db.select().from(communitySessions).where(eq(communitySessions.bookingCode, code.trim().toUpperCase()));
            if (!rows.length) return Response.json({ error: "Kode acara tidak ditemukan" }, { status: 404 });
            return Response.json(rows[0]);
        }
        const date = url.searchParams.get("date");
        const location = url.searchParams.get("location");
        const conditions = [];
        if (date) conditions.push(eq(communitySessions.date, date));
        if (location) conditions.push(eq(communitySessions.location, location));
        const rows = conditions.length
            ? await db.select().from(communitySessions).where(and(...conditions))
            : await db.select().from(communitySessions);
        return Response.json(rows);
    }

    if (req.method === "POST") {
        if (!(await isAuthedStaffReq(req))) {
            return Response.json({ error: "Sesi login sudah habis, silakan login ulang" }, { status: 403 });
        }
        const body = await req.json();
        const { date, time, duration, tableId, tableName, floor, location, pricePerPerson, notes } = body;
        if (!date || !time || !tableId || !tableName || !floor) {
            return Response.json({ error: "Lengkapi tanggal, jam, dan meja dulu ya" }, { status: 400 });
        }
        const dur = Math.max(1, parseInt(duration) || 2);
        const price = Math.max(0, parseInt(pricePerPerson) || 0);
        const loc = normalizeBranch(location);
        const startHour = parseInt(time);
        if (!Number.isFinite(startHour)) return Response.json({ error: "Jam tidak valid" }, { status: 400 });
        const endHour = startHour + dur;

        // Cegah bentrok DUA ARAH: sama meja & jam sudah dipakai booking
        // biasa, ATAU sudah ada sesi Acara Main Bareng lain yang masih open.
        if (await hasRegularBookingConflict(tableId, loc, date, startHour, endHour)) {
            return Response.json({ error: "Meja sudah dipesan booking biasa pada jam tersebut" }, { status: 409 });
        }
        if (await hasCommunitySessionConflict(tableId, loc, date, startHour, endHour)) {
            return Response.json({ error: "Sudah ada sesi Acara Main Bareng lain di meja & jam itu" }, { status: 409 });
        }

        let bookingCode: string;
        try {
            bookingCode = await generateSessionCode();
        } catch (e: any) {
            return Response.json({ error: e.message || "Gagal membuat kode acara" }, { status: 500 });
        }
        const [row] = await db.insert(communitySessions).values({
            date, time, duration: dur, tableId, tableName, floor, location: loc,
            pricePerPerson: price, notes: notes || "", bookingCode,
            createdBy: req.headers.get("x-auth-username") || "",
        }).returning();
        return Response.json(row, { status: 201 });
    }

    if (req.method === "PATCH") {
        if (!(await isAuthedStaffReq(req))) {
            return Response.json({ error: "Sesi login sudah habis, silakan login ulang" }, { status: 403 });
        }
        const id = parseInt(url.searchParams.get("id") || "");
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const body = await req.json();
        const updateData: any = {};
        if (body.status === "open" || body.status === "completed" || body.status === "cancelled") {
            updateData.status = body.status;
        }
        if (body.notes !== undefined) updateData.notes = body.notes;
        if (!Object.keys(updateData).length) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });
        const [row] = await db.update(communitySessions).set(updateData).where(eq(communitySessions.id, id)).returning();
        if (!row) return Response.json({ error: "Sesi tidak ditemukan" }, { status: 404 });
        return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/community-sessions" };
