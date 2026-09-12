import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectDetail: vi.fn(),
  updateProjectWithWebsiteChange: vi.fn(),
  updateProjectWebsiteWithChange: vi.fn(),
  startDiagnosisReportRefresh: vi.fn(),
  markInitialDiagnosisReportRefreshFailed: vi.fn(),
}))

vi.mock('./ai-task-db.ts', () => ({
  getAiTask: vi.fn(),
  getRunningAiTask: vi.fn(),
  listAiTasks: vi.fn(),
  clearIncompleteAiTasksOnStartup: vi.fn(),
}))

vi.mock('./db.ts', () => ({
  checkDatabase: vi.fn(),
  closeDatabasePool: vi.fn(),
  confirmQuestions: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  getProject: mocks.getProject,
  getProjectDetail: mocks.getProjectDetail,
  getInitialDiagnosisReportPdf: vi.fn(),
  getMonitoringDeliveryReportPdf: vi.fn(),
  isUniqueViolation: vi.fn(),
  listProjects: vi.fn(),
  markInitialDiagnosisReportRefreshFailed: mocks.markInitialDiagnosisReportRefreshFailed,
  confirmArticlePublished: vi.fn(),
  deleteQuestion: vi.fn(),
  deleteArticle: vi.fn(),
  getArticleProjectId: vi.fn(),
  saveMonitoringDeliveryReportPdf: vi.fn(),
  setQuestionLocked: vi.fn(),
  updateProjectWithWebsiteChange: mocks.updateProjectWithWebsiteChange,
  updateProjectWebsiteWithChange: mocks.updateProjectWebsiteWithChange,
}))

vi.mock('./diagnosis-report-service.ts', () => ({
  getDiagnosisReportRefresh: vi.fn(),
  startDiagnosisReportRefresh: mocks.startDiagnosisReportRefresh,
}))

