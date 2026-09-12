import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import {
  type GeneratedQuestion,
  type QuestionCategory,
  type QuestionGenerationInput,
} from './question-generator.ts'
import {
  ARTICLE_OPTIMIZATION_DIRECTIONS,
  QUESTION_GROUP_COUNTS,
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from '../src/business-rules.ts'
import type { WebsiteCrawlResult, WebsitePageResult } from './site-crawler.ts'
import type { DiagnosisAnswerState } from './diagnosis-core.ts'
import { contentAuditFailureSummary } from '../src/content-audit.ts'
import { isInitialDiagnosisComplete } from '../src/initial-diagnosis-completion.ts'
import {
  TECHNICAL_AUDIT_CURRENT_ITEM_IDS,
  TECHNICAL_AUDIT_ITEM_COUNT,
  TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_PUBLISH_SYNC_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS,
  TECHNICAL_AUDIT_RULE_VERSION,
  TECHNICAL_AUDIT_V6_ITEM_IDS,
  TECHNICAL_AUDIT_V5_ITEM_IDS,
  type TechnicalAuditItem,
  type TechnicalAuditSnapshot,
} from '../src/technical-audit.ts'
import type {
  ContentAuditCheckpoint,
  ContentAuditCheckpointClaim,
  ContentAuditCheckpointDecision,
  ContentAuditCheckpointSharedLocation,
  ContentAuditEvidence,
  ContentAuditExecutionError,
  ContentAuditIssue,
  ContentAuditIssueType,
  ContentAuditItem,
  ContentAuditLocation,
  ContentAuditProgress,
  ContentAuditRecord,
  ContentAuditRisk,
  ContentAuditResult,
  ContentAuditSource,
  ContentAuditUsage,
} from '../src/content-audit.ts'
import { abortAiTaskControllersById } from './ai-task-runtime.ts'

/**
 * A point-in-time partial audit result emitted by the pure runner.  This is
 * deliberately kept structural here so the persistence layer does not need a
 * runtime dependency on the runner module.
 */
export type ContentAuditProgressSnapshot = {
  result: ContentAuditResult
  executionErrors: ContentAuditExecutionError[]
  usage: ContentAuditUsage
  checkpoint?: ContentAuditCheckpoint
}

const expectedDatabase = 'geodesk'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const envFile = join(projectRoot, '.env.local')
const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))

let envLoadFailed = false
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile)
  } catch {
    envLoadFailed = true
  }
}

let pool: Pool | undefined

export type Project = {
  id: string
  companyName: string
  websiteUrl: string | null
  optimizationTarget: string | null
  supplementalInfo: string | null
  questionsGeneratedAt: string | null
  questionsLockedAt: string | null
  diagnosisStartedAt: string | null
  initialDiagnosisCompletedAt: string | null
  initialDiagnosisStatus: 'not_started' | 'running' | 'analyzing' | 'completed' | 'failed'
  initialRecommendationRate: number | null
  initialOfficialCitationRate: number | null
  initialDiagnosisAt: string | null
  latestMonitoringAt: string | null
  latestRecommendationRate: number | null
  latestOfficialCitationRate: number | null
  websiteLockedAt: string | null
  websiteCrawlStatus: 'not_started' | 'crawling' | 'completed' | 'failed'
  websiteCrawlStartedAt: string | null
  websiteCrawlCompletedAt: string | null
  websiteCrawlError: string | null
  websiteCrawlSource: 'sitemap' | 'links' | null
  websiteCrawlIncomplete: boolean
  websitePagesDiscovered: number
  websitePagesSucceeded: number
  websitePagesFailed: number
  questionsGenerationStatus: 'not_started' | 'generating' | 'completed' | 'failed'
  questionsGenerationStartedAt: string | null
  questionsGenerationCompletedAt: string | null
  questionsGenerationError: string | null
  createdAt: string
  updatedAt: string
}

export type Question = {
  id: string
  position: number
  question: string
  generatedAt: string
  category: QuestionCategory | null
  isLocked: boolean
}

export type WebsiteCrawlSummary = {
  status: Project['websiteCrawlStatus']
  source: Project['websiteCrawlSource']
  incomplete: boolean
  error: string | null
  discoveredCount: number
  successCount: number
  failedCount: number
  startedAt: string | null
  completedAt: string | null
}

export type QuestionsGenerationSummary = {
  status: Project['questionsGenerationStatus']
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export type QuestionGenerationPreparation = {
  project: Project
  pages: WebsitePageResult[]
  lockedQuestions: Question[]
  /**
   * A database-issued timestamp token.  It is kept separate from the
   * user-facing ISO value because node-postgres converts timestamptz values
   * to millisecond Dates, while the database may retain microseconds.
   */
  generationToken: string
}

export type DiagnosisRun = {
  id: string
  runType: 'initial' | 'monitoring'
  status: 'running' | 'analyzing' | 'completed' | 'failed'
  requestedModel: string | null
  roundNumber: number
  publishedArticleCount: number | null
  startedAt: string
  completedAt: string | null
  summaryAnalysis: unknown | null
  summaryModel: string | null
  summaryError: string | null
  recommendationRate: number | null
  officialCitationRate: number | null
}

export type DiagnosisAnswer = DiagnosisAnswerState

export type DiagnosisReportRefreshStatus = 'not_started' | 'running' | 'ready' | 'failed'

export type InitialDiagnosis = {
  run: DiagnosisRun | null
  answers: DiagnosisAnswer[]
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  reportRefreshStatus?: DiagnosisReportRefreshStatus
  reportRefreshStartedAt?: string | null
  reportRefreshError?: string | null
}

export type MonitoringRun = DiagnosisRun & { runType: 'monitoring'; answers: DiagnosisAnswer[] }

export type ArticlePublishStatus = 'pending' | 'published'
export type ArticleWritingStatus = 'pending' | 'writing' | 'ready' | 'failed'

export type ProjectArticle = {
  id: string
  projectId: string
  batchId: string
  title: string
  questionPositions: number[]
  contentHtml: string | null
  generatedAt: string
  updatedAt: string
  publishStatus: ArticlePublishStatus
  confirmedAt: string | null
  writingStatus: ArticleWritingStatus
  writingError: string | null
  optimizationType: string
  optimizationDirection: string | null
  targetPageUrl: string | null
  targetPageTitle: string | null
}

export type ArticleBatch = {
  id: string
  projectId: string
  requestedModel: string
  responseModel: string | null
  generatedAt: string
  articles: ProjectArticle[]
}

export type DeliveryReportMetadata = {
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  sourceRunId: string | null
}

export type ProjectDetail = Project & {
  websiteCrawl: WebsiteCrawlSummary
  questionsGeneration: QuestionsGenerationSummary
  questions: Question[]
  initialDiagnosis: InitialDiagnosis
  monitoringRuns: MonitoringRun[]
  articleBatches: ArticleBatch[]
  deliveryReport: DeliveryReportMetadata
}

export type ProjectInput = {
  companyName?: unknown
  websiteUrl?: unknown
  optimizationTarget?: unknown
  supplementalInfo?: unknown
  /** Required only when the normalized profile actually changes. */
  resetConfirmed?: unknown
  /** Public millisecond timestamp read when the edit form was opened. */
  expectedUpdatedAt?: unknown
}

function databaseConfig(): PoolConfig {
  if (envLoadFailed) {
    throw new Error('Database configuration is unavailable')
  }

  // Unit tests replace `pg.Pool` with an in-memory adapter.  Keep that
  // adapter independent from a developer's environment while preserving a
  // hard configuration failure for every real runtime.
  if (process.env.NODE_ENV === 'test') {
    return {
      host: '127.0.0.1',
      port: 5432,
      database: expectedDatabase,
      user: 'test',
      password: 'test',
      max: 4,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 5_000,
    }
  }

  const host = process.env.PGHOST?.trim()
  const portValue = process.env.PGPORT?.trim()
  const database = process.env.PGDATABASE?.trim()
  const user = process.env.PGUSER?.trim()
  const password = process.env.PGPASSWORD
  const port = Number(portValue)

  if (!host || !portValue || !Number.isInteger(port) || port < 1 || port > 65535 || !database || !user || !password) {
    throw new Error('Database configuration is incomplete')
  }

  return {
    host,
    port,
    database,
    user,
    password,
    max: 4,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000,
  }
}

export function databasePool(): Pool {
  if (!pool) {
    pool = new Pool(databaseConfig())
  }

  return pool
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  // node-postgres parses timestamptz columns as Date instances.  Date#toString
  // omits milliseconds, which would make the public CAS token differ from the
  // value read by the edit form.  Preserve the Date's ISO millisecond value
  // before handling text/numeric test adapters and legacy records.
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

function nullableRate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const DIAGNOSIS_REPORT_REFRESH_STATUS_VALUES = new Set<DiagnosisReportRefreshStatus>([
  'not_started',
  'running',
  'ready',
  'failed',
])

function diagnosisReportRefreshStatus(value: unknown): DiagnosisReportRefreshStatus {
  return DIAGNOSIS_REPORT_REFRESH_STATUS_VALUES.has(value as DiagnosisReportRefreshStatus)
    ? value as DiagnosisReportRefreshStatus
    : 'not_started'
}

function pdfBytes(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value !== 'string') return null
  // node-postgres returns BYTEA as a Buffer.  The two string forms below are
  // only compatibility for isolated adapters and old callers; a malformed
  // value is rejected rather than being exposed as a downloadable report.
  const direct = Buffer.from(value)
  if (direct.length >= 5 && direct.subarray(0, 5).toString('ascii') === '%PDF-') return direct
  const decoded = Buffer.from(value, 'base64')
  return decoded.length >= 5 && decoded.subarray(0, 5).toString('ascii') === '%PDF-' ? decoded : null
}

function projectFromRow(row: Record<string, unknown>): Project {
  const crawlStatus = String(row.website_crawl_status ?? 'not_started')
  const questionStatus = String(row.questions_generation_status ?? 'not_started')
  return {
    id: String(row.id),
    companyName: String(row.company_name),
    websiteUrl: (row.website_url as string | null) ?? null,
    optimizationTarget: (row.optimization_target as string | null) ?? null,
    supplementalInfo: (row.supplemental_info as string | null) ?? null,
    questionsGeneratedAt: nullableIso(row.questions_generated_at),
    questionsLockedAt: nullableIso(row.questions_locked_at),
    diagnosisStartedAt: nullableIso(row.diagnosis_started_at),
    initialDiagnosisCompletedAt: nullableIso(row.initial_diagnosis_completed_at),
    initialDiagnosisStatus: String(row.initial_diagnosis_status ?? 'not_started') as Project['initialDiagnosisStatus'],
    initialRecommendationRate: nullableRate(row.initial_recommendation_rate),
    initialOfficialCitationRate: nullableRate(row.initial_official_citation_rate),
    initialDiagnosisAt: nullableIso(row.initial_diagnosis_at),
    latestMonitoringAt: nullableIso(row.latest_monitoring_at),
    latestRecommendationRate: nullableRate(row.latest_monitoring_recommendation_rate),
    latestOfficialCitationRate: nullableRate(row.latest_monitoring_official_citation_rate),
    websiteLockedAt: nullableIso(row.website_locked_at),
    websiteCrawlStatus: crawlStatus as Project['websiteCrawlStatus'],
    websiteCrawlStartedAt: nullableIso(row.website_crawl_started_at),
    websiteCrawlCompletedAt: nullableIso(row.website_crawl_completed_at),
    websiteCrawlError: (row.website_crawl_error as string | null) ?? null,
    websiteCrawlSource: (row.website_crawl_source as Project['websiteCrawlSource']) ?? null,
    websiteCrawlIncomplete: Boolean(row.website_crawl_incomplete),
    websitePagesDiscovered: Number(row.website_pages_discovered ?? 0),
    websitePagesSucceeded: Number(row.website_pages_succeeded ?? 0),
    websitePagesFailed: Number(row.website_pages_failed ?? 0),
    questionsGenerationStatus: questionStatus as Project['questionsGenerationStatus'],
    questionsGenerationStartedAt: nullableIso(row.questions_generation_started_at),
    questionsGenerationCompletedAt: nullableIso(row.questions_generation_completed_at),
    questionsGenerationError: (row.questions_generation_error as string | null) ?? null,
    createdAt: nullableIso(row.created_at) as string,
    updatedAt: nullableIso(row.updated_at) as string,
  }
}

const projectColumns = `
  id,
  company_name,
  website_url,
  optimization_target,
  supplemental_info,
  questions_generated_at,
  questions_locked_at,
  diagnosis_started_at,
  initial_diagnosis_completed_at,
  initial_diagnosis_status,
  initial_recommendation_rate,
  initial_official_citation_rate,
  initial_diagnosis_at,
  website_locked_at,
  website_crawl_status,
  website_crawl_started_at,
  website_crawl_completed_at,
  website_crawl_error,
  website_crawl_source,
  website_crawl_incomplete,
  website_pages_discovered,
  website_pages_succeeded,
  website_pages_failed,
  questions_generation_status,
  questions_generation_started_at,
  questions_generation_completed_at,
  questions_generation_error,
  created_at,
  updated_at
`

const CONTENT_AUDIT_STATUS_VALUES = new Set(['checking', 'completed', 'failed'])
const CONTENT_AUDIT_PROGRESS_STAGES = new Set(['cleaning', 'extracting', 'checking'])
const CONTENT_AUDIT_ISSUE_TYPES = new Set<ContentAuditIssueType>(['conflict', 'incomplete', 'risk'])
const CONTENT_AUDIT_CHECKPOINT_MAX_PAGES = 10_000
const CONTENT_AUDIT_CHECKPOINT_MAX_CLAIMS_PER_PAGE = 10_000
const CONTENT_AUDIT_CHECKPOINT_MAX_CONFLICTS = 100_000

type StoredContentAuditExecutionError = ContentAuditExecutionError & {
  statement?: string
  sourceUrl?: string
  attempts?: number
  resolution?: string
}

function checkpointString(value: unknown, maxChars: number): string | null {
  return safeContentAuditText(value, maxChars)
}

function contentAuditCheckpointDecisionFromValue(value: unknown): ContentAuditCheckpointDecision | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.detected !== 'boolean') return undefined
  const reason = checkpointString(record.reason, 8_000)
  const suggestion = checkpointString(record.suggestion, 8_000)
  if (reason === null || suggestion === null) return undefined
  return { detected: record.detected, reason, suggestion }
}

function contentAuditCheckpointSharedLocationFromValue(value: unknown): ContentAuditCheckpointSharedLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const page = checkpointString(record.page, 8_000)
  const pageUrl = checkpointString(record.pageUrl, 8_000)
  const statement = checkpointString(record.statement, CONTENT_AUDIT_STATEMENT_MAX_CHARS)
  const context = checkpointString(record.context, CONTENT_AUDIT_FIELD_MAX_CHARS)
  const cleanText = checkpointString(record.cleanText, CONTENT_AUDIT_STATEMENT_MAX_CHARS)
  if (page === null || pageUrl === null || statement === null || context === null || cleanText === null) return null
  if (![record.rawStart, record.rawEnd].every((entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)) return null
  if ((record.rawEnd as number) <= (record.rawStart as number)) return null
  return {
    page,
    pageUrl,
    rawStart: record.rawStart as number,
    rawEnd: record.rawEnd as number,
    statement,
    context,
    cleanText,
  }
}

function contentAuditCheckpointClaimFromValue(value: unknown): ContentAuditCheckpointClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stringFields = ['statement', 'subject', 'timeScope', 'conditions', 'explanation', 'quote', 'page', 'pageUrl', 'location', 'context']
  const fields = new Map(stringFields.map((key) => [key, checkpointString(record[key], key === 'statement' || key === 'quote' ? CONTENT_AUDIT_STATEMENT_MAX_CHARS : CONTENT_AUDIT_FIELD_MAX_CHARS)]))
  if ([...fields.values()].some((entry) => entry === null)) return null
  if (typeof record.comparable !== 'boolean' || (record.origin !== 'title' && record.origin !== 'body')) return null
  const risk = contentAuditCheckpointDecisionFromValue(record.risk)
  const incomplete = contentAuditCheckpointDecisionFromValue(record.incomplete)
  if (risk === undefined || incomplete === undefined) return null
  const sourceIds = record.sourceIds === undefined
    ? undefined
    : Array.isArray(record.sourceIds) && record.sourceIds.length <= 128 && record.sourceIds.every((entry) => typeof entry === 'string')
      ? record.sourceIds.map((entry) => checkpointString(entry, CONTENT_AUDIT_FIELD_MAX_CHARS) as string)
      : null
  if (sourceIds === null) return null
  const sourceId = record.sourceId === undefined ? undefined : checkpointString(record.sourceId, CONTENT_AUDIT_FIELD_MAX_CHARS)
  if (record.sourceId !== undefined && sourceId === null) return null
  const normalizedSourceId = sourceId === null ? undefined : sourceId
  const section = record.section === undefined ? undefined : checkpointString(record.section, CONTENT_AUDIT_FIELD_MAX_CHARS)
  if (record.section !== undefined && section === null) return null
  const normalizedSection = section === null ? undefined : section
  const rawStart = record.rawStart === undefined ? undefined : record.rawStart
  const rawEnd = record.rawEnd === undefined ? undefined : record.rawEnd
  if ((rawStart !== undefined && (typeof rawStart !== 'number' || !Number.isSafeInteger(rawStart) || rawStart < 0))
    || (rawEnd !== undefined && (typeof rawEnd !== 'number' || !Number.isSafeInteger(rawEnd) || rawEnd < 0))) return null
  if (rawStart !== undefined && rawEnd !== undefined && rawEnd <= rawStart) return null
  const sharedLocations = record.sharedLocations === undefined
    ? undefined
    : Array.isArray(record.sharedLocations) && record.sharedLocations.length <= 128
      ? record.sharedLocations.map(contentAuditCheckpointSharedLocationFromValue)
      : null
  if (sharedLocations === null || sharedLocations?.some((entry) => entry === null)) return null
  return {
    statement: fields.get('statement') as string,
    subject: fields.get('subject') as string,
    timeScope: fields.get('timeScope') as string,
    conditions: fields.get('conditions') as string,
    explanation: fields.get('explanation') as string,
    quote: fields.get('quote') as string,
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(normalizedSourceId === undefined ? {} : { sourceId: normalizedSourceId }),
    comparable: record.comparable,
    origin: record.origin,
    ...(normalizedSection === undefined ? {} : { section: normalizedSection }),
    risk,
    incomplete,
    ...(rawStart === undefined ? {} : { rawStart }),
    ...(rawEnd === undefined ? {} : { rawEnd }),
    ...(sharedLocations === undefined ? {} : { sharedLocations: sharedLocations as ContentAuditCheckpointSharedLocation[] }),
    page: fields.get('page') as string,
    pageUrl: fields.get('pageUrl') as string,
    location: fields.get('location') as string,
    context: fields.get('context') as string,
  }
}

function contentAuditCheckpointFromValue(value: unknown): ContentAuditCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.completedPages !== 'number' || !Number.isSafeInteger(record.completedPages) || record.completedPages < 0
    || typeof record.totalClaims !== 'number' || !Number.isSafeInteger(record.totalClaims) || record.totalClaims < 0
    || typeof record.processedClaims !== 'number' || !Number.isSafeInteger(record.processedClaims) || record.processedClaims < 0
    || record.processedClaims > record.totalClaims
    || !Array.isArray(record.pageClaims) || record.pageClaims.length > CONTENT_AUDIT_CHECKPOINT_MAX_PAGES
    || !Array.isArray(record.excludedPages) || !Array.isArray(record.internalConflicts)) return null
  const completedPages = record.completedPages as number
  const pageClaims: Array<{ pageIndex: number; claims: ContentAuditCheckpointClaim[] }> = []
  for (const entry of record.pageClaims) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const page = entry as Record<string, unknown>
    if (typeof page.pageIndex !== 'number' || !Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0
      || !Array.isArray(page.claims) || page.claims.length > CONTENT_AUDIT_CHECKPOINT_MAX_CLAIMS_PER_PAGE) return null
    const claims = page.claims.map(contentAuditCheckpointClaimFromValue)
    if (claims.some((claim) => claim === null)) return null
    pageClaims.push({ pageIndex: page.pageIndex, claims: claims as ContentAuditCheckpointClaim[] })
  }
  const indexes = new Set(pageClaims.map((entry) => entry.pageIndex))
  if (pageClaims.length !== indexes.size || pageClaims.some((entry) => entry.pageIndex >= completedPages)
    || [...Array(completedPages).keys()].some((index) => !indexes.has(index))) return null
  const excludedPages = record.excludedPages.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const page = entry as Record<string, unknown>
    const url = checkpointString(page.url, 8_000)
    const reason = checkpointString(page.reason, 8_000)
    return url === null || reason === null ? null : { url, reason }
  })
  if (excludedPages.some((entry) => entry === null)) return null
  const internalConflicts = record.internalConflicts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const conflict = entry as Record<string, unknown>
    const key = checkpointString(conflict.key, 40_000)
    const counterpartKeys = Array.isArray(conflict.counterpartKeys)
      ? conflict.counterpartKeys.map((item) => checkpointString(item, 40_000))
      : null
    const reasons = Array.isArray(conflict.reasons) ? conflict.reasons.map((item) => checkpointString(item, 8_000)) : null
    const suggestions = Array.isArray(conflict.suggestions) ? conflict.suggestions.map((item) => checkpointString(item, 8_000)) : null
    if (key === null || counterpartKeys === null || reasons === null || suggestions === null
      || counterpartKeys.some((item) => item === null) || reasons.some((item) => item === null) || suggestions.some((item) => item === null)) return null
    return {
      key,
      counterpartKeys: counterpartKeys as string[],
      reasons: reasons as string[],
      suggestions: suggestions as string[],
    }
  })
  if (internalConflicts.some((entry) => entry === null)) return null
  return {
    version: 1,
    completedPages,
    totalClaims: record.totalClaims,
    processedClaims: record.processedClaims,
    pageClaims,
    excludedPages: excludedPages as Array<{ url: string; reason: string }>,
    internalConflicts: internalConflicts as Array<{ key: string; counterpartKeys: string[]; reasons: string[]; suggestions: string[] }>,
  }
}

