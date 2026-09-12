import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmAndStartDiagnosis, confirmQuestions, deleteQuestion, fetchDiagnosisReportRefresh, generateInitialDiagnosisReport, generateProjectArticles, observeQuestionGenerationTask, regenerateQuestions, runTechnicalAudit, saveDiagnosisReportPdf, saveProjectWebsite, setQuestionLocked, startDiagnosisReportRefresh, startOrResumeDiagnosis, startOrResumeMonitoring, type DiagnosisProgressEvent, type QuestionGenerationProgress, type TechnicalAuditProgressEvent, updateProject } from './api'
import type { DiagnosisAnswer, MonitoringRun, MonitoringUpdateEvent, ProjectDetail } from './types'
import { TECHNICAL_AUDIT_RULE_VERSION, type TechnicalAuditItem } from './technical-audit'

function answer(position: number, status: DiagnosisAnswer['status'] = 'success'): DiagnosisAnswer {
  return {
    position,
    question: `问题${position}`,
    status,
    answerText: status === 'running' ? null : `回答${position}`,
    citationUrls: [],
    responseModel: status === 'running' ? null : 'monitor-model',
    recommended: status === 'success' ? true : null,
    officialCitation: status === 'success' ? false : null,
    error: status === 'failed' ? '请求失败' : null,
    startedAt: '2026-09-08T07:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-09-08T07:00:01.000Z',
  }
}

function monitoringRun(): MonitoringRun {
  return {
    id: 'run-5',
    runType: 'monitoring',
    status: 'running',
    requestedModel: 'monitor-model',
    roundNumber: 5,
    publishedArticleCount: 2,
    startedAt: '2026-09-08T07:00:00.000Z',
    completedAt: null,
    summaryAnalysis: null,
    summaryModel: null,
    summaryError: null,
    recommendationRate: null,
    officialCitationRate: null,
    answers: Array.from({ length: 20 }, (_, index) => answer(index + 1, index === 0 ? 'success' : 'pending')),
  }
}

