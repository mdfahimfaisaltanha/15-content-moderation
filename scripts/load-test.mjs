/**
 * Sentinel load test — drives 500 synthetic submissions through the REAL
 * HTTP endpoint and reports latency, throughput, and routing distribution.
 *
 * Usage:
 *   npm run dev            # in one terminal (server must be running)
 *   npm run loadtest       # in another
 *
 * Env:
 *   BASE_URL     target server (default http://localhost:3000)
 *   TOTAL        submissions to send (default 500)
 *   CONCURRENCY  parallel in-flight requests (default 20)
 *
 * The mix is deliberately realistic:
 *   ~45% clean unique posts        → rules-decisive approvals (free)
 *   ~12% spam/promo templates      → stage 2 territory
 *   ~10% toxic-ish posts           → stage 2 / review queue
 *   ~5%  severe (threats, cards)   → rules-decisive rejections (free)
 *   ~8%  PII-ish marketplace posts → review queue
 *   ~20% exact duplicates          → dedupe fast-path
 *
 * NOTE (mock vs real): with no OPENAI_API_KEY the classifier is local and
 * deterministic — you're measuring the pipeline + Postgres. With a real key,
 * ambiguous items include an LLM round-trip; the two-stage design is exactly
 * why p95 stays sane: most content never reaches Stage 2.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000"
const TOTAL = Number(process.env.TOTAL) || 500
const CONCURRENCY = Number(process.env.CONCURRENCY) || 20

// ---- deterministic PRNG so runs are comparable -------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(42)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

// ---- content generators -------------------------------------------------------
const CLEAN_TOPICS = [
  "Just finished repotting my monstera — the roots were completely bound. Fingers crossed it recovers.",
  "The farmers market on Saturday had incredible sourdough. The stall next to the flowers, if anyone's looking.",
  "Finally beat my 10k personal record this morning. Cold air really does make a difference.",
  "Reading a fantastic book about urban planning this week. Happy to lend it out when I'm done.",
  "Our block's cleanup drive is this Sunday at 9am. Gloves and bags provided, bring water.",
  "Does anyone have a recommendation for a reliable bike mechanic near the station?",
  "The library extended its weekend hours — quiet study space until 9pm now.",
  "Made biryani for the first time using my grandmother's recipe. It actually worked.",
]
const SPAM_TEMPLATES = [
  "Buy now! Click here for exclusive deals {N} — subscribe to my channel!!!",
  "Follow for follow! Check out my page for a discount code {N}!!!",
  "Best investment opportunity of {N}. Passive income, risk free. DM me to earn!",
]
const TOXIC_TEMPLATES = [
  "Whoever designed this feature is an idiot, seriously. Ticket {N}.",
  "This is the most stupid take I've read all week ({N}). Pathetic.",
  "Shut up about the parking rules already, thread {N}.",
]
const SEVERE_TEMPLATES = [
  "You deserve to die for this take, thread {N}.",
  "Card dump {N}: 4539 1488 0343 6467 exp 09/27 DM me.",
]
const PII_TEMPLATES = [
  "Selling a desk, message me at seller{N}@example.com or 555-201-{N4}.",
  "Lost cat near the park — call me directly: +1 (555) 301-{N4}, ask for {N}.",
]
const DUPLICATE_POOL = [
  "CRYPTO GIVEAWAY!!! Double your money GUARANTEED. Act now, limited time offer — send gift cards or wire transfer to claim your prize!!!",
  "Huge sale this weekend, everything must go! https://deals.example/sale",
  "Reminder: the community meeting moved to Thursday 7pm at the hall.",
]

function generate(i) {
  const r = rand()
  const n = String(i)
  const n4 = String(1000 + Math.floor(rand() * 9000))
  if (r < 0.45) return `${pick(CLEAN_TOPICS)} (post ${n})`
  if (r < 0.57) return pick(SPAM_TEMPLATES).replaceAll("{N}", n)
  if (r < 0.67) return pick(TOXIC_TEMPLATES).replaceAll("{N}", n)
  if (r < 0.72) return pick(SEVERE_TEMPLATES).replaceAll("{N}", n)
  if (r < 0.8) return pick(PII_TEMPLATES).replaceAll("{N}", n).replaceAll("{N4}", n4)
  return pick(DUPLICATE_POOL) // exact duplicates — the dedupe fast-path
}

// ---- run ----------------------------------------------------------------------
console.log(`Sentinel load test → ${BASE_URL}/api/submissions`)
console.log(`total=${TOTAL} concurrency=${CONCURRENCY}\n`)

const jobs = Array.from({ length: TOTAL }, (_, i) => ({
  author: `load_user_${i % 40}`,
  content: generate(i),
}))

const latencies = []
const byStatus = {}
const byDecider = {}
let stage2Skipped = 0
let failures = 0
let cursor = 0

const startedAll = Date.now()

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]
    const t0 = Date.now()
    try {
      const res = await fetch(`${BASE_URL}/api/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      })
      const ms = Date.now() - t0
      if (!res.ok) {
        failures++
        continue
      }
      const { trace } = await res.json()
      latencies.push(ms)
      byStatus[trace.status] = (byStatus[trace.status] ?? 0) + 1
      byDecider[trace.decidedBy] = (byDecider[trace.decidedBy] ?? 0) + 1
      if (trace.stage2Skipped) stage2Skipped++
    } catch {
      failures++
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const wallMs = Date.now() - startedAll
latencies.sort((a, b) => a - b)
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]
const ok = latencies.length

console.log("---- results ------------------------------------------------")
console.log(`sent            ${TOTAL}`)
console.log(`succeeded       ${ok}`)
console.log(`failed          ${failures}`)
console.log(`wall time       ${(wallMs / 1000).toFixed(1)}s`)
console.log(`throughput      ${(ok / (wallMs / 1000)).toFixed(1)} req/s (end-to-end HTTP)`)
console.log("")
console.log(`latency p50     ${pct(50)} ms`)
console.log(`latency p95     ${pct(95)} ms`)
console.log(`latency p99     ${pct(99)} ms`)
console.log(`latency max     ${latencies[latencies.length - 1]} ms`)
console.log("")
console.log("routing:")
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  (${((v / ok) * 100).toFixed(1)}%)`)
}
console.log("decided by:")
for (const [k, v] of Object.entries(byDecider).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  (${((v / ok) * 100).toFixed(1)}%)`)
}
console.log(`\nstage 2 skipped  ${stage2Skipped} (${((stage2Skipped / ok) * 100).toFixed(1)}%) — decided free by rules or dedupe`)
console.log("\nCompare with PERFORMANCE.md and check the Metrics tab in the mod dashboard.")