function contentAuditRecordFromValue(value: unknown): ContentAuditRecord | null {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return null
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const record = candidate as Record<string, unknown>
  if (typeof record.status !== 'string' || !CONTENT_AUDIT_STATUS_VALUES.has(record.status)) return null
  if (typeof record.startedAt !== 'string' || !record.startedAt.trim()) return null
  if (record.completedAt !== null && typeof record.completedAt !== 'string') return null
  const progress = contentAuditProgressFromValue(record.progress)
  if (!progress) return null
  // A checking/failed record is only a lifecycle/error marker.  Previous
  // successful output is read from the separate history column and attached
  // as optional view data by getContentAuditRecord(); it must never be
  // accepted as the current partial result.
  if (record.status !== 'completed' && record.result !== null) return null
  const result = record.result === null ? null : contentAuditResultFromValue(record.result)
  if (record.result !== null && !result) return null
  if (typeof record.error !== 'string' && record.error !== null) return null
  if (!Array.isArray(record.executionErrors)) return null
  const executionErrors = record.executionErrors.map((entry) => contentAuditExecutionErrorFromValue(entry))
  if (executionErrors.some((entry) => entry === null)) return null
  const usage = contentAuditUsageFromValue(record.usage)
  if (!usage) return null
  const checkpoint = record.checkpoint === undefined ? undefined : contentAuditCheckpointFromValue(record.checkpoint)
  if (record.checkpoint !== undefined && !checkpoint) return null
  // Return the allowlisted/sanitized error shape rather than the raw JSONB
  // value.  This keeps legacy records readable while preventing old records
  // from re-exposing credentials, query tokens, or internal-only fields.
  const parsed: ContentAuditRecord = {
    status: record.status as ContentAuditRecord['status'],
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    progress,
    result,
    error: record.error === null ? null : safeContentAuditError(record.error),
    executionErrors: executionErrors as StoredContentAuditExecutionError[],
    usage,
  }
  // Checkpoints are only for the server-side retry path.  Keep the property
  // accessible to the service while excluding it from project/audit JSON
  // responses and browser payloads.
  if (checkpoint) Object.defineProperty(parsed, 'checkpoint', { value: checkpoint, enumerable: false })
  return parsed
}

export { contentAuditRecordFromValue }

export async function checkDatabase(): Promise<{ ok: true; database: typeof expectedDatabase }> {
  const result = await databasePool().query<{ database: string }>('select current_database() as database')
  const database = result.rows[0]?.database

  if (database !== expectedDatabase) {
    throw new Error('Unexpected database')
  }

  return { ok: true, database: expectedDatabase }
}

export async function checkSchema(): Promise<void> {
  const activePool = databasePool()
  await activePool.query('select 1 from geo_projects limit 1')
  await activePool.query('select 1 from geo_project_website_pages limit 1')
  await activePool.query('select 1 from geo_project_questions limit 1')
  await activePool.query('select 1 from geo_diagnosis_runs limit 1')
  await activePool.query('select 1 from geo_diagnosis_answers limit 1')
  await activePool.query('select 1 from geo_article_batches limit 1')
  await activePool.query('select 1 from geo_project_articles limit 1')
  const columns = await activePool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = current_schema()
       and ((table_name = 'geo_projects' and column_name in ('initial_diagnosis_status', 'initial_recommendation_rate', 'initial_official_citation_rate', 'initial_diagnosis_at', 'technical_audit', 'content_audit', 'content_audit_history', 'questions_generation_task_id'))
         or (table_name = 'geo_diagnosis_runs' and column_name in ('status', 'run_type', 'requested_model', 'round_number', 'published_article_count', 'summary_analysis', 'recommendation_rate', 'official_citation_rate', 'report_pdf', 'report_pdf_generated_at', 'report_refresh_status', 'report_refresh_started_at', 'report_refresh_error', 'diagnosis_ai_task_id'))
         or (table_name = 'geo_diagnosis_answers' and column_name in ('answer_text', 'citation_urls', 'response_model', 'recommended', 'official_citation'))
         or (table_name = 'geo_article_batches' and column_name in ('project_id', 'requested_model', 'response_model', 'generated_at'))
         or (table_name = 'geo_project_questions' and column_name in ('id', 'project_id', 'position', 'question', 'generated_at', 'category', 'is_locked'))
         or (table_name = 'geo_project_articles' and column_name in ('project_id', 'batch_id', 'title', 'question_position', 'question_positions', 'content_html', 'publish_status', 'confirmed_at', 'writing_status', 'writing_error', 'writing_attempt_token', 'writing_started_at', 'writing_lease_expires_at', 'updated_at', 'optimization_type', 'optimization_direction', 'target_page_url', 'target_page_title', 'source_website_url', 'source_website_crawl_started_at', 'source_diagnosis_run_id')))` ,
  )
  const columnKeys = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`))
  const requiredColumns = [
    'geo_projects.initial_diagnosis_status',
    'geo_projects.initial_recommendation_rate',
    'geo_projects.initial_official_citation_rate',
    'geo_projects.initial_diagnosis_at',
    'geo_projects.technical_audit',
    'geo_projects.content_audit',
    'geo_projects.content_audit_history',
    'geo_projects.questions_generation_task_id',
    'geo_project_questions.category',
    'geo_project_questions.is_locked',
    'geo_diagnosis_runs.status',
    'geo_diagnosis_runs.run_type',
    'geo_diagnosis_runs.requested_model',
    'geo_diagnosis_runs.round_number',
    'geo_diagnosis_runs.published_article_count',
    'geo_diagnosis_runs.summary_analysis',
    'geo_diagnosis_runs.recommendation_rate',
    'geo_diagnosis_runs.official_citation_rate',
    'geo_diagnosis_runs.report_pdf',
    'geo_diagnosis_runs.report_pdf_generated_at',
    'geo_diagnosis_runs.report_refresh_status',
    'geo_diagnosis_runs.report_refresh_started_at',
    'geo_diagnosis_runs.report_refresh_error',
    'geo_diagnosis_runs.diagnosis_ai_task_id',
    'geo_diagnosis_answers.answer_text',
    'geo_diagnosis_answers.citation_urls',
    'geo_diagnosis_answers.response_model',
    'geo_diagnosis_answers.recommended',
    'geo_diagnosis_answers.official_citation',
    'geo_article_batches.project_id',
    'geo_article_batches.requested_model',
    'geo_article_batches.response_model',
    'geo_article_batches.generated_at',
    'geo_project_articles.project_id',
    'geo_project_articles.batch_id',
    'geo_project_articles.title',
    'geo_project_articles.question_position',
    'geo_project_articles.question_positions',
    'geo_project_articles.content_html',
    'geo_project_articles.publish_status',
    'geo_project_articles.confirmed_at',
    'geo_project_articles.writing_status',
    'geo_project_articles.writing_error',
    'geo_project_articles.writing_attempt_token',
    'geo_project_articles.writing_started_at',
    'geo_project_articles.writing_lease_expires_at',
    'geo_project_articles.updated_at',
    'geo_project_articles.optimization_type',
    'geo_project_articles.optimization_direction',
    'geo_project_articles.target_page_url',
    'geo_project_articles.target_page_title',
    'geo_project_articles.source_website_url',
    'geo_project_articles.source_website_crawl_started_at',
    'geo_project_articles.source_diagnosis_run_id',
  ]
  if (requiredColumns.some((column) => !columnKeys.has(column))) throw new Error('Initial diagnosis schema is incomplete')
  const constraints = await activePool.query<{ conname: string }>(
    `select conname from pg_constraint
     where connamespace = current_schema()::regnamespace
       and conrelid in ('geo_projects'::regclass, 'geo_project_questions'::regclass, 'geo_diagnosis_runs'::regclass,
                        'geo_diagnosis_answers'::regclass, 'geo_project_articles'::regclass)
       and conname in ('geo_projects_company_name_unique', 'geo_projects_content_audit_history_array_check', 'geo_project_questions_category_check',
                       'geo_diagnosis_runs_type_check', 'geo_diagnosis_runs_report_refresh_status_check',
                       'geo_diagnosis_runs_round_check', 'geo_diagnosis_runs_published_article_count_check',
                       'geo_diagnosis_answers_run_position_unique', 'geo_project_articles_question_position_check',
                       'geo_project_articles_question_positions_check', 'geo_project_articles_title_not_blank',
                       'geo_project_articles_content_not_blank', 'geo_project_articles_publish_status_check',
                       'geo_project_articles_writing_status_check', 'geo_project_articles_writing_content_check',
                       'geo_project_articles_optimization_type_not_blank', 'geo_project_articles_optimization_direction_check', 'geo_project_articles_published_ready_check')`,
  )
  const constraintNames = new Set(constraints.rows.map((row) => row.conname))
  const indexes = await activePool.query<{ indexname: string }>(
    `select indexname from pg_indexes
     where schemaname = current_schema()
       and indexname in ('geo_project_articles_project_pending_title_unique',
                         'geo_project_articles_project_pending_target_unique',
                         'geo_diagnosis_runs_project_round_unique',
                         'geo_diagnosis_runs_project_initial_unique',
                         'geo_diagnosis_runs_one_unfinished_monitoring_unique',
                         'geo_diagnosis_runs_report_refresh_idx')`,
  )
  const indexNames = new Set(indexes.rows.map((row) => row.indexname))
  if (![...constraintNames].includes('geo_projects_company_name_unique')
    || !constraintNames.has('geo_projects_content_audit_history_array_check')
    || !constraintNames.has('geo_project_questions_category_check')
    || !constraintNames.has('geo_diagnosis_runs_type_check')
    || !constraintNames.has('geo_diagnosis_runs_report_refresh_status_check')
    || !constraintNames.has('geo_diagnosis_runs_round_check')
    || !constraintNames.has('geo_diagnosis_runs_published_article_count_check')
    || !constraintNames.has('geo_diagnosis_answers_run_position_unique')
    || !constraintNames.has('geo_project_articles_question_position_check')
    || !constraintNames.has('geo_project_articles_question_positions_check')
    || !constraintNames.has('geo_project_articles_title_not_blank')
    || !constraintNames.has('geo_project_articles_content_not_blank')
    || !constraintNames.has('geo_project_articles_publish_status_check')
    || !constraintNames.has('geo_project_articles_writing_status_check')
    || !constraintNames.has('geo_project_articles_writing_content_check')
    || !constraintNames.has('geo_project_articles_optimization_type_not_blank')
    || !constraintNames.has('geo_project_articles_optimization_direction_check')
    || !constraintNames.has('geo_project_articles_published_ready_check')
    || !indexNames.has('geo_project_articles_project_pending_title_unique')
    || !indexNames.has('geo_project_articles_project_pending_target_unique')
    || !indexNames.has('geo_diagnosis_runs_project_round_unique')
    || !indexNames.has('geo_diagnosis_runs_project_initial_unique')
    || !indexNames.has('geo_diagnosis_runs_one_unfinished_monitoring_unique')
    || !indexNames.has('geo_diagnosis_runs_report_refresh_idx')) {
    throw new Error('Initial diagnosis constraints are incomplete')
  }
}

export async function runMigrations(): Promise<string[]> {
  const activePool = databasePool()
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()

  await activePool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const applied: string[] = []
  for (const file of files) {
    const existing = await activePool.query<{ version: string }>('select version from schema_migrations where version = $1', [file])
    if (existing.rowCount) {
      continue
    }

    const sql = await readFile(join(migrationsDirectory, file), 'utf8')
    const client = await activePool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('insert into schema_migrations (version) values ($1)', [file])
      await client.query('COMMIT')
      applied.push(file)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return applied
}

export async function listProjects(search = ''): Promise<Project[]> {
  const result = await databasePool().query(
    `select p.*,
            latest.recommendation_rate as latest_monitoring_recommendation_rate,
            latest.official_citation_rate as latest_monitoring_official_citation_rate,
            monitoring_time.started_at as latest_monitoring_at
     from geo_projects p
     left join lateral (
       select recommendation_rate, official_citation_rate, completed_at
       from geo_diagnosis_runs
       where project_id = p.id and run_type = 'monitoring' and status = 'completed'
       order by round_number desc
       limit 1
     ) latest on true
     left join lateral (
       select started_at
       from geo_diagnosis_runs
       where project_id = p.id and run_type = 'monitoring'
       order by started_at desc, round_number desc
       limit 1
     ) monitoring_time on true
     where ($1 = '' or p.company_name ilike '%' || $1 || '%')
     order by p.updated_at desc, p.id desc`,
    [search.trim()],
  )
  return result.rows.map(projectFromRow)
}

export async function getProject(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<Project | null> {
  const executor = queryClient ?? databasePool()
  const result = await executor.query(
    `select p.*,
            latest.recommendation_rate as latest_monitoring_recommendation_rate,
            latest.official_citation_rate as latest_monitoring_official_citation_rate,
            monitoring_time.started_at as latest_monitoring_at
     from geo_projects p
     left join lateral (
       select recommendation_rate, official_citation_rate, completed_at
       from geo_diagnosis_runs
       where project_id = p.id and run_type = 'monitoring' and status = 'completed'
       order by round_number desc
       limit 1
     ) latest on true
     left join lateral (
       select started_at
       from geo_diagnosis_runs
       where project_id = p.id and run_type = 'monitoring'
       order by started_at desc, round_number desc
       limit 1
     ) monitoring_time on true
     where p.id = $1`,
    [id],
  )
  return result.rows[0] ? projectFromRow(result.rows[0]) : null
}

async function getQuestions(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<Question[]> {
  const result = await (queryClient ?? databasePool()).query(
    `select id, position, question, generated_at, category, is_locked
     from geo_project_questions
     where project_id = $1
     order by position`,
    [id],
  )
  return result.rows.map(questionFromRow)
}

function websitePageFromRow(row: Record<string, unknown>): WebsitePageResult {
  return {
    url: String(row.url),
    title: String(row.title ?? ''),
    bodyText: String(row.body_text ?? ''),
    status: row.status === 'success' ? 'success' : 'failed',
    error: (row.error as string | null) ?? null,
  }
}

export async function getWebsitePages(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<WebsitePageResult[]> {
  const executor = queryClient ?? databasePool()
  const result = await executor.query(
    `select url, title, body_text, status, error
     from geo_project_website_pages
     where project_id = $1
     order by id`,
    [id],
  )
  return result.rows.map(websitePageFromRow)
}

export type ContentAuditClaim = {
  project: Project
  pages: WebsitePageResult[]
  record: ContentAuditRecord
  /** The latest valid result used to re-check the current website. */
  previous?: ContentAuditRecord | null
}

/**
 * The current lifecycle record remains the only formal result.  When that
 * lifecycle is checking/failed, readers may also receive the last complete
 * history entry for an explicit "上一轮有效结果" display.  The previous
 * fields are intentionally omitted when there is no valid history so callers
 * cannot mistake a partial current result for an older result.
 */
export type ContentAuditReadRecord = ContentAuditRecord & {
  previousResult?: ContentAuditResult
  previousCompletedAt?: string
}

const emptyContentAuditUsage = (): ContentAuditUsage => ({
  modelCalls: 0,
  searchCalls: 0,
  sourceFetches: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  elapsedMs: 0,
})

function safeContentAuditError(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value ?? '')
  message = message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  message = redactContentAuditSecrets(message)
  return message.slice(0, 360) || '官网内容检查失败，请重试'
}

const CONTENT_AUDIT_STATEMENT_MAX_CHARS = 4_000
const CONTENT_AUDIT_FIELD_MAX_CHARS = 8_000

/**
 * Sanitize user/model supplied audit text without applying the shorter
 * execution-error limit.  Cached statements and comparison context need to
 * remain useful to the reviewer, while credentials and control characters
 * must never be persisted or returned.
 */
function safeContentAuditText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return redactContentAuditSecrets(cleaned).slice(0, maxChars)
}

function safeContentAuditField(value: unknown): string | null {
  const text = safeContentAuditText(value, CONTENT_AUDIT_FIELD_MAX_CHARS)
  return text && text.trim() ? text : null
}

function redactContentAuditSecrets(message: string): string {
  // Errors can originate in provider-controlled text.  Never retain bearer
  // credentials or API-key-shaped values in the project JSONB record.
  message = message
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|token|secret|password)\b\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 4 || !/(?:KEY|TOKEN|PASSWORD|SECRET|COOKIE)/i.test(key)) continue
    message = message.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]')
  }
  return message
}

function safeContentAuditPageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    // Query strings are not needed to identify a source page and may carry a
    // token.  They are deliberately omitted from persisted execution errors.
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().slice(0, 2_000)
  } catch {
    return null
  }
}

function safeContentAuditStatement(value: unknown): string | null {
  const statement = safeContentAuditText(value, CONTENT_AUDIT_STATEMENT_MAX_CHARS)
  return statement && statement.trim() ? statement : null
}

function contentAuditExecutionErrorFromValue(value: unknown): StoredContentAuditExecutionError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.stage !== 'string' || !entry.stage.trim() || typeof entry.message !== 'string' || !entry.message.trim()) return null
  const pageUrl = safeContentAuditPageUrl(entry.pageUrl)
  const sourceUrl = safeContentAuditPageUrl(entry.sourceUrl)
  const statement = safeContentAuditStatement(entry.statement)
  const attempts = typeof entry.attempts === 'number' && Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 && entry.attempts <= 1_000
    ? entry.attempts
    : null
  const resolution = typeof entry.resolution === 'string' && entry.resolution.trim()
    ? safeContentAuditError(entry.resolution)
    : null
  return {
    stage: entry.stage.trim().slice(0, 120),
    message: safeContentAuditError(entry.message),
    ...(pageUrl ? { pageUrl } : {}),
    ...(typeof entry.itemId === 'string' && entry.itemId.trim() ? { itemId: entry.itemId.trim().slice(0, 200) } : {}),
    ...(statement ? { statement } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(attempts !== null ? { attempts } : {}),
    ...(resolution ? { resolution } : {}),
  }
}

function contentAuditSourceFromValue(value: unknown): ContentAuditSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (typeof source.name !== 'string' || typeof source.origin !== 'string' || typeof source.sourceText !== 'string') return null
  if (source.versionAt !== undefined && source.versionAt !== null && typeof source.versionAt !== 'string') return null
  if (source.url !== undefined && source.url !== null && safeContentAuditPageUrl(source.url) === null) return null
  if (source.relation !== undefined && !['supports', 'contradicts', 'context'].includes(String(source.relation))) return null
  if (source.authorityReason !== undefined && typeof source.authorityReason !== 'string') return null
  return {
    name: source.name,
    origin: source.origin,
    sourceText: source.sourceText,
    ...(source.versionAt !== undefined ? { versionAt: source.versionAt as string | null } : {}),
    ...(source.url === null ? { url: undefined } : source.url !== undefined ? { url: safeContentAuditPageUrl(source.url) as string } : {}),
    ...(source.relation !== undefined ? { relation: source.relation as ContentAuditSource['relation'] } : {}),
    ...(source.authorityReason !== undefined ? { authorityReason: source.authorityReason as string } : {}),
  }
}

function contentAuditLocationFromValue(value: unknown): ContentAuditLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const location = value as Record<string, unknown>
  if (typeof location.page !== 'string'
    || typeof location.pageUrl !== 'string'
    || typeof location.statement !== 'string'
    || typeof location.location !== 'string'
    || typeof location.context !== 'string') return null
  const pageUrl = safeContentAuditPageUrl(location.pageUrl)
  const page = safeContentAuditText(location.page, CONTENT_AUDIT_FIELD_MAX_CHARS)
  const statement = safeContentAuditText(location.statement, CONTENT_AUDIT_STATEMENT_MAX_CHARS)
  const locationText = safeContentAuditText(location.location, CONTENT_AUDIT_FIELD_MAX_CHARS)
  const context = safeContentAuditText(location.context, CONTENT_AUDIT_FIELD_MAX_CHARS)
  if (!pageUrl || page === null || statement === null || locationText === null || context === null) return null
  return { page, pageUrl, statement, location: locationText, context }
}

function contentAuditRiskFromValue(value: unknown): ContentAuditRisk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const risk = value as Record<string, unknown>
  const reason = safeContentAuditField(risk.reason)
  const suggestion = safeContentAuditField(risk.suggestion)
  if (!reason || !suggestion) return null
  return { reason, suggestion }
}

function contentAuditIssueFromValue(value: unknown): ContentAuditIssue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const issue = value as Record<string, unknown>
  if (typeof issue.type !== 'string' || !CONTENT_AUDIT_ISSUE_TYPES.has(issue.type as ContentAuditIssueType)) return null
  const reason = safeContentAuditField(issue.reason)
  const suggestion = safeContentAuditField(issue.suggestion)
  if (!reason || !suggestion) return null
  return { type: issue.type as ContentAuditIssueType, reason, suggestion }
}

