# 5-minute demo walkthrough

Run `npm run setup` then `npm run dev`, open http://localhost:3000.

## 1. Watch the pipeline decide (public page, no login)

Submit these in order and read the **pipeline trace** each time:

1. `Just adopted a rescue dog, any tips for the first week?`
   → Stage 1: zero flags → **approved by rules**, Stage 2 SKIPPED. Free and instant.
2. `CRYPTO GIVEAWAY!!! Double your money GUARANTEED. Act now, limited time offer — send gift cards or wire transfer to claim your prize!!!`
   → Stage 1 stacks seven scam flags → **rejected by rules**, Stage 2 SKIPPED.
3. Submit **exactly the same scam text again**
   → **dedupe fast-path**: inherited rejection in ~1 ms. (The seed already
   contains this string — it may dedupe on your FIRST try. That's the point.)
4. `Honestly whoever shipped this update is an idiot.`
   → Stage 1: one toxic term (18 pts, not decisive) → **Stage 2 runs** → final
   lands in the middle → **pending review**.
5. `fr33 crÿpt0 g1veaway!!! d0uble y0ur m0ney guaranteed — act n0w`
   → leetspeak normalization catches it anyway. Obfuscation doesn't help.

## 2. Work the queue as a moderator

**Moderator sign-in** → `dana@sentinel.test` / your `SEED_PASSWORD` (default `ChangeMe123!`).

- **Review queue** (FIFO): 3 seeded items + whatever you just added. Each shows
  every Stage-1 flag with points and every Stage-2 category score — the
  moderator sees exactly what the machines saw.
- The seeded marketplace post (email + phone) is a classic judgment call:
  approve it with a note. The ambiguous self-harm-adjacent vent is why humans
  are in the loop at all.
- Approve/reject something, then check the **Audit log** tab — the system
  entry and your human entry sit side by side, both self-explanatory.

## 3. Read the metrics like a platform owner

**Metrics** tab:

- “Never needed Stage 2” is the cost story — rules + dedupe decided that
  fraction for free.
- “Who decided” shows rules vs classifier vs human vs dedupe, with per-path
  average latency — the rules path should be ~3× faster.

## 4. Blast it

```bash
npm run loadtest   # server still running — 500 submissions, concurrency 20
```

Watch the terminal report (p50/p95/p99, throughput, routing split, Stage-2
skip rate), then refresh the Metrics tab — server-side numbers should agree.
The review queue will have grown: that's the human-cost consequence of the
threshold band, live.

## 5. Turn the risk dials

Edit `.env.local`: `AUTO_APPROVE_BELOW=10` and `AUTO_REJECT_ABOVE=95`, restart,
re-run the load test — the review queue balloons (safe but expensive). Flip to
`40`/`60` — automation eats almost everything (cheap but riskier). Two env
vars, the entire moderation policy conversation.
