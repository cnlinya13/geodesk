import process from 'node:process'
import {
  claimContentAudit,
  contentAuditResultEligible,
  failContentAudit,
  finishContentAudit,
  getContentAuditRecord,
  saveContentAuditProgress,
  type ContentAuditProgressSnapshot,
  type ContentAuditClaim,
} from './db.ts'
import { runContentAudit, type ContentAuditRunOptions } from './content-audit-core.ts'
import type {
  ContentAuditExecutionError,
  ContentAuditProgress,
  ContentAuditRecord,
  ContentAuditResult,
} from '../src/content-audit.ts'
import type { DoubaoFetch, DoubaoTimingEvent } from './doubao-client.ts'

export class ContentAuditServiceError extends Error {
  executionErrors?: readonly ContentAuditExecutionError[]

  constructor(message: string, executionErrors?: readonly ContentAuditExecutionError[]) {
    super(message)
    this.name = 'ContentAuditServiceError'
    this.executionErrors = executionErrors
  }
}

export type ContentAuditModelTimingEvent = DoubaoTimingEvent & {
  phase: 'extracting' | 'search' | 'assessment'
  inputChars: number
  modelCall: number
}

export type ContentAuditServiceOptions = Partial<Omit<ContentAuditRunOptions, 'apiKey' | 'modelId' | 'onProgress' | 'onModelTiming'>> & {
  apiKey?: string
  modelId?: string
  fetch?: DoubaoFetch
  onModelTiming?: (event: ContentAuditModelTimingEvent) => void
  signal?: AbortSignal
  taskId?: string
}

function configuration(options: ContentAuditServiceOptions): { apiKey: string; modelId: string } {
  return {
    apiKey: options.apiKey ?? process.env.DOUBAO_API_KEY?.trim() ?? '',
    modelId: options.modelId ?? process.env.DOUBAO_MODEL_ID?.trim() ?? '',
  }
}

function validProgress(value: ContentAuditProgress, fallback: ContentAuditProgress): ContentAuditProgress {
  if (!value || typeof value !== 'object') return fallback
  const progress = value as ContentAuditProgress
  if (!['cleaning', 'extracting', 'checking'].includes(progress.stage)) return fallback
  if (![progress.totalPages, progress.processedPages, progress.totalClaims, progress.processedClaims].every((item) => Number.isSafeInteger(item) && item >= 0)) return fallback
  if (progress.processedPages > progress.totalPages || progress.processedClaims > progress.totalClaims) return fallback
  if (progress.cleanedPages !== undefined
    && (!Number.isSafeInteger(progress.cleanedPages) || progress.cleanedPages < 0 || progress.cleanedPages > progress.totalPages)) return fallback
  const optionalCounters = [progress.failedPages, progress.pendingPages]
  if (optionalCounters.some((item) => item !== undefined
    && (!Number.isSafeInteger(item) || item < 0 || item > progress.totalPages))) return fallback
  if (progress.failedPages !== undefined && progress.pendingPages !== undefined
    && progress.processedPages + progress.failedPages + progress.pendingPages !== progress.totalPages) return fallback
  if (progress.baselineReady !== undefined && typeof progress.baselineReady !== 'boolean') return fallback
  if (progress.baselineSource !== undefined && progress.baselineSource !== 'sitemap' && progress.baselineSource !== 'links') return fallback
  return progress
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function allowlistedTimingValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined
}

const MODEL_TIMING_PHASES = new Set<ContentAuditModelTimingEvent['phase']>(['extracting', 'search', 'assessment'])
const MODEL_TIMING_EVENTS = new Set<DoubaoTimingEvent['event']>(['request_start', 'response_headers', 'body_read_start', 'body_read_end', 'request_failed'])
const MODEL_TIMING_FAILURE_PHASES = new Set<NonNullable<DoubaoTimingEvent['failurePhase']>>(['waiting_headers', 'reading_body'])
const MODEL_TIMING_FAILURE_KINDS = new Set<NonNullable<DoubaoTimingEvent['failureKind']>>(['timeout', 'network', 'http', 'parse'])

