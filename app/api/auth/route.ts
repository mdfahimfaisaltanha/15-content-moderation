import { getPool } from "@/lib/db"
import { createSession, destroySession, getSession, verifyPassword } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json({ user: await getSession() })
}

/** Moderator login only — moderators are provisioned by the seed, not self-service. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email ?? "").trim().toLowerCase()
  const password = String(body?.password ?? "")
  if (!email || !password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 })
  }
  const res = await getPool().query(`SELECT id, password_hash FROM users WHERE email = $1`, [email])
  // Identical error for unknown email and wrong password — no account enumeration.
  if (res.rows.length === 0 || !verifyPassword(password, res.rows[0].password_hash)) {
    return Response.json({ error: "Invalid email or password." }, { status: 401 })
  }
  await createSession(res.rows[0].id)
  return Response.json({ user: await getSession() })
}

export async function DELETE() {
  await destroySession()
  return Response.json({ ok: true })
}
