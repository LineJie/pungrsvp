import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { staff } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { verifyPassword, ensureStaffTable } from "../../db/authUtils.js";

const SUPERADMIN_USERNAME = "tere";

export default async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    await ensureStaffTable(db);

    const { username, password } = await req.json();
    if (!username || !password) {
          return Response.json({ error: "Username & password wajib diisi" }, { status: 400 });
    }

    const superadminPw = process.env.SUPERADMIN_PASSWORD;
    if (username === SUPERADMIN_USERNAME && superadminPw && password === superadminPw) {
          return Response.json({ role: "superadmin", name: "Super Admin" });
    }

    const rows = await db.select().from(staff).where(eq(staff.username, username));
    if (!rows.length || !verifyPassword(password, rows[0].passwordHash)) {
          return Response.json({ error: "Username atau password salah" }, { status: 401 });
    }

    return Response.json({ role: rows[0].role, name: rows[0].name });
};

export const config: Config = { path: "/api/auth" };