function contentAuditLocationsFromValue(value: unknown): ContentAuditLocation[] | null {
  if (!Array.isArray(value)) return null
  const locations: ContentAuditLocation[] = []
  for (const entry of value) {
    const parsed = contentAuditLocationFromValue(entry)
    if (!parsed) return null
    locations.push(parsed)
  }
  return locations
}

function contentAuditResultFromValue(value: unknown): ContentAuditResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const isInternalResult = result.scope === 'website_internal'
  if (result.scope !== undefined && !isInternalResult) return null
  if (result.checkedAt !== undefined && result.checkedAt !== null && typeof result.checkedAt !== 'string') return null
  if (!Array.isArray(result.items)) return null
  const items: ContentAuditItem[] = []
  for (const value of result.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id.trim()
      || typeof item.statement !== 'string' || !item.statement.trim()
      || typeof item.explanation !== 'string'
      || typeof item.page !== 'string' || !item.page.trim()) return null
    const hasConclusion = item.conclusion !== undefined
    let conclusion: ContentAuditItem['conclusion']
    if (hasConclusion) {
      if (!['supported', 'conflict', 'insufficient'].includes(String(item.conclusion))) return null
      conclusion = item.conclusion as ContentAuditItem['conclusion']
    }
    const hasRisk = item.risk !== undefined
    let risk: ContentAuditRisk | undefined
    if (hasRisk) {
      const parsedRisk = contentAuditRiskFromValue(item.risk)
      if (!parsedRisk) return null
      risk = parsedRisk
    }
    let issues: ContentAuditIssue[] | undefined
    if (item.issues !== undefined) {
      if (!Array.isArray(item.issues)) return null
      issues = []
      for (const issue of item.issues) {
        const parsedIssue = contentAuditIssueFromValue(issue)
        if (!parsedIssue) return null
        issues.push(parsedIssue)
      }
    }
    if (isInternalResult) {
      // New internal rows are issue-driven.  Legacy conclusions/risk and all
      // external source fields must never be reinterpreted as this check's
      // findings or silently carried into a new scoped result.
      if (hasConclusion || hasRisk || issues === undefined || issues.length === 0) return null
    } else if (!conclusion && !risk && (!issues || issues.length === 0)) {
      return null
    }
    if (isInternalResult && item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence)) {
      const rawEvidence = item.evidence as Record<string, unknown>
      if (rawEvidence.sources !== undefined || rawEvidence.sourceIssues !== undefined) return null
    }
    if (!item.evidence || typeof item.evidence !== 'object' || Array.isArray(item.evidence)) return null
    const evidence = item.evidence as Record<string, unknown>
    if (typeof evidence.statement !== 'string'
      || typeof evidence.page !== 'string'
      || typeof evidence.judgment !== 'string'
      || typeof evidence.suggestion !== 'string') return null
    if (evidence.pageUrl !== undefined && evidence.pageUrl !== null && safeContentAuditPageUrl(evidence.pageUrl) === null) return null
    if (evidence.checkedAt !== undefined && evidence.checkedAt !== null && typeof evidence.checkedAt !== 'string') return null
    if (evidence.pageExcerpt !== undefined && evidence.pageExcerpt !== null) {
      const excerpt = evidence.pageExcerpt as Record<string, unknown>
      if (!excerpt || typeof excerpt !== 'object' || Array.isArray(excerpt)
        || typeof excerpt.location !== 'string' || typeof excerpt.context !== 'string') return null
    }
    if (evidence.sources !== undefined) {
      if (!Array.isArray(evidence.sources)) return null
      for (const source of evidence.sources) {
        if (!contentAuditSourceFromValue(source)) return null
      }
    }
    let comparisons: ContentAuditLocation[] | undefined
    if (evidence.comparisons !== undefined) {
      const parsedComparisons = contentAuditLocationsFromValue(evidence.comparisons)
      if (!parsedComparisons) return null
      comparisons = parsedComparisons
    }
    let sourceIssues: ContentAuditExecutionError[] | undefined
    if (evidence.sourceIssues !== undefined) {
      if (!Array.isArray(evidence.sourceIssues)) return null
      sourceIssues = []
      for (const issue of evidence.sourceIssues) {
        const parsedIssue = contentAuditExecutionErrorFromValue(issue)
        if (!parsedIssue) return null
        sourceIssues.push(parsedIssue)
      }
    }
    const locations = item.locations === undefined ? undefined : contentAuditLocationsFromValue(item.locations)
    if (item.locations !== undefined && !locations) return null
    let section: string | undefined
    if (item.section !== undefined) {
      if (typeof item.section !== 'string') return null
      section = safeContentAuditField(item.section) ?? undefined
    }
    for (const key of ['subject', 'timeScope', 'conditions']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') return null
    }
    // Preserve legacy fields exactly.  Only the newly introduced fields are
    // replaced with their sanitized shapes so old records remain readable and
    // existing page/source evidence does not change as a side effect.
    const normalizedEvidence: ContentAuditEvidence = {
      ...(evidence as ContentAuditEvidence),
      ...(comparisons !== undefined ? { comparisons } : {}),
      ...(sourceIssues !== undefined ? { sourceIssues } : {}),
    }
    const normalizedItem = {
      ...(item as unknown as ContentAuditItem),
      ...(conclusion !== undefined ? { conclusion } : {}),
      evidence: normalizedEvidence,
      ...(risk !== undefined ? { risk } : {}),
      ...(issues !== undefined ? { issues } : {}),
      ...(locations !== undefined ? { locations } : {}),
      ...(section !== undefined ? { section } : {}),
    } as ContentAuditItem
    if (isInternalResult) {
      // Do not expose deprecated external-result fields even when a caller
      // supplied them as `undefined` properties in an in-memory object.
      delete (normalizedItem as unknown as Record<string, unknown>).conclusion
      delete (normalizedItem as unknown as Record<string, unknown>).risk
      const internalEvidence = normalizedItem.evidence as unknown as Record<string, unknown>
      delete internalEvidence.sources
      delete internalEvidence.sourceIssues
    }
    if (issues === undefined) delete (normalizedItem as unknown as Record<string, unknown>).issues
    if (section === undefined) delete (normalizedItem as unknown as Record<string, unknown>).section
    items.push(normalizedItem)
  }
  if (result.excludedPages !== undefined && (!Array.isArray(result.excludedPages) || result.excludedPages.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    const page = entry as Record<string, unknown>
    return typeof page.url !== 'string' || safeContentAuditPageUrl(page.url) === null || typeof page.reason !== 'string'
  }))) return null
  const normalizedResult = {
    ...(result as unknown as ContentAuditResult),
    ...(isInternalResult ? { scope: 'website_internal' as const } : {}),
    items,
  }
  if (!isInternalResult) delete (normalizedResult as unknown as Record<string, unknown>).scope
  return normalizedResult
}

function contentAuditProgressFromValue(value: unknown): ContentAuditProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const progress = value as Record<string, unknown>
  if (typeof progress.stage !== 'string' || !CONTENT_AUDIT_PROGRESS_STAGES.has(progress.stage)) return null
  const numbers = ['totalPages', 'processedPages', 'totalClaims', 'processedClaims']
  if (numbers.some((key) => typeof progress[key] !== 'number' || !Number.isSafeInteger(progress[key]) || (progress[key] as number) < 0)) return null
  const cleanedPages = progress.cleanedPages
  if (cleanedPages !== undefined
    && (typeof cleanedPages !== 'number' || !Number.isSafeInteger(cleanedPages) || cleanedPages < 0 || cleanedPages > (progress.totalPages as number))) return null
  if ((progress.processedPages as number) > (progress.totalPages as number)
    || (progress.processedClaims as number) > (progress.totalClaims as number)) return null
  const failedPages = progress.failedPages
  if (failedPages !== undefined
    && (typeof failedPages !== 'number' || !Number.isSafeInteger(failedPages) || failedPages < 0 || failedPages > (progress.totalPages as number))) return null
  const pendingPages = progress.pendingPages
  if (pendingPages !== undefined
    && (typeof pendingPages !== 'number' || !Number.isSafeInteger(pendingPages) || pendingPages < 0 || pendingPages > (progress.totalPages as number))) return null
  if (failedPages !== undefined && pendingPages !== undefined
    && (progress.processedPages as number) + failedPages + pendingPages !== (progress.totalPages as number)) return null
  const baselineReady = progress.baselineReady
  if (baselineReady !== undefined && typeof baselineReady !== 'boolean') return null
  const baselineSource = progress.baselineSource
  if (baselineSource !== undefined && baselineSource !== 'sitemap' && baselineSource !== 'links') return null
  return {
    stage: progress.stage as ContentAuditProgress['stage'],
    totalPages: progress.totalPages as number,
    ...(cleanedPages !== undefined ? { cleanedPages: cleanedPages as number } : {}),
    processedPages: progress.processedPages as number,
    ...(failedPages !== undefined ? { failedPages } : {}),
    ...(pendingPages !== undefined ? { pendingPages } : {}),
    ...(baselineReady !== undefined ? { baselineReady } : {}),
    ...(baselineSource !== undefined ? { baselineSource } : {}),
    totalClaims: progress.totalClaims as number,
    processedClaims: progress.processedClaims as number,
  }
}

function contentAuditUsageFromValue(value: unknown): ContentAuditUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const numbers = ['modelCalls', 'searchCalls', 'sourceFetches', 'inputTokens', 'outputTokens', 'totalTokens', 'elapsedMs']
  if (numbers.some((key) => typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || (usage[key] as number) < 0)) return null
  return {
    modelCalls: usage.modelCalls as number,
    searchCalls: usage.searchCalls as number,
    sourceFetches: usage.sourceFetches as number,
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
    totalTokens: usage.totalTokens as number,
    elapsedMs: usage.elapsedMs as number,
  }
}

function contentAuditHistoryFromValue(value: unknown): ContentAuditRecord[] {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return []
    }
  }
  if (!Array.isArray(candidate)) return []
  const valid = candidate
    .map((entry) => contentAuditRecordFromValue(entry))
    .filter((entry): entry is ContentAuditRecord => Boolean(entry && contentAuditResultEligible(entry)))
  // History is append-only in normal operation, but sorting defensively keeps
  // an imported/legacy array from changing which valid result is displayed.
  return valid.sort((left, right) => {
    const leftTime = Date.parse(left.completedAt ?? left.startedAt)
    const rightTime = Date.parse(right.completedAt ?? right.startedAt)
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.startedAt.localeCompare(right.startedAt)
  })
}

function latestContentAuditHistory(value: unknown): ContentAuditRecord | null {
  const history = contentAuditHistoryFromValue(value)
  return history.at(-1) ?? null
}

/** Read the one current content-audit record; malformed JSON is unavailable. */
export async function getContentAuditRecord(
  id: string,
  queryClient?: Pick<PoolClient, 'query'>,
): Promise<ContentAuditReadRecord | null> {
  const result = await (queryClient ?? databasePool()).query<{ content_audit: unknown; content_audit_history: unknown }>(
    `select content_audit, content_audit_history
       from geo_projects
      where id = $1
      /* Backward-compatible matcher for older test adapters: select content_audit from geo_projects */`,
    [id],
  )
  const value = result.rows[0]?.content_audit
  if (value === null || value === undefined) return null
  const record = contentAuditRecordFromValue(value)
  if (!record) throw new Error('content_audit_invalid')
  if (record.status === 'checking' || record.status === 'failed') {
    const previous = latestContentAuditHistory(result.rows[0]?.content_audit_history)
    if (previous?.result && previous.completedAt) {
      return {
        ...record,
        previousResult: previous.result,
        previousCompletedAt: previous.completedAt,
      }
    }
  }
  return record
}

export function contentAuditResultEligible(record: ContentAuditRecord | null): record is ContentAuditRecord & { status: 'completed'; result: ContentAuditResult } {
  if (!record || record.status !== 'completed' || !record.completedAt || !record.completedAt.trim() || record.error !== null) return false
  if (record.executionErrors.length !== 0) return false
  const result = contentAuditResultFromValue(record.result)
  // Only the current cached-website-internal check can unlock generation.
  // Records written by the former external-source check remain readable, but
  // are never relabeled, upgraded, or treated as a current result.
  if (!result || result.scope !== 'website_internal') return false
  const progress = contentAuditProgressFromValue(record.progress)
  if (!progress) return false
  if ((progress.failedPages ?? 0) !== 0 || (progress.pendingPages ?? 0) !== 0) return false
  return progress.processedPages === progress.totalPages
    && progress.processedClaims === progress.totalClaims
    // Reviewed candidates include clean ordinary/internal facts which may not
    // produce a visible row.  A result can therefore contain fewer findings,
    // but it can never contain more findings than candidates actually checked.
    && result.items.length <= progress.processedClaims
}

/**
 * A title plan is tied to the exact content-audit lifecycle that was read
 * before the model call.  A completed run must still satisfy the normal
 * generation predicate, while a failed run is a valid terminal input for a
 * plan that deliberately uses no website findings.  In neither case may a
 * newer/checking run be mistaken for the run that produced the model output.
 */
function contentAuditGenerationRoundMatches(record: ContentAuditRecord | null, startedAt: string): boolean {
  if (!record || record.startedAt !== startedAt) return false
  if (record.status === 'failed') return true
  return contentAuditResultEligible(record)
}

/** Re-check the exact completed content-audit run while holding the project
 * row lock.  Used for zero-title generations too, which do not create a
 * batch but must not report success after a newer/failed audit replaces it. */
export async function assertContentAuditCurrent(
  id: string,
  startedAt: string,
  queryClient?: PoolClient,
): Promise<void> {
  const client = queryClient ?? await databasePool().connect()
  const ownsClient = !queryClient
  try {
    await client.query('BEGIN')
    const result = await client.query<{ content_audit: unknown }>(
      'select content_audit from geo_projects where id = $1 for update',
      [id],
    )
    const record = contentAuditRecordFromValue(result.rows[0]?.content_audit)
    if (!result.rows[0] || !contentAuditGenerationRoundMatches(record, startedAt)) {
      throw new Error('content_audit_required')
    }
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep original failure */ }
    throw error
  } finally {
    if (ownsClient) client.release()
  }
}

/**
 * Claim a new audit run and return the saved pages that it may inspect.  The
 * row update is conditional on the previous record not being `checking`, so
 * concurrent POSTs can never both launch a run.  No network call or crawl is
 * performed here.
 */
