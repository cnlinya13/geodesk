import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import process from 'node:process'

import { QUESTION_GROUP_COUNTS, QUESTION_TOTAL, type QuestionCategory } from '../src/business-rules.ts'

/**
 * A deliberately small, in-memory provider for the public demo.
 *
 * It implements the same HTTP shapes used by the browser for the happy-path
 * workflow, but it never imports the database or model clients.  A process
 * restart therefore resets the fixture and cannot accidentally reach a real
 * database, model endpoint, or customer website.
 */

const HOST = '127.0.0.1'
const PORT = 8788
const SYNTHETIC_MODEL = 'synthetic-demo-model'
const SYNTHETIC_SITE = 'https://demo.example.invalid'

type DemoQuestion = {
  id: string
  position: number
  question: string
  generatedAt: string
  category: QuestionCategory
  isLocked: boolean
}

type DemoAnswer = {
  position: number
  question: string
  status: 'success'
  answerText: string
  citationUrls: string[]
  responseModel: string
  recommended: boolean
  officialCitation: boolean
  error: null
  startedAt: string
  completedAt: string
}

type DemoArticle = {
  id: string
  projectId: string
  batchId: string
  title: string
  questionPositions: number[]
  contentHtml: string | null
  generatedAt: string
  updatedAt: string
  writingStatus: 'pending' | 'writing' | 'ready' | 'failed'
  writingError: string | null
  optimizationType: string
  optimizationDirection: string
  targetPageUrl: string | null
  targetPageTitle: string | null
  publishStatus: 'pending' | 'published'
  confirmedAt: string | null
}

type DemoRun = {
  id: string
  runType: 'initial' | 'monitoring'
  status: 'completed'
  requestedModel: string
  roundNumber: number
  publishedArticleCount: number | null
  startedAt: string
  completedAt: string
  summaryAnalysis: { mode: 'synthetic'; note: string }
  summaryModel: string
  summaryError: null
  recommendationRate: number
  officialCitationRate: number
  answers: DemoAnswer[]
}

type DemoProject = {
  id: string
  companyName: string
  websiteUrl: string | null
  optimizationTarget: string | null
  supplementalInfo: string | null
  questionsGeneratedAt: string | null
  questionsLockedAt: string | null
  diagnosisStartedAt: string | null
  initialDiagnosisCompletedAt: string | null
  initialDiagnosisStatus: 'not_started' | 'completed'
  initialRecommendationRate: number | null
  initialOfficialCitationRate: number | null
  initialDiagnosisAt: string | null
  latestMonitoringAt: string | null
  latestRecommendationRate: number | null
  latestOfficialCitationRate: number | null
  websiteLockedAt: string | null
  websiteCrawlStatus: 'not_started' | 'completed'
  websiteCrawlStartedAt: string | null
  websiteCrawlCompletedAt: string | null
  websiteCrawlError: string | null
  websiteCrawlSource: 'links' | null
  websiteCrawlIncomplete: boolean
  websitePagesDiscovered: number
  websitePagesSucceeded: number
  websitePagesFailed: number
  questionsGenerationStatus: 'not_started' | 'completed'
  questionsGenerationStartedAt: string | null
  questionsGenerationCompletedAt: string | null
  questionsGenerationError: string | null
  createdAt: string
  updatedAt: string
  websiteCrawl: {
    status: 'not_started' | 'completed'
    source: 'links' | null
    incomplete: boolean
    error: string | null
    discoveredCount: number
    successCount: number
    failedCount: number
    startedAt: string | null
    completedAt: string | null
  }
  questionsGeneration: {
    status: 'not_started' | 'completed'
    error: string | null
    startedAt: string | null
    completedAt: string | null
  }
  questions: DemoQuestion[]
  initialDiagnosis: {
    run: DemoRun | null
    answers: DemoAnswer[]
    reportPdfReady: false
    reportPdfGeneratedAt: null
    reportRefreshStatus: 'ready'
    reportRefreshStartedAt: string | null
    reportRefreshError: string | null
  }
  monitoringRuns: DemoRun[]
  articleBatches: Array<{
    id: string
    projectId: string
    requestedModel: string
    responseModel: string | null
    generatedAt: string
    articles: DemoArticle[]
  }>
  deliveryReport: {
    reportPdfReady: false
    reportPdfGeneratedAt: null
    sourceRunId: null
  }
}

