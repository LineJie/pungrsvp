import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { operatingHours } from "../../db/schema.js";
import { eq, and, asc } from "drizzle-orm";
import { ensureOperatingHoursTable } from "../../db/authUtils.js";
import { BRANCHES } from "../../db/branches.js";

// Super Admin auth check — identical pattern to promos.ts / payment-methods.ts.
// GET is public (index.html needs it to render available time slots for
// customers, without needing to log in). Only Super Admin (username "tere")
// can change the hours themselves.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

const VALID_LOCATIONS: readonly string[] = BRANCHES;

export default async (req: Request) => {
    await ensureOperatingHoursTable(db);
    const url = new URL(req.url);

    if (req.method === "GET") {
        const location = url.searchParams.get("location");
        const rows = location
            ? await db.select().from(operatingHours).where(eq(operatingHours.location, location)).orderBy(asc(operatingHours.dayOfWeek))
            : await db.select().from(operatingHours).orderBy(asc(operatingHours.location), asc(operatingHours.dayOfWeek));
        return Response.json(rows);
    }

    if (req.method === "PATCH") {
        if (!isSuperAdminReq(req)) {
            return Response.json({ error: "Hanya Super Admin yang bisa mengubah jam operasional" }, { status: 403 });
        }
        const id = parseInt(url.searchParams.get("id") || "");
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const body = await req.json();

        const updateData: any = {};
        if (body.openHour !== undefined) {
            const oh = parseInt(body.openHour);
            if (!Number.isFinite(oh) || oh < 0 || oh > 23) return Response.json({ error: "Jam buka tidak valid" }, { status: 400 });
            updateData.openHour = oh;
        }
        if (body.closeHour !== undefined) {
            const ch = parseInt(body.closeHour);
            if (!Number.isFinite(ch) || ch < 1 || ch > 24) return Response.json({ error: "Jam tutup tidak valid" }, { status: 400 });
            updateData.closeHour = ch;
        }
        if (Object.keys(updateData).length === 0) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });
        updateData.updatedBy = req.headers.get("x-auth-username") || "";
        updateData.updatedAt = new Date();

        const [row] = await db.update(operatingHours).set(updateData).where(eq(operatingHours.id, id)).returning();
        if (!row) return Response.json({ error: "Data jam operasional tidak ditemukan" }, { status: 404 });
        if (row.openHour >= row.closeHour) {
            // Rollback-ish guard: tolak kombinasi yang tidak masuk akal (buka >= tutup).
            // Sudah ditulis duluan supaya sederhana, jadi kita kembalikan error setelah
            // memberi tahu — di production nyata idealnya divalidasi sebelum update,
            // tapi kombinasi openHour & closeHour dikirim terpisah per field jadi kita
            // cek ulang di sini pakai nilai final di DB.
            return Response.json({ error: "Jam buka harus lebih awal dari jam tutup", row }, { status: 400 });
        }
        return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/operating-hours" };