function ndjsonResponse(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

const finalProject = { id: '18', monitoringRuns: [] } as unknown as ProjectDetail

function technicalAuditItem(itemId: string, status: TechnicalAuditItem['status'] = 'pass'): TechnicalAuditItem {
  return { item_id: itemId, status, message_code: status, facts: {}, evidence: {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('monitoring NDJSON updates', () => {
  it('parses split monitoring run, answer, and analyzing events before complete', async () => {
    const run = monitoringRun()
    const running = answer(2, 'running')
    const success = answer(2, 'success')
    const updates: MonitoringUpdateEvent[] = []
    const progress: DiagnosisProgressEvent[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/projects/18/monitoring/start-or-resume')
      expect(init?.method).toBe('POST')
      return ndjsonResponse([
        { type: 'started', total: 20 },
        { type: 'run', run },
        { type: 'answer', runId: run.id, answer: running },
        { type: 'progress', position: 2, status: 'success', completedCount: 2, failedCount: 0, total: 20, answer: success },
        { type: 'answer', runId: run.id, answer: success },
        { type: 'analyzing', runId: run.id },
        { type: 'complete', project: finalProject },
      ])
    }))

    const result = await startOrResumeMonitoring('18', (event) => progress.push(event), (event) => updates.push(event))

    expect(result).toEqual(finalProject)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ position: 2, completedCount: 2, failedCount: 0, answer: success })
    expect(updates).toEqual([
      { type: 'run', run },
      { type: 'answer', runId: run.id, answer: running },
      { type: 'answer', runId: run.id, answer: success },
      { type: 'analyzing', runId: run.id },
    ])
  })

  it('delivers monitoring updates while the response is still waiting for complete', async () => {
    const run = monitoringRun()
    const firstAnswer = answer(1, 'success')
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let resolveAnswerSeen: (() => void) | undefined
    const answerSeen = new Promise<void>((resolve) => { resolveAnswerSeen = resolve })
    let resolved = false

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'started', total: 20 })}\n`))
        streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'run', run })}\n`))
        streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'answer', runId: run.id, answer: firstAnswer })}\n`))
      },
    }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })))

    const resultPromise = startOrResumeMonitoring('18', undefined, (update) => {
      if (update.type === 'answer') resolveAnswerSeen?.()
    }).then((result) => {
      resolved = true
      return result
    })

    await answerSeen
    expect(resolved).toBe(false)
    controller?.enqueue(encoder.encode(`${JSON.stringify({ type: 'complete', project: finalProject })}\n`))
    controller?.close()
    await expect(resultPromise).resolves.toEqual(finalProject)
  })

  it('keeps the initial diagnosis stream compatible and does not expose monitoring updates', async () => {
    const progress: DiagnosisProgressEvent[] = []
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      { type: 'started', total: 20 },
      { type: 'progress', position: 1, status: 'success', completedCount: 1, failedCount: 0, total: 20 },
      { type: 'complete', project: finalProject },
    ])))

    await expect(startOrResumeDiagnosis('18', (event) => progress.push(event))).resolves.toEqual(finalProject)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ position: 1, status: 'success', completedCount: 1 })
  })

  it('rejects malformed typed monitoring updates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      { type: 'run', run: { ...monitoringRun(), answers: [{ ...answer(1), status: 'invalid' }] } },
      { type: 'complete', project: finalProject },
    ])))

    await expect(startOrResumeMonitoring('18', undefined, () => undefined)).rejects.toMatchObject({
      code: 'invalid_response',
      message: '服务返回了无法识别的监测轮次',
    })
  })

  it('does not start a stale diagnosis after its confirmation response arrives', async () => {
    let startCalls = 0
    await expect(confirmAndStartDiagnosis(
      '18',
      '2026-09-08T07:00:00.000Z',
      () => undefined,
      undefined,
      {
        confirm: async (_id, _expectedUpdatedAt) => ({ id: '18' } as unknown as ProjectDetail),
        start: async () => {
          startCalls += 1
          return finalProject
        },
        shouldContinue: () => false,
      },
    )).rejects.toMatchObject({
      code: 'project_action_stale',
    })
    expect(startCalls).toBe(0)
  })
})

describe('diagnosis report locale headers', () => {
  function reportRefreshResponse(): Response {
    return Response.json({
      ok: true,
      report: {
        status: 'running',
        startedAt: '2026-09-10T01:00:00.000Z',
        error: null,
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
        sourceRunId: 'initial-run-1',
      },
    })
  }

  it('sends the document locale when starting initial diagnosis', async () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    let captured: { init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { init }
      return ndjsonResponse([{ type: 'complete', project: finalProject }])
    }))

    await expect(startOrResumeDiagnosis('18')).resolves.toEqual(finalProject)
    expect(new Headers(captured?.init?.headers).get('X-GEO-Locale')).toBe('en')
  })

  it('sends the document locale for report aggregation retry and refresh acceptance', async () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      if (String(input).includes('/diagnosis/generate-report')) return Response.json({ ok: true, project: finalProject })
      return reportRefreshResponse()
    }))

    await expect(generateInitialDiagnosisReport('18')).resolves.toEqual(finalProject)
    await expect(startDiagnosisReportRefresh('18')).resolves.toMatchObject({ status: 'running' })

    expect(calls).toHaveLength(2)
    for (const call of calls) expect(new Headers(call.init?.headers).get('X-GEO-Locale')).toBe('en')
  })

  it('keeps report-status reads and legacy report requests without a locale header', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return reportRefreshResponse()
    }))

    await expect(fetchDiagnosisReportRefresh('18')).resolves.toMatchObject({ status: 'running' })
    await expect(startDiagnosisReportRefresh('18')).resolves.toMatchObject({ status: 'running' })

    expect(new Headers(calls[0]?.init?.headers).get('X-GEO-Locale')).toBeNull()
    expect(new Headers(calls[1]?.init?.headers).get('X-GEO-Locale')).toBeNull()
  })
})

describe('accepted AI tasks', () => {
  it('polls a 202 task to completion without posting the operation again', async () => {
    vi.useFakeTimers()
    const task = {
      id: 'task-title-1',
      projectId: '18',
      kind: 'article_titles',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-09T03:00:00.000Z',
      completedAt: null,
      result: null,
    }
    const completedTask = { ...task, status: 'completed', completedAt: '2026-09-09T03:00:01.000Z', result: { addedCount: 2 } }
    const calls: Array<{ input: string; method: string }> = []
    let detailReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), method: init?.method ?? 'GET' })
      if (init?.method === 'POST') return Response.json({ ok: true, task }, { status: 202 })
      detailReads += 1
      return Response.json({ ok: true, task: detailReads === 1 ? task : completedTask, project: finalProject })
    }))

    const resultPromise = generateProjectArticles('18')
    await vi.runAllTimersAsync()
    await expect(resultPromise).resolves.toEqual({ project: finalProject, addedCount: 2 })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(detailReads).toBe(2)
    vi.useRealTimers()
  })
})

describe('technical-audit NDJSON updates', () => {
  it('requests per-item stream progress and keeps UTF-8 item evidence intact', async () => {
    const progress: TechnicalAuditProgressEvent[] = []
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    const first = technicalAuditItem('site.dns')
    first.evidence = { requested_url: 'https://例子.test/', status: 200 }
    const second = technicalAuditItem('site.https', 'fix')
    const body = `${JSON.stringify({ type: 'item', item: first, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 })}\n${JSON.stringify({ type: 'item', item: second, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 2, total: 24 })}\n${JSON.stringify({ type: 'complete', audit: { checked_at: '2026-09-08T07:00:00.000Z', website_url: 'https://例子.test/', scope: {}, items: [first, second], rule_version: TECHNICAL_AUDIT_RULE_VERSION } })}`
    const bytes = new TextEncoder().encode(body)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
    }))

    const result = await runTechnicalAudit('42', (event) => progress.push(event))

    expect(result.items).toEqual([first, second])
    expect(progress).toEqual([
      { item: first, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
      { item: second, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 2, total: 24 },
    ])
    expect(captured?.input).toBe('/api/projects/42/technical-audit')
    expect(new Headers(captured?.init?.headers).get('Accept')).toBe('application/x-ndjson')
  })

  it('accepts a regular JSON response when progress is requested from an older server', async () => {
    const audit = { checked_at: '2026-09-08T07:00:00.000Z', website_url: 'https://example.test/', scope: {}, items: [] }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, audit }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runTechnicalAudit('42', () => undefined)).resolves.toEqual(audit)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Accept')).toBe('application/x-ndjson')
  })

  it('rejects malformed item progress, duplicates, rollback, and streams without complete', async () => {
    const run = async (events: unknown[]) => {
      vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse(events)))
      return runTechnicalAudit('42', () => undefined)
    }
    const valid = technicalAuditItem('site.dns')
    await expect(run([{ type: 'item', item: valid, rule_version: 6, completedCount: 1, total: 24 }])).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(run([
      { type: 'item', item: valid, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
      { type: 'item', item: valid, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 2, total: 24 },
    ])).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(run([
      { type: 'item', item: valid, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
      { type: 'item', item: technicalAuditItem('site.https'), rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
    ])).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(run([
      { type: 'item', item: valid, rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
    ])).rejects.toThrow('完整')
  })

  it('propagates stream error events without accepting a partial snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      { type: 'item', item: technicalAuditItem('site.dns'), rule_version: TECHNICAL_AUDIT_RULE_VERSION, completedCount: 1, total: 24 },
      { type: 'error', error: 'technical_audit_execution_failed', message: '部分页面请求未完成' },
    ])))

    await expect(runTechnicalAudit('42', () => undefined)).rejects.toMatchObject({
      code: 'technical_audit_execution_failed',
      message: '部分页面请求未完成',
    })
  })
})

describe('project reset mutation requests', () => {
  function projectWithReportState(websiteUrl = 'https://saved.example'): ProjectDetail {
    const run = { id: 'initial-run-1', status: 'completed' }
    return {
      id: '18',
      companyName: '原公司',
      websiteUrl,
      initialDiagnosis: {
        run,
        answers: [answer(1)],
        reportPdfReady: true,
        reportPdfGeneratedAt: '2026-09-08T06:00:00.000Z',
        reportRefreshStatus: 'ready',
        reportRefreshStartedAt: '2026-09-08T06:00:00.000Z',
        reportRefreshError: null,
      },
    } as unknown as ProjectDetail
  }

  it('sends reset confirmation and the expected project timestamp together', async () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await updateProject('18', {
      companyName: '新公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '新对象',
      supplementalInfo: '新补充信息',
    }, { resetConfirmed: true, expectedUpdatedAt: '2026-09-08T07:00:00.000Z' })

    expect(captured?.input).toBe('/api/projects/18')
    expect(captured?.init?.method).toBe('PATCH')
    expect(new Headers(captured?.init?.headers).get('X-GEO-Locale')).toBe('en')
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({
      companyName: '新公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '新对象',
      supplementalInfo: '新补充信息',
      resetConfirmed: true,
      expectedUpdatedAt: '2026-09-08T07:00:00.000Z',
    })
  })

  it('keeps the website-only mutation on the same confirmation protocol', async () => {
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await saveProjectWebsite('18', ' https://example.test ', { resetConfirmed: true, expectedUpdatedAt: '2026-09-08T07:00:00.000Z' })

    expect(captured?.input).toBe('/api/projects/18/website')
    expect(new Headers(captured?.init?.headers).get('X-GEO-Locale')).toBe('en')
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      websiteUrl: 'https://example.test',
      resetConfirmed: true,
      expectedUpdatedAt: '2026-09-08T07:00:00.000Z',
    })
  })

  it('merges a failed report-refresh marker into the returned project without losing diagnosis state', async () => {
    const project = projectWithReportState()
    const reportRefresh = {
      status: 'failed' as const,
      startedAt: '2026-09-09T07:00:00.000Z',
      error: '诊断报告生成失败，请重试',
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'initial-run-1',
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, project, reportRefresh })))

    const saved = await updateProject('18', {
      companyName: '原公司',
      websiteUrl: 'https://saved.example',
      optimizationTarget: '',
      supplementalInfo: '',
    })

    expect(saved.id).toBe('18')
    expect(saved.websiteUrl).toBe('https://saved.example')
    expect(saved.initialDiagnosis.run).toEqual(project.initialDiagnosis.run)
    expect(saved.initialDiagnosis.answers).toEqual(project.initialDiagnosis.answers)
    expect(saved.initialDiagnosis.reportRefreshStatus).toBe('failed')
    expect(saved.initialDiagnosis.reportRefreshStartedAt).toBe(reportRefresh.startedAt)
    expect(saved.initialDiagnosis.reportRefreshError).toBe(reportRefresh.error)
    expect(saved.initialDiagnosis.reportPdfReady).toBe(false)
    expect(saved.initialDiagnosis.reportPdfGeneratedAt).toBeNull()
  })

  it('merges a running report-refresh marker from the website-only mutation and clears an old PDF flag', async () => {
    const project = projectWithReportState('https://new.example')
    const reportRefresh = {
      status: 'running' as const,
      startedAt: '2026-09-09T07:01:00.000Z',
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: 'initial-run-1',
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, project, reportRefresh })))

    const saved = await saveProjectWebsite('18', ' https://new.example ')

    expect(saved.websiteUrl).toBe('https://new.example')
    expect(saved.initialDiagnosis.reportRefreshStatus).toBe('running')
    expect(saved.initialDiagnosis.reportRefreshStartedAt).toBe(reportRefresh.startedAt)
    expect(saved.initialDiagnosis.reportRefreshError).toBeNull()
    expect(saved.initialDiagnosis.reportPdfReady).toBe(false)
    expect(saved.initialDiagnosis.reportPdfGeneratedAt).toBeNull()
  })

  it('keeps website mutation errors as API errors instead of reopening the saved form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: 'website_locked', message: '官网只能填写一次' }, { status: 409 })))

    await expect(saveProjectWebsite('18', 'https://new.example')).rejects.toMatchObject({
      status: 409,
      code: 'website_locked',
      message: '官网只能填写一次',
    })
  })

  it('binds an initial diagnosis report PDF to the run that generated it', async () => {
    let captured: { init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { init }
      expect(input).toBe('/api/projects/18/diagnosis/report-pdf')
      return Response.json({ reportPdfReady: true, reportPdfGeneratedAt: '2026-09-08T07:00:00.000Z' })
    }))

    await saveDiagnosisReportPdf('18', new Blob(['pdf'], { type: 'application/pdf' }), 'initial-run-1')

    expect(new Headers(captured?.init?.headers).get('X-Source-Run-Id')).toBe('initial-run-1')
  })
})

describe('question mutation requests', () => {
  const expectedUpdatedAt = '2026-09-08T07:00:00.000Z'

  it('requests and parses incremental question-generation progress', async () => {
    const progress: QuestionGenerationProgress[] = []
    let captured: { init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { init }
      return ndjsonResponse([
        { type: 'progress', completedCount: 0, total: 2, questions: [] },
        { type: 'progress', completedCount: 1, total: 2, questions: [{ question: '适合谁采用这项服务？', category: 'recommendation' }] },
        { type: 'progress', completedCount: 2, total: 2, questions: [{ question: '适合谁采用这项服务？', category: 'recommendation' }, { question: '如何选择实施方式？', category: 'selection' }] },
        { type: 'complete', project: finalProject },
      ])
    }))

    const result = await regenerateQuestions('18', expectedUpdatedAt, (event) => progress.push(event))

    expect(result).toEqual(finalProject)
    expect(new Headers(captured?.init?.headers).get('Accept')).toBe('application/x-ndjson')
    expect(progress).toHaveLength(3)
    expect(progress[1]).toMatchObject({ completedCount: 1, total: 2 })
    expect(progress[2].questions).toHaveLength(2)
  })

  it('rejects a question-generation stream that ends before complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([
      { type: 'progress', completedCount: 1, total: 1, questions: [{ question: '问题', category: 'decision' }] },
    ])))

    await expect(regenerateQuestions('18', expectedUpdatedAt, () => undefined)).rejects.toThrow('完整')
  })

  it('observes a 202 questions task through its detail stream instead of polling', async () => {
    const task = {
      id: 'question-task-1',
      projectId: '18',
      kind: 'questions',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-09T03:00:00.000Z',
      completedAt: null,
      result: null,
    }
    const progress: QuestionGenerationProgress[] = []
    const calls: Array<{ input: string; method: string; accept: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), method: init?.method ?? 'GET', accept: new Headers(init?.headers).get('Accept') })
      if (init?.method === 'POST') return Response.json({ ok: true, task }, { status: 202 })
      return ndjsonResponse([
        { type: 'progress', completedCount: 1, total: 1, questions: [{ question: '如何选择实施方式？', category: 'selection' }] },
        { type: 'complete', project: finalProject },
      ])
    }))

    await expect(regenerateQuestions('18', expectedUpdatedAt, (event) => progress.push(event))).resolves.toEqual(finalProject)
    expect(calls).toEqual([
      { input: '/api/projects/18/questions/generate', method: 'POST', accept: 'application/x-ndjson' },
      { input: '/api/projects/18/ai-tasks/question-task-1', method: 'GET', accept: 'application/x-ndjson' },
    ])
    expect(progress).toHaveLength(1)
  })

  it('keeps the questions observer API available for project re-entry', async () => {
    let captured: { input: string; accept: string | null } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input: String(input), accept: new Headers(init?.headers).get('Accept') }
      return ndjsonResponse([{ type: 'complete', project: finalProject }])
    }))

    await expect(observeQuestionGenerationTask('18', 'question-task-2')).resolves.toEqual(finalProject)
    expect(captured).toEqual({ input: '/api/projects/18/ai-tasks/question-task-2', accept: 'application/x-ndjson' })
  })

  it('sends the expected project timestamp when generating questions', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await regenerateQuestions('18', expectedUpdatedAt)

    expect(captured?.input).toBe('/api/projects/18/questions/generate')
    expect(captured?.init?.method).toBe('POST')
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ expectedUpdatedAt })
  })

  it('sends the expected project timestamp when confirming questions', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await confirmQuestions('18', expectedUpdatedAt)

    expect(captured?.input).toBe('/api/projects/18/questions/confirm')
    expect(captured?.init?.method).toBe('POST')
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ expectedUpdatedAt })
  })

  it('sends lock state and timestamp for one question', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await setQuestionLocked('18', 'question/1', true, expectedUpdatedAt)

    expect(captured?.input).toBe('/api/projects/18/questions/question%2F1')
    expect(captured?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ isLocked: true, expectedUpdatedAt })
  })

  it('sends timestamp when deleting one question', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init }
      return Response.json({ project: { id: '18' } })
    }))

    await deleteQuestion('18', 'question-1', expectedUpdatedAt)

    expect(captured?.input).toBe('/api/projects/18/questions/question-1')
    expect(captured?.init?.method).toBe('DELETE')
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ expectedUpdatedAt })
  })
})