type DemoTaskKind = 'questions' | 'diagnosis' | 'monitoring' | 'article_titles' | 'article_body'
type DemoTask = {
  id: string
  projectId: string
  kind: DemoTaskKind
  targetId: string | null
  status: 'running' | 'completed'
  error: null
  startedAt: string
  completedAt: string | null
  result: Record<string, unknown>
}

type DemoState = {
  project: DemoProject | null
  tasks: Map<string, DemoTask>
  nextProjectId: number
  nextTaskId: number
  nextRunId: number
  nextArticleId: number
}

const state: DemoState = {
  project: null,
  tasks: new Map(),
  nextProjectId: 1,
  nextTaskId: 1,
  nextRunId: 1,
  nextArticleId: 1,
}

function now(): string {
  return new Date().toISOString()
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, status: number, error: string, message: string): void {
  sendJson(response, status, { ok: false, error, message })
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(new Error('invalid_json'))
        resolve(value as Record<string, unknown>)
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    request.on('error', reject)
  })
}

function validWebsite(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

function projectDetail(): DemoProject | null {
  return state.project
}

function touchProject(): void {
  if (state.project) state.project.updatedAt = now()
}

function createProject(body: Record<string, unknown>): DemoProject {
  const timestamp = now()
  const websiteUrl = typeof body.websiteUrl === 'string' && body.websiteUrl.trim() ? body.websiteUrl.trim() : SYNTHETIC_SITE
  const id = String(state.nextProjectId++)
  const project: DemoProject = {
    id,
    companyName: typeof body.companyName === 'string' ? body.companyName.trim() : 'Synthetic Demo Company',
    websiteUrl,
    optimizationTarget: typeof body.optimizationTarget === 'string' ? body.optimizationTarget.trim() || null : null,
    supplementalInfo: typeof body.supplementalInfo === 'string' ? body.supplementalInfo.trim() || null : null,
    questionsGeneratedAt: null,
    questionsLockedAt: null,
    diagnosisStartedAt: null,
    initialDiagnosisCompletedAt: null,
    initialDiagnosisStatus: 'not_started',
    initialRecommendationRate: null,
    initialOfficialCitationRate: null,
    initialDiagnosisAt: null,
    latestMonitoringAt: null,
    latestRecommendationRate: null,
    latestOfficialCitationRate: null,
    websiteLockedAt: null,
    websiteCrawlStatus: 'not_started',
    websiteCrawlStartedAt: null,
    websiteCrawlCompletedAt: null,
    websiteCrawlError: null,
    websiteCrawlSource: null,
    websiteCrawlIncomplete: false,
    websitePagesDiscovered: 0,
    websitePagesSucceeded: 0,
    websitePagesFailed: 0,
    questionsGenerationStatus: 'not_started',
    questionsGenerationStartedAt: null,
    questionsGenerationCompletedAt: null,
    questionsGenerationError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    websiteCrawl: {
      status: 'not_started', source: null, incomplete: false, error: null,
      discoveredCount: 0, successCount: 0, failedCount: 0, startedAt: null, completedAt: null,
    },
    questionsGeneration: { status: 'not_started', error: null, startedAt: null, completedAt: null },
    questions: [],
    initialDiagnosis: {
      run: null, answers: [], reportPdfReady: false, reportPdfGeneratedAt: null,
      reportRefreshStatus: 'ready', reportRefreshStartedAt: null, reportRefreshError: null,
    },
    monitoringRuns: [],
    articleBatches: [],
    deliveryReport: { reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: null },
  }
  state.project = project
  return project
}

function questionsForProject(): DemoQuestion[] {
  const categories: QuestionCategory[] = [
    ...Array.from({ length: QUESTION_GROUP_COUNTS.recommendation }, () => 'recommendation' as const),
    ...Array.from({ length: QUESTION_GROUP_COUNTS.selection }, () => 'selection' as const),
    ...Array.from({ length: QUESTION_GROUP_COUNTS.decision }, () => 'decision' as const),
  ]
  const timestamp = now()
  return categories.map((category, index) => ({
    id: `demo-question-${index + 1}`,
    position: index + 1,
    question: `合成演示问题 ${index + 1}：用户如何评估示例服务？`,
    generatedAt: timestamp,
    category,
    isLocked: false,
  }))
}

function answerSet(questions: DemoQuestion[], rateOffset = 0): DemoAnswer[] {
  const timestamp = now()
  return questions.map((question) => ({
    position: question.position,
    question: question.question,
    status: 'success',
    answerText: `合成回答 ${question.position}：这是用于公开演示的固定证据摘要。`,
    citationUrls: [`${SYNTHETIC_SITE}/evidence/${question.position}`],
    responseModel: SYNTHETIC_MODEL,
    recommended: ((question.position + rateOffset) % 10) < 7,
    officialCitation: ((question.position + rateOffset) % 5) < 3,
    error: null,
    startedAt: timestamp,
    completedAt: timestamp,
  }))
}

function makeTask(projectId: string, kind: DemoTaskKind, targetId: string | null, result: Record<string, unknown>): DemoTask {
  const startedAt = now()
  const task: DemoTask = {
    id: `demo-task-${state.nextTaskId++}`,
    projectId,
    kind,
    targetId,
    status: 'completed',
    error: null,
    startedAt,
    completedAt: now(),
    result,
  }
  state.tasks.set(task.id, task)
  return task
}

function acceptedTask(task: DemoTask): DemoTask {
  return { ...task, status: 'running', completedAt: null, result: {} }
}

function buildDiagnosisRun(runType: 'initial' | 'monitoring', answers: DemoAnswer[]): DemoRun {
  const timestamp = now()
  const run: DemoRun = {
    id: `demo-run-${state.nextRunId++}`,
    runType,
    status: 'completed',
    requestedModel: SYNTHETIC_MODEL,
    roundNumber: runType === 'initial' ? 0 : 1,
    publishedArticleCount: runType === 'monitoring' ? (state.project?.articleBatches.flatMap((batch) => batch.articles).filter((article) => article.publishStatus === 'published').length ?? 0) : null,
    startedAt: timestamp,
    completedAt: timestamp,
    summaryAnalysis: { mode: 'synthetic', note: '合成诊断汇总；未调用真实模型。' },
    summaryModel: SYNTHETIC_MODEL,
    summaryError: null,
    recommendationRate: runType === 'initial' ? 0.7 : 0.75,
    officialCitationRate: runType === 'initial' ? 0.6 : 0.65,
    answers,
  }
  return run
}

function completeQuestions(): DemoTask | null {
  const project = state.project
  if (!project) return null
  const questions = questionsForProject()
  const timestamp = now()
  project.questions = questions
  project.questionsGeneratedAt = timestamp
  project.questionsGenerationStatus = 'completed'
  project.questionsGenerationStartedAt = timestamp
  project.questionsGenerationCompletedAt = timestamp
  project.questionsGenerationError = null
  project.questionsGeneration = { status: 'completed', error: null, startedAt: timestamp, completedAt: timestamp }
  touchProject()
  return makeTask(project.id, 'questions', null, {
    progress: {
      completedCount: QUESTION_TOTAL,
      total: QUESTION_TOTAL,
      questions: questions.map(({ question, category }) => ({ question, category })),
    },
  })
}

function completeInitialDiagnosis(): DemoTask | null {
  const project = state.project
  if (!project || project.questions.length !== QUESTION_TOTAL || !project.questionsLockedAt) return null
  const answers = answerSet(project.questions)
  const run = buildDiagnosisRun('initial', answers)
  project.initialDiagnosisStatus = 'completed'
  project.diagnosisStartedAt = run.startedAt
  project.initialDiagnosisCompletedAt = run.completedAt
  project.initialDiagnosisAt = run.completedAt
  project.initialRecommendationRate = run.recommendationRate
  project.initialOfficialCitationRate = run.officialCitationRate
  project.initialDiagnosis = {
    run,
    answers,
    reportPdfReady: false,
    reportPdfGeneratedAt: null,
    reportRefreshStatus: 'ready',
    reportRefreshStartedAt: run.completedAt,
    reportRefreshError: null,
  }
  touchProject()
  return makeTask(project.id, 'diagnosis', null, { progress: { position: QUESTION_TOTAL, status: 'success', completedCount: QUESTION_TOTAL, failedCount: 0, total: QUESTION_TOTAL } })
}

function completeMonitoring(): DemoTask | null {
  const project = state.project
  if (!project || project.initialDiagnosisStatus !== 'completed' || project.questions.length !== QUESTION_TOTAL) return null
  const answers = answerSet(project.questions, 1)
  const run = buildDiagnosisRun('monitoring', answers)
  project.latestMonitoringAt = run.completedAt
  project.latestRecommendationRate = run.recommendationRate
  project.latestOfficialCitationRate = run.officialCitationRate
  project.monitoringRuns = [...project.monitoringRuns.filter((item) => item.roundNumber !== run.roundNumber), run]
  touchProject()
  return makeTask(project.id, 'monitoring', null, { progress: { position: QUESTION_TOTAL, status: 'success', completedCount: QUESTION_TOTAL, failedCount: 0, total: QUESTION_TOTAL } })
}

function findTask(id: string): DemoTask | null {
  return state.tasks.get(id) ?? null
}

function taskProject(task: DemoTask): DemoProject | null {
  return state.project?.id === task.projectId ? state.project : null
}

function writeNdjson(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)$/)
  return match?.[1] ?? null
}