export async function claimContentAudit(id: string, aiTaskId?: string): Promise<ContentAuditClaim | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns}, content_audit, content_audit_history
       from geo_projects
       where id = $1
       for update`,
      [id],
    )
    const row = projectResult.rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return null
    }
    const currentRecord = contentAuditRecordFromValue(row.content_audit)
    if (currentRecord?.status === 'checking') throw new Error('content_audit_in_progress')
    // Only complete, eligible history entries can seed a review.  A failed
    // or checking current record is never reused as if it were a prior valid
    // run.  The current completed record fallback keeps pre-018 databases
    // usable until their migration is applied; new writes always append to
    // content_audit_history before task completion.
    const previous = latestContentAuditHistory(row.content_audit_history)
      ?? (currentRecord && contentAuditResultEligible(currentRecord) ? currentRecord : null)
    const project = projectFromRow(row)
    if (!project.websiteUrl) throw new Error('website_required')
    if (project.websiteCrawlStatus === 'crawling') throw new Error('website_crawl_in_progress')

    // Content auditing now reads the configured website through the model's
    // bounded website-reading tool.  The existing question-generation crawl
    // is deliberately not an input gate and its page bodies never enter the
    // audit task.  Keep the legacy `pages` property empty for callers that
    // still use the structural claim type; it is not an audit data source.
    const pages: WebsitePageResult[] = []

    // The timestamp is both the public start time and the current-run guard
    // token.  The project row lock and conditional status update prevent two
    // active claims; Date precision is not used as a history/version field.
    const startedAt = new Date().toISOString()
    const record: ContentAuditRecord = {
      status: 'checking',
      startedAt,
      completedAt: null,
      progress: {
        stage: 'checking',
        totalPages: 0,
        processedPages: 0,
        totalClaims: 0,
        processedClaims: 0,
      },
      result: null,
      error: null,
      executionErrors: [],
      usage: emptyContentAuditUsage(),
    }
    const updated = await client.query(
      `update geo_projects
       set content_audit = $2::jsonb,
           content_audit_task_id = $3,
           updated_at = clock_timestamp()
       where id = $1
         and coalesce(content_audit->>'status', '') <> 'checking'
       returning id`,
      [id, JSON.stringify(record), aiTaskId ?? null],
    )
    if (!updated.rows[0]) throw new Error('content_audit_in_progress')
    await client.query('COMMIT')
    return { project, pages, record, previous }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep the original failure */ }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Persist progress for the currently claimed run.  The legacy three-argument
 * form updates only progress; a runner snapshot updates all partial fields in
 * one SQL UPDATE while deliberately leaving status/completedAt untouched.
 */
export async function saveContentAuditProgress(
  id: string,
  startedAt: string,
  progress: ContentAuditProgress,
  snapshot?: ContentAuditProgressSnapshot,
): Promise<boolean> {
  const parsedProgress = contentAuditProgressFromValue(progress)
  if (!parsedProgress) throw new Error('content_audit_progress_invalid')

  if (snapshot === undefined) {
    const result = await databasePool().query(
      `update geo_projects
       set content_audit = jsonb_set(content_audit, '{progress}', $3::jsonb, false),
           updated_at = clock_timestamp()
       where id = $1
         and content_audit->>'status' = 'checking'
         and content_audit->>'startedAt' = $2`,
      [id, startedAt, JSON.stringify(parsedProgress)],
    )
    return result.rowCount === 1
  }

  const parsedSnapshot = contentAuditProgressSnapshotForSave(snapshot)
  const hasCheckpoint = parsedSnapshot.checkpoint !== undefined
  const result = await databasePool().query(
    hasCheckpoint
      ? `update geo_projects
         set content_audit = content_audit || jsonb_build_object(
               'progress', $3::jsonb,
               'result', $4::jsonb,
               'executionErrors', $5::jsonb,
               'usage', $6::jsonb,
               'checkpoint', $7::jsonb
             ),
             updated_at = clock_timestamp()
         where id = $1
           and content_audit->>'status' = 'checking'
           and content_audit->>'startedAt' = $2`
      : `update geo_projects
         set content_audit = content_audit || jsonb_build_object(
               'progress', $3::jsonb,
               'result', $4::jsonb,
               'executionErrors', $5::jsonb,
               'usage', $6::jsonb
             ),
             updated_at = clock_timestamp()
         where id = $1
           and content_audit->>'status' = 'checking'
           and content_audit->>'startedAt' = $2`,
    [
      id,
      startedAt,
      JSON.stringify(parsedProgress),
      JSON.stringify(parsedSnapshot.result),
      JSON.stringify(parsedSnapshot.executionErrors),
      JSON.stringify(parsedSnapshot.usage),
      ...(hasCheckpoint ? [JSON.stringify(parsedSnapshot.checkpoint)] : []),
    ],
  )
  return result.rowCount === 1
}

function contentAuditErrorSummary(errors: readonly ContentAuditExecutionError[]): string {
  return contentAuditFailureSummary(errors)
}

function safeContentAuditExecutionErrors(errors: readonly ContentAuditExecutionError[]): ContentAuditExecutionError[] {
  return errors.map((entry) => contentAuditExecutionErrorFromValue(entry) ?? {
    stage: 'execution',
    message: '核查执行错误格式无效',
  })
}

function contentAuditProgressSnapshotForSave(value: ContentAuditProgressSnapshot): ContentAuditProgressSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('content_audit_snapshot_invalid')
  const candidate = value as unknown as Record<string, unknown>
  const result = contentAuditResultFromValue(candidate.result)
  const executionErrors = candidate.executionErrors
  const usage = contentAuditUsageFromValue(candidate.usage)
  const checkpoint = candidate.checkpoint === undefined ? undefined : contentAuditCheckpointFromValue(candidate.checkpoint)
  if (!result || result.scope !== 'website_internal' || !Array.isArray(executionErrors) || !usage) {
    throw new Error('content_audit_snapshot_invalid')
  }
  if (candidate.checkpoint !== undefined && !checkpoint) throw new Error('content_audit_snapshot_invalid')
  return {
    result,
    executionErrors: safeContentAuditExecutionErrors(executionErrors as ContentAuditExecutionError[]),
    usage,
    ...(checkpoint ? { checkpoint } : {}),
  }
}

/** Replace the current record with the terminal result, guarded by run token. */
export async function finishContentAudit(
  id: string,
  startedAt: string,
  result: ContentAuditResult | null,
  executionErrors: readonly ContentAuditExecutionError[],
  usage: ContentAuditUsage,
  finalProgress?: ContentAuditProgress,
): Promise<boolean> {
  const safeErrors = safeContentAuditExecutionErrors(executionErrors)
  const safeUsage = contentAuditUsageFromValue(usage) ?? emptyContentAuditUsage()
  const parsedResult = contentAuditResultFromValue(result)
  const parsedProgress = finalProgress ? contentAuditProgressFromValue(finalProgress) : null
  if (safeErrors.length === 0 && (!parsedResult || parsedResult.scope !== 'website_internal' || !parsedProgress
    || parsedProgress.processedPages !== parsedProgress.totalPages
    || parsedProgress.processedClaims !== parsedProgress.totalClaims
    || parsedResult.items.length > parsedProgress.processedClaims)) {
    safeErrors.push({ stage: 'completeness', message: '核查结果或实际进度未完整完成' })
  }
  const record: ContentAuditRecord = {
    status: safeErrors.length === 0 ? 'completed' : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    progress: parsedProgress ?? {
      stage: 'checking',
      totalPages: 0,
      processedPages: 0,
      totalClaims: result?.items.length ?? 0,
      processedClaims: result?.items.length ?? 0,
    },
    result: parsedResult,
    error: safeErrors.length === 0 ? null : contentAuditErrorSummary(safeErrors),
    executionErrors: safeErrors,
    usage: safeUsage,
  }
  // Keep the generation predicate as the final invariant rather than
  // allowing a malformed runner result to be persisted as `completed`.
  if (record.status === 'completed' && !contentAuditResultEligible(record)) {
    record.status = 'failed'
    record.error = contentAuditErrorSummary([{ stage: 'completeness', message: '核查结果或实际进度未完整完成' }])
    record.executionErrors = [{ stage: 'completeness', message: '核查结果或实际进度未完整完成' }]
  }
  // Failed runs retain their lifecycle/error metadata only.  Their prior
  // successful output is kept in content_audit_history and is exposed as
  // optional read data; never persist a partial current result alongside a
  // failed status.
  if (record.status !== 'completed') record.result = null
  const updated = await databasePool().query(
    `update geo_projects
       set content_audit = $3::jsonb,
           -- A task-owned run keeps its marker until completeAiTask() so the
           -- task status and history append can commit together.  Direct
           -- callers without a task marker append in this same UPDATE.
           content_audit_history = case
             when content_audit_task_id is null
               and $3::jsonb->>'status' = 'completed'
               and jsonb_typeof(coalesce(content_audit_history, '[]'::jsonb)) = 'array'
               and not exists (
                 select 1
                 from jsonb_array_elements(coalesce(content_audit_history, '[]'::jsonb)) as prior
                 where prior->>'startedAt' = $3::jsonb->>'startedAt'
               )
               then coalesce(content_audit_history, '[]'::jsonb) || jsonb_build_array($3::jsonb)
             else coalesce(content_audit_history, '[]'::jsonb)
           end,
           updated_at = clock_timestamp()
     where id = $1
       and content_audit->>'status' = 'checking'
       and content_audit->>'startedAt' = $2`,
    [id, startedAt, JSON.stringify(record)],
  )
  return updated.rowCount === 1
}

export async function failContentAudit(
  id: string,
  startedAt: string,
  error: unknown,
  executionErrors: readonly ContentAuditExecutionError[] = [],
  usage: ContentAuditUsage = emptyContentAuditUsage(),
  progress?: ContentAuditProgress,
  result?: ContentAuditResult | null,
  checkpoint?: ContentAuditCheckpoint,
): Promise<boolean> {
  const safeErrors = safeContentAuditExecutionErrors(executionErrors)
  const parsedProgress = progress === undefined ? null : contentAuditProgressFromValue(progress)
  const parsedResult = result === undefined || result === null ? null : contentAuditResultFromValue(result)
  const parsedUsage = contentAuditUsageFromValue(usage)
  const parsedCheckpoint = checkpoint === undefined ? undefined : contentAuditCheckpointFromValue(checkpoint)
  if (progress !== undefined && !parsedProgress) {
    safeErrors.push({ stage: 'progress', message: '核查进度格式无效' })
  }
  if (result !== undefined && result !== null && !parsedResult) {
    safeErrors.push({ stage: 'snapshot', message: '核查结果格式无效' })
  }
  if (result !== undefined && result !== null && parsedResult && parsedResult.scope !== 'website_internal') {
    safeErrors.push({ stage: 'snapshot', message: '官网内容检查结果格式无效' })
  }
  if (!parsedUsage) {
    safeErrors.push({ stage: 'usage', message: '核查用量格式无效' })
  }
  if (checkpoint !== undefined && !parsedCheckpoint) {
    safeErrors.push({ stage: 'checkpoint', message: '核查断点格式无效' })
  }
  const record: ContentAuditRecord = {
    status: 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    progress: parsedProgress ?? {
      stage: 'checking',
      totalPages: 0,
      processedPages: 0,
      totalClaims: parsedResult?.items.length ?? 0,
      processedClaims: 0,
    },
    // A failed run never exposes partial findings as its current result.  A
    // caller may still pass a result for shape validation/legacy source
    // compatibility, but it is intentionally discarded here.
    result: null,
    error: safeContentAuditError(error),
    executionErrors: safeErrors,
    usage: parsedUsage ?? emptyContentAuditUsage(),
    ...(parsedCheckpoint ? { checkpoint: parsedCheckpoint } : {}),
  }
  const updated = await databasePool().query(
    `update geo_projects
       set content_audit = $3::jsonb,
         updated_at = clock_timestamp()
     where id = $1
       and content_audit->>'status' = 'checking'
       and content_audit->>'startedAt' = $2`,
    [id, startedAt, JSON.stringify(record)],
  )
  return updated.rowCount === 1
}

/** Resolve an article's project without changing its writing state. */
export async function getArticleProjectId(id: string): Promise<string | null> {
  const result = await databasePool().query<{ project_id: string }>(
    'select project_id from geo_project_articles where id = $1',
    [id],
  )
  return result.rows[0]?.project_id === undefined ? null : String(result.rows[0].project_id)
}

/** Delete exactly one article task and its now-empty batch, without touching
 * the project website lock, diagnosis history, reports, or other tasks. */
export async function deleteArticle(id: string): Promise<{ project: ProjectDetail; deletedArticleId: string } | null> {
  const client = await databasePool().connect()
  let projectId: string | null = null
  try {
    await client.query('BEGIN')
    const articleResult = await client.query<{ id: string; project_id: string; batch_id: string; publish_status: string }>(
      `select id, project_id, batch_id, publish_status
       from geo_project_articles
       where id = $1
       for update`,
      [id],
    )
    const article = articleResult.rows[0]
    if (!article) {
      await client.query('ROLLBACK')
      return null
    }
    if (String(article.publish_status ?? '') === 'published') {
      await client.query('ROLLBACK')
      throw new Error('article_published_immutable')
    }
    projectId = String(article.project_id)
    const deleted = await client.query<{ id: string }>(
      `delete from geo_project_articles
       where id = $1
       returning id`,
      [id],
    )
    if (!deleted.rows[0]) throw new Error('article_delete_stale')
    await client.query(
      `delete from geo_article_batches b
       where b.id = $1
         and not exists (select 1 from geo_project_articles a where a.batch_id = b.id)`,
      [article.batch_id],
    )
    await client.query('update geo_projects set updated_at = now() where id = $1', [projectId])
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction may already be closed */ }
    throw error
  } finally {
    client.release()
  }
  const project = await getProjectDetail(projectId as string)
  if (!project) throw new Error('project_not_found')
  return { project, deletedArticleId: id }
}

const TECHNICAL_AUDIT_V6_ITEM_COUNT = TECHNICAL_AUDIT_V6_ITEM_IDS.length
const TECHNICAL_AUDIT_V5_ITEM_COUNT = TECHNICAL_AUDIT_V5_ITEM_IDS.length
const TECHNICAL_AUDIT_LEGACY_38_ITEM_COUNT = TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS.length
const TECHNICAL_AUDIT_LEGACY_43_ITEM_COUNT = TECHNICAL_AUDIT_LEGACY_38_ITEM_COUNT + TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS.length
const TECHNICAL_AUDIT_LEGACY_44_ITEM_COUNT = TECHNICAL_AUDIT_LEGACY_43_ITEM_COUNT + TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS.length
const TECHNICAL_AUDIT_LEGACY_REMOVED_IDS = new Set<string>(TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS)
const TECHNICAL_AUDIT_LEGACY_EXTRA_IDS = new Set<string>(TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS)
const TECHNICAL_AUDIT_LEGACY_CURRENT_IDS = new Set<string>(TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS)
const TECHNICAL_AUDIT_CURRENT_IDS = new Set<string>(TECHNICAL_AUDIT_CURRENT_ITEM_IDS)
const TECHNICAL_AUDIT_V6_IDS = new Set<string>(TECHNICAL_AUDIT_V6_ITEM_IDS)
const TECHNICAL_AUDIT_V5_IDS = new Set<string>(TECHNICAL_AUDIT_V5_ITEM_IDS)
const TECHNICAL_AUDIT_LEGACY_PUBLISH_SYNC_IDS = new Set<string>(TECHNICAL_AUDIT_LEGACY_PUBLISH_SYNC_ITEM_IDS)
const TECHNICAL_AUDIT_ACCEPTED_IDS = new Set<string>([
  ...TECHNICAL_AUDIT_CURRENT_ITEM_IDS,
  ...TECHNICAL_AUDIT_V6_ITEM_IDS,
  ...TECHNICAL_AUDIT_V5_ITEM_IDS,
  ...TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS,
  ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS,
  ...TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS,
])
const TECHNICAL_AUDIT_ACCEPTED_RULE_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8])
const TECHNICAL_AUDIT_STATUSES = new Set(['unchecked', 'pass', 'fix', 'review', 'not_applicable'])
const TECHNICAL_AUDIT_SNAPSHOT_KEYS = new Set(['checked_at', 'website_url', 'scope', 'items', 'rule_version'])
const TECHNICAL_AUDIT_ITEM_KEYS = new Set(['item_id', 'status', 'message_code', 'facts', 'evidence'])
const TECHNICAL_AUDIT_SCOPE_KEYS = new Set([
  'pages', 'sampled_pages', 'skipped_pages', 'candidates',
  'requests', 'request_limit', 'page_limit', 'response_limit_bytes', 'time_limit_ms', 'limits',
])
const TECHNICAL_AUDIT_SCOPE_ARRAY_KEYS = new Set(['pages', 'sampled_pages', 'skipped_pages', 'candidates', 'limits'])
const TECHNICAL_AUDIT_SCOPE_NUMBER_KEYS = new Set(['requests', 'request_limit', 'page_limit', 'response_limit_bytes', 'time_limit_ms'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function validTechnicalAuditScope(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, TECHNICAL_AUDIT_SCOPE_KEYS)) return false
  for (const [key, entry] of Object.entries(value)) {
    if (TECHNICAL_AUDIT_SCOPE_ARRAY_KEYS.has(key)) {
      if (!isStringArray(entry)) return false
      continue
    }
    if (TECHNICAL_AUDIT_SCOPE_NUMBER_KEYS.has(key)) {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) return false
      continue
    }
    // hasOnlyKeys() above makes this unreachable, but keep the guard local to
    // the parser so a future scope field cannot silently bypass validation.
    return false
  }
  return true
}

function validTechnicalAuditItem(value: unknown): value is TechnicalAuditItem {
  if (!isRecord(value) || !hasOnlyKeys(value, TECHNICAL_AUDIT_ITEM_KEYS)) return false
  if (typeof value.item_id !== 'string' || !TECHNICAL_AUDIT_ACCEPTED_IDS.has(value.item_id)) return false
  if (typeof value.status !== 'string' || !TECHNICAL_AUDIT_STATUSES.has(value.status)) return false
  if (value.item_id === 'content.structured_data' && value.status !== 'pass' && value.status !== 'fix') return false
  if (typeof value.message_code !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.message_code)) return false
  if (!isRecord(value.facts) || !isRecord(value.evidence)) return false
  return true
}

/**
 * Parse a stored audit snapshot without changing its contents.  Current
 * snapshots contain 24 items; v6 snapshots use the historical 31-item
 * contract, v5 snapshots use the historical 34-item contract and known
 * v4/v1-v3 shapes contain 38, 43 or 44 items (the latter has one
 * site.request_failure item).  Current and historical 38-item
 * snapshots may be partial for interrupted runs; the 43/44 shapes retain
 * their existing strict complete-set guard.  Rule versions 1 through 7 (or an
 * omitted legacy version) are retained as evidence; the parser never upgrades
 * or rewrites them.
 * Historical items are retained for the UI to explain/recheck; this function
 * deliberately performs no database write or migration.
 */
export function technicalAuditSnapshotFromValue(value: unknown): TechnicalAuditSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, TECHNICAL_AUDIT_SNAPSHOT_KEYS)) return null
  if (typeof value.checked_at !== 'string' || !value.checked_at.trim()) return null
  if (typeof value.website_url !== 'string' || !value.website_url.trim()) return null
  if (!validTechnicalAuditScope(value.scope) || !Array.isArray(value.items)) return null
  if (value.items.length < 1 || value.items.length > TECHNICAL_AUDIT_LEGACY_44_ITEM_COUNT) return null

  const hasRuleVersion = Object.prototype.hasOwnProperty.call(value, 'rule_version')
  if (hasRuleVersion && (typeof value.rule_version !== 'number' || !Number.isSafeInteger(value.rule_version) || !TECHNICAL_AUDIT_ACCEPTED_RULE_VERSIONS.has(value.rule_version))) return null

  const seen = new Set<string>()
  for (const entry of value.items) {
    if (!validTechnicalAuditItem(entry)) return null
    if (seen.has(entry.item_id)) return null
    seen.add(entry.item_id)
  }

  const hasLegacyStructuredItem = [...seen].some((id) => id.startsWith('structured.'))
  const hasLegacyRemovedItem = [...seen].some((id) => TECHNICAL_AUDIT_LEGACY_REMOVED_IDS.has(id))
  const hasLegacyExtraItem = [...seen].some((id) => TECHNICAL_AUDIT_LEGACY_EXTRA_IDS.has(id))
  const hasLegacyPublishSyncItem = [...seen].some((id) => TECHNICAL_AUDIT_LEGACY_PUBLISH_SYNC_IDS.has(id))
  const isCurrentVersion = value.rule_version === TECHNICAL_AUDIT_RULE_VERSION
  if (isCurrentVersion) {
    // v8 never accepts v6/v5 removed ids, v4 structured ids, or v1-v3 removed
    // items.  Partial current snapshots remain valid for incomplete runs;
    // missing items are rendered as unchecked by the client.
    if (hasLegacyStructuredItem || hasLegacyRemovedItem || hasLegacyExtraItem || hasLegacyPublishSyncItem) return null
    if (value.items.length > TECHNICAL_AUDIT_ITEM_COUNT || [...seen].some((id) => !TECHNICAL_AUDIT_CURRENT_IDS.has(id))) return null
    const currentLlms = value.items.find((entry) => entry.item_id === 'discovery.llms_txt')
    if (currentLlms && currentLlms.status !== 'pass' && currentLlms.status !== 'fix') return null
  } else if (value.rule_version === 7) {
    // v7 used the same item catalogue but the old llms.txt candidate/range
    // rules.  Keep those snapshots readable as historical evidence without
    // applying the v8 status guard or treating them as current results.
    if (value.items.length > TECHNICAL_AUDIT_ITEM_COUNT || [...seen].some((id) => !TECHNICAL_AUDIT_CURRENT_IDS.has(id))) return null
  } else if (value.rule_version === 6) {
    // v6 is historical after the seven unimplemented checks were removed.
    // Keep its explicit allow-list and the pre-existing partial-record
    // tolerance.
    if (value.items.length > TECHNICAL_AUDIT_V6_ITEM_COUNT || [...seen].some((id) => !TECHNICAL_AUDIT_V6_IDS.has(id))) return null
  } else if (value.rule_version === 5) {
    // v5 is historical after the v6 publish-sync removal.  Keep its explicit
    // allow-list and the pre-existing partial-record tolerance.
    if (value.items.length > TECHNICAL_AUDIT_V5_ITEM_COUNT || [...seen].some((id) => !TECHNICAL_AUDIT_V5_IDS.has(id))) return null
  } else {
    // v4 and v1-v3 use the explicit legacy directories.  The original 38-item
    // directory remains partial-compatible; 43/44 complete sets retain their
    // strict guard.  An omitted version is never inferred as v5 merely from a
    // structured-data item.
    if (seen.has('content.structured_data')) return null
    const legacyOnly = [...seen].every((id) => TECHNICAL_AUDIT_LEGACY_CURRENT_IDS.has(id)
      || TECHNICAL_AUDIT_LEGACY_REMOVED_IDS.has(id)
      || TECHNICAL_AUDIT_LEGACY_EXTRA_IDS.has(id))
    if (!legacyOnly || value.items.length > TECHNICAL_AUDIT_LEGACY_44_ITEM_COUNT) return null
    if (hasLegacyRemovedItem || hasLegacyExtraItem) {
      const expectedCount = hasLegacyExtraItem ? TECHNICAL_AUDIT_LEGACY_44_ITEM_COUNT : TECHNICAL_AUDIT_LEGACY_43_ITEM_COUNT
      if (value.items.length !== expectedCount) return null
      const expectedIds = new Set<string>([
        ...TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS,
        ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS,
        ...(hasLegacyExtraItem ? TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS : []),
      ])
      if (seen.size !== expectedIds.size || [...expectedIds].some((id) => !seen.has(id))) return null
    }
  }

  void TECHNICAL_AUDIT_LEGACY_38_ITEM_COUNT
  void TECHNICAL_AUDIT_LEGACY_43_ITEM_COUNT
  void TECHNICAL_AUDIT_LEGACY_44_ITEM_COUNT

  return value as unknown as TechnicalAuditSnapshot
}

/** Read only the latest snapshot when it still belongs to the current website.
 * A URL mutation therefore makes the old audit invisible without touching the
 * existing crawl invalidation flow. */
export async function getTechnicalAuditSnapshot(id: string): Promise<TechnicalAuditSnapshot | null> {
  const result = await databasePool().query<{ website_url: string | null; technical_audit: unknown }>(
    'select website_url, technical_audit from geo_projects where id = $1',
    [id],
  )
  const row = result.rows[0]
  if (!row?.website_url) return null
  const snapshot = technicalAuditSnapshotFromValue(row.technical_audit)
  if (!snapshot || snapshot.website_url !== row.website_url) return null
  return snapshot
}

/** Clear the single current audit before a new on-demand run starts. */
export async function clearTechnicalAuditSnapshot(
  id: string,
  websiteUrl: string,
  diagnosisRunId: string,
  queryClient?: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  if (typeof diagnosisRunId !== 'string' || !diagnosisRunId.trim()) return false
  const executor = queryClient ?? databasePool()
  const result = await executor.query(
    `update geo_projects
     set technical_audit = null
     where id = $1
       and website_url = $2
       and initial_diagnosis_status = 'completed'
       and exists (
         select 1
         from geo_diagnosis_runs as diagnosis
         where diagnosis.id = $3
           and diagnosis.project_id = geo_projects.id
           and diagnosis.run_type = 'initial'
           and diagnosis.status = 'completed'
           and diagnosis.id = (
             select latest.id
             from geo_diagnosis_runs as latest
             where latest.project_id = geo_projects.id
               and latest.run_type = 'initial'
             order by latest.started_at desc, latest.id desc
             limit 1
           )
       )`,
    [id, websiteUrl, diagnosisRunId],
  )
  return result.rowCount === 1
}

/**
 * Save only against the URL and current initial diagnosis run read before the
 * network run.  URL equality alone is insufficient for an A→B→A edit: the
 * reset replaces the initial run, so a late result from the old workflow must
 * be discarded even when the URL is unchanged.
 */
export async function saveTechnicalAuditSnapshot(
  id: string,
  websiteUrl: string,
  snapshot: TechnicalAuditSnapshot,
  diagnosisRunId: string,
  queryClient?: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  if (typeof diagnosisRunId !== 'string' || !diagnosisRunId.trim()) return false
  const executor = queryClient ?? databasePool()
  const result = await executor.query(
    `update geo_projects
     set technical_audit = $1::jsonb
     where id = $2
       and website_url = $3
       and initial_diagnosis_status = 'completed'
       and exists (
         select 1
         from geo_diagnosis_runs as diagnosis
         where diagnosis.id = $4
           and diagnosis.project_id = geo_projects.id
           and diagnosis.run_type = 'initial'
           and diagnosis.status = 'completed'
           and diagnosis.id = (
             select latest.id
             from geo_diagnosis_runs as latest
             where latest.project_id = geo_projects.id
               and latest.run_type = 'initial'
             order by latest.started_at desc, latest.id desc
             limit 1
           )
       )`,
    [JSON.stringify(snapshot), id, websiteUrl, diagnosisRunId],
  )
  return result.rowCount === 1
}

/** Hold a session advisory lock only; callers must not open a transaction
 * across network requests.  Finally always releases the lock before the
 * pooled client is returned. */
export async function withTechnicalAuditLock<T>(id: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect()
  const key = `technical-audit:${id}`
  let acquired = false
  let operationFailure: unknown
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [key],
    )
    acquired = Boolean(result.rows[0]?.locked)
    if (!acquired) throw new Error('technical_audit_in_progress')
    try {
      return await operation(client)
    } catch (error) {
      operationFailure = error
      throw error
    }
  } finally {
    let unlockFailure: Error | null = null
    try {
      if (acquired) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
    } catch (error) {
      unlockFailure = error instanceof Error ? error : new Error('technical_audit_lock_release_failed')
    }
    if (unlockFailure) {
      // Do not return a session with a potentially-held advisory lock to the
      // pool.  pg's release(error) destroys the underlying client.
      client.release(unlockFailure)
      if (!operationFailure) throw unlockFailure
    } else {
      client.release()
    }
  }
}

function diagnosisRunFromRow(row: Record<string, unknown>): DiagnosisRun {
  return {
    id: String(row.id),
    runType: String(row.run_type) as DiagnosisRun['runType'],
    status: String(row.status) as DiagnosisRun['status'],
    requestedModel: (row.requested_model as string | null) ?? null,
    roundNumber: Number(row.round_number ?? 0),
    publishedArticleCount: row.published_article_count === null || row.published_article_count === undefined
      ? null
      : Number(row.published_article_count),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : new Date(String(row.started_at)).toISOString(),
    completedAt: nullableIso(row.completed_at),
    summaryAnalysis: row.summary_analysis ?? null,
    summaryModel: (row.summary_model as string | null) ?? null,
    summaryError: (row.summary_error as string | null) ?? null,
    recommendationRate: nullableRate(row.recommendation_rate),
    officialCitationRate: nullableRate(row.official_citation_rate),
  }
}

function citationUrlsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function diagnosisAnswerFromRow(row: Record<string, unknown>): DiagnosisAnswer {
  return {
    position: Number(row.position),
    question: String(row.question),
    status: String(row.status) as DiagnosisAnswer['status'],
    answerText: (row.answer_text as string | null) ?? null,
    citationUrls: citationUrlsFromValue(row.citation_urls),
    responseModel: (row.response_model as string | null) ?? null,
    recommended: typeof row.recommended === 'boolean' ? row.recommended : null,
    officialCitation: typeof row.official_citation === 'boolean' ? row.official_citation : null,
    error: (row.error as string | null) ?? null,
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  }
}

function articleFromRow(row: Record<string, unknown>): ProjectArticle {
  const rawPositions = row.question_positions
  const questionPositions = Array.isArray(rawPositions)
    ? rawPositions.filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
    : []
  const legacyPosition = Number(row.question_position)
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    batchId: String(row.batch_id),
    title: String(row.title),
    questionPositions: questionPositions.length > 0
      ? questionPositions
      : Number.isInteger(legacyPosition) && legacyPosition >= QUESTION_POSITION_MIN && legacyPosition <= QUESTION_POSITION_MAX ? [legacyPosition] : [],
    contentHtml: row.content_html === null || row.content_html === undefined ? null : String(row.content_html),
    generatedAt: new Date(String(row.generated_at)).toISOString(),
    updatedAt: nullableIso(row.updated_at) ?? new Date(String(row.generated_at)).toISOString(),
    publishStatus: String(row.publish_status) as ArticlePublishStatus,
    confirmedAt: nullableIso(row.confirmed_at),
    writingStatus: (row.writing_status
      ? String(row.writing_status)
      : (row.content_html ? 'ready' : 'pending')) as ArticleWritingStatus,
    writingError: (row.writing_error as string | null) ?? null,
    optimizationType: String(row.optimization_type ?? '未分类'),
    optimizationDirection: row.optimization_direction === null || row.optimization_direction === undefined
      ? null
      : String(row.optimization_direction),
    targetPageUrl: (row.target_page_url as string | null) ?? null,
    targetPageTitle: (row.target_page_title as string | null) ?? null,
  }
}

async function getArticleBatches(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<ArticleBatch[]> {
  const result = await (queryClient ?? databasePool()).query(
    `select b.id as batch_id, b.project_id, b.requested_model, b.response_model, b.generated_at as batch_generated_at,
            a.id, a.batch_id as article_batch_id, a.project_id as article_project_id, a.title,
            a.question_position, a.question_positions, a.content_html, a.generated_at,
            case when a.writing_status = 'writing'
                   and a.writing_lease_expires_at is not null
                   and a.writing_lease_expires_at <= now()
                 then a.writing_lease_expires_at else a.updated_at end as updated_at,
            case when a.writing_status = 'writing'
                   and a.writing_lease_expires_at is not null
                   and a.writing_lease_expires_at <= now()
                 then 'failed' else a.writing_status end as writing_status,
            case when a.writing_status = 'writing'
                   and a.writing_lease_expires_at is not null
                   and a.writing_lease_expires_at <= now()
                 then coalesce(a.writing_error, '写作请求已超时，可重新开始') else a.writing_error end as writing_error,
            a.optimization_type, a.optimization_direction, a.target_page_url, a.target_page_title,
            a.publish_status, a.confirmed_at
     from geo_article_batches b
     left join geo_project_articles a on a.batch_id = b.id
     where b.project_id = $1
     order by b.id desc, a.id asc`,
    [id],
  )
  const batches = new Map<string, ArticleBatch>()
  for (const row of result.rows) {
    const batchId = String(row.batch_id)
    let batch = batches.get(batchId)
    if (!batch) {
      batch = {
        id: batchId,
        projectId: String(row.project_id),
        requestedModel: String(row.requested_model),
        responseModel: (row.response_model as string | null) ?? null,
        generatedAt: new Date(String(row.batch_generated_at)).toISOString(),
        articles: [],
      }
      batches.set(batchId, batch)
    }
    if (row.id !== null && row.id !== undefined) {
      batch.articles.push(articleFromRow({
        id: row.id,
        project_id: row.article_project_id,
        batch_id: row.article_batch_id,
        title: row.title,
        question_position: row.question_position,
        question_positions: row.question_positions,
        content_html: row.content_html,
        generated_at: row.generated_at,
        updated_at: row.updated_at,
        writing_status: row.writing_status,
        writing_error: row.writing_error,
        optimization_type: row.optimization_type,
        optimization_direction: row.optimization_direction,
        target_page_url: row.target_page_url,
        target_page_title: row.target_page_title,
        publish_status: row.publish_status,
        confirmed_at: row.confirmed_at,
      }))
    }
  }
  return [...batches.values()]
}

async function getDiagnosisAnswers(runId: string, queryClient?: Pick<PoolClient, 'query'>): Promise<DiagnosisAnswer[]> {
  const answerResult = await (queryClient ?? databasePool()).query(
    `select position, question, status, answer_text, citation_urls, response_model,
            recommended, official_citation, error, started_at, completed_at
     from geo_diagnosis_answers
     where run_id = $1
     order by position`,
    [runId],
  )
  return answerResult.rows.map(diagnosisAnswerFromRow)
}

export async function getInitialDiagnosis(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<InitialDiagnosis> {
  const runResult = await (queryClient ?? databasePool()).query(
    `select id, run_type, status, requested_model, round_number, published_article_count,
            started_at, completed_at, summary_analysis, summary_model, summary_error,
            recommendation_rate, official_citation_rate,
            report_refresh_status, report_refresh_started_at, report_refresh_error,
            (
              status = 'completed'
              and report_refresh_status = 'ready'
              and report_pdf is not null
              and octet_length(report_pdf) >= 5
              and substring(report_pdf from 1 for 5) = decode('255044462d', 'hex')
            ) as report_pdf_ready,
            report_pdf_generated_at
     from geo_diagnosis_runs
     where project_id = $1 and run_type = 'initial'`,
    [id],
  )
  const runRow = runResult.rows[0]
  if (!runRow) {
    return {
      run: null,
      answers: [],
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      reportRefreshStatus: 'not_started',
      reportRefreshStartedAt: null,
      reportRefreshError: null,
    }
  }
  const refreshStatus = diagnosisReportRefreshStatus(runRow.report_refresh_status)
  const reportPdfReady = refreshStatus === 'ready'
    && String(runRow.status) === 'completed'
    && (runRow.report_pdf_ready === true || runRow.report_pdf_ready === 't' || runRow.report_pdf_ready === 1 || runRow.report_pdf_ready === '1')
  return {
    run: diagnosisRunFromRow(runRow),
    answers: await getDiagnosisAnswers(String(runRow.id), queryClient),
    reportPdfReady,
    reportPdfGeneratedAt: reportPdfReady ? nullableIso(runRow.report_pdf_generated_at) : null,
    reportRefreshStatus: refreshStatus,
    reportRefreshStartedAt: nullableIso(runRow.report_refresh_started_at),
    reportRefreshError: runRow.report_refresh_error === null || runRow.report_refresh_error === undefined
      ? null
      : String(runRow.report_refresh_error),
  }
}

export type InitialDiagnosisReportPdfMetadata = {
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
}

/**
 * Save the browser-rendered initial report exactly once for the run that the
 * browser rendered.  The project row is locked before the run row, matching
 * the reset transaction's lock order.  A missing source run is a stale
 * upload, not permission to look up (and accidentally write) a newly-created
 * initial run for the same project.
 */
export async function saveInitialDiagnosisReportPdf(
  projectId: string,
  pdf: Buffer,
  sourceRunId: string,
): Promise<InitialDiagnosisReportPdfMetadata | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }

    const sourceResult = await client.query<{ status: string; report_pdf: Buffer | null; report_pdf_generated_at: unknown }>(
      `select id, status, report_pdf, report_pdf_generated_at
       from geo_diagnosis_runs
       where id = $1 and project_id = $2 and run_type = 'initial'
       for update`,
      [sourceRunId, projectId],
    )
    const source = sourceResult.rows[0]
    if (!source) throw new Error('diagnosis_report_stale')
    if (source.status !== 'completed') throw new Error('diagnosis_incomplete')

    const answerResult = await client.query<{ position: number; status: string }>(
      `select position, status
       from geo_diagnosis_answers
       where run_id = $1
       order by position`,
      [sourceRunId],
    )
    const answerPositions = answerResult.rows.map((row) => Number(row.position))
    const answersComplete = answerPositions.length === QUESTION_TOTAL
      && new Set(answerPositions).size === QUESTION_TOTAL
      && answerPositions.every((position) => Number.isInteger(position) && position >= QUESTION_POSITION_MIN && position <= QUESTION_POSITION_MAX)
      && answerResult.rows.every((row) => row.status === 'success')
    if (!answersComplete) throw new Error('diagnosis_incomplete')

    // A retry for the same source run is idempotent and must not replace the
    // first persisted bytes or timestamp.
    if (source.report_pdf !== null && source.report_pdf !== undefined) {
      await client.query('COMMIT')
      return {
        reportPdfReady: true,
        reportPdfGeneratedAt: nullableIso(source.report_pdf_generated_at),
      }
    }

    const saved = await client.query<{ report_pdf_generated_at: unknown }>(
      `update geo_diagnosis_runs
       set report_pdf = $2,
           report_pdf_generated_at = coalesce(report_pdf_generated_at, clock_timestamp())
       where id = $1
         and project_id = $3
         and run_type = 'initial'
         and status = 'completed'
         and report_pdf is null
       returning report_pdf_generated_at`,
      [sourceRunId, pdf, projectId],
    )
    if (!saved.rows[0]) throw new Error('diagnosis_report_stale')
    await client.query('COMMIT')
    return {
      reportPdfReady: true,
      reportPdfGeneratedAt: nullableIso(saved.rows[0].report_pdf_generated_at),
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep the original failure */ }
    throw error
  } finally {
    client.release()
  }
}

export type InitialDiagnosisReportPdf = {
  pdf: Buffer
  companyName: string
  completedAt: string | null
}

/** Read only the persisted binary and the values needed for its download name. */
export async function getInitialDiagnosisReportPdf(projectId: string): Promise<InitialDiagnosisReportPdf | null> {
  const result = await databasePool().query<{ pdf: Buffer; company_name: string; completed_at: unknown }>(
    `select run.report_pdf as pdf, project.company_name, run.completed_at
     from geo_diagnosis_runs as run
     join geo_projects as project on project.id = run.project_id
     where project.id = $1
       and run.run_type = 'initial'
       and run.status = 'completed'
       and run.report_refresh_status = 'ready'
       and run.report_pdf is not null
       and octet_length(run.report_pdf) >= 5
       and substring(run.report_pdf from 1 for 5) = decode('255044462d', 'hex')`,
    [projectId],
  )
  const row = result.rows[0]
  if (!row) return null
  const pdf = pdfBytes(row.pdf)
  if (!pdf) return null
  return {
    pdf,
    companyName: String(row.company_name),
    completedAt: nullableIso(row.completed_at),
  }
}

/**
 * Record a failed acceptance of the current non-AI initial report refresh.
 *
 * This deliberately updates only the refresh lifecycle fields.  Website
 * input, diagnosis answers, and any existing PDF bytes belong to separate
 * persistence boundaries and must not be changed by an acceptance marker.
 */
export async function markInitialDiagnosisReportRefreshFailed(
  projectId: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await databasePool().query(
    `update geo_diagnosis_runs
     set report_refresh_status = 'failed',
         report_refresh_error = $2
     where project_id = $1
       and run_type = 'initial'
     returning id`,
    [projectId, errorMessage],
  )
  return result.rowCount === 1
}

/**
 * Return only the project-level metadata for the one saved monitoring
 * delivery report.  The invariant is maintained by
 * saveMonitoringDeliveryReportPdf(), so this query deliberately does not
 * expose report bytes or a historical run list.
 */
export async function getMonitoringDeliveryReportMetadata(
  projectId: string,
  queryClient?: Pick<PoolClient, 'query'>,
): Promise<DeliveryReportMetadata> {
  const result = await (queryClient ?? databasePool()).query<{
    source_run_id: unknown
    report_pdf_ready: unknown
    report_pdf_generated_at: unknown
  }>(
    `select run.id as source_run_id,
            run.report_pdf is not null as report_pdf_ready,
            run.report_pdf_generated_at
     from geo_diagnosis_runs as run
     where run.project_id = $1
       and run.run_type = 'monitoring'
       and run.report_pdf is not null
     order by run.round_number desc
     limit 1`,
    [projectId],
  )
  const row = result.rows[0]
  if (!row) return { reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: null }
  return {
    reportPdfReady: Boolean(row.report_pdf_ready),
    reportPdfGeneratedAt: nullableIso(row.report_pdf_generated_at),
    sourceRunId: row.source_run_id === null || row.source_run_id === undefined ? null : String(row.source_run_id),
  }
}

export type MonitoringDeliveryReportPdf = {
  pdf: Buffer
  companyName: string
  completedAt: string | null
  sourceRunId: string
}

/**
 * Save a browser-rendered monitoring delivery report as the sole current
 * report for a project.  The project row is the serialization point for
 * concurrent uploads: after it is locked, the source run and its twenty
 * answers are validated, and the source must still be the latest successful
 * monitoring round.  All replacement writes happen in one transaction so a
 * failed upload never removes the previous report.
 */
export async function saveMonitoringDeliveryReportPdf(
  projectId: string,
  sourceRunId: string,
  pdf: Buffer,
): Promise<DeliveryReportMetadata | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')

    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }

    const sourceResult = await client.query(
      `select id, project_id, run_type, status, round_number,
              report_pdf is not null as report_pdf_ready, report_pdf_generated_at
       from geo_diagnosis_runs
       where id = $1 and project_id = $2
       for update`,
      [sourceRunId, projectId],
    )
    const source = sourceResult.rows[0]
    if (!source || String(source.run_type) !== 'monitoring') throw new Error('delivery_report_run_invalid')
    if (String(source.status) !== 'completed') throw new Error('delivery_report_run_incomplete')

    const answerResult = await client.query(
      `select position, status
       from geo_diagnosis_answers
       where run_id = $1
       order by position`,
      [sourceRunId],
    )
    const positions = answerResult.rows.map((row) => Number(row.position))
    const positionsComplete = positions.length === QUESTION_TOTAL
      && new Set(positions).size === QUESTION_TOTAL
      && positions.every((position) => Number.isInteger(position) && position >= QUESTION_POSITION_MIN && position <= QUESTION_POSITION_MAX)
    if (!positionsComplete || answerResult.rows.some((row) => String(row.status) !== 'success')) {
      throw new Error('delivery_report_run_incomplete')
    }

    const latestResult = await client.query(
      `select id, round_number
       from geo_diagnosis_runs
       where project_id = $1
         and run_type = 'monitoring'
         and status = 'completed'
       order by round_number desc
       limit 1
       for update`,
      [projectId],
    )
    const latest = latestResult.rows[0]
    if (!latest || String(latest.id) !== sourceRunId) throw new Error('delivery_report_stale')

    // A retry for the same source run is idempotent and must not change the
    // original bytes or timestamp.
    if (Boolean(source.report_pdf_ready)) {
      await client.query('COMMIT')
      return {
        reportPdfReady: true,
        reportPdfGeneratedAt: nullableIso(source.report_pdf_generated_at),
        sourceRunId,
      }
    }

    const saved = await client.query<{ report_pdf_generated_at: unknown }>(
      `update geo_diagnosis_runs
       set report_pdf = $2,
           report_pdf_generated_at = now()
       where id = $1
         and project_id = $3
         and run_type = 'monitoring'
         and status = 'completed'
         and report_pdf is null
       returning report_pdf_generated_at`,
      [sourceRunId, pdf, projectId],
    )
    if (!saved.rows[0]) throw new Error('delivery_report_save_failed')

    // Never clear the initial diagnosis report.  Only other monitoring rows
    // participate in the one-current-delivery-report invariant.
    await client.query(
      `update geo_diagnosis_runs
       set report_pdf = null,
           report_pdf_generated_at = null
       where project_id = $1
         and run_type = 'monitoring'
         and id <> $2
         and report_pdf is not null`,
      [projectId, sourceRunId],
    )
    await client.query('COMMIT')
    return {
      reportPdfReady: true,
      reportPdfGeneratedAt: nullableIso(saved.rows[0].report_pdf_generated_at),
      sourceRunId,
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep the original failure */ }
    throw error
  } finally {
    client.release()
  }
}

/** Read the sole current monitoring delivery report, without exposing run history. */
export async function getMonitoringDeliveryReportPdf(projectId: string): Promise<MonitoringDeliveryReportPdf | null> {
  const result = await databasePool().query<{
    pdf: Buffer
    company_name: string
    completed_at: unknown
    source_run_id: unknown
  }>(
    `select run.report_pdf as pdf,
            project.company_name,
            run.completed_at,
            run.id as source_run_id
     from geo_diagnosis_runs as run
     join geo_projects as project on project.id = run.project_id
     where project.id = $1
       and run.run_type = 'monitoring'
       and run.status = 'completed'
       and run.report_pdf is not null
     order by run.round_number desc
     limit 1`,
    [projectId],
  )
  const row = result.rows[0]
  if (!row) return null
  const pdf = Buffer.isBuffer(row.pdf) ? row.pdf : Buffer.from(row.pdf as unknown as Uint8Array)
  return {
    pdf,
    companyName: String(row.company_name),
    completedAt: nullableIso(row.completed_at),
    sourceRunId: String(row.source_run_id),
  }
}

export async function getMonitoringRuns(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<MonitoringRun[]> {
  const runResult = await (queryClient ?? databasePool()).query(
    `select id, run_type, status, requested_model, round_number, published_article_count,
            started_at, completed_at, summary_analysis, summary_model, summary_error,
            recommendation_rate, official_citation_rate
     from geo_diagnosis_runs
     where project_id = $1 and run_type = 'monitoring'
     order by round_number desc`,
    [id],
  )
  const runs: MonitoringRun[] = []
  for (const row of runResult.rows) {
    const run = diagnosisRunFromRow(row)
    if (run.runType !== 'monitoring') continue
    runs.push({ ...run, runType: 'monitoring', answers: await getDiagnosisAnswers(run.id, queryClient) })
  }
  return runs
}

export async function getProjectDetail(id: string, queryClient?: Pick<PoolClient, 'query'>): Promise<ProjectDetail | null> {
  const project = await getProject(id, queryClient)
  if (!project) return null
  return {
    ...project,
    websiteCrawl: {
      status: project.websiteCrawlStatus,
      source: project.websiteCrawlSource,
      incomplete: project.websiteCrawlIncomplete,
      error: project.websiteCrawlError,
      discoveredCount: project.websitePagesDiscovered,
      successCount: project.websitePagesSucceeded,
      failedCount: project.websitePagesFailed,
      startedAt: project.websiteCrawlStartedAt,
      completedAt: project.websiteCrawlCompletedAt,
    },
    questionsGeneration: {
      status: project.questionsGenerationStatus,
      error: project.questionsGenerationError,
      startedAt: project.questionsGenerationStartedAt,
      completedAt: project.questionsGenerationCompletedAt,
    },
    questions: await getQuestions(id, queryClient),
    initialDiagnosis: await getInitialDiagnosis(id, queryClient),
    monitoringRuns: await getMonitoringRuns(id, queryClient),
    articleBatches: await getArticleBatches(id, queryClient),
    deliveryReport: await getMonitoringDeliveryReportMetadata(id, queryClient),
  }
}

function requiredCompanyName(input: ProjectInput): string {
  if (typeof input.companyName !== 'string') {
    throw new Error('company_name_required')
  }
  const value = input.companyName.trim()
  if (!value) {
    throw new Error('company_name_required')
  }
  return value
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error('text_field_invalid')
  }
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * Normalize only the URL differences explicitly treated as equivalent by the
 * project rules.  In particular, the apex/www spelling and a root trailing
 * slash are equivalent; protocol, non-root paths, query strings and other
 * subdomains remain meaningful changes.
 */
export function normalizeWebsiteUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('website_url_invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('website_url_invalid')
  }

  parsed.hostname = parsed.hostname.toLocaleLowerCase().replace(/^www\./, '')
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return `${parsed.origin}${path}${parsed.search}${parsed.hash}`
}

function websiteText(value: unknown): string | null {
  const trimmed = optionalText(value)
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('website_url_invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('website_url_invalid')
  }
  // Store the trimmed URL that the user entered (including a meaningful www
  // host).  normalizeWebsiteUrl() is a comparison key only; using it for
  // persistence would silently change the actual request origin.
  return trimmed
}

export function questionGenerationSourceAvailable(
  project: Pick<Project, 'optimizationTarget' | 'websiteUrl' | 'supplementalInfo'>,
): boolean {
  return Boolean(project.optimizationTarget?.trim() || project.websiteUrl?.trim() || project.supplementalInfo?.trim())
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const companyName = requiredCompanyName(input)
  const result = await databasePool().query(
    `insert into geo_projects (company_name, website_url, optimization_target, supplemental_info)
     values ($1, $2, $3, $4)
     returning ${projectColumns}`,
    [companyName, websiteText(input.websiteUrl), optionalText(input.optimizationTarget), optionalText(input.supplementalInfo)],
  )
  return projectFromRow(result.rows[0])
}

/**
 * Delete a project and let the database cascade remove related records.
 * Lock the project row for the duration of the transaction so task discovery
 * and the cascading delete use one consistent snapshot.  Confirmed questions
 * and published articles do not make the project undeletable; deletion is an
 * explicit project-level operation and removes the complete project history.
 */
export async function deleteProject(id: string): Promise<boolean> {
  const client = await databasePool().connect()
  let taskIds: string[] = []
  try {
    await client.query('BEGIN')
    const project = await client.query(
      `select id
       from geo_projects
       where id = $1
       for update`,
      [id],
    )
    if (!project.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const tasks = await client.query<{ id: string }>('select id from geo_ai_tasks where project_id = $1 for update', [id])
    taskIds = tasks.rows.map((row) => String(row.id))
    await client.query('delete from geo_projects where id = $1', [id])
    await client.query('COMMIT')
    abortAiTaskControllersById(id, taskIds)
    return true
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    client.release()
  }
}

export type ProjectMutation = {
  project: Project | null
  websiteChanged: boolean
  /** Whether this request cleared an unconfirmed question outline. */
  resetPerformed: boolean
  /** Whether this request consumed the one empty-website fill operation. */
  websiteFilled: boolean
}

async function updateProjectMutation(id: string, input: ProjectInput): Promise<ProjectMutation> {
  const has = (key: keyof ProjectInput): boolean => Object.prototype.hasOwnProperty.call(input, key)
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      `select ${projectColumns},
              exists (
                select 1 from geo_ai_tasks task
                where task.project_id = geo_projects.id and task.status = 'running'
              ) as project_has_running_task,
              exists (
                select 1 from geo_project_questions question
                where question.project_id = geo_projects.id
              ) as project_has_questions,
              coalesce(content_audit->>'status', '') = 'checking' as content_audit_running
       from geo_projects
       where id = $1
       for update`,
      [id],
    )
    if (!currentResult.rows[0]) {
      await client.query('ROLLBACK')
      return { project: null, websiteChanged: false, resetPerformed: false, websiteFilled: false }
    }

    const currentRow = currentResult.rows[0] as Record<string, unknown>
    const current = projectFromRow(currentRow)
    const companyName = has('companyName') ? requiredCompanyName(input) : current.companyName
    const submittedWebsiteUrl = has('websiteUrl') ? websiteText(input.websiteUrl) : current.websiteUrl
    const optimizationTarget = has('optimizationTarget') ? optionalText(input.optimizationTarget) : current.optimizationTarget
    const supplementalInfo = has('supplementalInfo') ? optionalText(input.supplementalInfo) : current.supplementalInfo

    const profileChanged = companyName !== current.companyName
      || optimizationTarget !== current.optimizationTarget
      || supplementalInfo !== current.supplementalInfo
    const currentWebsiteKey = current.websiteUrl ? normalizeWebsiteUrl(current.websiteUrl) : null
    const submittedWebsiteKey = submittedWebsiteUrl ? normalizeWebsiteUrl(submittedWebsiteUrl) : null
    const websiteChanged = submittedWebsiteKey !== currentWebsiteKey
    const websiteUrl = websiteChanged ? submittedWebsiteUrl : current.websiteUrl

    // A retry that carries the current values is a true no-op.  In
    // particular, do not require confirmation or touch updated_at in this
    // branch: repeating a saved form must not clear data created after the
    // first save.
    if (!profileChanged && !websiteChanged) {
      await client.query('COMMIT')
      return { project: current, websiteChanged: false, resetPerformed: false, websiteFilled: false }
    }

    const databaseBoolean = (value: unknown): boolean => value === true || value === 't' || value === 1 || value === '1'
    const projectBusy = current.questionsGenerationStatus === 'generating'
      || current.initialDiagnosisStatus === 'running'
      || current.initialDiagnosisStatus === 'analyzing'
      || databaseBoolean(currentRow.project_has_running_task)
      || databaseBoolean(currentRow.content_audit_running)
    if (projectBusy) throw new Error('project_tasks_in_progress')

    if (current.questionsLockedAt) {
      // After the complete question set is confirmed, all business fields are
      // immutable.  The only permitted mutation is filling an empty website
      // once; it intentionally does not touch questions, diagnoses, tasks or
      // any website-crawl rows.
      if (profileChanged) throw new Error('questions_locked')
      if (!websiteChanged) {
        await client.query('COMMIT')
        return { project: current, websiteChanged: false, resetPerformed: false, websiteFilled: false }
      }
      if (current.websiteUrl || !websiteUrl) throw new Error('website_locked')
      expectedProjectTimestamp(current, input.expectedUpdatedAt)
      const filled = await client.query(
        `update geo_projects
         set website_url = $1,
             website_locked_at = coalesce(website_locked_at, clock_timestamp()),
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
         where id = $2
           and questions_locked_at is not null
           and website_url is null
           and date_trunc('milliseconds', updated_at) = $3::timestamptz
         returning ${projectColumns}`,
        [websiteUrl, id, current.updatedAt],
      )
      if (!filled.rows[0]) {
        await client.query('ROLLBACK')
        return { project: null, websiteChanged: false, resetPerformed: false, websiteFilled: false }
      }
      // A website fill changes the evidence basis of the initial report.  The
      // old binary must become unavailable in the same transaction as the
      // successful fill; a failed/rolled-back fill therefore leaves it intact.
      await client.query(
        `update geo_diagnosis_runs
         set report_pdf = null,
             report_pdf_generated_at = null,
             report_refresh_status = 'not_started',
             report_refresh_started_at = null,
             report_refresh_error = null
         where project_id = $1 and run_type = 'initial'`,
        [id],
      )
      await client.query('COMMIT')
      return {
        project: projectFromRow(filled.rows[0]),
        websiteChanged: true,
        resetPerformed: false,
        websiteFilled: true,
      }
    }

    // Editing a newly-created project before any question has actually been
    // persisted must not require a destructive reset confirmation.  Keep the
    // existing reset rules for projects that do have an outline; generation
    // timestamps/status alone are not evidence that questions exist.
    const actualQuestionsExist = databaseBoolean(currentRow.project_has_questions)
    const resetPerformed = actualQuestionsExist
      && (profileChanged || (websiteChanged && !optimizationTarget && !supplementalInfo))
    // Only an unconfirmed question outline is cleared.  A website-only edit
    // with business material keeps the outline because question generation
    // does not depend on the website in that branch.
    if (resetPerformed && input.resetConfirmed !== true) throw new Error('project_reset_confirmation_required')
    expectedProjectTimestamp(current, input.expectedUpdatedAt)

    // Validation and the profile update happen in one transaction.  No
    // diagnosis, monitoring, article, audit or task table is reset here.
    const updatedResult = await client.query(
      `update geo_projects
       set company_name = $1,
           website_url = $2,
           optimization_target = $3,
           supplemental_info = $4,
           questions_generated_at = case when $7 then null else questions_generated_at end,
           questions_generation_status = case when $7 then 'not_started' else questions_generation_status end,
           questions_generation_started_at = case when $7 then null else questions_generation_started_at end,
           questions_generation_completed_at = case when $7 then null else questions_generation_completed_at end,
           questions_generation_error = case when $7 then null else questions_generation_error end,
           questions_generation_task_id = case when $7 then null else questions_generation_task_id end,
           -- A real pre-lock website change invalidates every content-audit
           -- result tied to the old site.  Keep this separate from the
           -- question-outline reset: profile-only edits do not erase audit
           -- history, while a same-site normalized retry remains a no-op.
           content_audit = case when $8 then null::jsonb else content_audit end,
           content_audit_history = case when $8 then '[]'::jsonb else content_audit_history end,
           content_audit_task_id = case when $8 then null else content_audit_task_id end,
           updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
       where id = $5
         and date_trunc('milliseconds', updated_at) = $6::timestamptz
       returning ${projectColumns}`,
      [companyName, websiteUrl, optimizationTarget, supplementalInfo, id, current.updatedAt, resetPerformed, websiteChanged],
    )
    if (!updatedResult.rows[0]) {
      await client.query('ROLLBACK')
      return { project: null, websiteChanged: false, resetPerformed: false, websiteFilled: false }
    }

    if (resetPerformed) {
      await client.query('delete from geo_project_questions where project_id = $1', [id])
    }

    const finalResult = await client.query(`select ${projectColumns} from geo_projects where id = $1`, [id])
    await client.query('COMMIT')
    return {
      project: finalResult.rows[0] ? projectFromRow(finalResult.rows[0]) : null,
      websiteChanged,
      resetPerformed,
      websiteFilled: false,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project | null> {
  return (await updateProjectMutation(id, input)).project
}

/** Internal API variant used by the HTTP handler for project edits. */
export async function updateProjectWithWebsiteChange(id: string, input: ProjectInput): Promise<ProjectMutation> {
  return updateProjectMutation(id, input)
}

/**
 * The website entry point uses the same transaction as the full project edit.
 * After overall lock this adapter can only consume the one empty-website fill
 * operation; it cannot replace an existing website or reset project data.
 */
async function updateProjectWebsiteMutation(
  id: string,
  value: unknown,
  resetConfirmed?: unknown,
  expectedUpdatedAt?: unknown,
): Promise<ProjectMutation> {
  return updateProjectMutation(id, {
    websiteUrl: value,
    resetConfirmed,
    expectedUpdatedAt,
  })
}

export async function updateProjectWebsite(
  id: string,
  value: unknown,
  resetConfirmed?: unknown,
  expectedUpdatedAt?: unknown,
): Promise<Project | null> {
  return (await updateProjectWebsiteMutation(id, value, resetConfirmed, expectedUpdatedAt)).project
}

/** Internal API variant used by the HTTP handler for the website entry point. */
export async function updateProjectWebsiteWithChange(
  id: string,
  value: unknown,
  resetConfirmed?: unknown,
  expectedUpdatedAt?: unknown,
): Promise<ProjectMutation> {
  return updateProjectWebsiteMutation(id, value, resetConfirmed, expectedUpdatedAt)
}

/**
 * Claim a not-started crawl for the exact URL currently stored on the
 * project.  The returned formatted timestamp is the crawl task token.  No
 * schema change is needed: the existing started_at column is used as a
 * compare-and-set marker, with its microseconds preserved in the token.
 */
export async function markWebsiteCrawlStarted(id: string, expectedWebsiteUrl?: string | null): Promise<string | null> {
  let websiteUrl = expectedWebsiteUrl
  if (websiteUrl === undefined) websiteUrl = (await getProject(id))?.websiteUrl
  if (!websiteUrl) return null

  const result = await databasePool().query<{ crawl_token: string }>(
    `update geo_projects
     set website_crawl_status = 'crawling',
         -- Keep the task marker at millisecond precision because the public
         -- Project shape serializes timestamptz through a JavaScript Date.
         website_crawl_started_at = date_trunc('milliseconds', clock_timestamp()),
         website_crawl_completed_at = null,
         website_crawl_error = null,
         website_crawl_source = null,
         website_crawl_incomplete = false,
         website_pages_discovered = 0,
         website_pages_succeeded = 0,
         website_pages_failed = 0,
         updated_at = clock_timestamp()
     where id = $1
       and website_url = $2
       and website_crawl_status = 'not_started'
     returning to_char(website_crawl_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as crawl_token`,
    [id, websiteUrl],
  )
  return result.rows[0]?.crawl_token ?? null
}

/**
 * Persist a crawl only if the URL and task token still match.  The project
 * row lock makes URL replacement and this commit linearizable, so late A/B/A
 * results cannot delete or overwrite the active cache.
 */
export async function saveWebsiteCrawl(
  id: string,
  websiteUrl: string,
  crawlToken: string,
  result: WebsiteCrawlResult,
): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query<{ website_url: string | null; website_crawl_status: string; crawl_token: string | null }>(
      `select website_url, website_crawl_status,
              to_char(website_crawl_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as crawl_token
       from geo_projects
       where id = $1
       for update`,
      [id],
    )
    const project = projectResult.rows[0]
    if (!project
      || project.website_url !== websiteUrl
      || project.website_crawl_status !== 'crawling'
      || project.crawl_token !== crawlToken) {
      await client.query('COMMIT')
      return false
    }
    await client.query('delete from geo_project_website_pages where project_id = $1', [id])
    for (const page of result.pages) {
      await client.query(
        `insert into geo_project_website_pages (project_id, url, title, body_text, status, error, fetched_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [id, page.url, page.title, page.bodyText, page.status, page.error],
      )
    }
    await client.query(
      `update geo_projects
       set website_crawl_status = $1,
           website_crawl_completed_at = clock_timestamp(),
           website_crawl_error = $2,
           website_crawl_source = $3,
           website_crawl_incomplete = $4,
           website_pages_discovered = $5,
           website_pages_succeeded = $6,
           website_pages_failed = $7,
           updated_at = now()
       where id = $8`,
      [result.status, result.error, result.source, result.incomplete, result.discoveredCount, result.successCount, result.failedCount, id],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const QUESTION_CATEGORY_KEYS = Object.keys(QUESTION_GROUP_COUNTS) as QuestionCategory[]

function questionCategoryFromValue(value: unknown): QuestionCategory | null {
  return typeof value === 'string' && QUESTION_CATEGORY_KEYS.includes(value as QuestionCategory)
    ? value as QuestionCategory
    : null
}

function questionFromRow(row: Record<string, unknown>): Question {
  return {
    id: String(row.id),
    position: Number(row.position),
    question: String(row.question),
    generatedAt: nullableIso(row.generated_at) ?? new Date(0).toISOString(),
    category: questionCategoryFromValue(row.category),
    isLocked: row.is_locked === true || row.is_locked === 't' || row.is_locked === 1,
  }
}

function normalizedQuestionKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function questionForbiddenTerms(project: Project): string[] {
  const terms = [project.companyName.trim().toLocaleLowerCase()]
  if (project.websiteUrl) {
    try {
      const url = new URL(project.websiteUrl)
      terms.push(url.hostname.toLocaleLowerCase(), url.host.toLocaleLowerCase())
    } catch {
      // The project write boundary validates the URL.  Keep this guard
      // defensive for legacy rows rather than rejecting a whole save here.
    }
  }
  return [...new Set(terms.filter(Boolean))]
}

function validatedQuestionText(value: unknown, project: Project, seen: Set<string>): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('questions_content_invalid')
  const question = value.trim()
  const key = normalizedQuestionKey(question)
  if (seen.has(key)) throw new Error('questions_duplicate')
  seen.add(key)
  const lower = question.toLocaleLowerCase()
  if (questionForbiddenTerms(project).some((term) => lower.includes(term))) {
    throw new Error('questions_content_invalid')
  }
  return question
}

function expectedProjectTimestamp(project: Project, expectedUpdatedAt: unknown): void {
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt !== project.updatedAt) {
    throw new Error('project_changed')
  }
}

