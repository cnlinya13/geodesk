import type { AiTask, AiTaskKind, ApiErrorPayload, DeliveryReportMetadata, DiagnosisAnswer, DiagnosisReportRefreshMetadata, DiagnosisReportRefreshStatus, MonitoringRun, MonitoringUpdateEvent, Project, ProjectDetail } from './types'
import type { ContentAuditRecord } from './content-audit'
import {
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
  type QuestionCategory,
} from './business-rules'
import {
  TECHNICAL_AUDIT_CURRENT_ITEM_IDS,
  TECHNICAL_AUDIT_ITEM_COUNT,
  TECHNICAL_AUDIT_RULE_VERSION,
  type TechnicalAuditItem,
  type TechnicalAuditSnapshot,
} from './technical-audit'

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }

  let body: ApiErrorPayload & T
  try {
    body = (await response.json()) as ApiErrorPayload & T
  } catch {
    throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的结果')
  }

  if (!response.ok || body.ok === false) {
    throw new ApiError(response.status, body.error ?? 'request_failed', body.message ?? '请求失败，请稍后重试')
  }

  return body
}

type DiagnosisReportLocale = 'zh-CN' | 'en'

/**
 * Report-producing requests carry the document locale explicitly.  The
 * server deliberately does not infer a manual UI choice from Accept-Language;
 * an absent or unknown value keeps the legacy Chinese report behavior.
 */
function diagnosisReportLocaleHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const locale = document.documentElement?.lang as DiagnosisReportLocale | undefined
  return locale === 'en' || locale === 'zh-CN' ? { 'X-GEO-Locale': locale } : {}
}

/**
 * AI work is accepted by the API and then observed through its persisted task
 * record.  This interval is only the cadence of status reads; it is not a
 * deadline and must never be used to fail a model operation.
 */
export const AI_TASK_POLL_INTERVAL_MS = 1000

export type AiTaskSnapshot = {
  task: AiTask
  project: ProjectDetail
}

function parseAiTask(value: unknown, status: number): AiTask {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.projectId !== 'string'
    || (value.kind !== 'questions'
      && value.kind !== 'diagnosis'
      && value.kind !== 'diagnosis_report'
      && value.kind !== 'monitoring'
      && value.kind !== 'article_titles'
      && value.kind !== 'article_body'
      && value.kind !== 'content_audit')
    || (value.targetId !== null && typeof value.targetId !== 'string')
    || (value.status !== 'running' && value.status !== 'completed' && value.status !== 'failed')
    || (value.error !== null && typeof value.error !== 'string')
    || typeof value.startedAt !== 'string'
    || (value.completedAt !== null && typeof value.completedAt !== 'string')
    || (value.result !== null && value.result !== undefined && !isRecord(value.result))) {
    throw new ApiError(status, 'invalid_response', '服务返回了无法识别的AI任务状态')
  }
  return {
    id: value.id,
    projectId: value.projectId,
    kind: value.kind as AiTaskKind,
    targetId: value.targetId as string | null,
    status: value.status,
    error: value.error as string | null,
    startedAt: value.startedAt,
    completedAt: value.completedAt as string | null,
    result: isRecord(value.result) ? value.result : {},
  }
}

export async function fetchProjectAiTasks(projectId: string): Promise<AiTask[]> {
  const result = await request<{ tasks: unknown[] }>(`/api/projects/${encodeURIComponent(projectId)}/ai-tasks`)
  if (!Array.isArray(result.tasks)) throw new ApiError(200, 'invalid_response', '服务返回了无法识别的AI任务列表')
  return result.tasks.map((task) => parseAiTask(task, 200))
}

export async function fetchProjectAiTask(projectId: string, taskId: string): Promise<AiTaskSnapshot> {
  const result = await request<{ task: unknown; project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}/ai-tasks/${encodeURIComponent(taskId)}`)
  return {
    task: parseAiTask(result.task, 200),
    project: result.project,
  }
}

function waitForAiTaskDelay(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, AI_TASK_POLL_INTERVAL_MS))
}

/** Poll a persisted task without a deadline.  A missing task is reported as
 * an explicit error (for example, the service was restarted and cleared it),
 * never as an automatic retry. */
export async function waitForAiTask(
  projectId: string,
  taskId: string,
  onSnapshot?: (snapshot: AiTaskSnapshot) => void,
): Promise<AiTaskSnapshot> {
  while (true) {
    const snapshot = await fetchProjectAiTask(projectId, taskId)
    onSnapshot?.(snapshot)
    if (snapshot.task.status === 'completed') return snapshot
    if (snapshot.task.status === 'failed') {
      throw new ApiError(502, 'ai_task_failed', snapshot.task.error || 'AI任务执行失败，请重试')
    }
    await waitForAiTaskDelay()
  }
}

async function parseJsonEnvelope<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, response.ok ? 'invalid_response' : 'request_failed', fallback)
  }
  if (!isRecord(body)) throw new ApiError(response.status, response.ok ? 'invalid_response' : 'request_failed', fallback)
  if (!response.ok || body.ok === false) {
    throw new ApiError(response.status, typeof body.error === 'string' ? body.error : 'request_failed', typeof body.message === 'string' ? body.message : fallback)
  }
  return body as T
}

type AiTaskSubmitOptions<T> = {
  onSnapshot?: (snapshot: AiTaskSnapshot) => void
  mapCompleted?: (snapshot: AiTaskSnapshot) => T | Promise<T>
}

/** Submit an AI operation while retaining the previous synchronous/NDJSON
 * decoder for older servers.  New servers return 202 and a persisted task;
 * callers then observe that task until the saved project result is available. */
async function submitAiTask<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  projectId: string | null,
  decodeLegacy: (response: Response) => Promise<T>,
  options: AiTaskSubmitOptions<T> = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }

  if (response.status !== 202) return decodeLegacy(response)
  const accepted = await parseJsonEnvelope<{ task: unknown }>(response, 'AI任务暂时无法受理，请稍后重试')
  const task = parseAiTask(accepted.task, response.status)
  if ((projectId !== null && task.projectId !== projectId) || task.status !== 'running') {
    throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的AI任务状态')
  }
  const taskProjectId = projectId ?? task.projectId
  const completed = await waitForAiTask(taskProjectId, task.id, options.onSnapshot)
  return options.mapCompleted ? await options.mapCompleted(completed) : (completed as unknown as T)
}

export async function fetchProjects(search = ''): Promise<Project[]> {
  const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
  const result = await request<{ projects: Project[] }>(`/api/projects${query}`)
  return result.projects
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`)
  return result.project
}

