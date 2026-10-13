import type { RuleFlag, RulesResult } from "./types"

/**
 * STAGE 1 — the deterministic rules engine.
 *
 * Fast, free, and auditable. Its job is to be DECISIVE at both ends of the
 * spectrum so the expensive Stage-2 classifier only ever sees the ambiguous
 * middle:
 *
 *   - severe violations (explicit threats, card numbers, scam blasts)
 *     → auto-reject, no LLM call
 *   - clearly clean content (zero flags)
 *     → auto-approve, no LLM call
 *   - everything else → Stage 2
 *
 * Every flag carries points + a human-readable detail, because moderators and
 * auditors will read these verbatim on the review ticket.
 */

// ---- normalization ----------------------------------------------------------

/**
 * Leetspeak/obfuscation normalization BEFORE term matching — "fr33 crÿpt0
 * g1veaway" must match the same rules as its plain spelling. Deliberately
 * conservative: common substitutions only, applied to a COPY used for
 * matching (flags quote the original text).
 */
export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/\$/g, "s")
    .replace(/@/g, "a")
    .replace(/[^a-z\s]/g, " ") // collapse punctuation used to split words: "k.i.l.l"
    .replace(/\s+/g, " ")
}

// ---- term lists -------------------------------------------------------------

/** Severe: any hit is decisive rejection. Phrases, matched on normalized text. */
const SEVERE_TERMS: Array<{ term: string; detail: string }> = [
  { term: "kill yourself", detail: "direct self-harm instruction" },
  { term: "kys", detail: "direct self-harm instruction (abbreviated)" },
  { term: "i will kill you", detail: "explicit threat of violence" },
  { term: "i will find you", detail: "stalking/threat language" },
  { term: "ill kill you", detail: "explicit threat of violence" },
  { term: "deserve to die", detail: "violent wish" },
]

/** High: strong scam/fraud signals — heavy points but not individually decisive. */
const SCAM_TERMS: Array<{ term: string; detail: string }> = [
  { term: "wire transfer", detail: "payment-redirect scam phrase" },
  { term: "western union", detail: "payment-redirect scam phrase" },
  { term: "send gift cards", detail: "gift-card scam phrase" },
  { term: "gift card codes", detail: "gift-card scam phrase" },
  { term: "double your money", detail: "investment scam phrase" },
  { term: "guaranteed returns", detail: "investment scam phrase" },
  { term: "crypto giveaway", detail: "giveaway scam phrase" },
  { term: "free crypto", detail: "giveaway scam phrase" },
  { term: "claim your prize", detail: "prize scam phrase" },
  { term: "you have been selected", detail: "prize scam phrase" },
  { term: "act now", detail: "urgency pressure phrase" },
  { term: "limited time offer", detail: "urgency pressure phrase" },
]

/** Medium: harassment/toxicity words — accumulate points, Stage 2 arbitrates. */
const TOXIC_TERMS: Array<{ term: string; detail: string }> = [
  { term: "idiot", detail: "insult" },
  { term: "moron", detail: "insult" },
  { term: "stupid", detail: "insult" },
  { term: "pathetic", detail: "insult" },
  { term: "loser", detail: "insult" },
  { term: "trash human", detail: "dehumanizing insult" },
  { term: "nobody likes you", detail: "targeted harassment" },
  { term: "shut up", detail: "hostile" },
]

// ---- PII detection ----------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{0,4}/g
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g

