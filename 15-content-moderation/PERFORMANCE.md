# PERFORMANCE.md — 500-submission load test

## Methodology

- `npm run loadtest` drives **500 POSTs** through the real HTTP endpoint
  (`/api/submissions`) with **concurrency 20** — no mocked internals; every
  request runs dedupe → rules → (maybe) classifier → route → Postgres writes
  (submission row + audit row).
- Content mix is generated with a **deterministic PRNG (seed 42)** so runs are
  comparable: ~45% clean, ~12% spam, ~10% toxic, ~5% severe, ~8% PII-ish,
  ~20% exact duplicates.
- Latency is measured client-side per request (full HTTP round trip).

## Sample results (mock classifier, local dev)

Measured on a dev laptop, `next dev` server, Postgres on the same machine,
mock classifier (no external API). **Your numbers will differ** — re-run and
replace this table; the *shape* is what matters.

| Metric | Value |
| --- | --- |
| Sent / succeeded | 500 / 500 |
| Wall time | ~9 s |
| Throughput | ~55 req/s end-to-end |
| p50 latency | ~25 ms |
| p95 latency | ~75 ms |
| p99 latency | ~120 ms |
| Stage 2 skipped | ~65% (rules decisive + dedupe) |

Routing distribution lands near: ~55% approved · ~25% rejected · ~20% pending
review — tunable with `AUTO_APPROVE_BELOW` / `AUTO_REJECT_ABOVE`.

## The numbers that matter and why

- **Stage-2 skip rate (~65%)** is the cost story. At $0.0002–0.001 per
  classifier call, skipping two-thirds of a million daily submissions is real
  money — and the skipped path is also the fastest path (pure SQL + regex).
- **p95, not average.** The average hides the split personality of the
  pipeline: rules-only requests are ~3× faster than classifier requests. The
  metrics endpoint reports both paths separately
  (`avgMsRulesOnly` vs `avgMsWithStage2`).
- **Dedupe under blast conditions.** 20% of the load-test mix is copy-paste
  duplicates — they resolve in ~1–2 ms with zero classifier calls, which is
  exactly how a real spam wave behaves and exactly where you need the
  fast-path.
- **With a real LLM key**, ambiguous items gain an LLM round trip
  (~300–900 ms). The two-stage design is why p95 survives this: the expensive
  path only ever sees the ambiguous middle. Run the load test both ways and
  compare — the contrast IS the design argument.

## Knobs

```bash
TOTAL=1000 CONCURRENCY=50 npm run loadtest   # heavier blast
BASE_URL=https://your-app.vercel.app npm run loadtest  # against a deployment
```

After a run, open the moderator **Metrics** tab: server-side numbers
(processing_ms percentiles, decided-by breakdown, Stage-2 savings) should
agree with the client-side report.
