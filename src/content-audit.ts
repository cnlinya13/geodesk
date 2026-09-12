/**
 * View-only content fact-checking contracts.
 *
 * Shared contracts for the content-audit API and its evidence panel. The
 * existing website crawl is an input snapshot only; it is not, by itself, an
 * independently verified fact source.
 */
export type ContentAuditStatus = 'unavailable' | 'idle' | 'checking' | 'completed' | 'failed'

export type ContentAuditConclusion = 'supported' | 'conflict' | 'insufficient'

export type ContentAuditIssueType = 'conflict' | 'incomplete' | 'risk'

export type ContentAuditIssue = {
  type: ContentAuditIssueType
  reason: string
  suggestion: string
}

export type ContentAuditSource = {
  name: string
  origin: string
  versionAt?: string | null
  sourceText: string
  /** URL of the fetched public source, when the source is navigable. */
  url?: string
  /** How the fetched source relates to the statement. */
  relation?: 'supports' | 'contradicts' | 'context'
  /** Short, human-readable explanation of why the source is or is not authoritative. */
  authorityReason?: string
}

/** Every occurrence of a deduplicated claim remains addressable in the UI. */
export type ContentAuditLocation = {
  page: string
  pageUrl: string
  statement: string
  location: string
  context: string
}

export type ContentAuditPageExcerpt = {
  location: string
  context: string
}

export type ContentAuditEvidence = {
  statement: string
  page: string
  pageUrl?: string | null
  checkedAt?: string | null
  pageExcerpt?: ContentAuditPageExcerpt | null
  sources?: readonly ContentAuditSource[]
  /** Cached counterpart locations used to substantiate an internal conflict. */
  comparisons?: readonly ContentAuditLocation[]
  /** Nonfatal source-read diagnostics for this fact only. */
  sourceIssues?: readonly ContentAuditExecutionError[]
  judgment: string
  suggestion: string
}

export type ContentAuditRisk = {
  reason: string
  suggestion: string
}

export type ContentAuditItem = {
  id: string
  statement: string
  explanation: string
  page: string
  /** Explicit cached article category/section, when the source text supports it. */
  section?: string
  /** Omitted only for a risk-only review row. */
  conclusion?: ContentAuditConclusion
  evidence: ContentAuditEvidence
  /** Independent misleading-promise risk; may coexist with a conclusion. */
  risk?: ContentAuditRisk
  /** All locations for this normalized claim; `evidence` remains the legacy primary location. */
  locations?: readonly ContentAuditLocation[]
  subject?: string
  timeScope?: string
  conditions?: string
  /** New internal-only check findings. Optional solely for legacy readability. */
  issues?: readonly ContentAuditIssue[]
  /** The latest direct-read review of an issue from the preceding run. */
  review?: ContentAuditReview
}

export type ContentAuditReviewStatus = 'passed' | 'persists' | 'unverified'

export type ContentAuditReview = {
  issueId: string
  status: ContentAuditReviewStatus
  statement: string
  page: string
  pageUrl?: string | null
  checkedAt?: string | null
  reason: string
  suggestion: string
  evidence?: ContentAuditEvidence | null
}

/** Actual website-tool coverage; URL lists are kept transient and are not persisted. */
export type ContentAuditCoverage = {
  discoveredCount: number
  readCount: number
  failedCount: number
  toolCalls: number
  requestCount?: number
  complete: boolean
}

export type ContentAuditResult = {
  checkedAt?: string | null
  /** New runs are explicitly scoped to cached website-internal content. */
  scope?: 'website_internal'
  items: readonly ContentAuditItem[]
  /** Actual coverage summary from the direct website reader. */
  coverage?: ContentAuditCoverage
  /** Retained review outcomes for preceding issue rows. */
  reviews?: readonly ContentAuditReview[]
  /** Successfully crawled pages that were not available to the audit input. */
  excludedPages?: readonly { url: string; reason: string }[]
}

export type ContentAuditProgress = {
  stage: 'cleaning' | 'extracting' | 'checking'
  totalPages: number
  /** Present while the deterministic local cleaning stage is running. */
  cleanedPages?: number
  processedPages: number
  /** Actual page reads that failed; kept optional for old persisted records. */
  failedPages?: number
  /** Discovered content pages still safe and eligible for a read. */
  pendingPages?: number
  /** Whether this run has finished building its temporary page baseline. */
  baselineReady?: boolean
  /** `sitemap` is declared navigation; `links` is only this-run discovery. */
  baselineSource?: 'sitemap' | 'links'
  totalClaims: number
  processedClaims: number
}

export type ContentAuditExecutionError = {
  stage: string
  message: string
  pageUrl?: string
  itemId?: string
  /** Original fact text, when the failure belongs to one extracted claim. */
  statement?: string
  /** External source URL attempted for this failure, when known. */
  sourceUrl?: string
  /** Number of actual model/source attempts made for this operation. */
  attempts?: number
  /** Human-readable outcome of the bounded retry/alternative policy. */
  resolution?: string
}

export type ContentAuditUsage = {
  modelCalls: number
  searchCalls: number
  sourceFetches: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  elapsedMs: number
}

/**
 * Durable server-side checkpoint for a normally failed run.  It is kept on
 * the record so a user retry can reuse completed page extraction and review;
 * the API parser exposes it as a non-enumerable internal property and the
 * client never receives it.
 */
export type ContentAuditCheckpointDecision = {
  detected: boolean
  reason: string
  suggestion: string
}