export type ProjectFormValues = {
  companyName: string
  websiteUrl: string
  optimizationTarget: string
  supplementalInfo: string
}

function projectPayload(values: ProjectFormValues) {
  return {
    companyName: values.companyName,
    websiteUrl: values.websiteUrl,
    optimizationTarget: values.optimizationTarget,
    supplementalInfo: values.supplementalInfo,
  }
}

export async function createProject(values: ProjectFormValues): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectPayload(values)),
  })
  return result.project
}

export type ProjectMutationOptions = {
  resetConfirmed?: boolean
  expectedUpdatedAt?: string
}

function mutationPayload(values: ProjectFormValues, options: ProjectMutationOptions = {}) {
  return {
    ...projectPayload(values),
    ...(options.resetConfirmed !== undefined ? { resetConfirmed: options.resetConfirmed } : {}),
    ...(options.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}),
  }
}

/**
 * Website mutations may accept a persisted report refresh immediately after
 * the website is saved.  Keep that lifecycle marker on the returned project
 * so the workspace does not render the pre-mutation PDF state.  The marker is
 * optional for compatibility with older servers; when present it must use
 * the same contract as the report-refresh endpoint.
 */
function mergeProjectReportRefresh(project: ProjectDetail, value: unknown): ProjectDetail {
  if (value === undefined) return project
  const metadata = parseDiagnosisReportRefresh(value, 200)
  if (!isRecord(project.initialDiagnosis)) return project

  // A failed/running refresh must never leave an older PDF downloadable even
  // if a stale backend field is accidentally echoed in the response.
  const reportPdfReady = metadata.status === 'ready' && metadata.reportPdfReady
  return {
    ...project,
    initialDiagnosis: {
      ...project.initialDiagnosis,
      reportRefreshStatus: metadata.status,
      reportRefreshStartedAt: metadata.startedAt,
      reportRefreshError: metadata.error,
      reportPdfReady,
      reportPdfGeneratedAt: reportPdfReady ? metadata.reportPdfGeneratedAt : null,
    },
  }
}

export async function updateProject(
  id: string,
  values: ProjectFormValues,
  options: ProjectMutationOptions = {},
): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail; reportRefresh?: unknown }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...diagnosisReportLocaleHeaders() },
    body: JSON.stringify(mutationPayload(values, options)),
  })
  return mergeProjectReportRefresh(result.project, result.reportRefresh)
}