function safeTimingCallback(injected?: (event: ContentAuditModelTimingEvent) => void): (event: ContentAuditModelTimingEvent) => void {
  return (event) => {
    try {
      injected?.(event)
    } catch {
      // Injected timing hooks are diagnostic-only and cannot affect auditing.
    }

    // Keep the default log deliberately allowlisted. In particular, do not
    // include correlation IDs, URLs, request input, response bodies, headers,
    // credentials, or any future fields added to the event contract.
    const phase = allowlistedTimingValue(event.phase, MODEL_TIMING_PHASES)
    const eventName = allowlistedTimingValue(event.event, MODEL_TIMING_EVENTS)
    const failurePhase = allowlistedTimingValue(event.failurePhase, MODEL_TIMING_FAILURE_PHASES)
    const failureKind = allowlistedTimingValue(event.failureKind, MODEL_TIMING_FAILURE_KINDS)
    const inputChars = nonNegativeNumber(event.inputChars)
    const modelCall = nonNegativeNumber(event.modelCall)
    const elapsedMs = nonNegativeNumber(event.elapsedMs)
    const timeoutMs = nonNegativeNumber(event.timeoutMs)
    const headersElapsedMs = nonNegativeNumber(event.headersElapsedMs)
    const bodyReadMs = nonNegativeNumber(event.bodyReadMs)
    const httpStatus = typeof event.httpStatus === 'number' && Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599
      ? event.httpStatus
      : undefined
    const fields = [
      ...(phase === undefined ? [] : [`phase=${phase}`]),
      ...(inputChars === undefined ? [] : [`inputChars=${inputChars}`]),
      ...(modelCall === undefined ? [] : [`modelCall=${modelCall}`]),
      ...(eventName === undefined ? [] : [`event=${eventName}`]),
      ...(elapsedMs === undefined ? [] : [`elapsedMs=${elapsedMs}`]),
      ...(timeoutMs === undefined ? [] : [`timeoutMs=${timeoutMs}`]),
      ...(headersElapsedMs === undefined ? [] : [`headersElapsedMs=${headersElapsedMs}`]),
      ...(bodyReadMs === undefined ? [] : [`bodyReadMs=${bodyReadMs}`]),
      ...(httpStatus === undefined ? [] : [`httpStatus=${httpStatus}`]),
      ...(failurePhase === undefined ? [] : [`failurePhase=${failurePhase}`]),
      ...(failureKind === undefined ? [] : [`failureKind=${failureKind}`]),
    ]
    console.info(`[content-audit-timing] ${fields.join(' ')}`)
  }
}

function runnerOptions(
  options: ContentAuditServiceOptions,
  onProgress: (progress: ContentAuditProgress, snapshot?: ContentAuditProgressSnapshot) => Promise<void>,
): Parameters<typeof runContentAudit>[1] {
  const config = configuration(options)
  return {
    ...options,
    apiKey: config.apiKey,
    modelId: config.modelId,
    timeoutMs: options.timeoutMs ?? 0,
    signal: options.signal,
    onProgress,
    onModelTiming: safeTimingCallback(options.onModelTiming),
  }
}

async function runClaimedContentAudit(claim: ContentAuditClaim, options: ContentAuditServiceOptions): Promise<ContentAuditRecord | null> {
  const projectId = claim.project.id
  let progress = claim.record.progress
  try {
    const execution = await runContentAudit(
      {
        websiteUrl: claim.project.websiteUrl as string,
        previousResult: claim.previous?.status === 'completed' ? claim.previous.result : null,
      },
      runnerOptions(options, async (nextProgress, snapshot) => {
        progress = validProgress(nextProgress, progress)
        // Direct website audits intentionally never persist model/tool
        // snapshots or checkpoints. Only truthful counters are saved while
        // the task is running; issue rows are written atomically at success.
        const saved = await saveContentAuditProgress(projectId, claim.record.startedAt, progress)
        if (!saved) throw new ContentAuditServiceError('content_audit_stale')
      }),
    )
    // Keep the actual tool-derived counters; never infer completion from the
    // number of returned issue rows.
    const finalProgress = progress
    await saveContentAuditProgress(projectId, claim.record.startedAt, finalProgress)
    if (execution.executionErrors.length > 0) {
      // A failed direct run must not expose partial issue rows as a formal
      // result. The DB layer retains any prior effective history separately.
      await failContentAudit(
        projectId,
        claim.record.startedAt,
        execution.executionErrors[0]?.message ?? '官网内容检查失败',
        execution.executionErrors,
        execution.usage,
        finalProgress,
        null,
      )
    } else {
      await finishContentAudit(projectId, claim.record.startedAt, execution.result, [], execution.usage, finalProgress)
    }
  } catch (error) {
    // A stale/deleted project is intentionally harmless: the conditional
    // update refuses to resurrect a project or attach a late result. Never
    // persist direct-run partial rows or checkpoints on an exception.
    await failContentAudit(projectId, claim.record.startedAt, error, [], claim.record.usage, progress, null)
  }
  return getContentAuditRecord(projectId)
}

/** Read only the current (latest) content fact-checking record. */
export async function readContentAudit(projectId: string): Promise<ContentAuditRecord | null> {
  return getContentAuditRecord(projectId)
}

/**
 * Start a manually-triggered background audit.  The returned record is the
 * claimed `checking` record; terminal state is persisted by the background
 * runner and can be read through GET without keeping the browser request open.
 */
export async function startContentAudit(
  projectId: string,
  options: ContentAuditServiceOptions = {},
): Promise<ContentAuditRecord | null> {
  const claim = await claimContentAudit(projectId, options.taskId)
  if (!claim) return null
  void runClaimedContentAudit(claim, options).catch(() => undefined)
  return claim.record
}

/** Execute one claimed run synchronously. Intended for focused service tests. */
export async function executeContentAudit(
  projectId: string,
  options: ContentAuditServiceOptions = {},
): Promise<ContentAuditRecord | null> {
  const claim = await claimContentAudit(projectId, options.taskId)
  if (!claim) return null
  return runClaimedContentAudit(claim, options)
}

/**
 * Generation gate.  Only a completed current website-internal result can
 * pass; issue rows (including combined issue types) and a clean zero-finding
 * result do not block generation, while legacy external-check records stay
 * readable but ineligible.
 */
export async function requireContentAudit(projectId: string): Promise<ContentAuditResult> {
  const record = await getContentAuditRecord(projectId)
  if (!contentAuditResultEligible(record)) throw new ContentAuditServiceError('content_audit_required')
  return record.result
}
