import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { audit } from "@/lib/pipeline"

export const dynamic = "force-dynamic"

/**
 * GET — the moderation workspace.
 *   ?view=queue    (default) pending_review items, oldest first (FIFO — fairness)
 *   ?view=recent   last 50 decided items (spot-check the automation)
 *   ?view=audit    last 100 audit-log entries
 */
export async function GET(req: Request) {
  const user = await requireRole("moderator", "admin")
  if (user instanceof Response) return user
  const view = new URL(req.url).searchParams.get("view") ?? "queue"
  const pool = getPool()

  if (view === "audit") {
    const rows = await pool.query(
      `SELECT a.id, a.submission_id AS "submissionId", a.actor, a.detail, a.created_at AS "createdAt"
       FROM audit_log a ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    )
    return Response.json({ entries: rows.rows })
  }

  const where = view === "recent" ? `s.status IN ('approved', 'rejected')` : `s.status = 'pending_review'`
  const order = view === "recent" ? `s.decided_at DESC NULLS LAST, s.id DESC` : `s.created_at ASC, s.id ASC`
  const rows = await pool.query(
    `SELECT s.id, s.author, s.content, s.status, s.decided_by AS "decidedBy",
            s.rule_score AS "ruleScore", s.rule_flags AS "ruleFlags",
            s.llm_categories AS "llmCategories", s.llm_score AS "llmScore",
            s.final_score AS "finalScore", s.processing_ms AS "processingMs",
            s.created_at AS "createdAt", s.decided_at AS "decidedAt",
            s.review_note AS "reviewNote", u.name AS "reviewedByName"
     FROM submissions s LEFT JOIN users u ON u.id = s.reviewed_by
     WHERE ${where} ORDER BY ${order} LIMIT 50`,
  )
  return Response.json({ submissions: rows.rows })
}

/**
 * PATCH — human decision on a pending item.
 * Body: { id, action: "approve" | "reject", note? }
 * Guarded by `WHERE status = 'pending_review'` — two moderators racing the
 * same item: second one gets a 409, not a silent overwrite.
 */
export async function PATCH(req: Request) {
  const user = await requireRole("moderator", "admin")
  if (user instanceof Response) return user
  const body = await req.json().catch(() => null)
  const id = Number(body?.id)
  const action = String(body?.action ?? "")
  const note = String(body?.note ?? "").trim().slice(0, 500) || null
  if (!Number.isInteger(id) || !/^(approve|reject)$/.test(action)) {
    return Response.json({ error: "id and action (approve | reject) are required." }, { status: 400 })
  }
  const status = action === "approve" ? "approved" : "rejected"
  const res = await getPool().query(
    `UPDATE submissions
     SET status = $1, decided_by = 'human', decided_at = now(), reviewed_by = $2, review_note = $3
     WHERE id = $4 AND status = 'pending_review'
     RETURNING id`,
    [status, user.id, note, id],
  )
  if (res.rows.length === 0) {
    return Response.json(
      { error: "Submission not found or already decided (another moderator may have gotten there first)." },
      { status: 409 },
    )
  }
  await audit(id, user.name, `human review → ${status}${note ? ` · note: ${note}` : ""}`)
  return Response.json({ ok: true })
}