describe('website-fill project PATCH persistence boundary', () => {
  let handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>

  beforeAll(async () => {
    ({ handleRequest } = await import('./index.ts'))
  })

  beforeEach(() => {
    mocks.getProjectDetail.mockReset()
    mocks.getProject.mockReset()
    mocks.updateProjectWithWebsiteChange.mockReset()
    mocks.updateProjectWebsiteWithChange.mockReset()
    mocks.startDiagnosisReportRefresh.mockReset()
    mocks.markInitialDiagnosisReportRefreshFailed.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function request(pathname: string, locale?: string): IncomingMessage {
    const request = Readable.from([JSON.stringify({
      websiteUrl: 'https://new.example',
      expectedUpdatedAt: '2026-09-09T00:00:00.000Z',
    })]) as Readable & IncomingMessage
    Object.assign(request, {
      method: 'PATCH',
      url: pathname,
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        ...(locale ? { 'x-geo-locale': locale } : {}),
      },
    })
    return request
  }

  function response(): { value: ServerResponse; statusCode: number; body: string } {
    const state = { statusCode: 0, body: '' }
    const raw = {
      destroyed: false,
      headersSent: false,
      writeHead(statusCode: number): void {
        state.statusCode = statusCode
        raw.headersSent = true
      },
      end(body?: string | Uint8Array): void {
        state.body = body === undefined ? '' : Buffer.from(body).toString('utf8')
      },
    }
    const value = raw as unknown as ServerResponse
    return {
      value,
      get statusCode() { return state.statusCode },
      get body() { return state.body },
    }
  }

  function simpleRequest(pathname: string, method = 'POST', locale?: string, acceptLanguage?: string): IncomingMessage {
    const request = Readable.from([]) as Readable & IncomingMessage
    Object.assign(request, {
      method,
      url: pathname,
      headers: {
        host: '127.0.0.1:8787',
        ...(locale ? { 'x-geo-locale': locale } : {}),
        ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
      },
    })
    return request
  }

  function project(): Record<string, unknown> {
    return {
      id: '1',
      companyName: '示例公司',
      websiteUrl: 'https://new.example',
      optimizationTarget: '服务',
      supplementalInfo: null,
      questionsGeneratedAt: null,
      questionsLockedAt: '2026-09-08T00:00:00.000Z',
      diagnosisStartedAt: '2026-09-08T00:00:00.000Z',
      initialDiagnosisCompletedAt: '2026-09-08T00:01:00.000Z',
      initialDiagnosisStatus: 'completed',
      initialRecommendationRate: 0.5,
      initialOfficialCitationRate: null,
      initialDiagnosisAt: '2026-09-08T00:01:00.000Z',
      websiteLockedAt: '2026-09-09T00:00:01.000Z',
      websiteCrawlStatus: 'not_started',
      websiteCrawlStartedAt: null,
      websiteCrawlCompletedAt: null,
      websiteCrawlError: null,
      websiteCrawlSource: null,
      websiteCrawlIncomplete: false,
      websitePagesDiscovered: 0,
      websitePagesSucceeded: 0,
      websitePagesFailed: 0,
      questionsGenerationStatus: 'completed',
      questionsGenerationStartedAt: null,
      questionsGenerationCompletedAt: '2026-09-08T00:00:30.000Z',
      questionsGenerationError: null,
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:01.000Z',
    }
  }

  function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base = project()
    return {
      ...base,
      websiteCrawl: {
        status: base.websiteCrawlStatus,
        source: base.websiteCrawlSource,
        incomplete: base.websiteCrawlIncomplete,
        error: base.websiteCrawlError,
        discoveredCount: base.websitePagesDiscovered,
        successCount: base.websitePagesSucceeded,
        failedCount: base.websitePagesFailed,
        startedAt: base.websiteCrawlStartedAt,
        completedAt: base.websiteCrawlCompletedAt,
      },
      questionsGeneration: {
        status: base.questionsGenerationStatus,
        error: base.questionsGenerationError,
        startedAt: base.questionsGenerationStartedAt,
        completedAt: base.questionsGenerationCompletedAt,
      },
      questions: [{ position: 1, question: '问题', isLocked: true }],
      initialDiagnosis: {
        run: { id: 'run-1', runType: 'initial', status: 'completed' },
        answers: [],
        reportPdfReady: true,
        reportPdfGeneratedAt: '2026-09-08T00:02:00.000Z',
        reportRefreshStatus: 'ready',
        reportRefreshStartedAt: null,
        reportRefreshError: null,
      },
      monitoringRuns: [],
      articleBatches: [],
      deliveryReport: { reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: null },
      ...overrides,
    }
  }

  function configureMutation(pathname: string, mutation: Record<string, unknown>): void {
    const target = pathname.endsWith('/website')
      ? mocks.updateProjectWebsiteWithChange
      : mocks.updateProjectWithWebsiteChange
    target.mockResolvedValue(mutation)
  }

  it.each(['/api/projects/1', '/api/projects/1/website'])('keeps a saved %s response when report acceptance throws', async (pathname) => {
    const updated = project()
    const saved = detail({
      ...updated,
      initialDiagnosis: {
        ...(detail().initialDiagnosis as Record<string, unknown>),
        reportRefreshStatus: 'failed',
        reportRefreshError: '诊断报告刷新暂时无法开始，请稍后重试',
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
      },
    })
    configureMutation(pathname, { project: updated, websiteChanged: true, resetPerformed: false, websiteFilled: true })
    mocks.getProjectDetail.mockResolvedValueOnce(detail()).mockResolvedValueOnce(saved)
    mocks.startDiagnosisReportRefresh.mockRejectedValue(new Error('Bearer TOP_SECRET detail=TOP_SECRET'))
    mocks.markInitialDiagnosisReportRefreshFailed.mockResolvedValue(true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const output = response()

    await handleRequest(request(pathname), output.value)

    expect(output.statusCode).toBe(200)
    const body = JSON.parse(output.body) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.project.websiteUrl).toBe('https://new.example')
    expect(body.project.websiteLockedAt).toBeTruthy()
    expect(body.project.initialDiagnosis.reportPdfReady).toBe(false)
    expect(body.reportRefresh).toMatchObject({
      status: 'failed',
      error: '诊断报告刷新暂时无法开始，请稍后重试',
      reportPdfReady: false,
      persisted: true,
    })
    expect(mocks.markInitialDiagnosisReportRefreshFailed).toHaveBeenCalledWith('1', '诊断报告刷新暂时无法开始，请稍后重试')
    expect(log.mock.calls.flat().join(' ')).not.toContain('TOP_SECRET')
  })

  it('passes the accepted locale to direct diagnosis report refresh', async () => {
    mocks.getProject.mockResolvedValue(project())
    mocks.startDiagnosisReportRefresh.mockResolvedValue({
      status: 'running',
      startedAt: '2026-09-09T00:00:02.000Z',
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'run-1',
    })
    const output = response()

    await handleRequest(simpleRequest('/api/projects/1/diagnosis/report-refresh', 'POST', 'en'), output.value)

    expect(output.statusCode).toBe(202)
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('1', { locale: 'en' })
  })

  it('defaults direct report refresh to Chinese without the explicit locale header', async () => {
    mocks.getProject.mockResolvedValue(project())
    mocks.startDiagnosisReportRefresh.mockResolvedValue({
      status: 'running',
      startedAt: '2026-09-09T00:00:02.000Z',
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'run-1',
    })
    const output = response()

    await handleRequest(simpleRequest('/api/projects/1/diagnosis/report-refresh', 'POST', undefined, 'en-US'), output.value)

    expect(output.statusCode).toBe(202)
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('1', { locale: 'zh-CN' })
  })

  it.each(['/api/projects/1', '/api/projects/1/website'])('passes the accepted report locale for %s website fills', async (pathname) => {
    const updated = project()
    configureMutation(pathname, { project: updated, websiteChanged: true, resetPerformed: false, websiteFilled: true })
    mocks.getProjectDetail.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail({ ...updated, websiteUrl: 'https://new.example' }))
    mocks.startDiagnosisReportRefresh.mockResolvedValue({
      status: 'running',
      startedAt: '2026-09-09T00:00:02.000Z',
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'run-1',
    })
    const output = response()

    await handleRequest(request(pathname, 'en'), output.value)

    expect(output.statusCode).toBe(200)
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('1', { locale: 'en' })
  })

  it.each(['/api/projects/1', '/api/projects/1/website'])('keeps the committed %s response when detail reload fails', async (pathname) => {
    const updated = project()
    const previous = detail()
    configureMutation(pathname, { project: updated, websiteChanged: true, resetPerformed: false, websiteFilled: true })
    mocks.getProjectDetail.mockResolvedValueOnce(previous).mockRejectedValueOnce(new Error('detail read leaked SECRET'))
    mocks.startDiagnosisReportRefresh.mockResolvedValue({
      status: 'running',
      startedAt: '2026-09-09T00:00:02.000Z',
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'run-1',
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const output = response()

    await handleRequest(request(pathname), output.value)

    expect(output.statusCode).toBe(200)
    const body = JSON.parse(output.body) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.project.websiteUrl).toBe('https://new.example')
    expect(body.project.websiteLockedAt).toBeTruthy()
    expect(body.project.questions).toEqual(previous.questions)
    expect(body.project.initialDiagnosis.reportPdfReady).toBe(false)
    expect(body.reportRefresh).toMatchObject({
      status: 'failed',
      error: '项目已保存，但诊断报告状态暂时无法读取，请稍后重试',
      reportPdfReady: false,
      persisted: false,
    })
    expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET')
  })
})
