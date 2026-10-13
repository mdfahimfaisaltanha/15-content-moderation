# Sentinel — Content Moderation Pipeline

A two-stage content moderation pipeline for a community platform: a
deterministic **rules engine** handles the obvious ends of the spectrum for
free, an **LLM classifier** scores only the ambiguous middle, and configurable
thresholds route everything to **auto-approve / auto-reject / a human review
queue** — with a full audit trail and a 500-submission load test.

**Stack:** Next.js 14 (App Router) · TypeScript · PostgreSQL · OpenAI (optional — full mock mode included)

---

## The pipeline

```
submission
    │
    ▼
┌────────────────┐  SHA-256 of normalized content; already-decided
│ 0. DEDUPE       │  duplicates inherit the decision instantly — a
└────────┐───────┘  copy-paste spam blast costs ONE pipeline run
         ▼
┌────────────────┐  banned-term tiers (leetspeak-normalized), PII
│ 1. RULES ENGINE │  (Luhn-validated cards, emails, phones), spam shape
└────┐────────┐──┘  (link floods, caps, repetition)
     ▼ decisive ▼ not decisive
  approve /   ┌─────────────────┐  gpt-4o-mini or the deterministic
  reject      │ 2. CLASSIFIER    │  mock — scores 6 categories 0-100
  (no LLM     └────────┐────────┘
   call)               ▼
              ┌─────────────────┐  final = max(rules, classifier)
              │ 3. ROUTE         │  < 25 approve · > 80 reject ·
              └─────────────────┘  in between → human review queue
```

### Why two stages? Cost and latency.

Most content is obviously fine or obviously not. Stage 1 is regex and
arithmetic — microseconds, zero API cost — and it is **decisive at both
ends**: zero flags → approved, severe violation (explicit threat, Luhn-valid
card number, 3+ distinct scam phrases) → rejected. Only the ambiguous middle
ever reaches the classifier. In the seeded load-test mix, **~60–70% of
submissions never touch Stage 2** — that's the number that makes this design
cheap at scale, and the metrics dashboard reports it live.

### Why `max()` and not an average?

A Luhn-valid card number with an innocent-sounding caption must stay rejected.
Averaging lets a calm classifier wash out a severe rule hit; `max()` means the
most alarmed signal wins. Disagreement between stages naturally lands in the
review band — which is exactly where humans should be.

### Fail-closed, always

If the classifier fails (API down, malformed output), the submission routes to
**human review** — never auto-approve. A moderation pipeline's failure mode
must not be “everything is fine.” The audit log records the failure reason.

## Stage 1 details worth defending in an interview

- **Leetspeak normalization**: `fr33 crÿpt0 g1veaway` and `k.i.l.l` are
  normalized (digit/symbol substitutions, diacritics stripped, punctuation
  collapsed) before term matching — the first thing real spammers try.
- **Luhn checksum** separates actual card numbers from random digit strings —
  a 16-digit order ID doesn't nuke a legitimate post; a real PAN is decisive.
- **Points, not booleans**: every flag carries points + a human-readable
  detail. One insult (18 pts) rides the classifier's judgment; an insult plus
  a link flood plus token repetition stacks toward rejection.
- **Severity tiers**: `severe` flags and 3+ distinct scam phrases end the
  pipeline on their own — no LLM gets to overrule a card dump.

## Routing thresholds — the risk dials

```
AUTO_APPROVE_BELOW=25   # final score below this → approved
AUTO_REJECT_ABOVE=80    # final score above this → rejected
```

The gap between them is the **human review band**. Widen it and you trade
moderator time for safety; narrow it and you trade safety for automation.
It's two env vars precisely so you can demo that trade-off live.

## Getting started

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier works)
npm run setup                # schema + seeded submissions/moderators
npm run dev                  # http://localhost:3000
```

Seeded sign-ins (password = `SEED_PASSWORD`, default `ChangeMe123!`):

| Email | Role |
| --- | --- |
| `dana@sentinel.test` | Moderator |
| `lead@sentinel.test` | Admin |

The public page submits content and renders the **full pipeline trace** —
every rule flag with its points, classifier category scores, which stage
decided, and the timing. The seed includes 3 items already waiting in the
review queue. See `samples/walkthrough.md` for a 5-minute demo script and
`samples/sample-content.md` for content recipes per pipeline path.

## Load test

```bash
npm run dev        # terminal 1 — server must be running
npm run loadtest   # terminal 2 — 500 submissions, concurrency 20
```

Realistic mix (clean / spam / toxic / severe / PII / exact duplicates),
deterministic PRNG (seed 42) so runs are comparable. Reports p50/p95/p99
latency, throughput, routing distribution, and the Stage-2 skip rate.
Configurable via `BASE_URL`, `TOTAL`, `CONCURRENCY`. Results and methodology:
[PERFORMANCE.md](./PERFORMANCE.md).

## API surface

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/submissions` | POST | public¹ | Submit → full pipeline trace |
| `/api/submissions?id=` | GET | public | Author-visible status only |
| `/api/auth` | GET/POST/DELETE | — | Moderator session |
| `/api/mod/queue?view=queue\|recent\|audit` | GET | moderator | Queue / decisions / audit log |
| `/api/mod/queue` | PATCH | moderator | Approve/reject with note (409 on races) |
| `/api/mod/metrics` | GET | moderator | Routing, latency, Stage-2 savings |

¹ Public because it's the demo; in production your user auth or service API
key sits in front, and the trace endpoint would be internal-only.

## Edge cases handled

| Case | Behavior |
| --- | --- |
| Identical content resubmitted | Dedupe fast-path inherits the decision (~1 ms, no LLM) |
| Duplicate of a *pending* item | NOT inherited — a human hasn't spoken yet; runs the pipeline |
| Human decisions on duplicates | DO propagate — moderator effort is reused automatically |
| Leetspeak / punctuation obfuscation | Normalized before matching (`crÿpt0`, `k.i.l.l`) |
| 16-digit number that isn't a card | Luhn check fails → no flag |
| Classifier API failure | Fail-closed → review queue, reason in the audit log |
| Classifier returns malformed JSON | Same fail-closed path |
| Prompt injection in submitted content | Classifier prompt instructs judging content, not following it; rules and thresholds are immune by construction |
| Two moderators race one item | `WHERE status = 'pending_review'` guard → second gets 409 |
| Legit post mentioning an email | Medium flag (25 pts) → review band, not auto-reject |
| ALL-CAPS but clean content | Low flag alone (10 pts) stays under the approve threshold |
| Empty / oversized content | 400 with a clear message (5000-char cap) |

## Deploying

- **Vercel** — import the repo, set `DATABASE_URL`, thresholds, and optionally
  `OPENAI_API_KEY`.
- **Neon / Supabase** — free Postgres; run `npm run setup` once against it.

## Limitations (known and deliberate)

- Term lists are demo-sized; production systems use maintained lexicons and
  embeddings for paraphrase (the interface — flags with points — stays the same).
- Dedupe is exact-match SHA-256; near-duplicate detection (MinHash/SimHash) is
  the natural next step and slots into the same fast-path.
- The mock classifier is lexical — great for reproducible demos and load
  tests, weaker than an LLM on subtle harassment.
- No rate limiting on the public endpoint — add one before real traffic.
- Audit log grows unbounded — partition or archive in production.
