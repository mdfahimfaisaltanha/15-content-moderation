"use client"

import { useCallback, useEffect, useState } from "react"

type User = { id: number; name: string; email: string; role: string }
type Flag = { rule: string; severity: string; detail: string; points: number }
type Trace = {
  submissionId: number
  status: string
  decidedBy: string
  finalScore: number
  ruleScore: number
  ruleFlags: Flag[]
  classifier: { categories: Record<string, number>; score: number; model: string } | null
  stage2Skipped: boolean
  stage2SkippedReason: string | null
  processingMs: number
  thresholds: { approveBelow: number; rejectAbove: number }
}
type Sub = {
  id: number
  author: string
  content: string
  status: string
  decidedBy: string | null
  ruleScore: number | null
  ruleFlags: Flag[]
  llmCategories: Record<string, number> | null
  llmScore: number | null
  finalScore: number | null
  processingMs: number | null
  createdAt: string
  decidedAt: string | null
  reviewNote: string | null
  reviewedByName: string | null
}
type AuditEntry = { id: number; submissionId: number; actor: string; detail: string; createdAt: string }
type MetricsData = {
  totals: { total: number; approved: number; rejected: number; pending: number }
  decidedBy: { rules: number; classifier: number; human: number; dedupe: number }
  stage2: { skipped: number; skippedPct: number | null; classifier: string }
  latency: { avgMs: number | null; p95Ms: number | null; avgMsRulesOnly: number | null; avgMsWithStage2: number | null }
  topFlags: Array<{ rule: string; item_count: number }>
  categories: Array<{ category: string; item_count: number; avg_score: number }>
  thresholds: { approveBelow: number; rejectAbove: number }
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "ok" : status === "rejected" ? "bad" : "warn"
  return <span className={`badge ${cls}`}>{status.replace("_", " ")}</span>
}

function ScoreBar({ score, thresholds }: { score: number; thresholds: { approveBelow: number; rejectAbove: number } }) {
  const color = score < thresholds.approveBelow ? "var(--ok)" : score > thresholds.rejectAbove ? "var(--bad)" : "var(--warn)"
  return (
    <div className="scorebar">
      <div className="fill" style={{ width: `${Math.min(100, score)}%`, background: color }} />
    </div>
  )
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null)
  const [booted, setBooted] = useState(false)
  const [view, setView] = useState<"submit" | "login" | "dashboard">("submit")

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) {
          setUser(d.user)
          setView("dashboard")
        }
      })
      .finally(() => setBooted(true))
  }, [])

  if (!booted) return <main className="meta">Loading…</main>

  return (
    <main>
      <div className="topbar">
        <div className="brand">
          <span className="logo">🛡️</span>
          <div>
            <h1>Sentinel</h1>
            <div className="meta">Two-stage content moderation — rules first, LLM for the ambiguous middle, humans for judgment calls</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {user ? (
            <>
              <span className="meta">
                {user.name} <span className="badge accent">{user.role}</span>
              </span>
              <button className="ghost" onClick={() => setView(view === "dashboard" ? "submit" : "dashboard")}>
                {view === "dashboard" ? "Submit content" : "Mod dashboard"}
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  await fetch("/api/auth", { method: "DELETE" })
                  setUser(null)
                  setView("submit")
                }}
              >
                Sign out
              </button>
            </>
          ) : view === "login" ? (
            <button className="ghost" onClick={() => setView("submit")}>
              Back
            </button>
          ) : (
            <button className="ghost" onClick={() => setView("login")}>
              Moderator sign-in
            </button>
          )}
        </div>
      </div>

      {view === "submit" && <SubmitDemo />}
      {view === "login" && (
        <Login
          onLogin={(u) => {
            setUser(u)
            setView("dashboard")
          }}
        />
      )}
      {view === "dashboard" && user && <Dashboard />}
    </main>
  )
}

/* ------------------------------------------------------------------ */
/* Public submit demo                                                  */
/* ------------------------------------------------------------------ */

