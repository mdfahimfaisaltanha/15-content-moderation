import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { thresholds } from "@/lib/pipeline"
import { activeClassifier } from "@/lib/classify"

export const dynamic = "force-dynamic"

/**
 * GET — the numbers that justify the two-stage design:
 * - routing distribution (approved / rejected / pending)
 * - decided-by breakdown — how much work rules did for free
 * - stage-2 call savings: % of submissions that never touched the classifier
 * - latency: avg + p95 processing time, split by path
 * - top rule flags and classifier categories
 */
export async function GET() {
  const user = await requireRole("moderator", "admin")
  if (user instanceof Response) return user
  const pool = getPool()

  const totals = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE status = 'pending_review')::int AS pending,
      COUNT(*) FILTER (WHERE decided_by = 'rules')::int AS by_rules,
      COUNT(*) FILTER (WHERE decided_by = 'classifier')::int AS by_classifier,
      COUNT(*) FILTER (WHERE decided_by = 'human')::int AS by_human,
      COUNT(*) FILTER (WHERE decided_by = 'dedupe')::int AS by_dedupe,
      COUNT(*) FILTER (WHERE llm_score IS NULL)::int AS no_stage2,
      ROUND(AVG(processing_ms))::int AS avg_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_ms) AS p95_ms,
      ROUND(AVG(processing_ms) FILTER (WHERE llm_score IS NULL))::int AS avg_ms_rules_only,
      ROUND(AVG(processing_ms) FILTER (WHERE llm_score IS NOT NULL))::int AS avg_ms_with_stage2
    FROM submissions
  `)

  const flags = await pool.query(`
    SELECT f->>'rule' AS rule, COUNT(*)::int AS item_count
    FROM submissions s, jsonb_array_elements(s.rule_flags) f
    GROUP BY f->>'rule' ORDER BY item_count DESC LIMIT 10
  `)

  const categories = await pool.query(`
    SELECT c.key AS category, COUNT(*)::int AS item_count,
           ROUND(AVG((c.value)::numeric))::int AS avg_score
    FROM submissions s, jsonb_each_text(s.llm_categories) c
    WHERE (c.value)::numeric >= 20
    GROUP BY c.key ORDER BY item_count DESC
  `)

  const t = totals.rows[0]
  return Response.json({
    totals: {
      total: t.total,
      approved: t.approved,
      rejected: t.rejected,
      pending: t.pending,
    },
    decidedBy: {
      rules: t.by_rules,
      classifier: t.by_classifier,
      human: t.by_human,
      dedupe: t.by_dedupe,
    },
    stage2: {
      skipped: t.no_stage2,
      skippedPct: t.total > 0 ? Math.round((t.no_stage2 / t.total) * 1000) / 10 : null,
      classifier: activeClassifier(),
    },
    latency: {
      avgMs: t.avg_ms,
      p95Ms: t.p95_ms !== null ? Math.round(Number(t.p95_ms)) : null,
      avgMsRulesOnly: t.avg_ms_rules_only,
      avgMsWithStage2: t.avg_ms_with_stage2,
    },
    topFlags: flags.rows,
    categories: categories.rows,
    thresholds: thresholds(),
  })
}