export async function deleteProject(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function fetchTechnicalAudit(id: string): Promise<TechnicalAuditSnapshot | null> {
  const result = await request<{ audit: TechnicalAuditSnapshot | null }>(`/api/projects/${encodeURIComponent(id)}/technical-audit`)
  return result.audit ?? null
}

export type TechnicalAuditProgressEvent = {
  item: TechnicalAuditItem
  rule_version: number
  completedCount: number
  total: number
}

// Keep the server-side naming available to frontend callers without exposing
// a second shape for the same wire event.
export type TechnicalAuditItemProgress = TechnicalAuditProgressEvent

const TECHNICAL_AUDIT_ITEM_ID_SET = new Set<string>(TECHNICAL_AUDIT_CURRENT_ITEM_IDS)

function isTechnicalAuditStatus(value: unknown): value is TechnicalAuditItem['status'] {
  return value === 'unchecked'
    || value === 'pass'
    || value === 'fix'
    || value === 'review'
    || value === 'not_applicable'
}

function parseTechnicalAuditItem(value: unknown, status: number): TechnicalAuditItem {
  if (!isRecord(value)
    || typeof value.item_id !== 'string'
    || !TECHNICAL_AUDIT_ITEM_ID_SET.has(value.item_id)
    || !isTechnicalAuditStatus(value.status)
    || typeof value.message_code !== 'string'
    || !value.message_code.trim()
    || !isRecord(value.facts)
    || !isRecord(value.evidence)) {
    throw new ApiError(status, 'invalid_response', '服务返回了无法识别的技术检查进度')
  }
  return value as unknown as TechnicalAuditItem
}

async function parseTechnicalAuditJsonResponse(response: Response): Promise<TechnicalAuditSnapshot> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的结果')
  }
  if (!isRecord(body)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的结果')
  if (!response.ok || body.ok === false) {
    throw new ApiError(response.status, typeof body.error === 'string' ? body.error : 'request_failed', typeof body.message === 'string' ? body.message : '请求失败，请稍后重试')
  }
  if (!isRecord(body.audit)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查结果')
  return body.audit as TechnicalAuditSnapshot
}

/**
 * Run the deterministic technical audit.  The existing JSON response remains
 * the default.  Callers that provide onProgress opt into the per-item NDJSON
 * stream, while still accepting a JSON envelope from an older server.
 */
export async function runTechnicalAudit(
  id: string,
  onProgress?: (progress: TechnicalAuditProgressEvent) => void,
): Promise<TechnicalAuditSnapshot> {
  const input = `/api/projects/${encodeURIComponent(id)}/technical-audit`
  if (!onProgress) {
    const result = await request<{ audit: TechnicalAuditSnapshot }>(input, { method: 'POST' })
    return result.audit
  }

  let response: Response
  try {
    response = await fetch(input, {
      method: 'POST',
      headers: { Accept: 'application/x-ndjson' },
    })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }

  // HTTP failures use the same JSON error envelope and wording as the
  // regular request helper.  Do this before choosing the stream parser so a
  // proxy's JSON error response is not reported as a malformed progress line.
  if (!response.ok) return parseTechnicalAuditJsonResponse(response)

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('json') && !contentType.includes('ndjson')) {
    return parseTechnicalAuditJsonResponse(response)
  }
  if (!response.body) throw new ApiError(response.status, 'invalid_response', '服务没有返回技术检查进度')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completedAudit: TechnicalAuditSnapshot | null = null
  let streamCompleted = false
  let progressTotal: number | null = null
  let lastCompletedCount = 0
  const seenItems = new Set<string>()

  const consume = (line: string): void => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查进度')
    }
    if (!isRecord(parsed)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查进度')

    // A legacy server may ignore Accept and return the regular JSON envelope
    // as one line.  Treat it as a completed, one-event stream.
    if (parsed.ok === false) {
      throw new ApiError(response.status, typeof parsed.error === 'string' ? parsed.error : 'request_failed', typeof parsed.message === 'string' ? parsed.message : '请求失败，请稍后重试')
    }
    if (parsed.type === 'item') {
      if (streamCompleted
        || parsed.rule_version !== TECHNICAL_AUDIT_RULE_VERSION
        || parsed.total !== TECHNICAL_AUDIT_ITEM_COUNT
        || typeof parsed.rule_version !== 'number'
        || !Number.isSafeInteger(parsed.rule_version)
        || typeof parsed.completedCount !== 'number'
        || !Number.isSafeInteger(parsed.completedCount)
        || parsed.completedCount < 1
        || parsed.completedCount > TECHNICAL_AUDIT_ITEM_COUNT
        || (progressTotal !== null && parsed.total !== progressTotal)
        || parsed.completedCount !== lastCompletedCount + 1) {
        throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查进度')
      }
      const item = parseTechnicalAuditItem(parsed.item, response.status)
      if (seenItems.has(item.item_id)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查进度')
      seenItems.add(item.item_id)
      progressTotal = parsed.total
      lastCompletedCount = parsed.completedCount
      onProgress({
        item,
        rule_version: parsed.rule_version,
        completedCount: parsed.completedCount,
        total: parsed.total,
      })
      return
    }
    if (parsed.type === 'complete') {
      if (streamCompleted || !isRecord(parsed.audit)) {
        throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查结果')
      }
      completedAudit = parsed.audit as TechnicalAuditSnapshot
      streamCompleted = true
      return
    }
    if (parsed.type === 'error') {
      throw new ApiError(response.status, typeof parsed.error === 'string' ? parsed.error : 'technical_audit_failed', typeof parsed.message === 'string' ? parsed.message : '技术检查失败，请稍后重试')
    }
    if (isRecord(parsed.audit)) {
      if (streamCompleted) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查结果')
      completedAudit = parsed.audit as TechnicalAuditSnapshot
      streamCompleted = true
      return
    }
    throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的技术检查进度')
  }

  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (chunk.done) break
    }
    // A final event is valid without a trailing newline.  The decoder call on
    // the done chunk flushes any UTF-8 sequence split across chunks.
    if (buffer.trim()) consume(buffer)
  } catch (cause) {
    try { await reader.cancel() } catch { /* reader cleanup is best effort */ }
    if (cause instanceof ApiError) throw cause
    throw new ApiError(response.status, 'invalid_response', '技术检查进度流中断，请重试')
  } finally {
    reader.releaseLock()
  }

  if (!streamCompleted || !completedAudit) throw new ApiError(response.status, 'invalid_response', '服务没有返回完整的技术检查结果')
  return completedAudit
}

export async function fetchContentAudit(id: string): Promise<ContentAuditRecord | null> {
  const result = await request<{ audit: ContentAuditRecord | null }>(`/api/projects/${encodeURIComponent(id)}/content-audit`)
  return result.audit ?? null
}

/** Start a manual content fact-checking run. New servers return a persisted
 * task; this compatibility wrapper observes it to completion and returns the
 * existing audit record shape. */
export async function startContentAudit(id: string): Promise<ContentAuditRecord> {
  return submitAiTask<ContentAuditRecord>(
    `/api/projects/${encodeURIComponent(id)}/content-audit`,
    { method: 'POST' },
    id,
    async (response) => {
      const result = await parseJsonEnvelope<{ audit: ContentAuditRecord }>(response, '官网内容检查失败，请稍后重试')
      return result.audit
    },
    {
      mapCompleted: async (_snapshot) => {
        // Content-audit details are intentionally kept behind the existing
        // resource endpoint; the AI task only carries lifecycle metadata.
        return fetchContentAudit(id).then((record) => {
          if (!record) throw new ApiError(200, 'invalid_response', '服务没有返回官网内容检查结果')
          return record
        })
      },
    },
  )
}

