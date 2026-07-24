import { createHash } from "node:crypto"
import { getPool } from "./db"
import { runRules } from "./rules"
import { classify } from "./classify"
import type { ClassifyResult, Decision, PipelineTrace } from "./types"

/**
 * The orchestrator: dedupe → Stage 1 rules → (maybe) Stage 2 classifier →
 * route → persist + audit. Every submission gets exactly one decision row and
 * an audit trail explaining it.
 *
 * Routing:
 *   finalScore < AUTO_APPROVE_BELOW (default 25)  → approved
 *   finalScore > AUTO_REJECT_ABOVE  (default 80)  → rejected
 *   otherwise                                     → pending_review (humans)
 *
 * finalScore = max(ruleScore, classifierScore) — the most alarmed signal wins.
 * Averaging would let a clean-looking classifier wash out a card-number hit.
 *
 * FAIL-CLOSED: if Stage 2 errors (API down, malformed output), the submission
 * goes to pending_review — never auto-approved. A moderation pipeline's
 * failure mode must not be "everything is fine".
 *
 * DEDUPE: identical content (SHA-256) that was already decided inherits that
 * decision instantly — the classic copy-paste spam blast costs one pipeline
 * run, not five hundred. Pending items don't propagate (a human hasn't spoken
 * yet), and human decisions DO propagate to future duplicates.
 */

export function thresholds() {
  const lo = Number(process.env.AUTO_APPROVE_BELOW)
  const hi = Number(process.env.AUTO_REJECT_ABOVE)
  return {
    approveBelow: Number.isFinite(lo) ? Math.max(1, Math.min(99, Math.round(lo))) : 25,
    rejectAbove: Number.isFinite(hi) ? Math.max(1, Math.min(99, Math.round(hi))) : 80,
  }
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content.trim().toLowerCase()).digest("hex")
}

export async function moderate(author: string, content: string): Promise<PipelineTrace> {
  const started = Date.now()
  const pool = getPool()
  const th = thresholds()
  const hash = contentHash(content)

  // ---- dedupe fast-path ------------------------------------------------------
  const dup = await pool.query(
    `SELECT id, status, final_score, rule_score, rule_flags, llm_categories, llm_score
     FROM submissions
     WHERE content_hash = $1 AND status IN ('approved', 'rejected')
     ORDER BY decided_at DESC NULLS LAST LIMIT 1`,
    [hash],
  )
  if (dup.rows.length > 0) {
    const prev = dup.rows[0]
    const processingMs = Date.now() - started
    const ins = await pool.query(
      `INSERT INTO submissions (author, content, content_hash, status, decided_by, rule_score, rule_flags, llm_categories, llm_score, final_score, processing_ms, decided_at)
       VALUES ($1, $2, $3, $4, 'dedupe', $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
      [author, content, hash, prev.status, prev.rule_score, prev.rule_flags, prev.llm_categories, prev.llm_score, prev.final_score, processingMs],
    )
    await audit(ins.rows[0].id, "system", `dedupe: identical to submission #${prev.id} → inherited '${prev.status}'`)
    return {
      submissionId: ins.rows[0].id,
      status: prev.status as Decision,
      decidedBy: "dedupe",
      finalScore: prev.final_score ?? 0,
      ruleScore: prev.rule_score ?? 0,
      ruleFlags: prev.rule_flags ?? [],
      classifier: null,
      stage2Skipped: true,
      stage2SkippedReason: `duplicate of #${prev.id}`,
      processingMs,
      thresholds: th,
    }
  }

  // ---- Stage 1: rules ---------------------------------------------------------
  const rules = runRules(content)
  let status: Decision
  let decidedBy: PipelineTrace["decidedBy"]
  let classifier: ClassifyResult | null = null
  let stage2Skipped = true
  let stage2SkippedReason: string | null = null
  let finalScore = rules.score

  if (rules.decisive === "reject") {
    status = "rejected"
    decidedBy = "rules"
    finalScore = 100
    stage2SkippedReason = "stage 1 decisive: severe violation"
  } else if (rules.decisive === "approve") {
    status = "approved"
    decidedBy = "rules"
    stage2SkippedReason = "stage 1 decisive: zero flags"
  } else {
    // ---- Stage 2: classifier (the ambiguous middle only) ----------------------
    stage2Skipped = false
    try {
      classifier = await classify(content)
      finalScore = Math.max(rules.score, classifier.score)
      if (finalScore < th.approveBelow) {
        status = "approved"
        decidedBy = "classifier"
      } else if (finalScore > th.rejectAbove) {
        status = "rejected"
        decidedBy = "classifier"
      } else {
        status = "pending_review"
        decidedBy = "classifier"
      }
    } catch (err) {
      // FAIL-CLOSED: classifier down ≠ content is fine.
      status = "pending_review"
      decidedBy = "classifier"
      stage2SkippedReason = `classifier failed (${err instanceof Error ? err.message : "unknown"}) → fail-closed to human review`
    }
  }

  const processingMs = Date.now() - started
  const decided = status !== "pending_review"
  const ins = await pool.query(
    `INSERT INTO submissions (author, content, content_hash, status, decided_by, rule_score, rule_flags, llm_categories, llm_score, final_score, processing_ms, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${decided ? "now()" : "NULL"}) RETURNING id`,
    [
      author,
      content,
      hash,
      status,
      decided ? decidedBy : null,
      rules.score,
      JSON.stringify(rules.flags),
      classifier ? JSON.stringify(classifier.categories) : null,
      classifier?.score ?? null,
      finalScore,
      processingMs,
    ],
  )
  const id = ins.rows[0].id

  const flagSummary = rules.flags.length > 0 ? rules.flags.map((f) => f.rule).join(", ") : "none"
  await audit(
    id,
    "system",
    `stage1 score ${rules.score} (flags: ${flagSummary})` +
      (stage2Skipped
        ? ` · stage2 skipped (${stage2SkippedReason})`
        : ` · stage2 ${classifier ? `${classifier.model} score ${classifier.score}` : "FAILED → fail-closed"}`) +
      ` · final ${finalScore} → ${status}`,
  )

  return {
    submissionId: id,
    status,
    decidedBy: decided ? decidedBy : "classifier",
    finalScore,
    ruleScore: rules.score,
    ruleFlags: rules.flags,
    classifier,
    stage2Skipped,
    stage2SkippedReason,
    processingMs,
    thresholds: th,
  }
}

export async function audit(submissionId: number, actor: string, detail: string): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (submission_id, actor, detail) VALUES ($1, $2, $3)`,
    [submissionId, actor, detail],
  )
}
