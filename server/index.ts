import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  checkDatabase,
  closeDatabasePool,
  confirmQuestions,
  createProject,
  deleteProject,
  getProject,
  getProjectDetail,
  getInitialDiagnosis,
  getInitialDiagnosisReportPdf,
  getMonitoringDeliveryReportPdf,
  isUniqueViolation,
  listProjects,
  markInitialDiagnosisReportRefreshFailed,
  confirmArticlePublished,
  deleteQuestion,
  deleteArticle,
  getArticleProjectId,
  saveMonitoringDeliveryReportPdf,
  setQuestionLocked,
  updateProjectWithWebsiteChange,
  updateProjectWebsiteWithChange,
} from './db.ts'
import { getAiTask, getRunningAiTask, listAiTasks, type AiTask } from './ai-task-db.ts'
import { acceptAndRunAiTask, updateAcceptedAiTaskResult } from './ai-tasks.ts'
import { clearIncompleteAiTasksOnStartup } from './ai-task-db.ts'
import { abortAllAiTaskControllers } from './ai-task-runtime.ts'
import { subscribeAiTask, type AiTaskEvent } from './ai-task-events.ts'
import { ArticleGenerationError } from './article-generator.ts'
import { ArticleServiceError, generateProjectArticles, startArticleWriting } from './articles.ts'
import { generateInitialDiagnosisReport, InitialDiagnosisError, startOrResumeInitialDiagnosis, startOrResumeMonitoring } from './diagnosis.ts'
import { getDiagnosisReportRefresh, startDiagnosisReportRefresh, type DiagnosisReportRefreshMetadata } from './diagnosis-report-service.ts'
import { resolveDiagnosisReportLocale } from './diagnosis-report-locale.ts'
import { generateProjectQuestions } from './project-preparation.ts'
import { executeTechnicalAudit, readTechnicalAudit, TechnicalAuditServiceError } from './technical-audit-service.ts'
import { ContentAuditServiceError, executeContentAudit, readContentAudit } from './content-audit-service.ts'
import type { MonitoringUpdateEvent } from '../src/types.ts'
import { TECHNICAL_AUDIT_RULE_VERSION } from '../src/technical-audit.ts'
import { isInitialDiagnosisComplete } from '../src/initial-diagnosis-completion.ts'
import { QUESTION_TOTAL } from '../src/business-rules.ts'
import {
  isAllowedLocalRuntimeHostHeader,
  isAllowedLocalRuntimeOrigin,
  LOCAL_RUNTIME_API_PORT,
  LOCAL_RUNTIME_HOST,
} from '../local-runtime-config.ts'
import type { Project, ProjectDetail, ProjectMutation } from './db.ts'

const host = LOCAL_RUNTIME_HOST
const port = LOCAL_RUNTIME_API_PORT
const maxBodyBytes = 1_000_000
const maxReportPdfBytes = 15 * 1024 * 1024
const REPORT_REFRESH_ACCEPTANCE_ERROR = '诊断报告刷新暂时无法开始，请稍后重试'
const REPORT_REFRESH_DETAIL_READ_ERROR = '项目已保存，但诊断报告状态暂时无法读取，请稍后重试'

type ReportRefreshResponse = DiagnosisReportRefreshMetadata & {
  /** Whether the failure state was written to the database. */
  persisted?: boolean
}

type ProjectBody = {
  companyName?: unknown
  websiteUrl?: unknown
  optimizationTarget?: unknown
  supplementalInfo?: unknown
  resetConfirmed?: unknown
  expectedUpdatedAt?: unknown
  isLocked?: unknown
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, statusCode: number, error: string, message: string): void {
  sendJson(response, statusCode, { ok: false, error, message })
}

/**
 * A one-time website fill invalidates the old initial-report evidence.  The
 * database mutation is already committed before this acceptance call, so a
 * report-service outage must not turn a successful website save into a failed
 * save or reopen the edit form.  The persisted refresh state (when the
 * service can claim it) remains observable and retryable through the report
 * endpoint.  If acceptance itself cannot reach the database, return a fixed
 * transient failure payload so API callers can surface the retry without
 * pretending that an unpersisted state was stored.
 */
function failedReportRefresh(
  error: string,
  persisted: boolean,
  previous?: ReportRefreshResponse | null,
): ReportRefreshResponse {
  return {
    status: 'failed',
    startedAt: previous?.startedAt ?? null,
    error,
    reportPdfReady: false,
    reportPdfGeneratedAt: null,
    sourceRunId: previous?.sourceRunId ?? null,
    persisted,
  }
}

function reportLocaleFromRequest(request: IncomingMessage) {
  const header = request.headers['x-geo-locale']
  return resolveDiagnosisReportLocale(Array.isArray(header) ? header[0] : header)
}

async function acceptWebsiteReportRefresh(projectId: string, websiteFilled: boolean, reportLocale: ReturnType<typeof reportLocaleFromRequest>): Promise<ReportRefreshResponse | null> {
  if (!websiteFilled) return null
  try {
    return await startDiagnosisReportRefresh(projectId, { locale: reportLocale })
  } catch {
    let persisted = false
    try {
      persisted = await markInitialDiagnosisReportRefreshFailed(projectId, REPORT_REFRESH_ACCEPTANCE_ERROR)
    } catch {
      // A database outage means the transient failure below must not look
      // like a durable report-refresh state.
    }
    console.error('[api] diagnosis report refresh acceptance failed', {
      phase: 'website_fill_acceptance',
      category: persisted ? 'failure_persisted' : 'failure_not_persisted',
    })
    return failedReportRefresh(REPORT_REFRESH_ACCEPTANCE_ERROR, persisted)
  }
}

function fallbackWebsiteCrawl(project: Project): ProjectDetail['websiteCrawl'] {
  return {
    status: project.websiteCrawlStatus,
    source: project.websiteCrawlSource,
    incomplete: project.websiteCrawlIncomplete,
    error: project.websiteCrawlError,
    discoveredCount: project.websitePagesDiscovered,
    successCount: project.websitePagesSucceeded,
    failedCount: project.websitePagesFailed,
    startedAt: project.websiteCrawlStartedAt,
    completedAt: project.websiteCrawlCompletedAt,
  }
}

function fallbackQuestionsGeneration(project: Project): ProjectDetail['questionsGeneration'] {
  return {
    status: project.questionsGenerationStatus,
    error: project.questionsGenerationError,
    startedAt: project.questionsGenerationStartedAt,
    completedAt: project.questionsGenerationCompletedAt,
  }
}

/**
 * Keep a committed mutation visible when the post-commit detail read fails.
 * Only values already present before the mutation are reused; the returned
 * project fields come from the committed mutation, and a website fill always
 * makes the report explicitly unavailable until the refresh finishes.
 */
