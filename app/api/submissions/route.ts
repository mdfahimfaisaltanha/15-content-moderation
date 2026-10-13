import { moderate } from "@/lib/pipeline"
import { getPool } from "@/lib/db"

export const dynamic = "force-dynamic"

/**
 * POST — submit content for moderation. Public in this demo (this endpoint IS
 * the product); in production your normal user auth sits in front of it.
 *
 * Body: { author, content }
 * Returns the full pipeline trace — which stage decided, every rule flag,
 * classifier scores, timing, and the routing decision.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: "Invalid JSON body." }, { status: 400 })

  const author = String(body.author ?? "").trim().slice(0, 80) || "anonymous"
  const content = String(body.content ?? "").trim()
  if (!content) return Response.json({ error: "content is required." }, { status: 400 })
  if (content.length > 5000) {
    return Response.json({ error: "content is limited to 5000 characters." }, { status: 400 })
  }

  const trace = await moderate(author, content)
  return Response.json({ trace }, { status: 201 })
}

/**
 * GET ?id=123 — public decision status for a single submission (what the
 * author of the content would see: status only, not the internal signals).
 */
export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"))
  if (!Number.isInteger(id)) {
    return Response.json({ error: "id query param is required." }, { status: 400 })
  }
  const res = await getPool().query(
    `SELECT id, status, created_at AS "createdAt" FROM submissions WHERE id = $1`,
    [id],
  )
  if (res.rows.length === 0) return Response.json({ error: "Not found." }, { status: 404 })
  return Response.json({ submission: res.rows[0] })
}