function questionRowsQuery(): string {
  return `select id, project_id, position, question, generated_at, category, is_locked
          from geo_project_questions
          where project_id = $1
          order by position`
}

function validateQuestionSet(project: Project, rows: Question[]): void {
  if (rows.length !== QUESTION_TOTAL) throw new Error('questions_count_invalid')
  const positions = new Set<number>()
  const seen = new Set<string>()
  const counts: Record<QuestionCategory, number> = {
    recommendation: 0,
    selection: 0,
    decision: 0,
  }
  for (const row of rows) {
    if (!Number.isInteger(row.position) || row.position < QUESTION_POSITION_MIN || row.position > QUESTION_POSITION_MAX || positions.has(row.position)) {
      throw new Error('questions_count_invalid')
    }
    positions.add(row.position)
    if (!row.category || !QUESTION_CATEGORY_KEYS.includes(row.category)) {
      throw new Error('question_categories_required')
    }
    counts[row.category] += 1
    // Existing locked rows are already persisted, but checking them again at
    // the transaction boundary prevents a malformed legacy row from being
    // carried into a newly generated set.
    validatedQuestionText(row.question, project, seen)
  }
  if (positions.size !== QUESTION_TOTAL || QUESTION_CATEGORY_KEYS.some((key) => counts[key] !== QUESTION_GROUP_COUNTS[key])) {
    throw new Error('questions_count_invalid')
  }
}