function fallbackProjectDetail(
  previous: ProjectDetail | null,
  updated: Project,
  mutation: Pick<ProjectMutation, 'resetPerformed' | 'websiteFilled'>,
  reportRefresh: ReportRefreshResponse | null,
): ProjectDetail | Project {
  if (!previous) return updated

  const initialDiagnosis = mutation.websiteFilled
    ? {
      ...previous.initialDiagnosis,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      reportRefreshStatus: reportRefresh?.status ?? ('failed' as const),
      reportRefreshStartedAt: reportRefresh?.startedAt ?? null,
      reportRefreshError: reportRefresh?.error ?? null,
    }
    : previous.initialDiagnosis

  return {
    ...previous,
    ...updated,
    websiteCrawl: fallbackWebsiteCrawl(updated),
    questionsGeneration: fallbackQuestionsGeneration(updated),
    questions: mutation.resetPerformed ? [] : previous.questions,
    initialDiagnosis,
    // These collections are not changed by the project mutation.  Reusing
    // their pre-save values avoids inventing a new result in a read failure.
    monitoringRuns: previous.monitoringRuns,
    articleBatches: previous.articleBatches,
    deliveryReport: previous.deliveryReport,
  }
}

function detailReadFailureReportRefresh(
  reportRefresh: ReportRefreshResponse | null,
): ReportRefreshResponse | null {
  if (!reportRefresh || reportRefresh.status === 'failed') return reportRefresh
  return failedReportRefresh(REPORT_REFRESH_DETAIL_READ_ERROR, false, reportRefresh)
}

async function savedProjectResponse(
  projectId: string,
  previous: ProjectDetail | null,
  updated: Project,
  mutation: Pick<ProjectMutation, 'resetPerformed' | 'websiteFilled'>,
  reportRefresh: ReportRefreshResponse | null,
): Promise<{ project: ProjectDetail | Project; reportRefresh?: ReportRefreshResponse }> {
  try {
    const detail = await getProjectDetail(projectId)
    if (detail) {
      return {
        project: detail,
        ...(reportRefresh ? { reportRefresh } : {}),
      }
    }
  } catch {
    // The mutation has already committed.  Return its result with the last
    // known detail instead of converting a read failure into save failure.
    console.error('[api] saved project detail read failed', {
      phase: 'post_commit_detail_read',
      category: 'database_read',
    })
  }

  const responseReportRefresh = detailReadFailureReportRefresh(reportRefresh)
  return {
    project: fallbackProjectDetail(previous, updated, mutation, responseReportRefresh),
    ...(responseReportRefresh ? { reportRefresh: responseReportRefresh } : {}),
  }
}

async function readBody(request: IncomingMessage): Promise<ProjectBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBodyBytes) throw new Error('body_too_large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body')
  return parsed as ProjectBody
}

async function readReportPdfBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length'] ?? '')
  if (Number.isFinite(contentLength) && contentLength > maxReportPdfBytes) throw new Error('report_pdf_too_large')

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxReportPdfBytes) throw new Error('report_pdf_too_large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function isPdfContentType(value: string | undefined): boolean {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf'
}

function isPdfBody(value: Buffer): boolean {
  return value.length > 5 && value.subarray(0, 5).toString('ascii') === '%PDF-'
}

function sanitizeDiagnosisReportFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
}

function buildDiagnosisReportFilename(companyName: string, completedAt: string | null): string {
  const company = sanitizeDiagnosisReportFilenamePart(companyName) || '未命名公司'
  const dateValue = completedAt ? completedAt.slice(0, 10) : ''
  const date = sanitizeDiagnosisReportFilenamePart(dateValue) || '未标注日期'
  return `${company}-${date}.pdf`
}

function buildMonitoringDeliveryReportFilename(companyName: string, completedAt: string | null): string {
  const company = sanitizeDiagnosisReportFilenamePart(companyName) || '未命名公司'
  const completedDate = completedAt ? new Date(completedAt) : null
  const dateValue = completedDate && !Number.isNaN(completedDate.getTime())
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(completedDate)
    : ''
  const date = sanitizeDiagnosisReportFilenamePart(dateValue) || '未标注日期'
  return `${company}-交付报告-${date}.pdf`
}

function encodedContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function aiTasksProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/ai-tasks$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function aiTaskPathFromPath(pathname: string): { projectId: string; taskId: string } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/ai-tasks\/([^/]+)$/)
  if (!match?.[1] || !match[2]) return null
  try {
    const projectId = decodeURIComponent(match[1])
    const taskId = decodeURIComponent(match[2])
    if (!/^\d+$/.test(projectId) || !/^[A-Za-z0-9-]{8,100}$/.test(taskId)) return null
    return { projectId, taskId }
  } catch {
    return null
  }
}

function actionProjectIdFromPath(pathname: string, action: 'generate' | 'confirm'): string | null {
  const match = pathname.match(new RegExp(`^\\/api\\/projects\\/([^/]+)\\/questions\\/${action}$`))
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function questionMutationIdsFromPath(pathname: string): { projectId: string; questionId: string } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/questions\/([^/]+)$/)
  if (!match?.[1] || !match[2]) return null
  try {
    const projectId = decodeURIComponent(match[1])
    const questionId = decodeURIComponent(match[2])
    if (!/^\d+$/.test(projectId) || !/^\d+$/.test(questionId)) return null
    return { projectId, questionId }
  } catch {
    return null
  }
}

function diagnosisProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/diagnosis\/start-or-resume$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function diagnosisReportProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/diagnosis\/generate-report$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function diagnosisReportRefreshProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/diagnosis\/report-refresh$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function diagnosisReportPdfProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/diagnosis\/report-pdf$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function monitoringDeliveryReportPdfProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/monitoring\/report-pdf$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function monitoringProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/monitoring\/start-or-resume$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function technicalAuditProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/technical-audit$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function contentAuditProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/content-audit$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function technicalAuditPostIsCrossSite(request: IncomingMessage): boolean {
  if ((request.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return true
  const originHeader = request.headers.origin
  if (originHeader === 'null') return true
  if (originHeader && !isAllowedLocalRuntimeOrigin(originHeader)) return true
  const host = request.headers.host?.toLowerCase()
  if (host && !isAllowedLocalRuntimeHostHeader(host)) return true
  return false
}

function websiteProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/website$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function articleGenerateProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/articles\/generate$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function articleConfirmIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/articles\/([^/]+)\/confirm-published$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function articleWriteIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/articles\/([^/]+)\/write$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function articleDeleteIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/articles\/([^/]+)$/)
  if (!match?.[1]) return null
  try {
    const id = decodeURIComponent(match[1])
    return /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function writeDiagnosisEvent(response: ServerResponse, body: unknown): boolean {
  if (response.destroyed) return false
  try {
    response.write(`${JSON.stringify(body)}\n`)
    return true
  } catch {
    return false
  }
}

function acceptsQuestionGenerationStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept
  if (typeof accept !== 'string') return false
  return accept.split(',').some((value) => value.trim().split(';', 1)[0]?.toLowerCase() === 'application/x-ndjson')
}

function startQuestionGenerationStream(response: ServerResponse): void {
  if (response.headersSent) return
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

function writeQuestionGenerationEvent(response: ServerResponse, body: unknown): boolean {
  if (response.destroyed) return false
  try {
    startQuestionGenerationStream(response)
    response.write(`${JSON.stringify(body)}\n`)
    return true
  } catch {
    return false
  }
}

type QuestionGenerationProgressPayload = {
  completedCount: number
  total: number
  questions: Array<{ question: string; category: 'recommendation' | 'selection' | 'decision' }>
}

function questionGenerationProgress(value: unknown): QuestionGenerationProgressPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.completedCount !== 'number'
    || !Number.isSafeInteger(record.completedCount)
    || record.completedCount < 0
    || typeof record.total !== 'number'
    || !Number.isSafeInteger(record.total)
    || record.total < 0
    || record.total > QUESTION_TOTAL
    || record.completedCount > record.total
    || !Array.isArray(record.questions)
    || record.questions.length !== record.completedCount) return null
  const questions = record.questions.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const question = value as Record<string, unknown>
    if (typeof question.question !== 'string' || !question.question.trim()) return null
    if (question.category !== 'recommendation' && question.category !== 'selection' && question.category !== 'decision') return null
    return {
      question: question.question,
      category: question.category,
    }
  })
  if (questions.some((question): question is null => question === null)) return null
  return {
    completedCount: record.completedCount,
    total: record.total,
    questions: questions as QuestionGenerationProgressPayload['questions'],
  }
}