// Keep the operation name discoverable to callers that use the existing
// `runTechnicalAudit` naming convention without creating a second request
// implementation.
export const runContentAudit = startContentAudit

export async function saveProjectWebsite(
  id: string,
  websiteUrl: string,
  options: ProjectMutationOptions = {},
): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail; reportRefresh?: unknown }>(`/api/projects/${encodeURIComponent(id)}/website`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...diagnosisReportLocaleHeaders() },
    body: JSON.stringify({
      websiteUrl: websiteUrl.trim(),
      ...(options.resetConfirmed !== undefined ? { resetConfirmed: options.resetConfirmed } : {}),
      ...(options.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}),
    }),
  })
  return mergeProjectReportRefresh(result.project, result.reportRefresh)
}

export type ArticleGenerationResult = {
  project: ProjectDetail
  addedCount: number
}

export async function generateProjectArticles(id: string): Promise<ArticleGenerationResult> {
  return submitAiTask<ArticleGenerationResult>(
    `/api/projects/${encodeURIComponent(id)}/articles/generate`,
    { method: 'POST' },
    id,
    async (response) => {
      const result = await parseJsonEnvelope<ArticleGenerationResult>(response, '文章方案生成失败，请稍后重试')
      return { project: result.project, addedCount: result.addedCount }
    },
    {
      mapCompleted: (snapshot) => ({
        project: snapshot.project,
        addedCount: typeof snapshot.task.result.addedCount === 'number' ? snapshot.task.result.addedCount : 0,
      }),
    },
  )
}

export async function writeProjectArticle(id: string): Promise<ProjectDetail> {
  return submitAiTask<ProjectDetail>(
    `/api/articles/${encodeURIComponent(id)}/write`,
    { method: 'POST' },
    // The article endpoint is scoped by article id, while task detail is
    // scoped by project. The accepted task supplies the project id.
    null,
    async (response) => {
      const result = await parseJsonEnvelope<{ ok?: true; project: ProjectDetail }>(response, '文章写作失败，请稍后重试')
      return result.project
    },
    {
      mapCompleted: (snapshot) => snapshot.project,
    },
  )
}

export async function confirmArticlePublished(id: string): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>(`/api/articles/${encodeURIComponent(id)}/confirm-published`, {
    method: 'POST',
  })
  return result.project
}

export async function deleteArticle(id: string): Promise<{ project: ProjectDetail; deletedArticleId: string }> {
  const result = await request<{ project: ProjectDetail; deletedArticleId: string }>(`/api/articles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  return { project: result.project, deletedArticleId: result.deletedArticleId }
}

export type QuestionGenerationProgressQuestion = {
  question: string
  category: QuestionCategory
}

export type QuestionGenerationProgress = {
  completedCount: number
  total: number
  questions: QuestionGenerationProgressQuestion[]
}

function isQuestionGenerationCategory(value: unknown): value is QuestionGenerationProgressQuestion['category'] {
  return value === 'recommendation' || value === 'selection' || value === 'decision'
}

function parseQuestionGenerationProgress(value: unknown, status: number): QuestionGenerationProgress {
  if (!isRecord(value)) throw new ApiError(status, 'invalid_response', '服务返回了无法识别的问题生成进度')
  const completedCount = value.completedCount
  const total = value.total
  if (typeof completedCount !== 'number'
    || typeof total !== 'number'
    || !Number.isSafeInteger(completedCount)
    || completedCount < 0
    || !Number.isSafeInteger(total)
    || total < 0
    || total > QUESTION_TOTAL
    || completedCount > total
    || !Array.isArray(value.questions)
    || value.questions.length > total) {
    throw new ApiError(status, 'invalid_response', '服务返回了无法识别的问题生成进度')
  }
  const questions = value.questions.map((question) => {
    if (!isRecord(question) || typeof question.question !== 'string' || !question.question.trim() || !isQuestionGenerationCategory(question.category)) {
      throw new ApiError(status, 'invalid_response', '服务返回了无法识别的问题生成结果')
    }
    return { question: question.question, category: question.category }
  })
  return { completedCount, total, questions }
}

async function parseQuestionGenerationJsonResponse(response: Response): Promise<ProjectDetail> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, response.ok ? 'invalid_response' : 'request_failed', response.ok ? '服务返回了无法识别的问题生成结果' : '问题生成请求失败，请稍后重试')
  }
  if (!isRecord(body)) throw new ApiError(response.status, response.ok ? 'invalid_response' : 'request_failed', response.ok ? '服务返回了无法识别的问题生成结果' : '问题生成请求失败，请稍后重试')
  if (!response.ok) {
    throw new ApiError(response.status, typeof body.error === 'string' ? body.error : 'request_failed', typeof body.message === 'string' ? body.message : '问题生成请求失败，请稍后重试')
  }
  if (body.ok === false) {
    throw new ApiError(response.status, typeof body.error === 'string' ? body.error : 'request_failed', typeof body.message === 'string' ? body.message : '请求失败，请稍后重试')
  }
  if (!isRecord(body.project)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成结果')
  return body.project as ProjectDetail
}

/**
 * Consume the questions-only NDJSON observer stream.  The POST endpoint and
 * the task-detail observer deliberately share this decoder so a 202 response
 * never falls back to polling and a page re-entry sees the same progress
 * validation as the original generation request.
 */
async function readQuestionGenerationStream(
  response: Response,
  onProgress?: (progress: QuestionGenerationProgress) => void,
): Promise<ProjectDetail> {
  if (!response.body) throw new ApiError(response.status, 'invalid_response', '服务没有返回问题生成进度')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalProject: ProjectDetail | null = null
  let streamCompleted = false
  let progressTotal: number | null = null
  let lastCompletedCount = -1
  let lastQuestions: QuestionGenerationProgressQuestion[] = []

  const consume = (line: string): void => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成进度')
    }
    if (!isRecord(event)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成进度')

    // Older servers may return the regular JSON envelope even when the client
    // asks for NDJSON. Treat that envelope as a one-event stream.
    if (event.ok === false) {
      throw new ApiError(response.status, typeof event.error === 'string' ? event.error : 'request_failed', typeof event.message === 'string' ? event.message : '请求失败，请稍后重试')
    }
    if (event.type === 'progress') {
      if (streamCompleted) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成进度')
      const progress = parseQuestionGenerationProgress(event, response.status)
      if (progress.total > QUESTION_TOTAL
        || (progressTotal !== null && progress.total !== progressTotal)
        || progress.completedCount < lastCompletedCount
        || progress.completedCount !== progress.questions.length
        || progress.questions.some((question, index) => {
          const previous = lastQuestions[index]
          return previous !== undefined && (previous.question !== question.question || previous.category !== question.category)
        })) {
        throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成进度')
      }
      if (progress.completedCount === lastCompletedCount) return
      progressTotal = progress.total
      lastCompletedCount = progress.completedCount
      lastQuestions = progress.questions
      onProgress?.(progress)
      return
    }
    if (event.type === 'complete') {
      if (streamCompleted || !isRecord(event.project)) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成结果')
      finalProject = event.project as ProjectDetail
      streamCompleted = true
      return
    }
    if (event.type === 'error') {
      throw new ApiError(response.status, typeof event.error === 'string' ? event.error : 'questions_generation_failed', typeof event.message === 'string' ? event.message : '问题生成失败，请稍后重试')
    }
    if (isRecord(event.project)) {
      // JSON fallback: { ok: true, project }.
      if (streamCompleted) throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成结果')
      finalProject = event.project as ProjectDetail
      streamCompleted = true
      return
    }
    throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成进度')
  }

  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
      if (chunk.done) break
    }
    if (buffer.trim()) consume(buffer)
  } catch (cause) {
    try { await reader.cancel() } catch { /* reader cleanup is best effort */ }
    if (cause instanceof ApiError) throw cause
    throw new ApiError(response.status, 'invalid_response', '问题生成进度流中断，请重试')
  } finally {
    reader.releaseLock()
  }

  if (!streamCompleted || !finalProject) throw new ApiError(response.status, 'invalid_response', '服务没有返回完整的问题生成结果')
  return finalProject
}

/** Observe one accepted questions task over its process-local NDJSON stream. */
export async function observeQuestionGenerationTask(
  projectId: string,
  taskId: string,
  onProgress?: (progress: QuestionGenerationProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectDetail> {
  let response: Response
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/ai-tasks/${encodeURIComponent(taskId)}`, {
      headers: { Accept: 'application/x-ndjson' },
      signal: options.signal,
    })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }
  if (!response.ok) return parseQuestionGenerationJsonResponse(response)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('json') && !contentType.includes('ndjson')) return parseQuestionGenerationJsonResponse(response)
  return readQuestionGenerationStream(response, onProgress)
}