function generatedQuestionFromValue(value: unknown): GeneratedQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('questions_content_invalid')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'category' || keys[1] !== 'question') {
    throw new Error('questions_content_invalid')
  }
  const category = questionCategoryFromValue(record.category)
  if (!category || typeof record.question !== 'string') throw new Error('questions_content_invalid')
  return { question: record.question, category }
}

function validateGeneratedQuestions(
  project: Project,
  lockedQuestions: Question[],
  generated: GeneratedQuestion[],
): GeneratedQuestion[] {
  if (!Array.isArray(generated)) throw new Error('questions_count_invalid')
  const expectedCounts: Record<QuestionCategory, number> = {
    recommendation: QUESTION_GROUP_COUNTS.recommendation,
    selection: QUESTION_GROUP_COUNTS.selection,
    decision: QUESTION_GROUP_COUNTS.decision,
  }
  for (const locked of lockedQuestions) {
    if (!locked.category) throw new Error('question_categories_required')
    expectedCounts[locked.category] -= 1
  }
  if (Object.values(expectedCounts).some((count) => count < 0)) throw new Error('questions_count_invalid')
  if (generated.length !== Object.values(expectedCounts).reduce((sum, count) => sum + count, 0)) {
    throw new Error('questions_count_invalid')
  }

  const seen = new Set<string>()
  for (const locked of lockedQuestions) {
    if (!locked.question.trim()) throw new Error('questions_content_invalid')
    const key = normalizedQuestionKey(locked.question)
    if (seen.has(key)) throw new Error('questions_duplicate')
    seen.add(key)
  }

  const result: GeneratedQuestion[] = []
  for (const value of generated) {
    const question = generatedQuestionFromValue(value)
    if (expectedCounts[question.category] <= 0) throw new Error('questions_count_invalid')
    expectedCounts[question.category] -= 1
    result.push({
      question: validatedQuestionText(question.question, project, seen),
      category: question.category,
    })
  }
  if (Object.values(expectedCounts).some((count) => count !== 0)) throw new Error('questions_count_invalid')
  return result
}

/**
 * Lock a project, validate the current state, and snapshot the exact profile,
 * website pages, and locked questions used for one request.  Returning a
 * database token lets the eventual AI response commit only if this request
 * is still current after the network call completes.
 */