function sameQuestionGenerationProgress(
  left: QuestionGenerationProgressPayload,
  right: QuestionGenerationProgressPayload,
): boolean {
  return left.completedCount === right.completedCount
    && left.total === right.total
    && left.questions.length === right.questions.length
    && left.questions.every((question, index) => {
      const other = right.questions[index]
      return other?.question === question.question && other.category === question.category
    })
}

function extendsQuestionGenerationProgress(
  previous: QuestionGenerationProgressPayload,
  next: QuestionGenerationProgressPayload,
): boolean {
  return next.total === previous.total
    && next.completedCount >= previous.completedCount
    && previous.questions.every((question, index) => {
      const other = next.questions[index]
      return other?.question === question.question && other.category === question.category
    })
}

/**
 * Observe one accepted questions task through process-local notifications.
 * The listener is attached before the snapshot read; events received during
 * that read are queued and replayed after the persisted snapshot so a page
 * cannot miss the first question.
 */
async function streamQuestionGenerationTask(
  request: IncomingMessage,
  response: ServerResponse,
  projectId: string,
  taskId: string,
): Promise<void> {
  let closed = false
  let ready = false
  let terminal = false
  let lastProgress: QuestionGenerationProgressPayload | null = null
  const queued: AiTaskEvent[] = []
  let unsubscribe = (): void => undefined
  let eventChain = Promise.resolve()

  const cleanup = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
  }
  const end = (): void => {
    cleanup()
    if (!response.destroyed) response.end()
  }
  const streamError = (error: string, message: string): void => {
    if (terminal || closed) return
    terminal = true
    if (writeQuestionGenerationEvent(response, { type: 'error', error, message })) response.end()
    cleanup()
  }
  const emitProgress = (value: unknown): void => {
    if (terminal || closed) return
    const progress = questionGenerationProgress(value)
    if (!progress) return
    if (lastProgress) {
      if (sameQuestionGenerationProgress(lastProgress, progress)) return
      if (!extendsQuestionGenerationProgress(lastProgress, progress)) return
    }
    lastProgress = progress
    if (!writeQuestionGenerationEvent(response, { type: 'progress', ...progress })) cleanup()
  }
  const finishFromDatabase = async (): Promise<void> => {
    if (terminal || closed) return
    const latest = await getAiTask(projectId, taskId)
    if (!latest) {
      streamError('questions_generation_missing', '问题生成任务不存在，请重新打开项目后重试')
      return
    }
    if (latest.status === 'running') {
      emitProgress(latest.result?.progress)
      return
    }
    if (latest.status === 'failed') {
      terminal = true
      if (writeQuestionGenerationEvent(response, {
        type: 'error',
        error: 'questions_generation_failed',
        message: latest.error || '问题生成失败，请稍后重试',
      })) response.end()
      cleanup()
      return
    }
    // Do not mark the stream terminal until the persisted project snapshot is
    // available. If this read fails, the caller must still be able to emit a
    // terminal error and close the response rather than silently hanging.
    let project: ProjectDetail | null
    try {
      project = await getProjectDetail(projectId)
    } catch {
      streamError('questions_generation_stream_failed', '问题生成结果暂时无法读取，请重新打开项目查看结果')
      return
    }
    if (!project) {
      streamError('project_not_found', '项目不存在')
      return
    }
    terminal = true
    if (writeQuestionGenerationEvent(response, { type: 'complete', project })) response.end()
    cleanup()
  }
  const handleEvent = async (event: AiTaskEvent): Promise<void> => {
    if (event.taskId !== taskId || terminal || closed) return
    if (event.type === 'progress') {
      emitProgress(event.progress)
      return
    }
    await finishFromDatabase()
  }
  const enqueue = (event: AiTaskEvent): void => {
    if (closed) return
    if (!ready) {
      queued.push(event)
      return
    }
    eventChain = eventChain.then(() => handleEvent(event)).catch(() => {
      streamError('questions_generation_stream_failed', '问题生成实时进度暂时无法读取，请重新打开项目查看结果')
    })
  }

  unsubscribe = subscribeAiTask(taskId, enqueue)
  const onClose = (): void => cleanup()
  // IncomingMessage emits `close` after a normal GET request has been fully
  // read. Only the response lifecycle represents whether this observer's
  // client connection is still usable; listening to request close would
  // unsubscribe a healthy stream before later progress events arrive.
  response.once?.('close', onClose)

  try {
    const latest = await getAiTask(projectId, taskId)
    if (closed) return
    if (!latest) {
      streamError('questions_generation_missing', '问题生成任务不存在，请重新打开项目后重试')
      return
    }
    if (latest.kind !== 'questions') {
      streamError('invalid_response', '服务返回了无法识别的问题生成任务')
      return
    }
    if (latest.status !== 'running') {
      ready = true
      await finishFromDatabase()
      return
    }
    ready = true
    emitProgress(latest.result?.progress)
    for (const event of queued.splice(0)) enqueue(event)
  } catch {
    streamError('questions_generation_stream_failed', '问题生成实时进度暂时无法读取，请重新打开项目查看结果')
  }
}

function acceptsTechnicalAuditStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept
  if (typeof accept !== 'string') return false
  return accept.split(',').some((value) => value.trim().split(';', 1)[0]?.toLowerCase() === 'application/x-ndjson')
}