/**
 * Generate the question set. The original JSON response remains the default
 * for callers that do not need progress. Callers that provide onProgress opt
 * into the NDJSON stream, while still accepting a JSON response from an older
 * server for backwards compatibility.
 */
export async function regenerateQuestions(
  id: string,
  expectedUpdatedAt: string,
  onProgress?: (progress: QuestionGenerationProgress) => void,
  onTaskAccepted?: (task: AiTask) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectDetail> {
  let response: Response
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(id)}/questions/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(onProgress ? { Accept: 'application/x-ndjson' } : {}),
      },
      body: JSON.stringify({ expectedUpdatedAt }),
    })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }

  if (response.status === 202) {
    const accepted = await parseJsonEnvelope<{ task: unknown }>(response, '问题生成任务暂时无法受理，请稍后重试')
    const task = parseAiTask(accepted.task, response.status)
    if (task.projectId !== id || task.kind !== 'questions' || task.status !== 'running') {
      throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的问题生成任务')
    }
    onTaskAccepted?.(task)
    return observeQuestionGenerationTask(id, task.id, onProgress, options)
  }

  if (!response.ok) return parseQuestionGenerationJsonResponse(response)
  if (!onProgress) return parseQuestionGenerationJsonResponse(response)

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('json') && !contentType.includes('ndjson')) {
    return parseQuestionGenerationJsonResponse(response)
  }
  if (!response.body) throw new ApiError(response.status, 'invalid_response', '服务没有返回问题生成进度')

  return readQuestionGenerationStream(response, onProgress)
}

export async function confirmQuestions(id: string, expectedUpdatedAt: string): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}/questions/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt }),
  })
  return result.project
}

export async function setQuestionLocked(
  projectId: string,
  questionId: string,
  isLocked: boolean,
  expectedUpdatedAt: string,
): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isLocked, expectedUpdatedAt }),
  })
  return result.project
}

export async function deleteQuestion(
  projectId: string,
  questionId: string,
  expectedUpdatedAt: string,
): Promise<ProjectDetail> {
  const result = await request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}/questions/${encodeURIComponent(questionId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt }),
  })
  return result.project
}

/**
 * Lock the question set and immediately start the initial diagnosis with the
 * project returned by the lock request. Keeping the two calls here makes the
 * hand-off explicit and prevents callers from accidentally starting with a
 * stale project snapshot.
 */
