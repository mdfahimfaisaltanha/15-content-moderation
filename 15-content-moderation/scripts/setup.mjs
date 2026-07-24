/**
 * Sentinel — schema + seed.
 *
 * Usage: node scripts/setup.mjs   (or: npm run setup)
 *
 * - Creates all tables (idempotent).
 * - Seeds 2 moderators and ~15 submissions covering every pipeline path:
 *   rules-decisive approvals/rejections, classifier decisions, a dedupe pair,
 *   items waiting in the review queue, and one human-decided item — so the
 *   queue, metrics, and audit log are alive on first sign-in.
 * - Skips seeding if users already exist.
 *
 * Seeded rows are inserted with curated signals (they don't re-run the
 * pipeline); everything you submit through the UI or the load test runs the
 * real thing.
 */

import { readFileSync } from "node:fs"
import { createHash, randomBytes, scryptSync } from "node:crypto"
import pg from "pg"

// ---- .env.local loader (no dotenv dependency) ------------------------------
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* .env.local optional if env vars are set another way */
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
  process.exit(1)
}

const SEED_PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!"
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

// ---- mirrors of lib/auth.ts + lib/pipeline.ts (scripts can't import TS) ----
function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

function contentHash(content) {
  return createHash("sha256").update(content.trim().toLowerCase()).digest("hex")
}

// ---- schema ----------------------------------------------------------------
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('moderator', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'pending_review')),
      decided_by TEXT CHECK (decided_by IN ('rules', 'classifier', 'human', 'dedupe')),
      rule_score INTEGER,
      rule_flags JSONB NOT NULL DEFAULT '[]',
      llm_categories JSONB,
      llm_score INTEGER,
      final_score INTEGER,
      processing_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      reviewed_by INTEGER REFERENCES users(id),
      review_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions (content_hash);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