function startTechnicalAuditStream(response: ServerResponse): void {
  if (response.headersSent) return
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

function writeTechnicalAuditEvent(response: ServerResponse, body: unknown): boolean {
  if (response.destroyed) return false
  try {
    startTechnicalAuditStream(response)
    response.write(`${JSON.stringify(body)}\n`)
    return true
  } catch {
    return false
  }
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = request.url ? new URL(request.url, `http://${host}:${port}`) : null
  const pathname = requestUrl?.pathname ?? ''

  if (request.method === 'GET' && pathname === '/api/health/database') {
    try {
      sendJson(response, 200, await checkDatabase())
    } catch {
      console.error('[api] database health check failed')
      sendJson(response, 503, { ok: false, error: 'database_unavailable' })
    }
    return
  }

  if (request.method === 'GET' && pathname === '/api/projects') {
    try {
      sendJson(response, 200, { ok: true, projects: await listProjects(requestUrl?.searchParams.get('search') ?? '') })
    } catch {
      console.error('[api] project list failed')
      sendError(response, 503, 'database_unavailable', '项目列表暂时无法读取，请稍后重试')
    }
    return
  }

  const aiTaskListProjectId = aiTasksProjectIdFromPath(pathname)
  if (request.method === 'GET' && aiTaskListProjectId) {
    try {
      const project = await getProjectDetail(aiTaskListProjectId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, tasks: await listAiTasks(aiTaskListProjectId) })
    } catch {
      console.error('[api] AI任务列表读取失败')
      sendError(response, 503, 'ai_task_unavailable', 'AI任务状态暂时无法读取，请稍后重试')
    }
    return
  }

  const aiTaskPath = aiTaskPathFromPath(pathname)
  if (request.method === 'GET' && aiTaskPath) {
    try {
      const task = await getAiTask(aiTaskPath.projectId, aiTaskPath.taskId)
      if (!task) {
        sendError(response, 404, 'ai_task_not_found', 'AI任务不存在')
        return
      }
      const project = await getProjectDetail(aiTaskPath.projectId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      if (task.kind === 'questions' && acceptsQuestionGenerationStream(request)) {
        await streamQuestionGenerationTask(request, response, aiTaskPath.projectId, aiTaskPath.taskId)
        return
      }
      sendJson(response, 200, { ok: true, task, project })
    } catch {
      console.error('[api] AI任务读取失败')
      sendError(response, 503, 'ai_task_unavailable', 'AI任务状态暂时无法读取，请稍后重试')
    }
    return
  }

  const diagnosisReportRefreshId = diagnosisReportRefreshProjectIdFromPath(pathname)
  if ((request.method === 'GET' || request.method === 'POST') && diagnosisReportRefreshId) {
    if (request.method === 'POST' && technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '诊断报告刷新请求来源不受支持')
      return
    }
    try {
      const project = await getProject(diagnosisReportRefreshId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const report = request.method === 'POST'
        ? await startDiagnosisReportRefresh(diagnosisReportRefreshId, { locale: reportLocaleFromRequest(request) })
        : await getDiagnosisReportRefresh(diagnosisReportRefreshId)
      sendJson(response, request.method === 'POST' ? 202 : 200, { ok: true, report })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] diagnosis report refresh failed')
        sendError(response, 503, 'diagnosis_report_refresh_unavailable', '诊断报告刷新暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const generateId = actionProjectIdFromPath(pathname, 'generate')
  if (request.method === 'POST' && generateId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '问题请求来源不受支持')
      return
    }
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }
    try {
      const existingTask = await getRunningAiTask(generateId, 'questions')
      if (existingTask) {
        sendJson(response, 202, { ok: true, task: existingTask })
        return
      }
      if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()) {
        sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开项目后重试')
        return
      }
      const task = await acceptAndRunAiTask(generateId, 'questions', null, async (signal, acceptedTask) => {
        const detail = await generateProjectQuestions(generateId, body.expectedUpdatedAt as string, {
          signal,
          taskId: acceptedTask.id,
          onProgress: async (progress) => {
            await updateAcceptedAiTaskResult(acceptedTask.id, { progress })
          },
        })
        if (!detail) return { completed: false, error: 'project_not_found' }
        if (detail.questionsGenerationStatus === 'completed') return { completed: true }
        return { completed: false, error: detail.questionsGenerationError ?? '问题生成失败' }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else if (reason === 'ai_task_duplicate_race') sendError(response, 409, 'questions_generation_in_progress', '问题正在生成，请勿重复提交')
      else if (reason === 'question_source_required') sendError(response, 409, 'question_source_required', '请至少填写优化对象、客户官网或补充信息后再生成问题')
      else if (reason === 'project_tasks_in_progress') sendError(response, 409, 'project_tasks_in_progress', '项目任务正在执行，请稍后再生成问题')
      else {
        console.error('[api] question generation acceptance failed')
        sendError(response, 503, 'generation_unavailable', '问题暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const confirmId = actionProjectIdFromPath(pathname, 'confirm')
  if (request.method === 'POST' && confirmId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '问题请求来源不受支持')
      return
    }
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }
    if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()) {
      sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开项目后重试')
      return
    }
    try {
      const detail = await confirmQuestions(confirmId, body.expectedUpdatedAt)
      if (!detail) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, project: detail })
    } catch (error) {
      if (error instanceof Error && error.message === 'questions_locked') {
        sendError(response, 409, 'questions_locked', '问题已经锁定')
      } else if (error instanceof Error && error.message === 'questions_count_invalid') {
        sendError(response, 409, 'questions_count_invalid', `必须先生成完整的${QUESTION_TOTAL}个问题`)
      } else if (error instanceof Error && error.message === 'questions_generation_in_progress') {
        sendError(response, 409, 'questions_generation_in_progress', '问题正在生成，请稍候再锁定')
      } else if (error instanceof Error && error.message === 'website_crawl_in_progress') {
        sendError(response, 409, 'website_crawl_in_progress', '官网资料正在采集，请稍候再锁定问题')
      } else if (error instanceof Error && error.message === 'project_changed') {
        sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开项目后重试')
      } else if (error instanceof Error && error.message === 'question_categories_required') {
        sendError(response, 409, 'question_categories_required', '当前问题分类不完整，请先完整重新生成问题')
      } else if (error instanceof Error && error.message === 'question_source_required') {
        sendError(response, 409, 'question_source_required', '请至少填写优化对象、客户官网或补充信息后再锁定问题')
      } else if (error instanceof Error && error.message === 'project_tasks_in_progress') {
        sendError(response, 409, 'project_tasks_in_progress', '项目任务正在执行，请稍后再锁定问题')
      } else {
        console.error('[api] question confirmation failed')
        sendError(response, 503, 'database_unavailable', '问题暂时无法锁定，请稍后重试')
      }
    }
    return
  }

  const questionMutationIds = questionMutationIdsFromPath(pathname)
  if ((request.method === 'PATCH' || request.method === 'DELETE') && questionMutationIds) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '问题请求来源不受支持')
      return
    }
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }
    if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()) {
      sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开项目后重试')
      return
    }
    if (request.method === 'PATCH' && typeof body.isLocked !== 'boolean') {
      sendError(response, 400, 'invalid_request', '问题锁定状态必须是布尔值')
      return
    }
    try {
      const detail = request.method === 'PATCH'
        ? await setQuestionLocked(
          questionMutationIds.projectId,
          questionMutationIds.questionId,
          body.isLocked as boolean,
          body.expectedUpdatedAt,
        )
        : await deleteQuestion(
          questionMutationIds.projectId,
          questionMutationIds.questionId,
          body.expectedUpdatedAt,
        )
      if (!detail) {
        sendError(response, 404, 'question_not_found', '问题不存在')
        return
      }
      sendJson(response, 200, { ok: true, project: detail })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_changed') {
        sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开项目后重试')
      } else if (reason === 'questions_locked') {
        sendError(response, 409, 'questions_locked', '问题已经锁定，不能修改单题状态')
      } else if (reason === 'questions_generation_in_progress') {
        sendError(response, 409, 'questions_generation_in_progress', '问题正在生成，请稍候再操作')
      } else if (reason === 'website_crawl_in_progress') {
        sendError(response, 409, 'website_crawl_in_progress', '官网资料正在采集，请稍候再操作')
      } else if (reason === 'question_categories_required') {
        sendError(response, 409, 'question_categories_required', '当前问题缺少分类，请先完整重新生成问题')
      } else if (reason === 'question_not_found') {
        sendError(response, 404, 'question_not_found', '问题不存在')
      } else {
        console.error('[api] question mutation failed')
        sendError(response, 503, 'database_unavailable', '问题暂时无法修改，请稍后重试')
      }
    }
    return
  }

  const websiteId = websiteProjectIdFromPath(pathname)
  if (request.method === 'PATCH' && websiteId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '项目修改请求来源不受支持')
      return
    }
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }
    let previousDetail: ProjectDetail | null = null
    try {
      previousDetail = await getProjectDetail(websiteId)
    } catch {
      // The committed project returned by the mutation remains the minimum
      // honest fallback if the pre-save detail snapshot is unavailable.
    }
    try {
      const mutation = await updateProjectWebsiteWithChange(
        websiteId,
        body.websiteUrl,
        body.resetConfirmed,
        body.expectedUpdatedAt,
      )
      const updated = mutation.project
      if (!updated) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const reportRefresh = await acceptWebsiteReportRefresh(websiteId, mutation.websiteFilled, reportLocaleFromRequest(request))
      const saved = await savedProjectResponse(websiteId, previousDetail, updated, mutation, reportRefresh)
      sendJson(response, 200, { ok: true, ...saved })
    } catch (error) {
      if (error instanceof Error && error.message === 'website_url_invalid') {
        sendError(response, 400, 'website_url_invalid', '客户官网必须是HTTP或HTTPS地址')
      } else if (error instanceof Error && error.message === 'project_reset_confirmation_required') {
        sendError(response, 409, 'project_reset_confirmation_required', '请确认修改资料并清空项目数据')
      } else if (error instanceof Error && error.message === 'project_changed') {
        sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开编辑窗口后确认')
      } else if (error instanceof Error && error.message === 'project_tasks_in_progress') {
        sendError(response, 409, 'project_tasks_in_progress', '项目任务正在执行，请稍后再修改')
      } else if (error instanceof Error && error.message === 'website_locked') {
        sendError(response, 409, 'website_locked', '问题确认后官网只能填写一次，不能修改')
      } else {
        console.error('[api] website save failed')
        sendError(response, 503, 'website_unavailable', '官网保存暂时失败，请稍后重试')
      }
    }
    return
  }

  const articleGenerateId = articleGenerateProjectIdFromPath(pathname)
  if (request.method === 'POST' && articleGenerateId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '文章请求来源不受支持')
      return
    }
    try {
      const task = await acceptAndRunAiTask(articleGenerateId, 'article_titles', null, async (signal, acceptedTask) => {
        const result = await generateProjectArticles(articleGenerateId, {
          signal,
          taskId: acceptedTask.id,
        })
        if (!result) return { completed: false, error: 'project_not_found' }
        return { completed: true, result: { addedCount: result.addedCount } }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] article generation acceptance failed')
        sendError(response, 503, 'article_generation_failed', '文章选题暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const articleDeleteId = articleDeleteIdFromPath(pathname)
  if (request.method === 'DELETE' && articleDeleteId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '文章请求来源不受支持')
      return
    }
    try {
      const result = await deleteArticle(articleDeleteId)
      if (!result) {
        sendError(response, 404, 'article_not_found', '文章不存在')
        return
      }
      sendJson(response, 200, { ok: true, project: result.project, deletedArticleId: result.deletedArticleId })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') {
        sendError(response, 404, 'project_not_found', '项目不存在')
      } else if (reason === 'article_published_immutable') {
        sendError(response, 409, 'article_published_immutable', '已发布文章不可删除')
      } else {
        console.error('[api] article deletion failed')
        sendError(response, 503, 'article_unavailable', '文章删除暂时失败，请稍后重试')
      }
    }
    return
  }

  const articleWriteId = articleWriteIdFromPath(pathname)
  if (request.method === 'POST' && articleWriteId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '文章请求来源不受支持')
      return
    }
    try {
      const projectId = await getArticleProjectId(articleWriteId)
      if (!projectId) {
        sendError(response, 404, 'article_not_found', '文章不存在')
        return
      }
      const task = await acceptAndRunAiTask(projectId, 'article_body', articleWriteId, async (signal, acceptedTask) => {
        const result = await startArticleWriting(articleWriteId, { signal, taskId: acceptedTask.id })
        if (!result) return { completed: false, error: 'article_not_found' }
        return { completed: true }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] article writing acceptance failed')
        sendError(response, 503, 'article_generation_failed', '文章正文暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const articleConfirmId = articleConfirmIdFromPath(pathname)
  if (request.method === 'POST' && articleConfirmId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '文章请求来源不受支持')
      return
    }
    try {
      const article = await confirmArticlePublished(articleConfirmId)
      if (!article) {
        sendError(response, 404, 'article_not_found', '文章不存在')
        return
      }
      sendJson(response, 200, { ok: true, article, project: await getProjectDetail(article.projectId) })
    } catch (error) {
      if (error instanceof Error && error.message === 'article_not_ready') {
        sendError(response, 409, 'article_not_ready', '文章正文生成完成后才能确认发布')
        return
      }
      console.error('[api] article publish confirmation failed')
      sendError(response, 503, 'article_unavailable', '发布状态暂时无法保存，请稍后重试')
    }
    return
  }

  const diagnosisId = diagnosisProjectIdFromPath(pathname)
  if (request.method === 'POST' && diagnosisId) {
    try {
      const project = await getProject(diagnosisId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      if (!project.questionsLockedAt) {
        sendError(response, 409, 'questions_not_locked', `请先确认${QUESTION_TOTAL}个问题，再开始诊断`)
        return
      }
      const task = await acceptAndRunAiTask(diagnosisId, 'diagnosis', null, async (signal, acceptedTask) => {
        const detail = await startOrResumeInitialDiagnosis(diagnosisId, {
          signal,
          taskId: acceptedTask.id,
          reportLocale: reportLocaleFromRequest(request),
          onRunCreated: async (runId) => {
            const updated = await updateAcceptedAiTaskResult(acceptedTask.id, { runId })
            if (!updated) throw new Error('ai_task_stale')
          },
        })
        if (!detail) return { completed: false, error: 'project_not_found' }
        const run = detail.initialDiagnosis.run
        if (run?.status === 'completed') return { completed: true, result: { runId: run.id } }
        return { completed: false, error: run?.summaryError ?? '初始诊断未完成', result: run ? { runId: run.id } : undefined }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'questions_not_locked') sendError(response, 409, 'questions_not_locked', `请先确认${QUESTION_TOTAL}个问题，再开始诊断`)
      else if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] diagnosis acceptance failed')
        sendError(response, 503, 'diagnosis_unavailable', '诊断暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const diagnosisReportId = diagnosisReportProjectIdFromPath(pathname)
  if (request.method === 'POST' && diagnosisReportId) {
    try {
      const existingTask = await getRunningAiTask(diagnosisReportId, 'diagnosis_report')
      if (existingTask) {
        sendJson(response, 202, { ok: true, task: existingTask })
        return
      }
      const detail = await getProjectDetail(diagnosisReportId)
      if (!detail) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const diagnosisTaskRunning = (await listAiTasks(diagnosisReportId)).some((task) => task.kind === 'diagnosis' && task.status === 'running')
      const run = detail.initialDiagnosis.run
      const answersComplete = detail.initialDiagnosis.answers.length === QUESTION_TOTAL && detail.initialDiagnosis.answers.every((answer) => answer.status === 'success')
      if (diagnosisTaskRunning || run?.status === 'running' || run?.status === 'analyzing') {
        sendError(response, 409, 'diagnosis_in_progress', '初始诊断正在执行，请稍后再生成报告')
        return
      }
      if (!detail.questionsLockedAt) {
        sendError(response, 409, 'questions_not_locked', `请先确认${QUESTION_TOTAL}个问题，再开始诊断`)
        return
      }
      if (!run || !answersComplete) {
        sendError(response, 409, 'answers_incomplete', `${QUESTION_TOTAL}个问题尚未全部回答完成`)
        return
      }
      const task = await acceptAndRunAiTask(diagnosisReportId, 'diagnosis_report', null, async (signal, acceptedTask) => {
        const report = await generateInitialDiagnosisReport(diagnosisReportId, {
          signal,
          taskId: acceptedTask.id,
          reportLocale: reportLocaleFromRequest(request),
          onRunCreated: async (runId) => {
            const updated = await updateAcceptedAiTaskResult(acceptedTask.id, { runId })
            if (!updated) throw new Error('ai_task_stale')
          },
        })
        if (!report) return { completed: false, error: 'project_not_found' }
        const reportRun = report.initialDiagnosis.run
        if (reportRun?.status === 'completed') return { completed: true, result: { runId: reportRun.id } }
        return { completed: false, error: reportRun?.summaryError ?? '诊断报告未完成', result: reportRun ? { runId: reportRun.id } : undefined }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] diagnosis report acceptance failed')
        sendError(response, 503, 'diagnosis_report_failed', '诊断报告暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const diagnosisReportPdfId = diagnosisReportPdfProjectIdFromPath(pathname)

  if (request.method === 'GET' && diagnosisReportPdfId) {
    try {
      const report = await getInitialDiagnosisReportPdf(diagnosisReportPdfId)
      if (!report) {
        sendError(response, 404, 'report_pdf_not_found', '诊断报告PDF尚未保存')
        return
      }
      const filename = buildDiagnosisReportFilename(report.companyName, report.completedAt)
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="diagnosis-report.pdf"; filename*=UTF-8''${encodedContentDispositionFilename(filename)}`,
        'Cache-Control': 'private, no-store',
        'Content-Length': report.pdf.length,
      })
      response.end(report.pdf)
    } catch {
      console.error('[api] diagnosis report PDF download failed')
      sendError(response, 503, 'diagnosis_report_pdf_unavailable', '诊断报告PDF暂时无法下载，请稍后重试')
    }
    return
  }

  const monitoringDeliveryReportPdfId = monitoringDeliveryReportPdfProjectIdFromPath(pathname)
  if (request.method === 'PUT' && monitoringDeliveryReportPdfId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '交付报告请求来源不受支持')
      return
    }
    if (!isPdfContentType(request.headers['content-type'])) {
      sendError(response, 415, 'unsupported_media_type', 'PDF保存请求必须使用 application/pdf')
      return
    }

    const querySourceRunId = requestUrl?.searchParams.get('sourceRunId')?.trim()
    const headerSourceRunId = typeof request.headers['x-source-run-id'] === 'string' ? request.headers['x-source-run-id'].trim() : ''
    const sourceRunId = querySourceRunId || headerSourceRunId
    if (!sourceRunId || !/^\d+$/.test(sourceRunId)) {
      sendError(response, 400, 'source_run_required', '必须提供有效的监测轮次 sourceRunId')
      return
    }

    let pdf: Buffer
    try {
      pdf = await readReportPdfBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'report_pdf_too_large') {
        sendError(response, 413, 'report_pdf_too_large', 'PDF文件不能超过15 MiB')
      } else {
        sendError(response, 400, 'invalid_report_pdf', 'PDF文件读取失败，请重试')
      }
      return
    }
    if (!isPdfBody(pdf)) {
      sendError(response, 400, 'invalid_report_pdf', '请求内容不是有效的PDF文件')
      return
    }

    try {
      const saved = await saveMonitoringDeliveryReportPdf(monitoringDeliveryReportPdfId, sourceRunId, pdf)
      if (!saved) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, ...saved })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'delivery_report_run_invalid') {
        sendError(response, 409, 'delivery_report_run_invalid', '监测轮次不属于当前项目')
      } else if (reason === 'delivery_report_run_incomplete') {
        sendError(response, 409, 'delivery_report_incomplete', '本轮监测尚未完整完成，暂时不能保存交付报告')
      } else if (reason === 'delivery_report_stale') {
        sendError(response, 409, 'delivery_report_stale', '该监测轮次已不是最新成功轮次，请刷新后重试')
      } else {
        console.error('[api] monitoring delivery report PDF save failed')
        sendError(response, 503, 'delivery_report_pdf_unavailable', '交付报告PDF暂时无法保存，请稍后重试')
      }
    }
    return
  }

  if (request.method === 'GET' && monitoringDeliveryReportPdfId) {
    try {
      const report = await getMonitoringDeliveryReportPdf(monitoringDeliveryReportPdfId)
      if (!report) {
        sendError(response, 404, 'delivery_report_not_found', '交付报告PDF尚未保存')
        return
      }
      const filename = buildMonitoringDeliveryReportFilename(report.companyName, report.completedAt)
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="delivery-report.pdf"; filename*=UTF-8''${encodedContentDispositionFilename(filename)}`,
        'Cache-Control': 'private, no-store',
        'Content-Length': report.pdf.length,
      })
      response.end(report.pdf)
    } catch {
      console.error('[api] monitoring delivery report PDF download failed')
      sendError(response, 503, 'delivery_report_pdf_unavailable', '交付报告PDF暂时无法下载，请稍后重试')
    }
    return
  }

  const monitoringId = monitoringProjectIdFromPath(pathname)
  if (request.method === 'POST' && monitoringId) {
    try {
      const project = await getProject(monitoringId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const initialDiagnosis = await getInitialDiagnosis(monitoringId)
      if (!isInitialDiagnosisComplete({ initialDiagnosisStatus: project.initialDiagnosisStatus, initialDiagnosis })) {
        sendError(response, 409, 'initial_diagnosis_incomplete', '初始诊断完成后才能开始监测')
        return
      }
      if (!project.websiteUrl) {
        sendError(response, 409, 'website_required', '填写客户官网后才能开始监测')
        return
      }
      const task = await acceptAndRunAiTask(monitoringId, 'monitoring', null, async (signal, acceptedTask) => {
        const detail = await startOrResumeMonitoring(monitoringId, {
          signal,
          taskId: acceptedTask.id,
          onRunCreated: async (runId) => {
            const updated = await updateAcceptedAiTaskResult(acceptedTask.id, { runId })
            if (!updated) throw new Error('ai_task_stale')
          },
        })
        if (!detail) return { completed: false, error: 'project_not_found' }
        const run = detail.monitoringRuns.slice().sort((a, b) => b.roundNumber - a.roundNumber)[0]
        if (run?.status === 'completed') return { completed: true, result: { runId: run.id } }
        return { completed: false, error: run?.summaryError ?? '监测未完成', result: run ? { runId: run.id } : undefined }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'initial_diagnosis_incomplete') sendError(response, 409, 'initial_diagnosis_incomplete', '初始诊断完成后才能开始监测')
      else if (reason === 'website_required') sendError(response, 409, 'website_required', '填写客户官网后才能开始监测')
      else if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] monitoring acceptance failed')
        sendError(response, 503, 'monitoring_unavailable', '监测暂时无法开始，请稍后重试')
      }
    }
    return
  }

  const technicalAuditId = technicalAuditProjectIdFromPath(pathname)
  const contentAuditId = contentAuditProjectIdFromPath(pathname)
  if (contentAuditId && request.method === 'GET') {
    try {
      const project = await getProject(contentAuditId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, audit: await readContentAudit(contentAuditId) })
    } catch {
      console.error('[api] content audit read failed')
      sendError(response, 503, 'content_audit_unavailable', '内容事实核查结果暂时无法读取，请稍后重试')
    }
    return
  }

  if (contentAuditId && request.method === 'POST') {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '内容事实核查请求来源不受支持')
      return
    }
    try {
      const project = await getProject(contentAuditId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const task = await acceptAndRunAiTask(contentAuditId, 'content_audit', null, async (signal, acceptedTask) => {
        const audit = await executeContentAudit(contentAuditId, { signal, taskId: acceptedTask.id })
        if (!audit) return { completed: false, error: 'content_audit_stale' }
        if (audit.status === 'completed' && audit.error === null) return { completed: true }
        return { completed: false, error: audit.error ?? '内容事实核查失败' }
      })
      sendJson(response, 202, { ok: true, task })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      if (reason === 'content_audit_in_progress') sendError(response, 409, 'content_audit_in_progress', '内容事实核查正在进行，请勿重复提交')
      else if (reason === 'project_not_found') sendError(response, 404, 'project_not_found', '项目不存在')
      else {
        console.error('[api] content audit acceptance failed')
        sendError(response, 503, 'content_audit_failed', '内容事实核查暂时无法开始，请稍后重试')
      }
    }
    return
  }

  if (technicalAuditId && request.method === 'GET') {
    try {
      const project = await getProject(technicalAuditId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, audit: await readTechnicalAudit(technicalAuditId) })
    } catch {
      console.error('[api] technical audit read failed')
      sendError(response, 503, 'technical_audit_unavailable', '技术检查结果暂时无法读取，请稍后重试')
    }
    return
  }

  if (technicalAuditId && request.method === 'POST') {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '技术检查请求来源不受支持')
      return
    }
    const wantsStream = acceptsTechnicalAuditStream(request)
    try {
      const audit = wantsStream
        ? await executeTechnicalAudit(technicalAuditId, {
            onItem: (item, completedCount, total) => {
              writeTechnicalAuditEvent(response, {
                type: 'item',
                item,
                rule_version: TECHNICAL_AUDIT_RULE_VERSION,
                completedCount,
                total,
              })
            },
          })
        : await executeTechnicalAudit(technicalAuditId)
      if (!audit) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      if (wantsStream) {
        writeTechnicalAuditEvent(response, { type: 'complete', audit })
        if (!response.destroyed) response.end()
        return
      }
      sendJson(response, 200, { ok: true, audit })
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      const streamError = (errorCode: string, message: string): void => {
        if (!response.destroyed) {
          writeTechnicalAuditEvent(response, { type: 'error', error: errorCode, message })
          response.end()
        }
      }
      const hasStreamHeaders = wantsStream && response.headersSent
      if (error instanceof Error && reason === 'technical_audit_in_progress') {
        if (hasStreamHeaders) streamError('technical_audit_in_progress', '技术检查正在进行，请勿重复提交')
        else sendError(response, 409, 'technical_audit_in_progress', '技术检查正在进行，请勿重复提交')
      } else if (error instanceof TechnicalAuditServiceError && reason === 'diagnosis_incomplete') {
        if (hasStreamHeaders) streamError('diagnosis_incomplete', '初始诊断完成后才能进行技术检查')
        else sendError(response, 409, 'diagnosis_incomplete', '初始诊断完成后才能进行技术检查')
      } else if (error instanceof TechnicalAuditServiceError && reason === 'website_required') {
        if (hasStreamHeaders) streamError('website_required', '请先填写客户官网')
        else sendError(response, 409, 'website_required', '请先填写客户官网')
      } else if (error instanceof TechnicalAuditServiceError && reason === 'website_changed') {
        if (hasStreamHeaders) streamError('website_changed', '客户官网已变更，请基于当前官网重新检查')
        else sendError(response, 409, 'website_changed', '客户官网已变更，请基于当前官网重新检查')
      } else if (error instanceof TechnicalAuditServiceError && reason === 'technical_audit_execution_failed') {
        // Basic checks deliberately do not expose execution-failure causes.
        // The UI can retain any already persisted item results and render the
        // remaining items as unchecked; a retry is the only actionable next
        // step.  In particular, do not turn transport/parser details into a
        // customer-facing website diagnosis.
        const message = '基础检查未完成，请重试'
        if (hasStreamHeaders) streamError('technical_audit_execution_failed', message)
        else sendError(response, 503, 'technical_audit_execution_failed', message)
      } else if (reason === 'website_url_invalid') {
        if (hasStreamHeaders) streamError('website_url_invalid', '客户官网地址无法用于技术检查')
        else sendError(response, 409, 'website_url_invalid', '客户官网地址无法用于技术检查')
      } else {
        console.error('[api] technical audit failed')
        if (hasStreamHeaders) streamError('technical_audit_failed', '技术检查暂时失败，请稍后重试')
        else sendError(response, 503, 'technical_audit_failed', '技术检查暂时失败，请稍后重试')
      }
    }
    return
  }

  const projectId = projectIdFromPath(pathname)
  if (request.method === 'DELETE' && projectId) {
    try {
      const deleted = await deleteProject(projectId)
      if (!deleted) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true })
    } catch {
      console.error('[api] project deletion failed')
      sendError(response, 503, 'project_delete_failed', '项目删除失败，请稍后重试')
    }
    return
  }

  if (request.method === 'GET' && projectId) {
    try {
      const project = await getProjectDetail(projectId)
      if (!project) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      sendJson(response, 200, { ok: true, project })
    } catch {
      console.error('[api] project detail failed')
      sendError(response, 503, 'database_unavailable', '项目详情暂时无法读取，请稍后重试')
    }
    return
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }

    try {
      const created = await createProject(body)
      sendJson(response, 201, { ok: true, project: await getProjectDetail(created.id) ?? created })
    } catch (error) {
      if (error instanceof Error && error.message === 'company_name_required') {
        sendError(response, 400, 'company_name_required', '客户公司全名为必填项')
      } else if (error instanceof Error && error.message === 'text_field_invalid') {
        sendError(response, 400, 'invalid_field', '文本字段格式不正确')
      } else if (error instanceof Error && error.message === 'website_url_invalid') {
        sendError(response, 400, 'website_url_invalid', '客户官网必须是HTTP或HTTPS地址')
      } else if (isUniqueViolation(error)) {
        sendError(response, 409, 'company_name_exists', '公司名称已存在，不允许重复创建')
      } else {
        console.error('[api] project creation failed')
        sendError(response, 503, 'project_unavailable', '项目暂时无法创建，请稍后重试')
      }
    }
    return
  }

  if (request.method === 'PATCH' && projectId) {
    if (technicalAuditPostIsCrossSite(request)) {
      sendError(response, 403, 'cross_site_request', '项目修改请求来源不受支持')
      return
    }
    let body: ProjectBody
    try {
      body = await readBody(request)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      sendError(response, reason === 'body_too_large' ? 413 : 400, reason === 'body_too_large' ? 'body_too_large' : 'invalid_request', reason === 'body_too_large' ? '提交内容过大' : '请求内容不是有效的JSON')
      return
    }
    let previousDetail: ProjectDetail | null = null
    try {
      previousDetail = await getProjectDetail(projectId)
    } catch {
      // The committed project returned by the mutation remains the minimum
      // honest fallback if the pre-save detail snapshot is unavailable.
    }

    try {
      const mutation = await updateProjectWithWebsiteChange(projectId, body)
      const updated = mutation.project
      if (!updated) {
        sendError(response, 404, 'project_not_found', '项目不存在')
        return
      }
      const reportRefresh = await acceptWebsiteReportRefresh(projectId, mutation.websiteFilled, reportLocaleFromRequest(request))
      const saved = await savedProjectResponse(projectId, previousDetail, updated, mutation, reportRefresh)
      sendJson(response, 200, { ok: true, ...saved })
    } catch (error) {
      if (error instanceof Error && error.message === 'company_name_required') {
        sendError(response, 400, 'company_name_required', '客户公司全名为必填项')
      } else if (error instanceof Error && error.message === 'text_field_invalid') {
        sendError(response, 400, 'invalid_field', '文本字段格式不正确')
      } else if (error instanceof Error && error.message === 'website_url_invalid') {
        sendError(response, 400, 'website_url_invalid', '客户官网必须是HTTP或HTTPS地址')
      } else if (error instanceof Error && error.message === 'project_reset_confirmation_required') {
        sendError(response, 409, 'project_reset_confirmation_required', '请确认修改资料并清空项目数据')
      } else if (error instanceof Error && error.message === 'project_changed') {
        sendError(response, 409, 'project_changed', '项目信息或任务状态已变化，请重新打开编辑窗口后确认')
      } else if (error instanceof Error && error.message === 'questions_locked') {
        sendError(response, 409, 'questions_locked', '问题已经锁定，不能修改项目信息')
      } else if (error instanceof Error && error.message === 'website_locked') {
        sendError(response, 409, 'website_locked', '问题确认后官网只能填写一次，不能修改')
      } else if (error instanceof Error && error.message === 'project_tasks_in_progress') {
        sendError(response, 409, 'project_tasks_in_progress', '项目任务正在执行，请稍后再修改')
      } else if (isUniqueViolation(error)) {
        sendError(response, 409, 'company_name_exists', '公司名称已存在，不允许重复使用')
      } else {
        console.error('[api] project update failed')
        sendError(response, 503, 'project_unavailable', '项目更新暂时失败，请稍后重试')
      }
    }
    return
  }

  sendError(response, 404, 'not_found', '请求地址不存在')
}

export function createApiServer() {
  const api = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) sendError(response, 500, 'internal_error', '服务器发生错误，请稍后重试')
      else response.destroy()
    })
  })
  api.on('error', () => {
    console.error('[api] server error')
    process.exitCode = 1
  })
  return api
}

const server = createApiServer()

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  // Stop provider requests before draining the pool.  There is deliberately
  // no business timeout here: unfinished task rows remain for startup cleanup
  // on the next process, while AbortSignal gives cooperative providers a
  // chance to release their database/advisory-lock connections promptly.
  abortAllAiTaskControllers()
  await closeDatabasePool()
  server.close(() => process.exit(0))
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

export async function startServer(): Promise<void> {
  const cleanup = await clearIncompleteAiTasksOnStartup()
  console.info(`[api] startup AI task cleanup ${JSON.stringify(cleanup)}`)
  await new Promise<void>((resolveStart, rejectStart) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectStart(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveStart()
      console.log(`[api] listening on http://${host}:${port}`)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  void startServer().catch(() => {
    console.error('[api] startup AI task cleanup failed; listener not started')
    process.exitCode = 1
  })
}
