import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { staff } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { hashPassword, ensureStaffTable, ensureLocationColumns } from "../../db/authUtils.js";

const SUPERADMIN_USERNAME = "tere";

function isSuperAdmin(req: Request): boolean {
      const u = req.headers.get("x-auth-username");
      const p = req.headers.get("x-auth-password");
      const superadminPw = process.env.SUPERADMIN_PASSWORD;
      return !!superadminPw && u === SUPERADMIN_USERNAME && p === superadminPw;
}

export default async (req: Request) => {
      await ensureStaffTable(db);
      await ensureLocationColumns(db);

      if (!isSuperAdmin(req)) {
              return Response.json({ error: "Hanya Super Admin yang bisa mengakses ini" }, { status: 403 });
      }

      if (req.method === "GET") {
              const rows = await db.select({
                        id: staff.id, name: staff.name, username: staff.username,
                        role: staff.role, location: staff.location, createdAt: staff.createdAt,
              }).from(staff);
              return Response.json(rows);
      }

      if (req.method === "POST") {
              const body = await req.json();
              const { name, username, password, role, location } = body;
              if (!name || !username || !password || !role) {
                        return Response.json({ error: "Semua field wajib diisi" }, { status: 400 });
              }
              const loc = location === "denpasar" ? "denpasar" : "surabaya";
              const existing = await db.select().from(staff).where(eq(staff.username, username));
              if (existing.length) {
                        return Response.json({ error: "Username sudah dipakai" }, { status: 409 });
              }
              const passwordHash = hashPassword(password);
              const [row] = await db.insert(staff).values({ name, username, passwordHash, role, location: loc }).returning();
              return Response.json({ id: row.id, name: row.name, username: row.username, role: row.role, location: row.location }, { status: 201 });
      }

      if (req.method === "PATCH") {
              const url = new URL(req.url);
              const id = parseInt(url.searchParams.get("id") || "");
              if (!id) return Response.json({ error: "id required" }, { status: 400 });
              const body = await req.json();
              const updateData: any = {};
              if (body.name) updateData.name = body.name;
              if (body.role === "admin" || body.role === "kasir") updateData.role = body.role;
              if (body.location === "denpasar" || body.location === "surabaya") updateData.location = body.location;
              if (body.password) updateData.passwordHash = hashPassword(body.password);
              if (!Object.keys(updateData).length) {
                        return Response.json({ error: "Tidak ada field yang diupdate" }, { status: 400 });
              }
              const [row] = await db.update(staff).set(updateData).where(eq(staff.id, id)).returning();
              if (!row) return Response.json({ error: "Staff not found" }, { status: 404 });
              return Response.json({ id: row.id, name: row.name, username: row.username, role: row.role, location: row.location });
      }

      if (req.method === "DELETE") {
              const url = new URL(req.url);
              const id = parseInt(url.searchParams.get("id") || "");
              if (!id) return Response.json({ error: "id required" }, { status: 400 });
              await db.delete(staff).where(eq(staff.id, id));
              return Response.json({ ok: true });
      }

      return new Response("Method not allowed", { status: 405 });
};

export const config: Config = { path: "/api/staff" };
