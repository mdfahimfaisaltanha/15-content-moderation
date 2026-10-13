export type Role = "moderator" | "admin"

export type SessionUser = {
  id: number
  name: string
  email: string
  role: Role
}

export type RuleFlag = {
  rule: string
  severity: "low" | "medium" | "high" | "severe"
  detail: string
  points: number
}

export type RulesResult = {
  score: number // 0-100
  flags: RuleFlag[]
  /** Stage 1 can end the pipeline on its own (both directions). */
  decisive: "approve" | "reject" | null
}

export type Category =
  | "harassment"
  | "threat_of_violence"
  | "self_harm"
  | "sexual"
  | "scam_or_fraud"
  | "spam"

export type ClassifyResult = {
  categories: Partial<Record<Category, number>> // 0-100 each
  score: number // max category score
  model: string
}

export type Decision = "approved" | "rejected" | "pending_review"
export type DecidedBy = "rules" | "classifier" | "human" | "dedupe" | null

export type Submission = {
  id: number
  author: string
  content: string
  contentHash: string
  status: Decision
  decidedBy: DecidedBy
  ruleScore: number | null
  ruleFlags: RuleFlag[]
  llmCategories: Partial<Record<Category, number>> | null
  llmScore: number | null
  finalScore: number | null
  processingMs: number | null
  createdAt: string
  decidedAt: string | null
  reviewedByName?: string | null
  reviewNote?: string | null
}

export type PipelineTrace = {
  submissionId: number
  status: Decision
  decidedBy: Exclude<DecidedBy, null>
  finalScore: number
  ruleScore: number
  ruleFlags: RuleFlag[]
  classifier: ClassifyResult | null
  stage2Skipped: boolean
  stage2SkippedReason: string | null
  processingMs: number
  thresholds: { approveBelow: number; rejectAbove: number }
}