/** Luhn checksum — separates real card numbers from random digit strings. */
export function luhnValid(digits: string): boolean {
  const ds = digits.replace(/\D/g, "")
  if (ds.length < 13 || ds.length > 19) return false
  let sum = 0
  let dbl = false
  for (let i = ds.length - 1; i >= 0; i--) {
    let d = ds.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

// ---- the engine -------------------------------------------------------------

export function runRules(content: string): RulesResult {
  const flags: RuleFlag[] = []
  const normalized = normalizeForMatching(content)
  const padded = ` ${normalized} `

  // 1. Severe terms — decisive on their own.
  for (const { term, detail } of SEVERE_TERMS) {
    if (padded.includes(` ${term} `)) {
      flags.push({ rule: "severe_term", severity: "severe", detail: `"${term}" — ${detail}`, points: 100 })
    }
  }

  // 2. Credit-card numbers (Luhn-validated) — also decisive: PII we must never host.
  for (const cand of content.match(CARD_CANDIDATE_RE) ?? []) {
    if (luhnValid(cand)) {
      flags.push({
        rule: "credit_card",
        severity: "severe",
        detail: `Luhn-valid card number ending ${cand.replace(/\D/g, "").slice(-4)}`,
        points: 100,
      })
    }
  }

  // 3. Other PII — heavy but reviewable (support posts legitimately mention emails).
  const emails = content.match(EMAIL_RE) ?? []
  if (emails.length > 0) {
    flags.push({
      rule: "email_address",
      severity: "medium",
      detail: `${emails.length} email address(es) in public content`,
      points: 25,
    })
  }
  const phones = (content.match(PHONE_RE) ?? []).filter((p) => p.replace(/\D/g, "").length >= 10)
  if (phones.length > 0) {
    flags.push({
      rule: "phone_number",
      severity: "medium",
      detail: `${phones.length} phone-number-like string(s)`,
      points: 20,
    })
  }

  // 4. Scam phrases — stack up fast.
  let scamHits = 0
  for (const { term, detail } of SCAM_TERMS) {
    if (padded.includes(` ${term} `)) {
      scamHits++
      flags.push({ rule: "scam_phrase", severity: "high", detail: `"${term}" — ${detail}`, points: 30 })
    }
  }

  // 5. Toxicity terms.
  for (const { term, detail } of TOXIC_TERMS) {
    if (padded.includes(` ${term} `)) {
      flags.push({ rule: "toxic_term", severity: "medium", detail: `"${term}" — ${detail}`, points: 18 })
    }
  }

  // 6. Spam shape heuristics.
  const links = content.match(/https?:\/\/\S+/gi) ?? []
  if (links.length >= 3) {
    flags.push({ rule: "link_flood", severity: "high", detail: `${links.length} links in one post`, points: 30 })
  } else if (links.length > 0 && content.replace(/https?:\/\/\S+/gi, "").trim().length < 15) {
    flags.push({ rule: "bare_link", severity: "medium", detail: "link with almost no accompanying text", points: 20 })
  }

  const letters = content.replace(/[^a-zA-Z]/g, "")
  if (letters.length > 20) {
    const capsRatio = (content.replace(/[^A-Z]/g, "").length) / letters.length
    if (capsRatio > 0.6) {
      flags.push({
        rule: "caps_shouting",
        severity: "low",
        detail: `${Math.round(capsRatio * 100)}% capital letters`,
        points: 10,
      })
    }
  }

  if (/(.)\1{5,}/.test(content)) {
    flags.push({ rule: "char_flood", severity: "low", detail: "a character repeated 6+ times in a row", points: 8 })
  }

  const tokens = normalized.split(" ").filter(Boolean)
  if (tokens.length >= 8) {
    const unique = new Set(tokens).size
    if (unique / tokens.length < 0.4) {
      flags.push({
        rule: "token_repetition",
        severity: "medium",
        detail: `only ${unique} unique words out of ${tokens.length}`,
        points: 20,
      })
    }
  }

  // ---- score + decisiveness --------------------------------------------------
  const score = Math.min(100, flags.reduce((s, f) => s + f.points, 0))
  const severe = flags.some((f) => f.severity === "severe")
  const scamPileup = scamHits >= 3 // three distinct scam phrases is not a coincidence

  let decisive: RulesResult["decisive"] = null
  if (severe || scamPileup) decisive = "reject"
  else if (flags.length === 0) decisive = "approve"

  return { score, flags, decisive }
}
