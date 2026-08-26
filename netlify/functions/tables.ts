import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { venueTables } from "../../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { ensureVenueTablesTable } from "../../db/authUtils.js";

// Super Admin auth check — identical pattern ke payment-methods.ts / promos.ts.
// GET tetap kebuka buat semua (index.html, admin.html, pos.html semua perlu
// baca daftar meja + tarif buat nampilin harga), tapi nambah/ubah/nonaktifkan
// meja cuma Super Admin.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

const DEFAULT_RATE: Record<string, number> = { matic: 50000, manual: 30000 };

// table_key dibuat SERVER dari nama (slug), bukan dikirim klien — konsisten
// sama seperti payment-methods.ts. Kalau slug sudah dipakai, ditambah angka.
function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "meja";
}

export default async (req: Request) => {
    await ensureVenueTablesTable(db);
    const url = new URL(req.url);

    if (req.method === "GET") {
        const location = url.searchParams.get("location");
        const includeInactive = url.searchParams.get("includeInactive") === "1";
        let rows = await db.select().from(venueTables).orderBy(asc(venueTables.sortOrder), asc(venueTables.id));
        if (!includeInactive) rows = rows.filter(r => r.active);
        if (location) rows = rows.filter(r => r.location === location);
        return Response.json(rows);
    }

    if (req.method === "POST") {
        if (!isSuperAdminReq(req)) {
            return Response.json({ error: "Hanya Super Admin yang bisa menambah meja" }, { status: 403 });
        }
        const body = await req.json();
        const name = String(body.name || "").trim();
        const type = body.type === "manual" ? "manual" : "matic";
        const floor = String(body.floor || "").trim();
        const location = body.location === "denpasar" ? "denpasar" : "surabaya";
        if (!name) return Response.json({ error: "Nama meja wajib diisi" }, { status: 400 });
        if (!floor) return Response.json({ error: "Lantai / area wajib diisi" }, { status: 400 });

        const hourlyRate = (typeof body.hourlyRate === "number" && body.hourlyRate >= 0)
            ? Math.round(body.hourlyRate)
            : DEFAULT_RATE[type];

        const baseKey = slugify(name);
        const existing = await db.select().from(venueTables);
        let tableKey = baseKey;
        let suffix = 2;
        while (existing.some(t => t.tableKey === tableKey)) {
            tableKey = `${baseKey}-${suffix}`;
            suffix++;
        }
        const maxSort = existing.reduce((max, t) => Math.max(max, t.sortOrder || 0), 0);

        const [row] = await db.insert(venueTables).values({
            tableKey,
            name,
            type,
            hourlyRate,
            floor,
            location,
            capacity: body.capacity ? String(body.capacity).trim() : "4 orang",
            emoji: body.emoji ? String(body.emoji).trim() : (type === "manual" ? "🍂" : "🀄"),
            notes: body.notes ? String(body.notes).trim() : "",
            active: true,
            sortOrder: maxSort + 1,
            createdBy: req.headers.get("x-auth-username") || "",
        }).returning();
        return Response.json(row, { status: 201 });
    }

    if (req.method === "PATCH") {
        if (!isSuperAdminReq(req)) {
            return Response.json({ error: "Hanya Super Admin yang bisa mengubah meja" }, { status: 403 });
        }
        const id = parseInt(url.searchParams.get("id") || "");
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const body = await req.json();

        const updateData: any = {};
        if (body.name !== undefined) {
            if (!String(body.name).trim()) return Response.json({ error: "Nama meja wajib diisi" }, { status: 400 });
            updateData.name = String(body.name).trim();
        }
        if (body.type === "matic" || body.type === "manual") updateData.type = body.type;
        if (typeof body.hourlyRate === "number" && body.hourlyRate >= 0) updateData.hourlyRate = Math.round(body.hourlyRate);
        if (body.floor !== undefined) updateData.floor = String(body.floor).trim();
        if (body.location === "surabaya" || body.location === "denpasar") updateData.location = body.location;
        if (body.capacity !== undefined) updateData.capacity = String(body.capacity).trim();
        if (body.emoji !== undefined) updateData.emoji = String(body.emoji).trim();
        if (body.notes !== undefined) updateData.notes = String(body.notes).trim();
        if (typeof body.active === "boolean") updateData.active = body.active;
        if (typeof body.sortOrder === "number") updateData.sortOrder = body.sortOrder;

        if (Object.keys(updateData).length === 0) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });

        const [row] = await db.update(venueTables).set(updateData).where(eq(venueTables.id, id)).returning();
        if (!row) return Response.json({ error: "Meja not found" }, { status: 404 });
        return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/tables" };