export async function beginQuestionGeneration(
  id: string,
  expectedUpdatedAt: string,
  taskId?: string,
): Promise<QuestionGenerationPreparation | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns} from geo_projects where id = $1 for update`,
      [id],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (taskId) {
      const taskResult = await client.query<{ id: string; status: string }>(
        `select id, status
         from geo_ai_tasks
         where id = $2 and project_id = $1
         for update`,
        [id, taskId],
      )
      if (taskResult.rows[0]?.status !== 'running') throw new Error('ai_task_stale')
    }
    const current = projectFromRow(projectResult.rows[0])
    expectedProjectTimestamp(current, expectedUpdatedAt)
    if (current.questionsLockedAt) throw new Error('questions_locked')
    if (current.questionsGenerationStatus === 'generating') throw new Error('questions_generation_in_progress')

    const questionResult = await client.query(questionRowsQuery(), [id])
    const existingQuestions = questionResult.rows.map(questionFromRow)
    const lockedQuestions = existingQuestions.filter((question) => question.isLocked)
    if (lockedQuestions.some((question) => question.category === null)) throw new Error('question_categories_required')
    if (existingQuestions.length === QUESTION_TOTAL && lockedQuestions.length === QUESTION_TOTAL) throw new Error('all_questions_locked')
    if (!questionGenerationSourceAvailable(current)) throw new Error('question_source_required')

    const updatedResult = await client.query(
      `update geo_projects
       set questions_generation_status = 'generating',
           questions_generation_started_at = clock_timestamp(),
           questions_generation_completed_at = null,
           questions_generation_error = null,
           questions_generation_task_id = $2,
           updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
       where id = $1 and questions_generation_status <> 'generating'
       returning ${projectColumns},
                 to_char(questions_generation_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as generation_token`,
      [id, taskId ?? null],
    )
    const updated = updatedResult.rows[0]
    if (!updated) throw new Error('questions_generation_in_progress')

    await client.query('COMMIT')
    return {
      project: projectFromRow(updated),
      // Website pages are never used as a persisted question-generation
      // snapshot.  The project-preparation layer may replace this empty array
      // with one bounded, task-scoped page only for the website-only branch.
      pages: [],
      lockedQuestions,
      generationToken: String(updated.generation_token),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveQuestions(
  id: string,
  questions: GeneratedQuestion[],
  generationToken: string,
): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns},
              to_char(questions_generation_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as generation_token
       from geo_projects where id = $1 for update`,
      [id],
    )
    const projectRow = projectResult.rows[0]
    if (!projectRow) {
      await client.query('ROLLBACK')
      return false
    }
    const project = projectFromRow(projectRow)
    const current = {
      questions_generation_status: String(projectRow.questions_generation_status ?? 'not_started'),
      questions_locked_at: projectRow.questions_locked_at,
      generation_token: projectRow.generation_token === null || projectRow.generation_token === undefined
        ? null
        : String(projectRow.generation_token),
    }
    if (current.questions_locked_at) throw new Error('questions_locked')
    if (current.questions_generation_status !== 'generating' || current.generation_token !== generationToken) {
      await client.query('COMMIT')
      return false
    }

    const questionResult = await client.query(questionRowsQuery(), [id])
    const existingQuestions = questionResult.rows.map(questionFromRow)
    const lockedQuestions = existingQuestions.filter((question) => question.isLocked)
    const generated = validateGeneratedQuestions(project, lockedQuestions, questions)
    const lockedByPosition = new Map(lockedQuestions.map((question) => [question.position, question]))
    const generatedByPosition: Question[] = []
    let generatedIndex = 0
    for (let position = QUESTION_POSITION_MIN; position <= QUESTION_POSITION_MAX; position += 1) {
      if (lockedByPosition.has(position)) continue
      const value = generated[generatedIndex++]
      if (!value) throw new Error('questions_count_invalid')
      generatedByPosition.push({
        id: '',
        position,
        question: value.question,
        generatedAt: new Date().toISOString(),
        category: value.category,
        isLocked: false,
      })
    }
    const finalQuestions = [...lockedQuestions, ...generatedByPosition].sort((a, b) => a.position - b.position)
    validateQuestionSet(project, finalQuestions)

    // Validate first, then replace only unlocked rows.  A validation or late
    // task failure therefore leaves the previously visible question set intact.
    await client.query('delete from geo_project_questions where project_id = $1 and is_locked = false', [id])
    for (const question of generatedByPosition) {
      await client.query(
        `insert into geo_project_questions (project_id, position, question, category, is_locked)
         values ($1, $2, $3, $4, false)`,
        [id, question.position, question.question, question.category],
      )
    }
    await client.query(
      `update geo_projects
       set questions_generated_at = now(),
           questions_generation_status = 'completed',
           questions_generation_completed_at = now(),
           questions_generation_error = null,
           updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
       where id = $1`,
      [id],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveQuestionGenerationError(id: string, message: string, generationToken: string): Promise<boolean> {
  const result = await databasePool().query(
    `update geo_projects
     set questions_generation_status = 'failed',
         questions_generation_completed_at = null,
         questions_generation_error = $1,
         updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
     where id = $2
       and questions_generation_status = 'generating'
       and to_char(questions_generation_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') = $3`,
    [message, id, generationToken],
  )
  return result.rowCount === 1
}

export async function confirmQuestions(id: string, expectedUpdatedAt: string): Promise<ProjectDetail | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns},
              exists (
                select 1 from geo_ai_tasks task
                where task.project_id = geo_projects.id and task.status = 'running'
              ) as project_has_running_task,
              coalesce(content_audit->>'status', '') = 'checking' as content_audit_running
       from geo_projects
       where id = $1
       for update`,
      [id],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const project = projectFromRow(projectResult.rows[0])
    expectedProjectTimestamp(project, expectedUpdatedAt)
    if (project.questionsLockedAt) throw new Error('questions_locked')
    if (project.questionsGenerationStatus === 'generating') throw new Error('questions_generation_in_progress')
    const projectRow = projectResult.rows[0] as Record<string, unknown>
    const databaseBoolean = (value: unknown): boolean => value === true || value === 't' || value === 1 || value === '1'
    if (databaseBoolean(projectRow.project_has_running_task) || databaseBoolean(projectRow.content_audit_running)) {
      throw new Error('project_tasks_in_progress')
    }
    if (!questionGenerationSourceAvailable(project)) throw new Error('question_source_required')
    const questionResult = await client.query(questionRowsQuery(), [id])
    const questions = questionResult.rows.map(questionFromRow)
    const positions = new Set(questions.map((question) => question.position))
    if (questions.length !== QUESTION_TOTAL
      || positions.size !== QUESTION_TOTAL
      || questions.some((question) => !Number.isInteger(question.position) || question.position < QUESTION_POSITION_MIN || question.position > QUESTION_POSITION_MAX)) {
      throw new Error('questions_count_invalid')
    }
    const categorizedCount = questions.filter((question) => question.category !== null).length
    if (categorizedCount !== 0 && categorizedCount !== questions.length) throw new Error('question_categories_required')
    if (categorizedCount === questions.length) validateQuestionSet(project, questions)
    await client.query(
      `update geo_project_questions
       set is_locked = true
       where project_id = $1`,
      [id],
    )
    await client.query(
      `update geo_projects
       set questions_locked_at = now(),
           website_locked_at = case when website_url is null then null else coalesce(website_locked_at, now()) end,
           diagnosis_started_at = now(),
           updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
       where id = $1`,
      [id],
    )
    await client.query('COMMIT')
    return getProjectDetail(id)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function guardedQuestionMutation(
  projectId: string,
  questionId: string,
  expectedUpdatedAt: unknown,
  operation: 'lock' | 'delete',
  isLocked?: boolean,
): Promise<ProjectDetail | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns},
              exists (
                select 1 from geo_ai_tasks task
                where task.project_id = geo_projects.id and task.status = 'running'
              ) as project_has_running_task,
              coalesce(content_audit->>'status', '') = 'checking' as content_audit_running
       from geo_projects
       where id = $1
       for update`,
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const project = projectFromRow(projectResult.rows[0])
    expectedProjectTimestamp(project, expectedUpdatedAt)
    if (project.questionsLockedAt) throw new Error('questions_locked')
    if (project.questionsGenerationStatus === 'generating') throw new Error('questions_generation_in_progress')
    const projectRow = projectResult.rows[0] as Record<string, unknown>
    const databaseBoolean = (value: unknown): boolean => value === true || value === 't' || value === 1 || value === '1'
    if (project.initialDiagnosisStatus === 'running'
      || project.initialDiagnosisStatus === 'analyzing'
      || databaseBoolean(projectRow.project_has_running_task)
      || databaseBoolean(projectRow.content_audit_running)) {
      throw new Error('project_tasks_in_progress')
    }
    const questionResult = await client.query(
      `select id, position, question, generated_at, category, is_locked
       from geo_project_questions
       where project_id = $1 and id = $2
       for update`,
      [projectId, questionId],
    )
    if (!questionResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const allQuestionsResult = await client.query(
      `select id, position, question, generated_at, category, is_locked
       from geo_project_questions
       where project_id = $1
       order by position
       for update`,
      [projectId],
    )
    const allQuestions = allQuestionsResult.rows.map(questionFromRow)
    if (allQuestions.some((question) => question.category === null)) throw new Error('question_categories_required')
    if (operation === 'lock') {
      if (typeof isLocked !== 'boolean') throw new Error('question_lock_invalid')
      await client.query(
        `update geo_project_questions
         set is_locked = $3
         where project_id = $1 and id = $2`,
        [projectId, questionId, isLocked],
      )
    } else {
      await client.query(
        'delete from geo_project_questions where project_id = $1 and id = $2',
        [projectId, questionId],
      )
    }
    await client.query(
      `update geo_projects
       set updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
       where id = $1`,
      [projectId],
    )
    await client.query('COMMIT')
    return getProjectDetail(projectId)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function setQuestionLocked(
  projectId: string,
  questionId: string,
  isLocked: boolean,
  expectedUpdatedAt: string,
): Promise<ProjectDetail | null> {
  return guardedQuestionMutation(projectId, questionId, expectedUpdatedAt, 'lock', isLocked)
}

export async function deleteQuestion(
  projectId: string,
  questionId: string,
  expectedUpdatedAt: string,
): Promise<ProjectDetail | null> {
  return guardedQuestionMutation(projectId, questionId, expectedUpdatedAt, 'delete')
}

export type DiagnosisPreparation = {
  run: DiagnosisRun
  answers: DiagnosisAnswer[]
}

export async function createOrResumeDiagnosis(
  id: string,
  runType: 'initial' | 'monitoring',
  taskId?: string,
): Promise<DiagnosisPreparation | null> {
  const activePool = databasePool()
  const client = await activePool.connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns} from geo_projects where id = $1 for update`,
      [id],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (taskId) {
      const taskResult = await client.query<{ id: string; status: string }>(
        `select id, status
         from geo_ai_tasks
         where id = $2 and project_id = $1
         for update`,
        [id, taskId],
      )
      if (taskResult.rows[0]?.status !== 'running') throw new Error('ai_task_stale')
    }
    const project = projectFromRow(projectResult.rows[0])
    if (!project.questionsLockedAt) throw new Error('questions_not_locked')

    const questionResult = await client.query(
      `select position, question from geo_project_questions where project_id = $1 order by position`,
      [id],
    )
    if (questionResult.rowCount !== QUESTION_TOTAL || questionResult.rows.some((row) => Number(row.position) !== questionResult.rows.indexOf(row) + QUESTION_POSITION_MIN)) {
      throw new Error('questions_count_invalid')
    }

    let runResult = runType === 'initial'
      ? await client.query(
        `select id, run_type, status, requested_model, round_number, published_article_count,
                started_at, completed_at, summary_analysis, summary_model, summary_error,
                recommendation_rate, official_citation_rate
         from geo_diagnosis_runs
         where project_id = $1 and run_type = 'initial'
         for update`,
        [id],
      )
      : await client.query(
        `select id, run_type, status, requested_model, round_number, published_article_count,
                started_at, completed_at, summary_analysis, summary_model, summary_error,
                recommendation_rate, official_citation_rate
         from geo_diagnosis_runs
         where project_id = $1 and run_type = 'monitoring'
           and status in ('running', 'analyzing', 'failed')
         order by round_number desc
         limit 1
         for update`,
        [id],
      )
    let runRow = runResult.rows[0]
    if (!runRow) {
      const roundNumber = runType === 'initial'
        ? 0
        : Number((await client.query<{ next_round: number }>(
          `select coalesce(max(round_number), 0) + 1 as next_round
           from geo_diagnosis_runs where project_id = $1 and run_type = 'monitoring'`,
          [id],
        )).rows[0]?.next_round ?? 1)
      const publishedArticleCount = runType === 'monitoring'
        ? Number((await client.query<{ count: string }>(
          `select count(*)::int as count from geo_project_articles
           where project_id = $1 and publish_status = 'published'`,
          [id],
        )).rows[0]?.count ?? 0)
        : null
      runResult = await client.query(
        `insert into geo_diagnosis_runs
           (project_id, run_type, round_number, published_article_count, status, diagnosis_ai_task_id)
         values ($1, $2, $3, $4, 'running', $5)
         returning id, run_type, status, requested_model, round_number, published_article_count,
                   started_at, completed_at, summary_analysis, summary_model, summary_error,
                   recommendation_rate, official_citation_rate`,
        [id, runType, roundNumber, publishedArticleCount, taskId ?? null],
      )
      runRow = runResult.rows[0]
    } else if (String(runRow.status) !== 'completed') {
      runResult = await client.query(
        `update geo_diagnosis_runs
         set status = 'running', completed_at = null, summary_error = null,
             diagnosis_ai_task_id = coalesce($2, diagnosis_ai_task_id)
         where id = $1
         returning id, run_type, status, requested_model, round_number, published_article_count,
                   started_at, completed_at, summary_analysis, summary_model, summary_error,
                   recommendation_rate, official_citation_rate`,
        [runRow.id, taskId ?? null],
      )
      runRow = runResult.rows[0]
    }

    for (const row of questionResult.rows) {
      await client.query(
        `insert into geo_diagnosis_answers (run_id, position, question)
         values ($1, $2, $3)
         on conflict (run_id, position) do nothing`,
        [runRow.id, Number(row.position), String(row.question)],
      )
    }
    if (runType === 'initial' && String(runRow.status) !== 'completed') {
      await client.query(
        `update geo_projects
         set initial_diagnosis_status = 'running',
             diagnosis_started_at = (
               select started_at
               from geo_diagnosis_runs
               where id = $2 and project_id = $1 and run_type = 'initial'
             ),
             initial_diagnosis_completed_at = null,
             initial_diagnosis_at = null,
             updated_at = clock_timestamp()
         where id = $1`,
        [id, runRow.id],
      )
    }
    await client.query('COMMIT')
    const run = diagnosisRunFromRow(runRow)
    return { run, answers: await getDiagnosisAnswers(run.id) }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function createOrResumeInitialDiagnosis(id: string): Promise<DiagnosisPreparation | null> {
  return createOrResumeDiagnosis(id, 'initial')
}

/** Bind a report task to the existing diagnosis run before model work starts.
 * The project lock matches reset/delete lock order, so a task accepted just
 * before a reset cannot attach itself to a newer or already-invalid run. */
export async function bindDiagnosisReportTask(
  runId: string,
  projectId: string,
  taskId: string,
): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const project = await client.query('select id from geo_projects where id = $1 for update', [projectId])
    if (!project.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const task = await client.query(
      `select id from geo_ai_tasks
       where id = $1 and project_id = $2 and status = 'running'
       for update`,
      [taskId, projectId],
    )
    if (!task.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const updated = await client.query(
      `update geo_diagnosis_runs
       set diagnosis_ai_task_id = $3
       where id = $1 and project_id = $2 and run_type = 'initial' and status <> 'completed'
       returning id`,
      [runId, projectId, taskId],
    )
    if (!updated.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    client.release()
  }
}

export async function setDiagnosisRunRequestedModel(runId: string, modelId: string): Promise<string | null> {
  const result = await databasePool().query<{ requested_model: string | null }>(
    `update geo_diagnosis_runs
     set requested_model = $2
     where id = $1 and requested_model is null and status <> 'completed'
     returning requested_model`,
    [runId, modelId],
  )
  if (result.rows[0]?.requested_model) return result.rows[0].requested_model
  const current = await databasePool().query<{ requested_model: string | null }>(
    `select requested_model from geo_diagnosis_runs where id = $1`,
    [runId],
  )
  return current.rows[0]?.requested_model ?? null
}

export async function markDiagnosisRunAnalyzing(runId: string, projectId: string, runType: 'initial' | 'monitoring' = 'initial'): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    // Reset and all diagnosis terminal writes serialize through the project
    // row first.  A missing run means this callback belongs to a discarded
    // workflow; never update a newly-reset project's status in that case.
    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const runResult = await client.query<{ id: string; status: string }>(
      `select id, status
       from geo_diagnosis_runs
       where id = $1 and project_id = $2 and run_type = $3
       for update`,
      [runId, projectId, runType],
    )
    const run = runResult.rows[0]
    if (!run || run.status === 'completed') {
      await client.query('COMMIT')
      return false
    }
    const updatedRun = await client.query(
      `update geo_diagnosis_runs
       set status = 'analyzing', summary_error = null
       where id = $1 and project_id = $2 and run_type = $3 and status <> 'completed'`,
      [runId, projectId, runType],
    )
    if (updatedRun.rowCount !== 1) {
      await client.query('COMMIT')
      return false
    }
    if (runType === 'initial') {
      await client.query(
        `update geo_projects
         set initial_diagnosis_status = 'analyzing', updated_at = now()
         where id = $1`,
        [projectId],
      )
    } else {
      await client.query('update geo_projects set updated_at = now() where id = $1', [projectId])
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveDiagnosisAnswer(runId: string, answer: DiagnosisAnswerState, projectId?: string): Promise<boolean> {
  const values = [
    runId,
    answer.position,
    answer.status,
    answer.answerText,
    JSON.stringify(answer.citationUrls),
    answer.responseModel,
    answer.error,
    answer.startedAt,
    answer.completedAt,
  ]

  // Keep the two-argument form for small non-service callers, while the
  // diagnosis service supplies projectId so the write participates in the
  // project -> run -> answer lock order used by reset.  In either form this
  // is an UPDATE only: a deleted answer is never recreated.
  if (projectId === undefined) {
    const result = await databasePool().query(
      `update geo_diagnosis_answers
       set status = $3,
           answer_text = $4,
           citation_urls = $5::jsonb,
           response_model = $6,
           error = $7,
           started_at = $8,
           completed_at = $9,
           updated_at = now()
       where run_id = $1 and position = $2 and status <> 'success'`,
      values,
    )
    return result.rowCount === 1
  }

  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const runResult = await client.query(
      `select id
       from geo_diagnosis_runs
       where id = $1 and project_id = $2
       for update`,
      [runId, projectId],
    )
    if (!runResult.rows[0]) {
      await client.query('COMMIT')
      return false
    }
    const answerResult = await client.query<{ status: string }>(
      `select status
       from geo_diagnosis_answers
       where run_id = $1 and position = $2
       for update`,
      [runId, answer.position],
    )
    if (!answerResult.rows[0]) {
      await client.query('COMMIT')
      return false
    }
    // Re-emitting an already-successful answer is idempotent, not stale.  A
    // present row is enough to let the core continue; only a missing run or
    // answer signals that reset discarded this callback.
    if (answerResult.rows[0].status === 'success') {
      await client.query('COMMIT')
      return true
    }
    const updated = await client.query(
      `update geo_diagnosis_answers
       set status = $3,
           answer_text = $4,
           citation_urls = $5::jsonb,
           response_model = $6,
           error = $7,
           started_at = $8,
           completed_at = $9,
           updated_at = now()
       where run_id = $1 and position = $2 and status <> 'success'`,
      values,
    )
    await client.query('COMMIT')
    return updated.rowCount === 1
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function saveDiagnosisSummary(
  runId: string,
  projectId: string,
  answers: DiagnosisAnswerState[],
  summary: { analysis: unknown; model: string | null; recommendationRate: number; officialCitationRate: number | null },
  runType: 'initial' | 'monitoring' = 'initial',
): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    // Lock in project -> run order, the same order used by the reset.  If the
    // old run has already been deleted, this is a no-op and no project-level
    // metrics may be written for the new workflow.
    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const runResult = await client.query<{ id: string; status: string }>(
      `select id, status
       from geo_diagnosis_runs
       where id = $1 and project_id = $2 and run_type = $3
       for update`,
      [runId, projectId, runType],
    )
    const run = runResult.rows[0]
    if (!run || run.status === 'completed') {
      await client.query('COMMIT')
      return false
    }
    for (const answer of answers) {
      await client.query(
        `update geo_diagnosis_answers
         set recommended = $3,
             official_citation = $4,
             updated_at = now()
         where run_id = $1 and position = $2 and status = 'success'`,
        [runId, answer.position, answer.recommended, answer.officialCitation],
      )
    }
    const updatedRun = await client.query(
      `update geo_diagnosis_runs
       set status = 'completed',
           completed_at = now(),
           summary_analysis = $2::jsonb,
           summary_model = $3,
           summary_error = null,
           recommendation_rate = $4,
           official_citation_rate = $5
      where id = $1
         and project_id = $6
         and run_type = $7
         and status <> 'completed'`,
      [runId, JSON.stringify(summary.analysis), summary.model, summary.recommendationRate, summary.officialCitationRate, projectId, runType],
    )
    if (updatedRun.rowCount !== 1) {
      await client.query('COMMIT')
      return false
    }
    if (runType === 'initial') {
      await client.query(
        `update geo_projects
         set initial_diagnosis_status = 'completed',
             initial_diagnosis_completed_at = now(),
             initial_diagnosis_at = now(),
             initial_recommendation_rate = $2,
             initial_official_citation_rate = $3,
             updated_at = now()
         where id = $1`,
        [projectId, summary.recommendationRate, summary.officialCitationRate],
      )
    } else {
      await client.query('update geo_projects set updated_at = now() where id = $1', [projectId])
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function markDiagnosisRunFailed(runId: string, projectId: string, message: string, runType: 'initial' | 'monitoring' = 'initial'): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    // As with summary/analyzing, lock the project before looking up the run so
    // a reset cannot be followed by a late failure write to the new state.
    const projectResult = await client.query(
      'select id from geo_projects where id = $1 for update',
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      return false
    }
    const runResult = await client.query<{ id: string; status: string }>(
      `select id, status
       from geo_diagnosis_runs
       where id = $1 and project_id = $2 and run_type = $3
       for update`,
      [runId, projectId, runType],
    )
    const run = runResult.rows[0]
    if (!run || run.status === 'completed') {
      await client.query('COMMIT')
      return false
    }
    const updatedRun = await client.query(
      `update geo_diagnosis_runs
       set status = 'failed', completed_at = null, summary_error = $4
       where id = $1 and project_id = $2 and run_type = $3 and status <> 'completed'`,
      [runId, projectId, runType, message],
    )
    if (updatedRun.rowCount !== 1) {
      await client.query('COMMIT')
      return false
    }
    if (runType === 'initial') {
      await client.query(
        `update geo_projects
         set initial_diagnosis_status = 'failed', updated_at = now()
         where id = $1 and initial_diagnosis_status <> 'completed'`,
        [projectId],
      )
    } else {
      await client.query('update geo_projects set updated_at = now() where id = $1', [projectId])
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export type GeneratedArticle = {
  title: string
  questionPositions: number[]
  contentHtml: string
  optimizationType?: string
  optimizationDirection?: string | null
}

export type GeneratedArticleTitle = {
  title: string
  questionPositions: number[]
  optimizationType: string
  optimizationDirection?: string | null
  targetPageUrl?: string | null
  targetPageTitle?: string | null
}

const ARTICLE_OPTIMIZATION_DIRECTION_SET = new Set<string>(ARTICLE_OPTIMIZATION_DIRECTIONS)

function normalizedArticleOptimizationDirection(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error('article_optimization_direction_invalid')
  const normalized = value.trim()
  if (!ARTICLE_OPTIMIZATION_DIRECTION_SET.has(normalized)) throw new Error('article_optimization_direction_invalid')
  return normalized
}

export type ArticleWebsiteCacheExpectation = {
  websiteUrl: string
  websiteCrawlStartedAt: string | null
}

export type ArticleSourceSnapshot = ArticleWebsiteCacheExpectation & {
  diagnosisRunId?: string | null
}

function articleOptimizationType(value: string | null | undefined): 'new' | 'update' | 'legacy' {
  const normalized = value?.trim() ?? ''
  if (normalized === '更新已有文章' || normalized === '更新现有页面') return 'update'
  if (normalized === '新增文章' || normalized === '新增专题文章') return 'new'
  return 'legacy'
}

function normalizedArticleTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function normalizedHttpUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (parsed.username || parsed.password) return null
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:api[-_]?key|access[-_]?token|auth(?:entication)?|credential|cookie|jwt|password|secret|session(?:[-_]?id)?|signature|sig|token)$/iu.test(key)) return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Resolve the title of a validated content-audit target without reading the
 * website or its crawl cache.  The title is evidence metadata from the same
 * current audit round that authorized the update target; it must not be
 * guessed from the URL or copied from an older result.
 */
function contentAuditTargetPageTitle(value: unknown, targetUrl: string | null): string | null {
  const target = normalizedHttpUrl(targetUrl)
  if (!target) return null
  const record = contentAuditRecordFromValue(value)
  if (!contentAuditResultEligible(record)) return null
  for (const item of record.result.items) {
    const hasActionableIssue = Array.isArray(item.issues)
      && item.issues.some((issue) => CONTENT_AUDIT_ISSUE_TYPES.has(issue.type))
    if (!hasActionableIssue) continue
    const locations = Array.isArray(item.locations) && item.locations.length > 0
      ? item.locations
      : [item.evidence]
    if (!locations.some((location) => normalizedHttpUrl(location.pageUrl) === target)) continue
    const title = safeContentAuditField(item.page || item.evidence.page)
    return title ? title.slice(0, 500) : null
  }
  return null
}

function articleProjectPreflight(project: Project, initialDiagnosis: InitialDiagnosis, websiteCacheExpectation: ArticleWebsiteCacheExpectation): void {
  if (!isInitialDiagnosisComplete({ initialDiagnosisStatus: project.initialDiagnosisStatus, initialDiagnosis })) throw new Error('diagnosis_incomplete')
  if (!project.websiteUrl) throw new Error('website_required')
  if (project.websiteCrawlStatus === 'crawling') throw new Error('website_crawl_in_progress')
  if (project.websitePagesSucceeded < 1) throw new Error('website_cache_unavailable')
  if (project.websiteUrl !== websiteCacheExpectation.websiteUrl
    || project.websiteCrawlStartedAt !== websiteCacheExpectation.websiteCrawlStartedAt) {
    throw new Error('website_cache_changed')
  }
}

function isPoolClient(value: unknown): value is PoolClient {
  return Boolean(value && typeof value === 'object' && typeof (value as { query?: unknown }).query === 'function')
}

function articleRowSelect(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}id, ${prefix}project_id, ${prefix}batch_id, ${prefix}title,
          ${prefix}question_position, ${prefix}question_positions, ${prefix}content_html,
          ${prefix}generated_at, ${prefix}updated_at, ${prefix}writing_status,
          ${prefix}writing_error, ${prefix}writing_attempt_token, ${prefix}writing_started_at,
          ${prefix}writing_lease_expires_at, ${prefix}optimization_type,
          ${prefix}optimization_direction,
          ${prefix}target_page_url, ${prefix}target_page_title, ${prefix}publish_status,
          ${prefix}confirmed_at`
}