export async function confirmAndStartDiagnosis(
  id: string,
  expectedUpdatedAt: string,
  onConfirmed: (project: ProjectDetail) => void,
  onProgress?: (progress: DiagnosisProgressEvent) => void,
  dependencies: {
    confirm?: (projectId: string, expectedUpdatedAt: string) => Promise<ProjectDetail>
    start?: (projectId: string, progress?: (progress: DiagnosisProgressEvent) => void) => Promise<ProjectDetail>
    shouldContinue?: () => boolean
  } = {},
): Promise<ProjectDetail> {
  const confirmed = await (dependencies.confirm ?? confirmQuestions)(id, expectedUpdatedAt)
  if (dependencies.shouldContinue && !dependencies.shouldContinue()) {
    throw new ApiError(409, 'project_action_stale', '项目流程已重置，请返回监测口径重新开始')
  }
  onConfirmed(confirmed)
  if (dependencies.shouldContinue && !dependencies.shouldContinue()) {
    throw new ApiError(409, 'project_action_stale', '项目流程已重置，请返回监测口径重新开始')
  }
  return (dependencies.start ?? startOrResumeDiagnosis)(confirmed.id, onProgress)
}

export type DiagnosisProgressEvent = {
  position: number
  status: 'success' | 'failed'
  completedCount: number
  failedCount: number
  total: number
  answer?: DiagnosisAnswer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isDiagnosisAnswer(value: unknown): value is DiagnosisAnswer {
  if (!isRecord(value)) return false
  return typeof value.position === 'number'
    && Number.isInteger(value.position)
    && value.position >= QUESTION_POSITION_MIN
    && value.position <= QUESTION_POSITION_MAX
    && typeof value.question === 'string'
    && (value.status === 'pending' || value.status === 'running' || value.status === 'success' || value.status === 'failed')
    && isNullableString(value.answerText)
    && Array.isArray(value.citationUrls)
    && value.citationUrls.every((citation) => typeof citation === 'string')
    && isNullableString(value.responseModel)
    && (value.recommended === null || typeof value.recommended === 'boolean')
    && (value.officialCitation === null || typeof value.officialCitation === 'boolean')
    && isNullableString(value.error)
    && isNullableString(value.startedAt)
    && isNullableString(value.completedAt)
}

function isMonitoringRun(value: unknown): value is MonitoringRun {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && value.runType === 'monitoring'
    && (value.status === 'running' || value.status === 'analyzing' || value.status === 'completed' || value.status === 'failed')
    && isNullableString(value.requestedModel)
    && typeof value.roundNumber === 'number'
    && Number.isInteger(value.roundNumber)
    && value.roundNumber >= 1
    && isNullableFiniteNumber(value.publishedArticleCount)
    && typeof value.startedAt === 'string'
    && isNullableString(value.completedAt)
    && 'summaryAnalysis' in value
    && isNullableString(value.summaryModel)
    && isNullableString(value.summaryError)
    && isNullableFiniteNumber(value.recommendationRate)
    && isNullableFiniteNumber(value.officialCitationRate)
    && Array.isArray(value.answers)
    && value.answers.every((answer) => isDiagnosisAnswer(answer))
}

function parseMonitoringUpdate(item: Record<string, unknown>): MonitoringUpdateEvent | null {
  if (item.type === 'run') {
    if (!isMonitoringRun(item.run)) throw new ApiError(200, 'invalid_response', '服务返回了无法识别的监测轮次')
    return { type: 'run', run: item.run }
  }
  if (item.type === 'answer') {
    if (typeof item.runId !== 'string' || !item.runId.trim() || !isDiagnosisAnswer(item.answer)) {
      throw new ApiError(200, 'invalid_response', '服务返回了无法识别的监测题目进度')
    }
    return { type: 'answer', runId: item.runId, answer: item.answer }
  }
  if (item.type === 'analyzing') {
    if (typeof item.runId !== 'string' || !item.runId.trim()) {
      throw new ApiError(200, 'invalid_response', '服务返回了无法识别的监测汇总进度')
    }
    return { type: 'analyzing', runId: item.runId }
  }
  return null
}

async function startOrResumeDiagnosisRun(
  id: string,
  runPath: 'diagnosis' | 'monitoring',
  onProgress?: (progress: DiagnosisProgressEvent) => void,
  onUpdate?: (update: MonitoringUpdateEvent) => void,
): Promise<ProjectDetail> {
  let response: Response
  try {
    const init: RequestInit = { method: 'POST' }
    if (runPath === 'diagnosis') init.headers = diagnosisReportLocaleHeaders()
    response = await fetch(`/api/projects/${encodeURIComponent(id)}/${runPath}/start-or-resume`, init)
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }

  if (response.status === 202) {
    const accepted = await parseJsonEnvelope<{ task: unknown }>(response, '诊断任务暂时无法受理，请稍后重试')
    const task = parseAiTask(accepted.task, response.status)
    const expectedKind = runPath === 'monitoring' ? 'monitoring' : 'diagnosis'
    if (task.projectId !== id || task.kind !== expectedKind || task.status !== 'running') {
      throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的诊断任务')
    }
    let lastDerivedProgress = ''
    const snapshot = await waitForAiTask(id, task.id, (current) => {
      const progress = current.task.result.progress
      if (isRecord(progress)
        && typeof progress.position === 'number'
        && typeof progress.status === 'string'
        && typeof progress.completedCount === 'number'
        && typeof progress.failedCount === 'number'
        && typeof progress.total === 'number') {
        onProgress?.({
          position: progress.position,
          status: progress.status === 'success' ? 'success' : 'failed',
          completedCount: progress.completedCount,
          failedCount: progress.failedCount,
          total: progress.total,
          answer: isDiagnosisAnswer(progress.answer) ? progress.answer : undefined,
        })
      } else {
        const monitoringRun = runPath === 'monitoring'
          ? current.project.monitoringRuns.slice().sort((left, right) => right.roundNumber - left.roundNumber)[0]
          : null
        const run = runPath === 'monitoring' ? monitoringRun : current.project.initialDiagnosis.run
        const answers: DiagnosisAnswer[] = runPath === 'monitoring' ? (monitoringRun?.answers ?? []) : current.project.initialDiagnosis.answers
        const completedCount = answers.filter((answer) => answer.status === 'success').length
        const failedCount = answers.filter((answer) => answer.status === 'failed').length
        const latestAnswer = answers
          .filter((answer) => answer.status === 'success' || answer.status === 'failed')
          .slice()
          .sort((left, right) => right.position - left.position)[0]
        const derivedKey = `${run?.id ?? ''}:${completedCount}:${failedCount}:${latestAnswer?.position ?? 0}:${latestAnswer?.status ?? ''}`
        if (derivedKey !== lastDerivedProgress && (completedCount > 0 || failedCount > 0)) {
          lastDerivedProgress = derivedKey
          onProgress?.({
            position: latestAnswer?.position ?? completedCount + failedCount,
            status: latestAnswer?.status === 'failed' ? 'failed' : 'success',
            completedCount,
            failedCount,
            total: QUESTION_TOTAL,
            answer: latestAnswer,
          })
        }
      }
      if (runPath === 'monitoring' && Array.isArray(current.project.monitoringRuns)) {
        const latest = current.project.monitoringRuns.slice().sort((left, right) => right.roundNumber - left.roundNumber)[0]
        if (latest) onUpdate?.({ type: 'run', run: latest })
      }
    })
    return snapshot.project
  }

  if (!response.ok) {
    let body: ApiErrorPayload = {}
    try { body = (await response.json()) as ApiErrorPayload } catch { /* handled by generic message */ }
    throw new ApiError(response.status, body.error ?? 'request_failed', body.message ?? '诊断暂时无法开始，请稍后重试')
  }

  if (!response.body) throw new ApiError(response.status, 'invalid_response', '服务没有返回诊断进度')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalProject: ProjectDetail | null = null
  const consume = (line: string): void => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new ApiError(response.status, 'invalid_response', '服务返回了无法识别的诊断进度')
    }
    if (!event || typeof event !== 'object') return
    const item = event as Record<string, unknown>
    if (item.type === 'progress') {
      onProgress?.({
        position: Number(item.position),
        status: item.status === 'success' ? 'success' : 'failed',
        completedCount: Number(item.completedCount),
        failedCount: Number(item.failedCount),
        total: Number(item.total),
        answer: item.answer && typeof item.answer === 'object' ? item.answer as DiagnosisAnswer : undefined,
      })
    } else if (runPath === 'monitoring' && (item.type === 'run' || item.type === 'answer' || item.type === 'analyzing')) {
      const update = parseMonitoringUpdate(item)
      if (update) onUpdate?.(update)
    } else if (item.type === 'complete' && item.project && typeof item.project === 'object') {
      finalProject = item.project as ProjectDetail
    } else if (item.type === 'error') {
      throw new ApiError(response.status, String(item.error ?? 'diagnosis_failed'), String(item.message ?? '诊断暂时失败，请稍后重试'))
    }
  }

  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
    if (chunk.done) break
  }
  if (buffer.trim()) consume(buffer)
  if (!finalProject) throw new ApiError(response.status, 'invalid_response', '服务没有返回诊断结果')
  return finalProject
}