function taskPath(pathname: string): { projectId: string; taskId: string } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/ai-tasks\/([^/]+)$/)
  return match?.[1] && match[2] ? { projectId: match[1], taskId: match[2] } : null
}

function latestArticle(id: string): DemoArticle | null {
  return state.project?.articleBatches.flatMap((batch) => batch.articles).find((article) => article.id === id) ?? null
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  if (pathname === '/api/health/database' && method === 'GET') {
    sendJson(response, 200, { ok: true, database: 'synthetic-demo', mode: 'demo' })
    return
  }
  if (pathname === '/api/demo/status' && method === 'GET') {
    sendJson(response, 200, { ok: true, mode: 'synthetic', externalRequests: false, resetOnRestart: true })
    return
  }
  if (pathname === '/api/projects' && method === 'GET') {
    sendJson(response, 200, { ok: true, projects: state.project ? [state.project] : [] })
    return
  }
  if (pathname === '/api/projects' && method === 'POST') {
    let body: Record<string, unknown>
    try { body = await readJson(request) } catch { sendError(response, 400, 'invalid_request', '请求内容不是有效的 JSON'); return }
    if (typeof body.companyName !== 'string' || !body.companyName.trim()) {
      sendError(response, 400, 'company_name_required', '客户公司全名为必填项')
      return
    }
    const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : ''
    if (websiteUrl && !validWebsite(websiteUrl)) {
      sendError(response, 400, 'website_url_invalid', '客户官网必须是 HTTP 或 HTTPS 地址')
      return
    }
    const project = createProject(body)
    sendJson(response, 201, { ok: true, project })
    return
  }

  const taskRoute = taskPath(pathname)
  if (taskRoute && method === 'GET') {
    const task = findTask(taskRoute.taskId)
    const project = task ? taskProject(task) : null
    if (!task || !project || project.id !== taskRoute.projectId) {
      sendError(response, 404, 'task_not_found', '演示任务不存在')
      return
    }
    if ((request.headers.accept ?? '').includes('application/x-ndjson') && task.kind === 'questions') {
      const questions = project.questions.map(({ question, category }) => ({ question, category }))
      writeNdjson(response, [
        ...project.questions.map((question, index) => ({
          type: 'progress', completedCount: index + 1, total: QUESTION_TOTAL,
          questions: questions.slice(0, index + 1),
        })),
        { type: 'complete', project },
      ])
      return
    }
    sendJson(response, 200, { ok: true, task, project })
    return
  }

  const projectId = projectIdFromPath(pathname)
  if (projectId && method === 'GET') {
    if (!state.project || state.project.id !== projectId) { sendError(response, 404, 'project_not_found', '项目不存在'); return }
    sendJson(response, 200, { ok: true, project: state.project })
    return
  }
  if (projectId && method === 'DELETE') {
    if (!state.project || state.project.id !== projectId) { sendError(response, 404, 'project_not_found', '项目不存在'); return }
    state.project = null
    state.tasks.clear()
    sendJson(response, 200, { ok: true })
    return
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/)
  const id = projectMatch?.[1]
  const subpath = projectMatch?.[2] ?? ''
  if (id && state.project?.id !== id) { sendError(response, 404, 'project_not_found', '项目不存在'); return }
  const project = state.project

  if (id && subpath === 'ai-tasks' && method === 'GET' && project) {
    sendJson(response, 200, { ok: true, tasks: [...state.tasks.values()].filter((task) => task.projectId === id) })
    return
  }

  if (id && subpath === 'questions/generate' && method === 'POST' && project) {
    const task = completeQuestions()
    if (!task) { sendError(response, 409, 'questions_generation_failed', '问题生成暂时不可用'); return }
    sendJson(response, 202, { ok: true, task: acceptedTask(task) })
    return
  }
  if (id && subpath === 'questions/confirm' && method === 'POST' && project) {
    if (project.questions.length !== QUESTION_TOTAL) { sendError(response, 409, 'questions_count_invalid', '问题数量未达到 20 题'); return }
    const timestamp = now()
    project.questions = project.questions.map((question) => ({ ...question, isLocked: true }))
    project.questionsLockedAt = timestamp
    project.websiteLockedAt = timestamp
    touchProject()
    sendJson(response, 200, { ok: true, project })
    return
  }
  const questionMatch = id ? subpath.match(/^questions\/([^/]+)$/) : null
  if (id && questionMatch && project && (method === 'PATCH' || method === 'DELETE')) {
    const question = project.questions.find((item) => item.id === questionMatch[1])
    if (!question) { sendError(response, 404, 'question_not_found', '问题不存在'); return }
    if (method === 'PATCH') {
      const body = await readJson(request)
      if (typeof body.isLocked !== 'boolean') { sendError(response, 400, 'invalid_request', '锁定状态无效'); return }
      question.isLocked = body.isLocked
    } else {
      project.questions = project.questions.filter((item) => item.id !== question.id)
    }
    touchProject()
    sendJson(response, 200, { ok: true, project })
    return
  }
  if (id && subpath === 'diagnosis/start-or-resume' && method === 'POST' && project) {
    const task = completeInitialDiagnosis()
    if (!task) { sendError(response, 409, 'questions_not_locked', '请先确认问题集'); return }
    sendJson(response, 202, { ok: true, task: acceptedTask(task) })
    return
  }
  if (id && subpath === 'monitoring/start-or-resume' && method === 'POST' && project) {
    const task = completeMonitoring()
    if (!task) { sendError(response, 409, 'diagnosis_incomplete', '请先完成初始诊断'); return }
    sendJson(response, 202, { ok: true, task: acceptedTask(task) })
    return
  }
  if (id && subpath === 'articles/generate' && method === 'POST' && project) {
    if (project.initialDiagnosisStatus !== 'completed') { sendError(response, 409, 'diagnosis_incomplete', '请先完成初始诊断'); return }
    const timestamp = now()
    const batchId = `demo-batch-${project.articleBatches.length + 1}`
    const article: DemoArticle = {
      id: `demo-article-${state.nextArticleId++}`,
      projectId: project.id,
      batchId,
      title: '合成优化任务：补充可引用的服务说明',
      questionPositions: [1],
      contentHtml: null,
      generatedAt: timestamp,
      updatedAt: timestamp,
      writingStatus: 'pending',
      writingError: null,
      optimizationType: 'new',
      optimizationDirection: '主题内容补充',
      targetPageUrl: project.websiteUrl,
      targetPageTitle: '示例服务说明',
      publishStatus: 'pending',
      confirmedAt: null,
    }
    project.articleBatches.push({ id: batchId, projectId: project.id, requestedModel: SYNTHETIC_MODEL, responseModel: SYNTHETIC_MODEL, generatedAt: timestamp, articles: [article] })
    touchProject()
    const task = makeTask(project.id, 'article_titles', null, { addedCount: 1 })
    sendJson(response, 202, { ok: true, task: acceptedTask(task) })
    return
  }
  if (id && subpath === 'technical-audit' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') { sendJson(response, 200, { ok: true, audit: null }); return }
    sendError(response, 501, 'demo_not_supported', '演示模式不执行网站技术检查')
    return
  }
  if (id && subpath === 'content-audit' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') { sendJson(response, 200, { ok: true, audit: null }); return }
    sendError(response, 501, 'demo_not_supported', '演示模式不执行网站内容检查')
    return
  }
  if (id && subpath === 'diagnosis/report-refresh' && project && (method === 'GET' || method === 'POST')) {
    sendJson(response, 200, {
      ok: true, report: {
        status: 'ready', startedAt: project.initialDiagnosisCompletedAt, error: null,
        reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: project.initialDiagnosis.run?.id ?? null,
      },
    })
    return
  }
  if (id && (subpath === 'diagnosis/report-pdf' || subpath === 'monitoring/report-pdf') && method === 'GET') {
    sendError(response, 404, 'demo_pdf_unavailable', '演示模式不生成 PDF，下载功能已禁用')
    return
  }
  if (id && subpath === 'diagnosis/report-pdf' && method === 'PUT') {
    sendError(response, 501, 'demo_not_supported', '演示模式不保存 PDF')
    return
  }
  if (id && subpath === 'monitoring/report-pdf' && (method === 'PUT' || method === 'GET')) {
    sendError(response, 501, 'demo_not_supported', '演示模式不保存 PDF')
    return
  }
  if (id && method === 'PATCH' && project) {
    const body = await readJson(request)
    const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : project.websiteUrl ?? ''
    if (websiteUrl && !validWebsite(websiteUrl)) { sendError(response, 400, 'website_url_invalid', '客户官网必须是 HTTP 或 HTTPS 地址'); return }
    if (typeof body.companyName === 'string' && body.companyName.trim()) project.companyName = body.companyName.trim()
    project.websiteUrl = websiteUrl || null
    if (typeof body.optimizationTarget === 'string') project.optimizationTarget = body.optimizationTarget.trim() || null
    if (typeof body.supplementalInfo === 'string') project.supplementalInfo = body.supplementalInfo.trim() || null
    touchProject()
    sendJson(response, 200, { ok: true, project, reportRefresh: null })
    return
  }

  const articleWriteMatch = pathname.match(/^\/api\/articles\/([^/]+)\/write$/)
  const articleConfirmMatch = pathname.match(/^\/api\/articles\/([^/]+)\/confirm-published$/)
  const articleDeleteMatch = pathname.match(/^\/api\/articles\/([^/]+)$/)
  if (articleWriteMatch && method === 'POST') {
    const article = latestArticle(articleWriteMatch[1] ?? '')
    if (!article || !state.project) { sendError(response, 404, 'article_not_found', '文章任务不存在'); return }
    article.writingStatus = 'ready'
    article.contentHtml = '<h1>合成优化正文</h1><p>这是公开演示生成的固定正文，不调用真实模型，也不会自动发布到外部系统。</p>'
    article.updatedAt = now()
    const task = makeTask(state.project.id, 'article_body', article.id, { articleId: article.id })
    sendJson(response, 202, { ok: true, task: acceptedTask(task) })
    return
  }
  if (articleConfirmMatch && method === 'POST') {
    const article = latestArticle(articleConfirmMatch[1] ?? '')
    if (!article || !state.project) { sendError(response, 404, 'article_not_found', '文章任务不存在'); return }
    article.publishStatus = 'published'
    article.confirmedAt = now()
    article.updatedAt = article.confirmedAt
    touchProject()
    sendJson(response, 200, { ok: true, project: state.project })
    return
  }
  if (articleDeleteMatch && method === 'DELETE') {
    const articleId = articleDeleteMatch[1] ?? ''
    if (!state.project) { sendError(response, 404, 'article_not_found', '文章任务不存在'); return }
    let removed = false
    for (const batch of state.project.articleBatches) {
      const before = batch.articles.length
      batch.articles = batch.articles.filter((article) => article.id !== articleId)
      removed ||= before !== batch.articles.length
    }
    if (!removed) { sendError(response, 404, 'article_not_found', '文章任务不存在'); return }
    touchProject()
    sendJson(response, 200, { ok: true, project: state.project, deletedArticleId: articleId })
    return
  }

  sendError(response, 404, 'not_found', '请求地址不存在')
}

const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) sendError(response, 500, 'internal_error', '演示服务发生错误')
    else response.destroy()
  })
})

server.on('error', () => {
  process.exitCode = 1
})

function shutdown(): void {
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

server.listen(PORT, HOST, () => {
  console.log(`[demo-api] synthetic fixture listening on http://${HOST}:${PORT}`)
  console.log('[demo-api] no database, model key, or external network requests; restart resets the fixture')
})
