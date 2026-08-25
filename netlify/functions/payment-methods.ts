import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { paymentMethods } from "../../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { ensurePaymentMethodsTable } from "../../db/authUtils.js";

// Super Admin auth check — identical pattern to promos.ts / bookings.ts.
// Only Super Admin (username "tere") can create or edit payment methods.
// Staff can still READ the list (GET) so the POS checkout buttons can show
// active methods for their branch — read access is not gated because it's
// not sensitive and staff need it to do the checkout.
const SUPERADMIN_USERNAME = "tere";
function isSuperAdminReq(req: Request): boolean {
    const u = req.headers.get("x-auth-username");
    const p = req.headers.get("x-auth-password");
    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

// `key` dibuat SERVER dari label (slug), bukan dikirim klien — supaya selalu
// konsisten dan unik, sama seperti totalPaid/promo yang dihitung server di
// bookings.ts. Kalau slug sudah dipakai, ditambah angka di belakang.
function slugify(label: string): string {
    return label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "metode";
}

export default async (req: Request) => {
    await ensurePaymentMethodsTable(db);
    const url = new URL(req.url);

    if (req.method === "GET") {
        const rows = await db.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.id));
        return Response.json(rows);
    }

    if (req.method === "POST") {
        if (!isSuperAdminReq(req)) {
            return Response.json({ error: "Hanya Super Admin yang bisa menambah metode pembayaran" }, { status: 403 });
        }
        const body = await req.json();
        const { label, emoji } = body;

        if (!label || !String(label).trim()) return Response.json({ error: "Nama metode pembayaran wajib diisi" }, { status: 400 });

        const baseKey = slugify(String(label));
        const existing = await db.select().from(paymentMethods);
        let key = baseKey;
        let suffix = 2;
        while (existing.some(m => m.key === key)) {
            key = `${baseKey}-${suffix}`;
            suffix++;
        }

        const maxSort = existing.reduce((max, m) => Math.max(max, m.sortOrder || 0), 0);

        const [row] = await db.insert(paymentMethods).values({
            key,
            label: String(label).trim(),
            emoji: emoji && String(emoji).trim() ? String(emoji).trim() : "💳",
            active: true,
            sortOrder: maxSort + 1,
            createdBy: req.headers.get("x-auth-username") || "",
        }).returning();
        return Response.json(row, { status: 201 });
    }

    if (req.method === "PATCH") {
        if (!isSuperAdminReq(req)) {
            return Response.json({ error: "Hanya Super Admin yang bisa mengubah metode pembayaran" }, { status: 403 });
        }
        const id = parseInt(url.searchParams.get("id") || "");
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const body = await req.json();

        const updateData: any = {};
        if (typeof body.active === "boolean") updateData.active = body.active;
        if (body.label !== undefined) {
            if (!String(body.label).trim()) return Response.json({ error: "Nama metode pembayaran wajib diisi" }, { status: 400 });
            updateData.label = String(body.label).trim();
        }
        if (body.emoji !== undefined) updateData.emoji = String(body.emoji).trim() || "💳";
        if (typeof body.sortOrder === "number") updateData.sortOrder = body.sortOrder;

        if (Object.keys(updateData).length === 0) return Response.json({ error: "Tidak ada perubahan" }, { status: 400 });

        const [row] = await db.update(paymentMethods).set(updateData).where(eq(paymentMethods.id, id)).returning();
        if (!row) return Response.json({ error: "Metode pembayaran not found" }, { status: 404 });
        return Response.json(row);
    }

    return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/payment-methods" };