export function startOrResumeDiagnosis(id: string, onProgress?: (progress: DiagnosisProgressEvent) => void): Promise<ProjectDetail> {
  return startOrResumeDiagnosisRun(id, 'diagnosis', onProgress)
}

/**
 * Retry only the persisted initial-diagnosis aggregate after all twenty
 * answers already succeeded. This is an AI task and is deliberately separate
 * from the non-AI report-refresh endpoint below.
 */
export async function generateInitialDiagnosisReport(id: string): Promise<ProjectDetail> {
  return submitAiTask<ProjectDetail>(
    `/api/projects/${encodeURIComponent(id)}/diagnosis/generate-report`,
    { method: 'POST', headers: diagnosisReportLocaleHeaders() },
    id,
    async (response) => {
      const result = await parseJsonEnvelope<{ project: ProjectDetail }>(response, '诊断汇总失败，请稍后重试')
      return result.project
    },
    {
      mapCompleted: (snapshot) => snapshot.project,
    },
  )
}

export function startOrResumeMonitoring(
  id: string,
  onProgress?: (progress: DiagnosisProgressEvent) => void,
  onUpdate?: (update: MonitoringUpdateEvent) => void,
): Promise<ProjectDetail> {
  return startOrResumeDiagnosisRun(id, 'monitoring', onProgress, onUpdate)
}

const diagnosisReportRefreshPath = (id: string): string => `/api/projects/${encodeURIComponent(id)}/diagnosis/report-refresh`

function isDiagnosisReportRefreshStatus(value: unknown): value is DiagnosisReportRefreshStatus {
  return value === 'not_started' || value === 'running' || value === 'ready' || value === 'failed'
}