function SubmitDemo() {
  const [author, setAuthor] = useState("demo_user")
  const [content, setContent] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trace, setTrace] = useState<Trace | null>(null)

  async function submit() {
    if (!content.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author, content }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.")
        return
      }
      setTrace(data.trace)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="card">
        <h2>📝 Submit content to the pipeline</h2>
        <p className="meta">
          Every submission returns its full pipeline trace. Try something clean, then “DOUBLE YOUR
          MONEY — crypto giveaway, act now!!!”, then paste the same thing twice to see the dedupe
          fast-path. More recipes in <span className="mono">samples/sample-content.md</span>.
        </p>
        <label>Author handle</label>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        <label>Content</label>
        <textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write a post to moderate…" />
        {error && <div className="error-box">{error}</div>}
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Moderating…" : "Submit for moderation"}
          </button>
        </div>
      </div>

      {trace && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>
              Decision: <StatusBadge status={trace.status} />{" "}
              <span className="badge info">decided by {trace.decidedBy}</span>
            </h2>
            <span className="meta">
              #{trace.submissionId} · {trace.processingMs} ms
            </span>
          </div>

          <ScoreBar score={trace.finalScore} thresholds={trace.thresholds} />
          <p className="meta">
            final score <b>{trace.finalScore}</b> · approve below {trace.thresholds.approveBelow} · reject above{" "}
            {trace.thresholds.rejectAbove} · in between → human review
          </p>

          <div className="trace-stage">
            <div className="title">Stage 1 — rules engine · score {trace.ruleScore}</div>
            {trace.ruleFlags.length === 0 ? (
              <span className="flag-line">no flags</span>
            ) : (
              trace.ruleFlags.map((f, i) => (
                <span className="flag-line" key={i}>
                  [{f.severity}] {f.rule}: {f.detail} (+{f.points})
                </span>
              ))
            )}
          </div>

          <div className={`trace-stage ${trace.stage2Skipped ? "skipped" : ""}`}>
            <div className="title">
              Stage 2 — classifier{" "}
              {trace.stage2Skipped ? `· SKIPPED (${trace.stage2SkippedReason})` : trace.classifier ? `· ${trace.classifier.model} · score ${trace.classifier.score}` : "· failed → human review (fail-closed)"}
            </div>
            {!trace.stage2Skipped &&
              trace.classifier &&
              Object.entries(trace.classifier.categories)
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span className="flag-line" key={k}>
                    {k}: {v}
                  </span>
                ))}
            {!trace.stage2Skipped && trace.classifier && Object.values(trace.classifier.categories).every((v) => v === 0) && (
              <span className="flag-line">all categories 0</span>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Moderator login                                                     */
/* ------------------------------------------------------------------ */

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Login failed.")
        return
      }
      onLogin(data.user)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="card">
        <h2>Moderator sign-in</h2>
        <p className="meta">
          Seeded moderators: <span className="mono">dana@sentinel.test</span> ·{" "}
          <span className="mono">lead@sentinel.test</span> (password: your SEED_PASSWORD, default{" "}
          <span className="mono">ChangeMe123!</span>)
        </p>
        {error && <div className="error-box">{error}</div>}
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <div style={{ marginTop: 14 }}>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Moderator dashboard                                                 */
/* ------------------------------------------------------------------ */

function Dashboard() {
  const [tab, setTab] = useState<"queue" | "recent" | "metrics" | "audit">("queue")
  return (
    <>
      <div className="tabs">
        <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
          ⏳ Review queue
        </button>
        <button className={tab === "recent" ? "active" : ""} onClick={() => setTab("recent")}>
          🗂️ Recent decisions
        </button>
        <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
          📊 Metrics
        </button>
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
          📜 Audit log
        </button>
      </div>
      {tab === "queue" && <QueueView view="queue" />}
      {tab === "recent" && <QueueView view="recent" />}
      {tab === "metrics" && <Metrics />}
      {tab === "audit" && <Audit />}
    </>
  )
}

function QueueView({ view }: { view: "queue" | "recent" }) {
  const [subs, setSubs] = useState<Sub[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    const res = await fetch(`/api/mod/queue?view=${view}`)
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? "Failed to load.")
      return
    }
    setSubs(data.submissions)
  }, [view])

  useEffect(() => {
    load()
  }, [load])

  async function decide(id: number, action: "approve" | "reject") {
    setError(null)
    const res = await fetch("/api/mod/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, note: notes[id] || undefined }),
    })
    const data = await res.json()
    if (!res.ok) setError(data.error ?? "Action failed.")
    await load()
  }

  return (
    <>
      {error && <div className="error-box">{error}</div>}
      {view === "queue" && (
        <p className="meta">{subs.length} item(s) awaiting review — FIFO, oldest first. Each shows every signal both stages produced.</p>
      )}
      {subs.length === 0 && <div className="card meta">{view === "queue" ? "Queue is empty — the automation is holding the line." : "No decisions yet."}</div>}
      {subs.map((s) => (
        <div key={s.id} className="card">
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <b>#{s.id}</b> · <span className="mono">{s.author}</span> <StatusBadge status={s.status} />{" "}
              {s.decidedBy && <span className="badge info">by {s.decidedBy}</span>}{" "}
              {s.finalScore !== null && <span className="badge accent">score {s.finalScore}</span>}
            </div>
            <span className="meta">
              {new Date(s.createdAt).toLocaleString()}
              {s.processingMs !== null ? ` · ${s.processingMs} ms` : ""}
              {s.reviewedByName ? ` · reviewed by ${s.reviewedByName}` : ""}
            </span>
          </div>
          <div className="content-quote">{s.content}</div>
          {(s.ruleFlags?.length ?? 0) > 0 && (
            <div className="trace-stage">
              <div className="title">Stage 1 flags (score {s.ruleScore})</div>
              {s.ruleFlags.map((f, i) => (
                <span className="flag-line" key={i}>
                  [{f.severity}] {f.rule}: {f.detail} (+{f.points})
                </span>
              ))}
            </div>
          )}
          {s.llmCategories && (
            <div className="trace-stage">
              <div className="title">Stage 2 categories (score {s.llmScore})</div>
              {Object.entries(s.llmCategories)
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span className="flag-line" key={k}>
                    {k}: {v}
                  </span>
                ))}
            </div>
          )}
          {s.reviewNote && <p className="meta">Note: {s.reviewNote}</p>}
          {s.status === "pending_review" && (
            <>
              <label>Review note (optional)</label>
              <input value={notes[s.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))} placeholder="Why?" />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="approve" onClick={() => decide(s.id, "approve")}>
                  ✓ Approve
                </button>
                <button className="reject" onClick={() => decide(s.id, "reject")}>
                  ✕ Reject
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </>
  )
}

function Metrics() {
  const [data, setData] = useState<MetricsData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/mod/metrics")
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? "Failed to load metrics.")
        setData(d)
      })
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-box">{error}</div>
  if (!data) return <p className="meta">Loading…</p>

  return (
    <>
      <div className="grid">
        <div className="stat">
          <div className="num">{data.totals.total}</div>
          <div className="lbl">Total submissions</div>
        </div>
        <div className="stat">
          <div className="num">
            {data.totals.approved} / {data.totals.rejected} / {data.totals.pending}
          </div>
          <div className="lbl">Approved / rejected / pending</div>
        </div>
        <div className="stat">
          <div className="num">{data.stage2.skippedPct !== null ? `${data.stage2.skippedPct}%` : "—"}</div>
          <div className="lbl">Never needed Stage 2 (rules + dedupe did it free)</div>
        </div>
        <div className="stat">
          <div className="num">
            {data.latency.avgMs ?? "—"} / {data.latency.p95Ms ?? "—"} ms
          </div>
          <div className="lbl">Processing avg / p95</div>
        </div>
      </div>

      <div className="card">
        <h3>Who decided</h3>
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Count</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Rules (Stage 1 decisive)</td>
              <td>{data.decidedBy.rules}</td>
              <td className="meta">free + ~{data.latency.avgMsRulesOnly ?? "—"} ms avg</td>
            </tr>
            <tr>
              <td>Classifier (Stage 2)</td>
              <td>{data.decidedBy.classifier}</td>
              <td className="meta">
                {data.stage2.classifier} · ~{data.latency.avgMsWithStage2 ?? "—"} ms avg
              </td>
            </tr>
            <tr>
              <td>Human review</td>
              <td>{data.decidedBy.human}</td>
              <td className="meta">the judgment calls</td>
            </tr>
            <tr>
              <td>Dedupe fast-path</td>
              <td>{data.decidedBy.dedupe}</td>
              <td className="meta">inherited decisions on identical content</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Top rule flags</h3>
        {data.topFlags.length === 0 ? (
          <p className="meta">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Hits</th>
              </tr>
            </thead>
            <tbody>
              {data.topFlags.map((f) => (
                <tr key={f.rule}>
                  <td className="mono">{f.rule}</td>
                  <td>{f.item_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Classifier categories (score ≥ 20)</h3>
        {data.categories.length === 0 ? (
          <p className="meta">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Submissions</th>
                <th>Avg score</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.category}>
                  <td className="mono">{c.category}</td>
                  <td>{c.item_count}</td>
                  <td>{c.avg_score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Live configuration</h3>
        <p className="meta">
          approve below <b>{data.thresholds.approveBelow}</b> · reject above <b>{data.thresholds.rejectAbove}</b> · classifier{" "}
          <span className="mono">{data.stage2.classifier}</span> — widen the review band for safety, narrow it for automation.
        </p>
      </div>
    </>
  )
}

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/mod/queue?view=audit")
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? "Failed to load audit log.")
        setEntries(d.entries)
      })
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-box">{error}</div>

  return (
    <div className="card">
      <h3>Last {entries.length} entries — every decision explains itself</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Submission</th>
            <th>Actor</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="meta" style={{ whiteSpace: "nowrap" }}>
                {new Date(e.createdAt).toLocaleString()}
              </td>
              <td>#{e.submissionId}</td>
              <td>{e.actor}</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {e.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