export type ContentAuditCheckpointSharedLocation = {
  page: string
  pageUrl: string
  rawStart: number
  rawEnd: number
  statement: string
  context: string
  cleanText: string
}

export type ContentAuditCheckpointClaim = {
  statement: string
  subject: string
  timeScope: string
  conditions: string
  explanation: string
  quote: string
  sourceIds?: readonly string[]
  sourceId?: string
  comparable: boolean
  origin: 'title' | 'body'
  section?: string
  risk: ContentAuditCheckpointDecision | null
  incomplete: ContentAuditCheckpointDecision | null
  rawStart?: number
  rawEnd?: number
  sharedLocations?: readonly ContentAuditCheckpointSharedLocation[]
  page: string
  pageUrl: string
  location: string
  context: string
}

export type ContentAuditCheckpoint = {
  version: 1
  completedPages: number
  totalClaims: number
  processedClaims: number
  pageClaims: readonly { pageIndex: number; claims: readonly ContentAuditCheckpointClaim[] }[]
  excludedPages: readonly { url: string; reason: string }[]
  internalConflicts: readonly {
    key: string
    counterpartKeys: readonly string[]
    reasons: readonly string[]
    suggestions: readonly string[]
  }[]
}

export type ContentAuditRecord = {
  status: 'checking' | 'completed' | 'failed'
  startedAt: string
  completedAt: string | null
  progress: ContentAuditProgress
  result: ContentAuditResult | null
  error: string | null
  executionErrors: readonly ContentAuditExecutionError[]
  usage: ContentAuditUsage
  /**
   * Read-only view of the latest valid completed result from audit history.
   * This is present only while the current run is checking/failed; it is never
   * part of the persisted current record and must not be used for planning.
   */
  previousResult?: ContentAuditResult
  /** Completion time paired with `previousResult` in read-only responses. */
  previousCompletedAt?: string
  /** Internal retry checkpoint; omitted from JSON responses by the server. */
  checkpoint?: ContentAuditCheckpoint
}

const CONTENT_AUDIT_FAILURE_MESSAGE_MAX_CHARS = 240

function contentAuditFailureStageLabel(stage: unknown): string {
  if (stage === 'cleaning') return '内容清洗'
  if (stage === 'extracting') return '页面解析'
  if (stage === 'assessment') return '站内对照'
  if (stage === 'baseline') return 'Sitemap基线'
  if (stage === 'page') return '页面读取'
  if (stage === 'pending') return '未读取页面'
  if (stage === 'resource') return '资源限制'
  if (stage === 'model') return '模型响应'
  if (stage === 'validation') return 'JSON校验'
  if (stage === 'evidence') return '原文证据校验'
  if (stage === 'progress' || stage === 'snapshot' || stage === 'persistence') return '结果保存'
  if (stage === 'config' || stage === 'input') return '准备检查'
  return '执行'
}

/**
 * Render one safe, concise failure description for both server persistence
 * and the client.  The input may come from stored JSONB, so this formatter
 * deliberately validates and redacts at runtime instead of trusting its type.
 */
export function contentAuditFailureSummary(errors: readonly ContentAuditExecutionError[]): string {
  if (!Array.isArray(errors) || errors.length === 0) return '官网内容检查失败，请重试。'

  const first = errors[0]
  const rawMessage = first && typeof first === 'object' && typeof first.message === 'string'
    ? first.message
    : ''
  let message = rawMessage
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Credentials and provider-controlled URLs must not become visible in a
    // browser error banner.  Keep the page path, but remove query/hash data.
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?\b(api[-_ ]?key|access[-_ ]?token|token|secret|password)\b["']?\s*[:=]\s*["']?)[^\s,;}\]"']+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"'，。；、)]+/gi, (value: string) => {
      const trailing = value.match(/[，。；、)]+$/u)?.[0] ?? ''
      const candidate = trailing ? value.slice(0, -trailing.length) : value
      try {
        const parsed = new URL(candidate)
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return `${parsed.toString()}${trailing}`
      } catch {
        return `${candidate.split(/[?#]/u, 1)[0]}${trailing}`
      }
    })
    .slice(0, CONTENT_AUDIT_FAILURE_MESSAGE_MAX_CHARS)
    .replace(/[。.!！?？]+$/u, '')
    .trim()

  if (!message) message = '未提供具体错误信息'

  const stage = contentAuditFailureStageLabel(first && typeof first === 'object' ? first.stage : undefined)
  return `官网内容检查在${stage}阶段失败：${message}。`
}

export function contentAuditConclusionLabel(conclusion: ContentAuditConclusion): string {
  if (conclusion === 'supported') return '有依据'
  if (conclusion === 'conflict') return '存在冲突'
  return '无法核实'
}

export function contentAuditIssueTypeLabel(type: ContentAuditIssueType): string {
  if (type === 'conflict') return '数据冲突'
  if (type === 'incomplete') return '信息缺项'
  return '表述风险'
}

export function contentAuditConclusionTone(conclusion: ContentAuditConclusion): 'success' | 'warning' | 'danger' {
  if (conclusion === 'supported') return 'success'
  if (conclusion === 'conflict') return 'danger'
  return 'warning'
}

/**
 * Only expose navigable HTTP(S) evidence links. Invalid protocols are kept as
 * plain text (or omitted by the caller) and can never become javascript: URLs.
 */
export function safeContentAuditUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().slice(0, 2_000)
  } catch {
    return null
  }
}

export function contentAuditItems(result: ContentAuditResult | null | undefined): readonly ContentAuditItem[] {
  return result && Array.isArray(result.items) ? result.items : []
}