// ---- seed -------------------------------------------------------------------
async function seed() {
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM users`)
  if (existing.rows[0].n > 0) {
    console.log("Users already exist — skipping seed. (Drop tables to reseed.)")
    return
  }

  const pw = hashPassword(SEED_PASSWORD)
  const users = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES
     ('Dana Chowdhury', 'dana@sentinel.test', $1, 'moderator'),
     ('Rafiq Alam', 'lead@sentinel.test', $1, 'admin')
     RETURNING id, email`,
    [pw],
  )
  const dana = users.rows.find((u) => u.email === "dana@sentinel.test").id

  async function sub(row) {
    const {
      author, content, status, decidedBy = null, ruleScore = 0, ruleFlags = [],
      llmCategories = null, llmScore = null, finalScore = null, processingMs = 4,
      hoursAgo = 24, reviewedBy = null, reviewNote = null, auditDetail,
    } = row
    const decided = status !== "pending_review"
    const res = await pool.query(
      `INSERT INTO submissions (author, content, content_hash, status, decided_by, rule_score, rule_flags, llm_categories, llm_score, final_score, processing_ms, created_at, decided_at, reviewed_by, review_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               now() - ($12 || ' hours')::interval,
               ${decided ? "now() - ($12 || ' hours')::interval" : "NULL"},
               $13, $14)
       RETURNING id`,
      [author, content, contentHash(content), status, decidedBy, ruleScore,
       JSON.stringify(ruleFlags), llmCategories ? JSON.stringify(llmCategories) : null,
       llmScore, finalScore, processingMs, String(hoursAgo), reviewedBy, reviewNote],
    )
    const id = res.rows[0].id
    await pool.query(
      `INSERT INTO audit_log (submission_id, actor, detail, created_at) VALUES ($1, 'system', $2, now() - ($3 || ' hours')::interval)`,
      [id, auditDetail, String(hoursAgo)],
    )
    return id
  }

  // --- clean → rules-decisive approvals --------------------------------------
  await sub({
    author: "gardener_amy", hoursAgo: 40,
    content: "Just harvested my first batch of cherry tomatoes this season. The trick was switching to a deeper container. Happy to share my watering schedule if anyone wants it.",
    status: "approved", decidedBy: "rules", ruleScore: 0, finalScore: 0, processingMs: 3,
    auditDetail: "stage1 score 0 (flags: none) · stage2 skipped (stage 1 decisive: zero flags) · final 0 → approved",
  })
  await sub({
    author: "trail_runner", hoursAgo: 38,
    content: "The north loop is muddy after yesterday's rain but totally runnable. Wear shoes with decent grip and you'll be fine.",
    status: "approved", decidedBy: "rules", ruleScore: 0, finalScore: 0, processingMs: 2,
    auditDetail: "stage1 score 0 (flags: none) · stage2 skipped (stage 1 decisive: zero flags) · final 0 → approved",
  })

  // --- severe → rules-decisive rejections -------------------------------------
  await sub({
    author: "burner_acct_99", hoursAgo: 36,
    content: "Nobody would miss you. Kill yourself.",
    status: "rejected", decidedBy: "rules", ruleScore: 100, finalScore: 100, processingMs: 3,
    ruleFlags: [{ rule: "severe_term", severity: "severe", detail: '"kill yourself" — direct self-harm instruction', points: 100 }],
    auditDetail: "stage1 score 100 (flags: severe_term) · stage2 skipped (stage 1 decisive: severe violation) · final 100 → rejected",
  })
  await sub({
    author: "cardz4sale", hoursAgo: 30,
    content: "Fresh fullz available, test card 4539 1488 0343 6467 exp 09/27, DM for the rest.",
    status: "rejected", decidedBy: "rules", ruleScore: 100, finalScore: 100, processingMs: 4,
    ruleFlags: [{ rule: "credit_card", severity: "severe", detail: "Luhn-valid card number ending 6467", points: 100 }],
    auditDetail: "stage1 score 100 (flags: credit_card) · stage2 skipped (stage 1 decisive: severe violation) · final 100 → rejected",
  })
  const scamContent = "CRYPTO GIVEAWAY!!! Double your money GUARANTEED. Act now, limited time offer — send gift cards or wire transfer to claim your prize!!!"
  const scamId = await sub({
    author: "eth_giveaway_official", hoursAgo: 28,
    content: scamContent,
    status: "rejected", decidedBy: "rules", ruleScore: 100, finalScore: 100, processingMs: 3,
    ruleFlags: [
      { rule: "scam_phrase", severity: "high", detail: '"crypto giveaway" — giveaway scam phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"double your money" — investment scam phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"act now" — urgency pressure phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"limited time offer" — urgency pressure phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"send gift cards" — gift-card scam phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"wire transfer" — payment-redirect scam phrase', points: 30 },
      { rule: "scam_phrase", severity: "high", detail: '"claim your prize" — prize scam phrase', points: 30 },
      { rule: "caps_shouting", severity: "low", detail: "38% capital letters", points: 10 },
    ],
    auditDetail: "stage1 score 100 (flags: scam_phrase ×7, caps_shouting) · stage2 skipped (stage 1 decisive: 3+ scam phrases) · final 100 → rejected",
  })

  // --- dedupe: the same scam blasted again ------------------------------------
  await sub({
    author: "eth_giveaway_backup", hoursAgo: 27,
    content: scamContent,
    status: "rejected", decidedBy: "dedupe", ruleScore: 100, finalScore: 100, processingMs: 1,
    ruleFlags: [],
    auditDetail: `dedupe: identical to submission #${scamId} → inherited 'rejected'`,
  })

  // --- classifier decisions ----------------------------------------------------
  await sub({
    author: "kdrama_fan", hoursAgo: 22,
    content: "Check out my ranking of this season's shows on my blog https://myblog.example/rankings — curious what you all think!",
    status: "approved", decidedBy: "classifier", ruleScore: 0, finalScore: 12, llmScore: 12, processingMs: 9,
    ruleFlags: [],
    llmCategories: { spam: 12 },
    auditDetail: "stage1 score 0 (flags: none) → wait, single link with real text · stage2 mock-keyword-v1 score 12 · final 12 → approved",
  })
  await sub({
    author: "promo_bot_31", hoursAgo: 20,
    content: "Buy now! Click here for the best discount code deals, subscribe to my channel for more!!! https://spam.example/a https://spam.example/b https://spam.example/c",
    status: "rejected", decidedBy: "classifier", ruleScore: 40, finalScore: 95, llmScore: 95, processingMs: 11,
    ruleFlags: [
      { rule: "link_flood", severity: "high", detail: "3 links in one post", points: 30 },
      { rule: "caps_shouting", severity: "low", detail: "caps + exclamation density", points: 10 },
    ],
    llmCategories: { spam: 95, scam_or_fraud: 30 },
    auditDetail: "stage1 score 40 (flags: link_flood, caps_shouting) · stage2 mock-keyword-v1 score 95 · final 95 → rejected",
  })

  // --- the review queue (ambiguous middle) --------------------------------------
  await sub({
    author: "frustrated_dev", hoursAgo: 8,
    content: "Honestly this update is stupid and whoever shipped it should feel bad. Roll it back.",
    status: "pending_review", ruleScore: 18, finalScore: 35, llmScore: 35, processingMs: 10,
    ruleFlags: [{ rule: "toxic_term", severity: "medium", detail: '"stupid" — insult', points: 18 }],
    llmCategories: { harassment: 35 },
    auditDetail: "stage1 score 18 (flags: toxic_term) · stage2 mock-keyword-v1 score 35 · final 35 → pending_review",
  })
  await sub({
    author: "marketplace_mel", hoursAgo: 6,
    content: "Selling my old camera, DM me — you can also reach me at mel.photos@example.com or 555-867-5309.",
    status: "pending_review", ruleScore: 45, finalScore: 45, llmScore: 8, processingMs: 12,
    ruleFlags: [
      { rule: "email_address", severity: "medium", detail: "1 email address(es) in public content", points: 25 },
      { rule: "phone_number", severity: "medium", detail: "1 phone-number-like string(s)", points: 20 },
    ],
    llmCategories: { spam: 8 },
    auditDetail: "stage1 score 45 (flags: email_address, phone_number) · stage2 mock-keyword-v1 score 8 · final 45 → pending_review",
  })
  await sub({
    author: "anon_vent", hoursAgo: 3,
    content: "Some days I just feel like there's no reason to live in this city anymore, everything is falling apart.",
    status: "pending_review", ruleScore: 0, finalScore: 60, llmScore: 60, processingMs: 9,
    ruleFlags: [],
    llmCategories: { self_harm: 60 },
    auditDetail: "stage1 score 0 (flags: none) → not decisive: ambiguous phrasing · stage2 mock-keyword-v1 score 60 · final 60 → pending_review",
  })

  // --- one already-worked human decision (with note) ----------------------------
  const humanId = await sub({
    author: "local_biz_omar", hoursAgo: 26,
    content: "We just opened a bakery on 5th street — first 50 customers tomorrow get a free croissant! Hope this is ok to post here.",
    status: "approved", decidedBy: "human", ruleScore: 0, finalScore: 30, llmScore: 30, processingMs: 10,
    ruleFlags: [],
    llmCategories: { spam: 30 },
    reviewedBy: dana, reviewNote: "Local community promo, explicitly allowed by our guidelines.",
    auditDetail: "stage1 score 0 · stage2 mock-keyword-v1 score 30 · final 30 → pending_review",
  })
  await pool.query(
    `INSERT INTO audit_log (submission_id, actor, detail, created_at)
     VALUES ($1, 'Dana Chowdhury', 'human review → approved · note: Local community promo, explicitly allowed by our guidelines.', now() - interval '25 hours')`,
    [humanId],
  )

  console.log("\nSeed complete ✅")
  console.log("\nModerator sign-ins (password: " + SEED_PASSWORD + ")")
  console.log("  dana@sentinel.test   — moderator")
  console.log("  lead@sentinel.test   — admin")
  console.log("\nSeeded: 12 submissions — rules approvals/rejections, a dedupe pair,")
  console.log("classifier decisions, 3 items waiting in the review queue, and one")
  console.log("human-decided item. Metrics and the audit log are live.")
  console.log("\nNext: npm run dev → http://localhost:3000")
  console.log("Load test (server must be running): npm run loadtest")
}

try {
  await createSchema()
  await seed()
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await pool.end()
}