function parseDiagnosisReportRefresh(value: unknown, status: number): DiagnosisReportRefreshMetadata {
  if (!isRecord(value)
    || !isDiagnosisReportRefreshStatus(value.status)
    || (value.startedAt !== null && typeof value.startedAt !== 'string')
    || (value.error !== null && typeof value.error !== 'string')
    || typeof value.reportPdfReady !== 'boolean'
    || (value.reportPdfGeneratedAt !== null && typeof value.reportPdfGeneratedAt !== 'string')
    || (value.sourceRunId !== null && typeof value.sourceRunId !== 'string')) {
    throw new ApiError(status, 'invalid_response', '服务返回了无法识别的诊断报告状态')
  }
  return {
    status: value.status,
    startedAt: value.startedAt as string | null,
    error: value.error as string | null,
    reportPdfReady: value.reportPdfReady,
    reportPdfGeneratedAt: value.reportPdfGeneratedAt as string | null,
    sourceRunId: value.sourceRunId as string | null,
  }
}

async function readDiagnosisReportRefreshResponse(response: Response): Promise<DiagnosisReportRefreshMetadata> {
  const body = await parseJsonEnvelope<{ report?: unknown }>(response, '诊断报告状态暂时无法读取，请稍后重试')
  const payload = isRecord(body.report) ? body.report : body
  return parseDiagnosisReportRefresh(payload, response.status)
}

/** Read the persisted non-AI report-refresh lifecycle; this is not an AI task. */
export async function fetchDiagnosisReportRefresh(id: string): Promise<DiagnosisReportRefreshMetadata> {
  let response: Response
  try {
    response = await fetch(diagnosisReportRefreshPath(id))
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }
  return readDiagnosisReportRefreshResponse(response)
}

/** Accept one report refresh and return immediately with its persisted state. */
export async function startDiagnosisReportRefresh(id: string): Promise<DiagnosisReportRefreshMetadata> {
  let response: Response
  try {
    response = await fetch(diagnosisReportRefreshPath(id), { method: 'POST', headers: diagnosisReportLocaleHeaders() })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }
  return readDiagnosisReportRefreshResponse(response)
}

async function readBinaryResponseError(response: Response, fallback: string): Promise<never> {
  let body: ApiErrorPayload = {}
  try { body = (await response.json()) as ApiErrorPayload } catch { /* use fallback */ }
  throw new ApiError(response.status, body.error ?? 'request_failed', body.message ?? fallback)
}

export type DownloadedDiagnosisReportPdf = {
  blob: Blob
  filename: string | null
}

function responseFilename(response: Response): string | null {
  const disposition = response.headers.get('content-disposition')
  if (!disposition) return null
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try { return decodeURIComponent(encoded) } catch { /* use the ASCII fallback */ }
  }
  const fallback = disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    ?? disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
  return fallback || null
}

export async function downloadDiagnosisReportPdf(id: string): Promise<DownloadedDiagnosisReportPdf> {
  let response: Response
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(id)}/diagnosis/report-pdf`)
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }
  if (!response.ok) await readBinaryResponseError(response, '诊断报告PDF暂时无法下载，请稍后重试')
  const blob = await response.blob()
  if (blob.size === 0) throw new ApiError(response.status, 'invalid_response', '服务返回了空的诊断报告PDF')
  return { blob, filename: responseFilename(response) }
}

/**
 * @deprecated The app no longer prepares or uploads diagnosis PDFs in the
 * browser. Kept only for older API consumers while they migrate to the
 * persisted report-refresh endpoint.
 */
export async function saveDiagnosisReportPdf(id: string, pdf: Blob, sourceRunId: string): Promise<{ reportPdfReady: boolean; reportPdfGeneratedAt: string | null }> {
  const result = await request<{ reportPdfReady: boolean; reportPdfGeneratedAt: string | null }>(`/api/projects/${encodeURIComponent(id)}/diagnosis/report-pdf`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf', 'X-Source-Run-Id': sourceRunId },
    body: pdf,
  })
  if (result.reportPdfReady !== true) throw new ApiError(200, 'invalid_response', '服务没有确认诊断报告PDF已保存')
  return {
    reportPdfReady: true,
    reportPdfGeneratedAt: typeof result.reportPdfGeneratedAt === 'string' ? result.reportPdfGeneratedAt : null,
  }
}

export async function saveMonitoringDeliveryReportPdf(id: string, sourceRunId: string, pdf: Blob): Promise<DeliveryReportMetadata> {
  const query = `?sourceRunId=${encodeURIComponent(sourceRunId)}`
  const result = await request<DeliveryReportMetadata>(`/api/projects/${encodeURIComponent(id)}/monitoring/report-pdf${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdf,
  })
  if (result.reportPdfReady !== true || typeof result.sourceRunId !== 'string') {
    throw new ApiError(200, 'invalid_response', '服务没有确认交付报告PDF已保存')
  }
  return {
    reportPdfReady: true,
    reportPdfGeneratedAt: typeof result.reportPdfGeneratedAt === 'string' ? result.reportPdfGeneratedAt : null,
    sourceRunId: result.sourceRunId,
  }
}

export type DownloadedMonitoringDeliveryReportPdf = {
  blob: Blob
  filename: string | null
}

export async function downloadMonitoringDeliveryReportPdf(id: string): Promise<DownloadedMonitoringDeliveryReportPdf> {
  let response: Response
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(id)}/monitoring/report-pdf`)
  } catch {
    throw new ApiError(0, 'network_error', '无法连接到本机服务，请确认API正在运行')
  }
  if (!response.ok) await readBinaryResponseError(response, '交付报告PDF暂时无法下载，请稍后重试')
  const blob = await response.blob()
  if (blob.size === 0) throw new ApiError(response.status, 'invalid_response', '服务返回了空的交付报告PDF')
  return { blob, filename: responseFilename(response) }
}