/**
 * Keep title generation serialized per project without holding a transaction
 * across the provider request. The same leased session is passed to the
 * callback so a max-four pool cannot deadlock while the lock is held.
 */
export async function withArticleTitleGenerationLock<T>(projectId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await databasePool().connect()
  const key = `article-title-generation:${projectId}`
  let acquired = false
  let operationFailure: unknown
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [key],
    )
    acquired = Boolean(result.rows[0]?.locked)
    if (!acquired) throw new Error('article_generation_in_progress')
    try {
      return await operation(client)
    } catch (error) {
      operationFailure = error
      throw error
    }
  } finally {
    let unlockFailure: Error | null = null
    try {
      if (acquired) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
    } catch (error) {
      unlockFailure = error instanceof Error ? error : new Error('article_generation_lock_release_failed')
    }
    if (unlockFailure) {
      client.release(unlockFailure)
      if (!operationFailure) throw unlockFailure
    } else {
      client.release()
    }
  }
}

export async function saveArticleBatch(
  projectId: string,
  requestedModel: string,
  responseModel: string | null,
  articles: GeneratedArticle[],
  websiteCacheExpectation: ArticleWebsiteCacheExpectation,
): Promise<ArticleBatch> {
  if (articles.length < 1) throw new Error('articles_count_invalid')
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns} from geo_projects where id = $1 for update`,
      [projectId],
    )
    if (!projectResult.rows[0]) {
      await client.query('ROLLBACK')
      throw new Error('project_not_found')
    }
    const project = projectFromRow(projectResult.rows[0])
    const initialDiagnosis = await getInitialDiagnosis(projectId, client)
    articleProjectPreflight(project, initialDiagnosis, websiteCacheExpectation)

    const batchResult = await client.query(
      `insert into geo_article_batches (project_id, requested_model, response_model)
       values ($1, $2, $3)
       returning id, project_id, requested_model, response_model, generated_at`,
      [projectId, requestedModel, responseModel],
    )
    const batch = batchResult.rows[0]
    for (const article of articles) {
      await client.query(
        `insert into geo_project_articles
           (project_id, batch_id, title, question_position, question_positions, content_html,
            generated_at, updated_at, publish_status, writing_status, optimization_type, optimization_direction,
            source_website_url, source_website_crawl_started_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, now(), now(), 'pending', 'ready', $7, $8, $9, $10)`,
        [projectId, batch.id, article.title, article.questionPositions[0], JSON.stringify(article.questionPositions), article.contentHtml,
          article.optimizationType?.trim() || '未分类', normalizedArticleOptimizationDirection(article.optimizationDirection), project.websiteUrl, project.websiteCrawlStartedAt],
      )
    }
    await client.query(
      `update geo_projects
       set website_locked_at = coalesce(website_locked_at, now()), updated_at = now()
       where id = $1`,
      [projectId],
    )
    await client.query('COMMIT')
    const batches = await getArticleBatches(projectId)
    const saved = batches.find((item) => item.id === String(batch.id))
    if (!saved) throw new Error('article_batch_unavailable')
    return saved
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction may already be closed */ }
    throw error
  } finally {
    client.release()
  }
}

/** Persist only title rows. A zero-title result is handled by the service and
 * intentionally never creates an empty batch. */
export function saveArticleTitles(
  projectId: string,
  requestedModel: string,
  responseModel: string | null,
  titles: GeneratedArticleTitle[],
  sourceDiagnosisRunId: string | null,
  queryClient?: PoolClient,
  expectedContentAuditStartedAt?: string,
  expectedProjectUpdatedAt?: string,
  aiTaskId?: string,
): Promise<ArticleBatch>
/** @deprecated Compatibility for callers from the pre-direct-read workflow. */
export function saveArticleTitles(
  projectId: string,
  requestedModel: string,
  responseModel: string | null,
  titles: GeneratedArticleTitle[],
  websiteCacheExpectation: ArticleWebsiteCacheExpectation,
  sourceDiagnosisRunId: string | null,
  queryClient?: PoolClient,
  expectedContentAuditStartedAt?: string,
  expectedProjectUpdatedAt?: string,
  aiTaskId?: string,
): Promise<ArticleBatch>
export async function saveArticleTitles(
  projectId: string,
  requestedModel: string,
  responseModel: string | null,
  titles: GeneratedArticleTitle[],
  sourceOrWebsiteExpectation: string | null | ArticleWebsiteCacheExpectation,
  queryClientOrSource?: PoolClient | string | null,
  expectedContentAuditOrClient?: string | PoolClient,
  expectedProjectOrAudit?: string,
  aiTaskIdOrProject?: string,
  legacyAiTaskId?: string,
): Promise<ArticleBatch> {
  if (titles.length < 1) throw new Error('articles_count_invalid')
  const legacyCall = sourceOrWebsiteExpectation !== null
    && typeof sourceOrWebsiteExpectation === 'object'
    && !Array.isArray(sourceOrWebsiteExpectation)
  // Keep old test adapters and pre-direct-read callers source-compatible, but
  // ensure the production (string source run id) path below has no cache
  // lookup or cache gate.  This compatibility branch can be removed once all
  // deployed callers have crossed the direct-reader migration.
  const sourceDiagnosisRunId = legacyCall
    ? typeof queryClientOrSource === 'string' ? queryClientOrSource : null
    : sourceOrWebsiteExpectation
  const queryClient = legacyCall
    ? isPoolClient(expectedContentAuditOrClient) ? expectedContentAuditOrClient : undefined
    : isPoolClient(queryClientOrSource) ? queryClientOrSource : undefined
  const expectedContentAuditStartedAt = legacyCall
    ? expectedProjectOrAudit
    : typeof expectedContentAuditOrClient === 'string' ? expectedContentAuditOrClient : undefined
  const expectedProjectUpdatedAt = legacyCall ? aiTaskIdOrProject : expectedProjectOrAudit
  const aiTaskId = legacyCall ? legacyAiTaskId : aiTaskIdOrProject
  const client = queryClient ?? await databasePool().connect()
  const ownsClient = !queryClient
  try {
    await client.query('BEGIN')
    const projectResult = await client.query(
      `select ${projectColumns}, content_audit from geo_projects where id = $1 for update`,
      [projectId],
    )
    if (!projectResult.rows[0]) throw new Error('project_not_found')
    const project = projectFromRow(projectResult.rows[0])
    if (expectedProjectUpdatedAt !== undefined && project.updatedAt !== expectedProjectUpdatedAt) {
      throw new Error('article_generation_stale')
    }
    if (expectedContentAuditStartedAt !== undefined) {
      const audit = contentAuditRecordFromValue(projectResult.rows[0].content_audit)
      if (!contentAuditGenerationRoundMatches(audit, expectedContentAuditStartedAt)) {
        throw new Error('content_audit_required')
      }
    }
    if (legacyCall) {
      const initialDiagnosis = await getInitialDiagnosis(projectId, client)
      articleProjectPreflight(project, initialDiagnosis, sourceOrWebsiteExpectation)
    }
    const existingResult = await client.query(
      `select title, publish_status, target_page_url
       from geo_project_articles
       where project_id = $1`,
      [projectId],
    )
    const existingTitles = new Set(existingResult.rows.map((row) => normalizedArticleTitle(String(row.title ?? ''))).filter(Boolean))
    const pendingTitles = new Set(existingResult.rows
      .filter((row) => String(row.publish_status ?? 'pending') !== 'published')
      .map((row) => normalizedArticleTitle(String(row.title ?? '')))
      .filter(Boolean))
    const pendingTargets = new Set(existingResult.rows
      .filter((row) => String(row.publish_status ?? 'pending') !== 'published')
      .map((row) => normalizedHttpUrl(row.target_page_url as string | null))
      .filter((value): value is string => Boolean(value)))

    const batchResult = await client.query(
      `insert into geo_article_batches (project_id, requested_model, response_model, ai_task_id)
       values ($1, $2, $3, $4)
       returning id, project_id, requested_model, response_model, generated_at`,
      [projectId, requestedModel, responseModel, aiTaskId ?? null],
    )
    const batch = batchResult.rows[0]
    const preparedTitles: Array<GeneratedArticleTitle & { optimizationType: string; optimizationDirection: string | null; targetPageUrl: string | null; targetPageTitle: string | null }> = []
    for (const article of titles) {
      const type = articleOptimizationType(article.optimizationType)
      const rawTarget = typeof article.targetPageUrl === 'string' ? article.targetPageUrl.trim() : ''
      const requestedTarget = normalizedHttpUrl(article.targetPageUrl)
      // A legacy update row without a target is compatible with a new task.
      // Once a non-empty target is supplied, however, an invalid/credentialed
      // URL must remain an update failure rather than silently changing the
      // operation to a new article.  The target itself is read only when its
      // body-writing task starts; title planning never consults the website
      // cache or performs a page lookup.
      if (type === 'update' && rawTarget && !requestedTarget) throw new Error('article_target_unavailable')
      const isUpdate = type === 'update' && Boolean(requestedTarget)
      const optimizationType = isUpdate ? '更新已有文章' : '新增文章'
      const optimizationDirection = normalizedArticleOptimizationDirection(article.optimizationDirection)
      const targetPageUrl = isUpdate ? requestedTarget : null
      const targetPageTitle = isUpdate
        ? typeof article.targetPageTitle === 'string' && article.targetPageTitle.trim()
          ? article.targetPageTitle.trim().slice(0, 500)
          : contentAuditTargetPageTitle(projectResult.rows[0].content_audit, targetPageUrl)
        : null
      const titleKey = normalizedArticleTitle(article.title)
      if (!titleKey) throw new Error('article_title_exists')
      if (isUpdate) {
        if (targetPageUrl && pendingTargets.has(targetPageUrl)) throw new Error('article_target_exists')
        // A published article with the same title is historical evidence and
        // may be superseded by a new update.  An unfinished title is still an
        // active task, so reject it even when its target URL differs.
        if (pendingTitles.has(titleKey)) throw new Error('article_title_exists')
      } else if (existingTitles.has(titleKey) || pendingTitles.has(titleKey)) {
        // Invalid/missing target updates are deliberately treated as new
        // articles.  Refuse an exact historical collision instead of claiming
        // an update after silently dropping its target.
        throw new Error('article_title_exists')
      }
      if (!isUpdate && pendingTitles.has(titleKey)) throw new Error('article_title_exists')
      preparedTitles.push({ ...article, optimizationType, optimizationDirection, targetPageUrl, targetPageTitle })
      existingTitles.add(titleKey)
      pendingTitles.add(titleKey)
      if (targetPageUrl) pendingTargets.add(targetPageUrl)
    }
    for (const article of preparedTitles) {
      await client.query(
        `insert into geo_project_articles
           (project_id, batch_id, title, question_position, question_positions, content_html,
            generated_at, updated_at, publish_status, writing_status, optimization_type, optimization_direction,
            target_page_url, target_page_title,
            source_diagnosis_run_id)
         values ($1, $2, $3, $4, $5::jsonb, null, now(), now(), 'pending', 'pending', $6, $7, $8, $9, $10)`,
        [projectId, batch.id, article.title, article.questionPositions[0] ?? null, JSON.stringify(article.questionPositions),
          article.optimizationType, article.optimizationDirection, article.targetPageUrl, article.targetPageTitle,
          sourceDiagnosisRunId],
      )
    }
    await client.query(
      `update geo_projects
       set website_locked_at = coalesce(website_locked_at, now()), updated_at = now()
       where id = $1`,
      [projectId],
    )
    await client.query('COMMIT')
    const batches = await getArticleBatches(projectId, client)
    const saved = batches.find((item) => item.id === String(batch.id))
    if (!saved) throw new Error('article_batch_unavailable')
    return saved
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction may already be closed */ }
    throw error
  } finally {
    if (ownsClient) client.release()
  }
}

export type ArticleWritingClaim = {
  article: ProjectArticle
  attemptToken: string
  source: ArticleSourceSnapshot
}

export async function claimArticleWriting(id: string, aiTaskId?: string): Promise<ArticleWritingClaim | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `select ${articleRowSelect('a')}, p.website_url, p.website_crawl_started_at
       from geo_project_articles a
       join geo_projects p on p.id = a.project_id
       where a.id = $1
       for update`,
      [id],
    )
    const row = result.rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return null
    }
    const status = String(row.writing_status ?? (row.content_html ? 'ready' : 'pending')) as ArticleWritingStatus
    const leaseActive = status === 'writing' && row.writing_lease_expires_at && new Date(String(row.writing_lease_expires_at)).getTime() > Date.now()
    if (status === 'ready' || row.publish_status === 'published') {
      await client.query('ROLLBACK')
      throw new Error('article_already_ready')
    }
    if (leaseActive) {
      await client.query('ROLLBACK')
      throw new Error('article_writing_in_progress')
    }
    const attemptToken = randomUUID()
    const updated = await client.query(
      `update geo_project_articles
       set writing_status = 'writing', writing_error = null,
           writing_attempt_token = $2, writing_started_at = now(),
           writing_lease_expires_at = null, writing_ai_task_id = $3, updated_at = now()
       where id = $1
       returning ${articleRowSelect()}`,
      [id, attemptToken, aiTaskId ?? null],
    )
    await client.query('COMMIT')
    if (!updated.rows[0]) throw new Error('article_write_stale')
    const article = articleFromRow(updated.rows[0])
    return {
      article,
      attemptToken,
      source: {
        websiteUrl: String(row.website_url ?? ''),
        websiteCrawlStartedAt: nullableIso(row.website_crawl_started_at),
      },
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction may already be closed */ }
    throw error
  } finally {
    client.release()
  }
}

export async function completeArticleWriting(
  id: string,
  attemptToken: string,
  contentHtml: string,
  _source?: ArticleSourceSnapshot,
): Promise<ProjectArticle | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const current = await client.query(
      `select ${articleRowSelect('a')}, p.website_url, p.website_crawl_started_at,
              p.initial_diagnosis_completed_at
       from geo_project_articles a
       join geo_projects p on p.id = a.project_id
       where a.id = $1 and a.writing_status = 'writing'
       for update`,
      [id],
    )
    const row = current.rows[0]
    if (!row) throw new Error('article_write_stale')
    if (String(row.writing_attempt_token ?? '') !== attemptToken) throw new Error('article_write_stale')
    if (!contentHtml.trim()) throw new Error('article_body_empty')
    const updated = await client.query(
      `update geo_project_articles
       set content_html = $2, writing_status = 'ready', writing_error = null,
           writing_attempt_token = null, writing_started_at = null,
            writing_lease_expires_at = null, updated_at = now()
       where id = $1 and writing_status = 'writing' and writing_attempt_token = $3
       returning ${articleRowSelect()}`,
      [id, contentHtml, attemptToken],
    )
    if (!updated.rows[0]) throw new Error('article_write_stale')
    await client.query('COMMIT')
    return articleFromRow(updated.rows[0])
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* transaction may already be closed */ }
    throw error
  } finally {
    client.release()
  }
}

export async function failArticleWriting(id: string, attemptToken: string, message: string): Promise<boolean> {
  const safeMessage = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360) || '文章正文生成失败，可重新开始'
  const result = await databasePool().query(
    `update geo_project_articles
     set writing_status = 'failed', writing_error = $3,
         writing_attempt_token = null, writing_started_at = null,
          writing_lease_expires_at = null, updated_at = now()
     where id = $1 and writing_status = 'writing' and writing_attempt_token = $2`,
    [id, attemptToken, safeMessage],
  )
  return result.rowCount === 1
}

export async function confirmArticlePublished(id: string): Promise<ProjectArticle | null> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `select ${articleRowSelect()}
       from geo_project_articles where id = $1 for update`,
      [id],
    )
    if (!result.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (String(result.rows[0].writing_status ?? (result.rows[0].content_html ? 'ready' : 'pending')) !== 'ready'
      || typeof result.rows[0].content_html !== 'string'
      || !result.rows[0].content_html.trim()) {
      await client.query('ROLLBACK')
      throw new Error('article_not_ready')
    }
    if (result.rows[0].publish_status !== 'published') {
      await client.query(
        `update geo_project_articles
         set publish_status = 'published', confirmed_at = now(), updated_at = now()
         where id = $1 and publish_status <> 'published'`,
        [id],
      )
    }
    const updated = await client.query(
      `select ${articleRowSelect()}
       from geo_project_articles where id = $1`,
      [id],
    )
    await client.query('COMMIT')
    return updated.rows[0] ? articleFromRow(updated.rows[0]) : null
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export function projectQuestionInput(
  project: Project,
  pages: WebsitePageResult[] = [],
  lockedQuestions: Array<Pick<GeneratedQuestion, 'question' | 'category'>> = [],
): QuestionGenerationInput {
  return {
    companyName: project.companyName,
    websiteUrl: project.websiteUrl,
    optimizationTarget: project.optimizationTarget,
    supplementalInfo: project.supplementalInfo,
    pages,
    lockedQuestions,
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505'
}

export async function closeDatabasePool(): Promise<void> {
  if (!pool) return
  const activePool = pool
  pool = undefined
  await activePool.end()
}
