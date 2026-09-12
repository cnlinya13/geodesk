/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import App, { ArticlePreviewModal, aiTaskProgressForDisplay, confirmAndDeleteProject, contentAuditGenerationReady, contentAuditPollingNeeded, contentAuditTaskForPolling, DiagnosisReport, formatArticleUpdatedAt, isCurrentProjectSnapshot, isCurrentProjectWebsite, mergeMonitoringUpdate, mergeProjectArticleSnapshots, MonitoringDashboard, MonitoringScope, normalizeContentAuditRecordForLoad, normalizeProjectFormValues, normalizeProjectOnInitialLoad, OptimizationSuggestions, pendingProjectSaveCallback, projectEntryStage, projectFormValuesEqual, ProjectFormModal, ProjectReportPage, ProjectWorkspace, projectWebsiteValidationError, questionCategoryLabel, questionGenerationTaskProgress, questionTaskIdForObservation, shouldClearUnconfirmedOutline, stageActionError, stageStates, websiteCrawlIsActive } from './App'
import { copyArticleContent } from './article-copy'
import { confirmAndStartDiagnosis, type QuestionGenerationProgress } from './api'
import { GlobalHeader, PhaseNav, stages } from './components/UI'
import type { ContentAuditRecord } from './content-audit'
import type { AiTask, DiagnosisAnswer, MonitoringRun, ProjectDetail } from './types'

const appSource = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8')
const appCss = readFileSync(fileURLToPath(new URL('./App.css', import.meta.url)), 'utf8')
const missingQuestionSourceMessage = '请填写优化对象、客户官网或补充信息后，再生成诊断提纲。'

function monitoringActionArea(html: string): string {
  const match = html.match(/<div class="operation-bar__left">([\s\S]*?)<\/div><div class="operation-bar__center">([\s\S]*?)<\/div><div class="operation-bar__right">/)
  if (!match) throw new Error('monitoring operation bar was not rendered')
  return `${match[1]}${match[2]}`
}

function operationBarCenter(html: string): string {
  const match = html.match(/<div class="operation-bar__center">([\s\S]*?)<\/div>/)
  if (!match) throw new Error('operation bar center was not rendered')
  return match[1]
}

function cssRulesForClass(css: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`[^{}]*\\.${escaped}(?![a-zA-Z0-9_-])[^{}]*\\{[\\s\\S]*?\\n\\}`, 'g')) ?? []
}

function monitoringProgressProject(): ProjectDetail {
  return {
    id: 'monitoring-progress',
    companyName: '监测进度公司',
    websiteUrl: null,
    optimizationTarget: null,
    supplementalInfo: null,
    questions: [],
    articleBatches: [],
    monitoringRuns: [],
    deliveryReport: { reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: null },
  } as unknown as ProjectDetail
}

function monitoringRunFixture(overrides: Partial<MonitoringRun> = {}): MonitoringRun {
  return {
    id: 'monitoring-run-4',
    runType: 'monitoring',
    status: 'running',
    requestedModel: 'monitor-model',
    roundNumber: 4,
    publishedArticleCount: 0,
    startedAt: '2026-09-08T07:00:00.000Z',
    completedAt: null,
    summaryAnalysis: null,
    summaryModel: null,
    summaryError: null,
    recommendationRate: null,
    officialCitationRate: null,
    answers: [],
    ...overrides,
  }
}

function entryArticle({
  id = 'article-1',
  writingStatus = 'ready',
  publishStatus = 'pending',
}: {
  id?: string
  writingStatus?: 'pending' | 'writing' | 'ready' | 'failed'
  publishStatus?: 'pending' | 'published'
} = {}) {
  return {
    id,
    projectId: 'entry-project',
    batchId: 'entry-batch',
    title: '入口测试文章',
    questionPositions: [1],
    contentHtml: '<p>已生成正文</p>',
    generatedAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    writingStatus,
    writingError: null,
    optimizationType: 'brand_intro',
    publishStatus,
    confirmedAt: null,
  }
}

function entryDiagnosis({
  runStatus = 'completed',
  answerCount = 20,
  reportPdfReady = true,
}: {
  runStatus?: 'running' | 'completed'
  answerCount?: number
  reportPdfReady?: boolean
} = {}) {
  return {
    run: { status: runStatus },
    answers: Array.from({ length: answerCount }, () => ({ status: 'success' })),
    reportPdfReady,
  } as unknown as ProjectDetail['initialDiagnosis']
}

function entryProject(overrides: {
  questionsLockedAt?: string | null
  initialDiagnosisStatus?: ProjectDetail['initialDiagnosisStatus']
  initialDiagnosis?: ProjectDetail['initialDiagnosis'] | null
  articleBatches?: ProjectDetail['articleBatches'] | undefined
  monitoringRuns?: ProjectDetail['monitoringRuns'] | undefined
} = {}): ProjectDetail {
  return {
    questionsLockedAt: '2026-09-07T00:00:00.000Z',
    initialDiagnosisStatus: 'completed',
    initialDiagnosis: entryDiagnosis(),
    articleBatches: [],
    monitoringRuns: [],
    ...overrides,
  } as unknown as ProjectDetail
}

function contentAuditRecord(status: ContentAuditRecord['status'], result: ContentAuditRecord['result'] = { scope: 'website_internal', items: [] }): ContentAuditRecord {
  return {
    status,
    startedAt: '2026-09-07T00:00:00.000Z',
    completedAt: status === 'checking' ? null : '2026-09-07T00:01:00.000Z',
    progress: { stage: 'checking', totalPages: 2, processedPages: status === 'checking' ? 1 : 2, totalClaims: result?.items.length ?? 0, processedClaims: status === 'checking' ? 0 : result?.items.length ?? 0 },
    result,
    error: status === 'failed' ? '来源读取失败' : null,
    executionErrors: status === 'failed' ? [{ stage: 'source_fetch', message: '超时' }] : [],
    usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
  }
}

function reloadProjectFixture(): ProjectDetail {
  const answer = {
    position: 1,
    question: '诊断问题1',
    status: 'failed' as const,
    answerText: null,
    citationUrls: [],
    responseModel: null,
    recommended: null,
    officialCitation: null,
    error: '旧回答失败',
    startedAt: '2026-09-07T00:02:00.000Z',
    completedAt: null,
  }
  const run = (id: string, status: 'completed' | 'running' | 'failed', answers: typeof answer[] = []) => ({
    id,
    runType: 'monitoring' as const,
    status,
    requestedModel: 'test-model',
    roundNumber: Number(id.replace(/\D/g, '')) || 1,
    publishedArticleCount: 1,
    startedAt: '2026-09-07T00:00:00.000Z',
    completedAt: status === 'completed' ? '2026-09-07T00:01:00.000Z' : null,
    summaryAnalysis: status === 'completed' ? { results: [] } : null,
    summaryModel: status === 'completed' ? 'test-model' : null,
    summaryError: status === 'failed' ? '旧监测失败' : null,
    recommendationRate: status === 'completed' ? 0.4 : null,
    officialCitationRate: status === 'completed' ? 0.3 : null,
    answers,
  })
  return {
    id: 'reload-project',
    companyName: '刷新归一化公司',
    websiteUrl: 'https://example.test',
    optimizationTarget: '企业服务',
    supplementalInfo: '客户补充信息',
    questionsGeneratedAt: '2026-09-07T00:00:00.000Z',
    questionsLockedAt: null,
    diagnosisStartedAt: '2026-09-07T00:02:00.000Z',
    initialDiagnosisCompletedAt: null,
    initialDiagnosisStatus: 'failed',
    initialRecommendationRate: null,
    initialOfficialCitationRate: null,
    initialDiagnosisAt: '2026-09-07T00:02:00.000Z',
    latestMonitoringAt: '2026-09-06T00:00:00.000Z',
    latestRecommendationRate: 0.4,
    latestOfficialCitationRate: 0.3,
    websiteLockedAt: null,
    websiteCrawlStatus: 'failed',
    websiteCrawlStartedAt: '2026-09-07T00:00:00.000Z',
    websiteCrawlCompletedAt: null,
    websiteCrawlError: '旧官网读取失败',
    websiteCrawlSource: 'links',
    websiteCrawlIncomplete: true,
    websitePagesDiscovered: 4,
    websitePagesSucceeded: 3,
    websitePagesFailed: 1,
    questionsGenerationStatus: 'failed',
    questionsGenerationStartedAt: '2026-09-07T00:01:00.000Z',
    questionsGenerationCompletedAt: null,
    questionsGenerationError: '旧问题生成失败',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-07T00:02:00.000Z',
    websiteCrawl: {
      status: 'failed',
      source: 'links',
      incomplete: true,
      error: '旧官网读取失败',
      discoveredCount: 4,
      successCount: 3,
      failedCount: 1,
      startedAt: '2026-09-07T00:00:00.000Z',
      completedAt: null,
    },
    questionsGeneration: {
      status: 'failed',
      error: '旧问题生成失败',
      startedAt: '2026-09-07T00:01:00.000Z',
      completedAt: null,
    },
    questions: [{ position: 1, question: '已保存问题', generatedAt: '2026-09-07T00:00:00.000Z' }],
    initialDiagnosis: {
      run: {
        id: 'initial-failed',
        runType: 'initial',
        status: 'failed',
        requestedModel: 'test-model',
        roundNumber: 0,
        publishedArticleCount: null,
        startedAt: '2026-09-07T00:02:00.000Z',
        completedAt: null,
        summaryAnalysis: null,
        summaryModel: null,
        summaryError: '旧诊断失败',
        recommendationRate: null,
        officialCitationRate: null,
      },
      answers: [answer],
      reportPdfReady: true,
      reportPdfGeneratedAt: '2026-09-07T00:03:00.000Z',
    },
    monitoringRuns: [run('failed-1', 'failed', [answer]), run('completed-2', 'completed'), run('running-3', 'running', [answer])],
    articleBatches: [{
      id: 'batch-1',
      projectId: 'reload-project',
      requestedModel: 'test-model',
      responseModel: 'test-model',
      generatedAt: '2026-09-07T00:00:00.000Z',
      articles: [{
        id: 'article-failed',
        projectId: 'reload-project',
        batchId: 'batch-1',
        title: '保留标题',
        questionPositions: [1],
        contentHtml: '<p>保留正文</p>',
        generatedAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:02:00.000Z',
        writingStatus: 'failed',
        writingError: '旧写作失败',
        optimizationType: 'FAQ',
        publishStatus: 'pending',
        confirmedAt: null,
      }],
    }],
  } as unknown as ProjectDetail
}

describe('GEO Desk project entry', () => {
  it('renders the project list entry shell', () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('GEO Desk')
    expect(html).toContain('项目列表')
    expect(html).toContain('创建GEO项目')
    expect(html).toContain('搜索公司')
  })

  it('prioritizes scope before questions are locked', () => {
    expect(projectEntryStage(entryProject({ questionsLockedAt: null, articleBatches: [{ articles: [entryArticle({ publishStatus: 'published' })] }] as unknown as ProjectDetail['articleBatches'] }))).toBe('scope')
  })

  it('enters diagnosis when questions are locked but the initial diagnosis is incomplete', () => {
    expect(projectEntryStage(entryProject({ initialDiagnosisStatus: 'running' }))).toBe('diagnosis')
    expect(projectEntryStage(entryProject({ initialDiagnosis: entryDiagnosis({ reportPdfReady: false }) }))).toBe('diagnosis')
    expect(projectEntryStage(entryProject({ initialDiagnosis: entryDiagnosis({ answerCount: 19 }) }))).toBe('diagnosis')
    expect(projectEntryStage(entryProject({ initialDiagnosis: entryDiagnosis({ runStatus: 'running' }) }))).toBe('diagnosis')
  })

  it('enters optimization after a completed diagnosis regardless of article or monitoring history', () => {
    expect(projectEntryStage(entryProject())).toBe('optimization')
    expect(projectEntryStage(entryProject({ articleBatches: undefined }))).toBe('optimization')
    expect(projectEntryStage(entryProject({ articleBatches: [{ articles: [] }] as unknown as ProjectDetail['articleBatches'] }))).toBe('optimization')
    expect(projectEntryStage(entryProject({ articleBatches: [{ articles: [entryArticle()] }] as unknown as ProjectDetail['articleBatches'] }))).toBe('optimization')
    expect(projectEntryStage(entryProject({ articleBatches: [{ articles: [entryArticle({ publishStatus: 'published' })] }] as unknown as ProjectDetail['articleBatches'] }))).toBe('optimization')
    expect(projectEntryStage(entryProject({ articleBatches: [{ articles: [entryArticle({ publishStatus: 'published' })] }, { articles: [entryArticle({ id: 'pending', publishStatus: 'pending' })] }] as unknown as ProjectDetail['articleBatches'] }))).toBe('optimization')
    expect(projectEntryStage(entryProject({ monitoringRuns: [{ status: 'running' }, { status: 'completed' }] as unknown as ProjectDetail['monitoringRuns'] }))).toBe('optimization')
  })

  it('normalizes failed tasks on initial project load without losing saved data or manual actions', () => {
    const failed = reloadProjectFixture()
    const before = structuredClone(failed)
    const normalized = normalizeProjectOnInitialLoad(failed)

    expect(normalized.questions).toEqual(failed.questions)
    expect(normalized.questionsGeneration.status).toBe('not_started')
    expect(normalized.questionsGeneration.error).toBeNull()
    expect(normalized.questionsGeneration.startedAt).toBeNull()
    expect(normalized.questionsGeneration.completedAt).toBeNull()
    expect(normalized.questionsGenerationStatus).toBe('not_started')
    expect(normalized.questionsGenerationError).toBeNull()
    expect(normalized.questionsGenerationStartedAt).toBeNull()
    expect(normalized.questionsGenerationCompletedAt).toBeNull()

    expect(normalized.websiteCrawl.status).toBe('not_started')
    expect(normalized.websiteCrawl.error).toBeNull()
    expect(normalized.websiteCrawl.startedAt).toBeNull()
    expect(normalized.websiteCrawl.completedAt).toBeNull()
    expect(normalized.websiteCrawl.incomplete).toBe(false)
    expect(normalized.websiteCrawlStatus).toBe('not_started')
    expect(normalized.websiteCrawlError).toBeNull()
    expect(normalized.websiteCrawlStartedAt).toBeNull()
    expect(normalized.websiteCrawlCompletedAt).toBeNull()
    expect(normalized.websiteCrawlIncomplete).toBe(false)
    expect(normalized.websitePagesSucceeded).toBe(3)
    expect(normalized.websiteCrawl.successCount).toBe(3)

    expect(normalized.initialDiagnosisStatus).toBe('not_started')
    expect(normalized.diagnosisStartedAt).toBeNull()
    expect(normalized.initialDiagnosisCompletedAt).toBeNull()
    expect(normalized.initialRecommendationRate).toBeNull()
    expect(normalized.initialOfficialCitationRate).toBeNull()
    expect(normalized.initialDiagnosisAt).toBeNull()
    expect(normalized.initialDiagnosis.run).toBeNull()
    expect(normalized.initialDiagnosis.answers).toEqual([])
    expect(normalized.initialDiagnosis.reportPdfReady).toBe(false)
    expect(normalized.initialDiagnosis.reportPdfGeneratedAt).toBeNull()

    expect(normalized.monitoringRuns.map((run) => run.id)).toEqual(['completed-2', 'running-3'])
    expect(normalized.articleBatches[0].articles[0]).toMatchObject({
      title: '保留标题',
      contentHtml: '<p>保留正文</p>',
      writingStatus: 'pending',
      writingError: null,
      publishStatus: 'pending',
    })

    const scopeHtml = renderToStaticMarkup(<MonitoringScope project={normalized} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generationButton = scopeHtml.match(/<button[^>]*>[\s\S]*?<span>重新生成<\/span><\/button>/)?.[0] ?? ''
    expect(generationButton).not.toBe('')
    expect(generationButton).not.toContain('disabled=""')
    expect(scopeHtml).not.toContain('旧问题生成失败')
    expect(scopeHtml).not.toContain('官网读取 3 / 4')

    const diagnosisHtml = renderToStaticMarkup(<DiagnosisReport project={normalized} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    expect(diagnosisHtml).toContain('开始诊断')
    expect(diagnosisHtml).not.toContain('旧诊断失败')
    expect(diagnosisHtml).not.toContain('旧回答失败')
    expect(failed).toEqual(before)
  })

  it('keeps successful and actively running task snapshots unchanged on initial load', () => {
    const base = reloadProjectFixture()
    const active: ProjectDetail = {
      ...base,
      initialDiagnosisStatus: 'running',
      diagnosisStartedAt: '2026-09-07T00:02:00.000Z',
      initialDiagnosisCompletedAt: null,
      initialDiagnosis: {
        ...base.initialDiagnosis,
        run: { ...base.initialDiagnosis.run!, status: 'running', summaryError: null },
        answers: [base.initialDiagnosis.answers[0]],
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
      },
      websiteCrawlStatus: 'crawling',
      websiteCrawlStartedAt: '2026-09-07T00:00:00.000Z',
      websiteCrawlCompletedAt: null,
      websiteCrawlError: null,
      websiteCrawlIncomplete: false,
      websiteCrawl: { ...base.websiteCrawl, status: 'crawling', error: null, incomplete: false },
      questionsGenerationStatus: 'generating',
      questionsGenerationStartedAt: '2026-09-07T00:01:00.000Z',
      questionsGenerationCompletedAt: null,
      questionsGenerationError: null,
      questionsGeneration: { ...base.questionsGeneration, status: 'generating', error: null },
      monitoringRuns: [base.monitoringRuns[1], base.monitoringRuns[2]],
      articleBatches: [{
        ...base.articleBatches[0],
        articles: [{ ...base.articleBatches[0].articles[0], writingStatus: 'writing', writingError: null }],
      }],
    }
    const before = structuredClone(active)
    expect(normalizeProjectOnInitialLoad(active)).toEqual(before)
  })

  it('preserves normal failed AI results when the persisted failed task is present', () => {
    const failed = reloadProjectFixture()
    const normalized = normalizeProjectOnInitialLoad(failed, [
      { id: 'questions-failed', projectId: failed.id, kind: 'questions', targetId: null, status: 'failed', error: '部分问题失败', startedAt: '2026-09-07T00:01:00.000Z', completedAt: '2026-09-07T00:02:00.000Z', result: {} },
      { id: 'diagnosis-failed', projectId: failed.id, kind: 'diagnosis', targetId: null, status: 'failed', error: '部分诊断失败', startedAt: '2026-09-07T00:02:00.000Z', completedAt: '2026-09-07T00:03:00.000Z', result: {} },
      { id: 'monitoring-failed', projectId: failed.id, kind: 'monitoring', targetId: null, status: 'failed', error: '部分监测失败', startedAt: '2026-09-07T00:03:00.000Z', completedAt: '2026-09-07T00:04:00.000Z', result: {} },
      { id: 'article-failed', projectId: failed.id, kind: 'article_body', targetId: 'article-failed', status: 'failed', error: '正文失败', startedAt: '2026-09-07T00:04:00.000Z', completedAt: '2026-09-07T00:05:00.000Z', result: {} },
    ])

    expect(normalized.questionsGeneration.status).toBe('failed')
    expect(normalized.initialDiagnosis.run?.status).toBe('failed')
    expect(normalized.initialDiagnosis.answers).toHaveLength(1)
    expect(normalized.monitoringRuns.some((run) => run.status === 'failed')).toBe(true)
    expect(normalized.articleBatches[0]?.articles[0]?.writingStatus).toBe('failed')
  })

  it('preserves the initial diagnosis snapshot when an independent report task failed', () => {
    const failed = reloadProjectFixture()
    const normalized = normalizeProjectOnInitialLoad(failed, [{
      id: 'diagnosis-report-failed',
      projectId: failed.id,
      kind: 'diagnosis_report',
      targetId: null,
      status: 'failed',
      error: '报告汇总失败',
      startedAt: '2026-09-07T00:03:00.000Z',
      completedAt: '2026-09-07T00:04:00.000Z',
      result: {},
    }])

    expect(normalized.initialDiagnosis.run?.status).toBe('failed')
    expect(normalized.initialDiagnosis.answers).toEqual(failed.initialDiagnosis.answers)
    expect(normalized.initialDiagnosis.reportPdfReady).toBe(true)
    expect(normalized.initialDiagnosis.reportPdfGeneratedAt).toBe('2026-09-07T00:03:00.000Z')
  })

  it('trusts an empty task list after startup cleanup and keeps a failed report run retryable', () => {
    const base = reloadProjectFixture()
    const answers = Array.from({ length: 20 }, (_, index) => ({
      ...base.initialDiagnosis.answers[0],
      position: index + 1,
      question: `诊断问题${index + 1}`,
      status: 'success' as const,
      answerText: `回答${index + 1}`,
      responseModel: 'test-model',
      recommended: index % 2 === 0,
      officialCitation: index % 3 === 0,
      error: null,
      completedAt: '2026-09-07T00:03:00.000Z',
    }))
    const project = {
      ...base,
      questionsLockedAt: '2026-09-07T00:01:00.000Z',
      initialDiagnosisCompletedAt: null,
      initialDiagnosisStatus: 'failed' as const,
      initialDiagnosis: {
        ...base.initialDiagnosis,
        run: {
          ...base.initialDiagnosis.run!,
          runType: 'initial' as const,
          status: 'failed' as const,
          summaryAnalysis: null,
          summaryModel: null,
          summaryError: '汇总失败，请重试',
          recommendationRate: null,
          officialCitationRate: null,
        },
        answers,
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
      },
    } as unknown as ProjectDetail

    const normalized = normalizeProjectOnInitialLoad(project, [])
    expect(normalized.initialDiagnosis.run?.status).toBe('failed')
    expect(normalized.initialDiagnosis.run?.summaryError).toBe('汇总失败，请重试')
    expect(normalized.initialDiagnosis.answers).toHaveLength(20)
    expect(normalized.initialDiagnosis.answers.every((answer) => answer.status === 'success')).toBe(true)
    expect(normalized.initialDiagnosisCompletedAt).toBeNull()
    expect(projectEntryStage(normalized)).toBe('diagnosis')

    const html = renderToStaticMarkup(<DiagnosisReport project={normalized} busy={false} actionError="" progress={null} onStart={() => undefined} onRetrySummary={() => undefined} />)
    expect(html).toContain('重试汇总')
    expect(html).not.toContain('开始诊断')
    expect(html).not.toContain('继续诊断')
  })

  it('keeps a persisted failed content audit visible even when no task row remains', () => {
    const failed = contentAuditRecord('failed')
    const checking = contentAuditRecord('checking')

    expect(normalizeContentAuditRecordForLoad(failed, true)).toBe(failed)
    expect(normalizeContentAuditRecordForLoad(failed, true, true)).toBe(failed)
    expect(normalizeContentAuditRecordForLoad(failed, false)).toBe(failed)
    expect(normalizeContentAuditRecordForLoad(checking, true)).toBe(checking)
    expect(failed.status).toBe('failed')
  })

  it('reads task progress without requiring a task-detail snapshot', () => {
    const task = {
      id: 'diagnosis-progress',
      projectId: 'progress-project',
      kind: 'diagnosis',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-07T00:00:00.000Z',
      completedAt: null,
      result: { progress: { position: 3, status: 'failed', completedCount: 2, failedCount: 1, total: 20 } },
    } as const
    expect(aiTaskProgressForDisplay(task)).toEqual({ completedCount: 2, failedCount: 1, total: 20 })
    expect(questionGenerationTaskProgress({
      ...task,
      id: 'questions-progress',
      kind: 'questions',
      result: { progress: { completedCount: 1, failedCount: 0, total: 2, questions: [{ question: '问题', category: 'recommendation' }] } },
    })).toEqual({ completedCount: 1, failedCount: 0, total: 2, questions: [{ question: '问题', category: 'recommendation' }] })
    expect(aiTaskProgressForDisplay({ ...task, status: 'failed' })).toBeNull()
  })

  it('keeps an open questions observer keyed after polling changes the task to terminal', () => {
    const running = {
      id: 'questions-stream-task', projectId: 'progress-project', kind: 'questions', targetId: null,
      status: 'running', error: null, startedAt: '2026-09-07T00:00:00.000Z', completedAt: null, result: {},
    } as unknown as AiTask
    const completed = { ...running, status: 'completed', completedAt: '2026-09-07T00:00:01.000Z' } as AiTask

    expect(questionTaskIdForObservation([running], null)).toBe(running.id)
    // The running -> completed poll update must not make the effect lose its
    // task id and abort the stream before its complete event is read.
    expect(questionTaskIdForObservation([completed], running.id)).toBe(running.id)
    expect(questionTaskIdForObservation([completed], null)).toBeNull()
  })

  it('does not key the questions observer effect to locale changes', () => {
    // Structural regression only: this inspects the hook declaration rather
    // than simulating React lifecycle cleanup or an in-flight stream.
    const observerStart = appSource.indexOf('useEffect(() =>', appSource.indexOf('const runningQuestionTaskId ='))
    const observerEnd = appSource.indexOf('\n\n  const refreshContentAudit =', observerStart)
    const observerSource = observerStart >= 0 && observerEnd > observerStart
      ? appSource.slice(observerStart, observerEnd)
      : ''

    expect(observerSource).toContain('observeQuestionGenerationTask')
    expect(observerSource).toContain('}, [project?.id, runningQuestionTaskId])')
    expect(observerSource).not.toContain('locale')
  })

  it('keys content-audit polling to a stable task and stops only at the current terminal run', () => {
    const running = {
      id: 'content-audit-task', projectId: 'progress-project', kind: 'content_audit', targetId: null,
      status: 'running', error: null, startedAt: '2026-09-07T00:00:01.000Z', completedAt: null, result: {},
    } as unknown as AiTask
    const progressUpdate = { ...running, result: { progress: { processedPages: 1, totalPages: 2 } } } as AiTask
    const previousCompleted = { status: 'completed' as const, startedAt: '2026-09-07T00:00:00.000Z' }
    const currentChecking = { status: 'checking' as const, startedAt: running.startedAt }
    const currentCompleted = { status: 'completed' as const, startedAt: running.startedAt }
    const currentFailed = { status: 'failed' as const, startedAt: running.startedAt }

    expect(contentAuditTaskForPolling([running])).toBe(running)
    expect(contentAuditTaskForPolling([progressUpdate])?.id).toBe(running.id)
    expect(contentAuditPollingNeeded(previousCompleted, running)).toBe(true)
    expect(contentAuditPollingNeeded(currentChecking, running)).toBe(true)
    expect(contentAuditPollingNeeded(currentCompleted, running)).toBe(false)
    expect(contentAuditPollingNeeded(currentFailed, running)).toBe(false)
    expect(contentAuditPollingNeeded(null, running)).toBe(true)
    expect(contentAuditPollingNeeded(currentCompleted, null)).toBe(false)
  })

  it('keeps one-second polling through progress snapshots and stops after the terminal snapshot', async () => {
    vi.useFakeTimers()
    try {
      const interval = 1_000
      const running = {
        id: 'content-audit-clock-task', projectId: 'progress-project', kind: 'content_audit', targetId: null,
        status: 'running', error: null, startedAt: '2026-09-07T00:00:01.000Z', completedAt: null, result: {},
      } as unknown as AiTask
      const taskSnapshots = [
        { ...running, result: { progress: { processedPages: 18, totalPages: 20 } } },
        { ...running, result: { progress: { processedPages: 19, totalPages: 20 } } },
        { ...running, status: 'completed' as const, completedAt: '2026-09-07T00:00:03.000Z' },
      ] as AiTask[]
      const auditSnapshots = [
        { status: 'checking' as const, startedAt: running.startedAt, progress: 18 },
        { status: 'checking' as const, startedAt: running.startedAt, progress: 19 },
        { status: 'completed' as const, startedAt: running.startedAt, progress: 'completed' },
      ]
      const fetched: Array<number | string> = []
      let pollIndex = 0
      const poll = (): void => {
        const task = contentAuditTaskForPolling([taskSnapshots[pollIndex]!])
        const record = auditSnapshots[pollIndex++]!
        fetched.push(record.progress)
        if (contentAuditPollingNeeded(record, task)) setTimeout(poll, interval)
      }

      setTimeout(poll, interval)
      await vi.advanceTimersByTimeAsync(interval)
      await vi.advanceTimersByTimeAsync(interval)
      await vi.advanceTimersByTimeAsync(interval)
      await vi.advanceTimersByTimeAsync(interval * 2)

      expect(fetched).toEqual([18, 19, 'completed'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows deletion only in the edit modal and does not call the API when confirmation is cancelled', async () => {
    const project = {
      id: '9',
      companyName: '待删除公司',
      websiteUrl: null,
      optimizationTarget: null,
      supplementalInfo: null,
      diagnosisStartedAt: null,
      websiteLockedAt: null,
    } as unknown as ProjectDetail
    const editHtml = renderToStaticMarkup(
      <ProjectFormModal project={project} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />,
    )
    const createHtml = renderToStaticMarkup(
      <ProjectFormModal project={null} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />,
    )

    expect(editHtml).toContain('删除')
    expect(createHtml).not.toContain('删除')

    let deleteCalls = 0
    const deleted = await confirmAndDeleteProject('待删除公司', () => false, async () => { deleteCalls += 1 })
    expect(deleted).toBe(false)
    expect(deleteCalls).toBe(0)
  })

  it('renders the same collapsed supplemental-info guidance in create and edit forms', () => {
    const project = {
      id: 'guided-edit',
      companyName: '已有资料公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '企业服务',
      supplementalInfo: '已有补充信息',
    } as unknown as ProjectDetail
    const createHtml = renderToStaticMarkup(
      <ProjectFormModal project={null} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />,
    )
    const editHtml = renderToStaticMarkup(
      <ProjectFormModal project={project} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />,
    )

    for (const html of [createHtml, editHtml]) {
      expect(html).toContain('补充信息（选填，建议填写）')
      expect(html).toContain('id="supplemental-info-guidance"')
      expect(html.indexOf('for="supplemental-info"')).toBeLessThan(html.indexOf('id="supplemental-info-guidance"'))
      expect(html.indexOf('id="supplemental-info-guidance"')).toBeLessThan(html.indexOf('<textarea'))
      expect(html).toContain('aria-describedby="supplemental-info-guidance"')
      expect(html).toContain('主营业务：重点推广哪些产品或服务？')
      expect(html).toContain('目标客户：主要服务哪类客户？服务哪些地区？')
      expect(html).toContain('常见咨询：客户购买前通常会问什么？建议列出 2—3 个真实问题。')
      expect(html).toContain('补充事实：有哪些可核实的案例、资质或产品特点？没有可不填。')
      expect(html).toContain('<details class="project-form-modal__supplemental-example"><summary>查看填写示例</summary>')
      expect(html).not.toMatch(/<details[^>]*\bopen(?:="")?>/)
      expect(html).not.toContain('以下为虚构示例，请按实际情况填写')
      expect(html).toContain('我们主要提供工业冷水机，重点推广激光加工配套机型')
      expect(html).not.toContain('id="supplemental-info-reminder"')
      expect(html).toContain('请简述主营业务、目标客户和常见咨询，帮助生成监测问题与诊断提纲。不清楚的可跳过；内容应真实可核实，避免宣传用语，勿含个人信息或商业机密。')
      expect(html).not.toContain('AI只使用你填写的信息，不会自行查找或猜测客户官网。')
    }

    const createTextarea = createHtml.match(/<textarea[\s\S]*?<\/textarea>/)?.[0] ?? ''
    const editTextarea = editHtml.match(/<textarea[\s\S]*?<\/textarea>/)?.[0] ?? ''
    expect(createTextarea).toMatch(/><\/textarea>$/)
    expect(editTextarea).toContain('>已有补充信息</textarea>')
    expect(createTextarea).not.toContain('工业冷水机')
    expect(editTextarea).not.toContain('工业冷水机')
  })

  it('normalizes editable project values without treating surrounding whitespace as a reset', () => {
    const original = { companyName: '测试公司', websiteUrl: 'https://example.test', optimizationTarget: '企业服务', supplementalInfo: '补充说明' }
    expect(normalizeProjectFormValues({ companyName: '  测试公司 ', websiteUrl: ' https://example.test ', optimizationTarget: ' 企业服务 ', supplementalInfo: ' 补充说明 ' })).toEqual(original)
    expect(projectFormValuesEqual(original, { ...original, companyName: ' 测试公司 ' })).toBe(true)
    expect(projectFormValuesEqual(original, { ...original, supplementalInfo: '新的补充说明' })).toBe(false)
  })

  it('validates website URLs before a destructive project reset', () => {
    expect(projectWebsiteValidationError('')).toBeNull()
    expect(projectWebsiteValidationError('https://example.test/path')).toBeNull()
    expect(projectWebsiteValidationError('ftp://example.test')).toBe('客户官网必须是HTTP或HTTPS地址')
    expect(projectWebsiteValidationError('https://user:password@example.test')).toBe('客户官网必须是HTTP或HTTPS地址')
  })

  it('does not ask to clear an empty question outline, but keeps the confirmation for existing questions', () => {
    const project = {
      companyName: '原公司',
      websiteUrl: null,
      optimizationTarget: null,
      supplementalInfo: null,
      questions: [],
    } as unknown as ProjectDetail
    const changed = { companyName: '新公司', websiteUrl: 'https://example.test', optimizationTarget: '', supplementalInfo: '' }
    expect(shouldClearUnconfirmedOutline(project, changed, false)).toBe(false)
    expect(shouldClearUnconfirmedOutline({ ...project, questions: [{ question: '已有问题' }] } as unknown as ProjectDetail, changed, false)).toBe(true)
    expect(shouldClearUnconfirmedOutline({ ...project, questions: [{ question: '已有问题' }] } as unknown as ProjectDetail, changed, true)).toBe(false)
  })

  it('locks the three project fields after confirmation and permits one website fill', () => {
    const lockedWithoutWebsite = {
      id: 'locked-website-fill',
      companyName: '锁定后只可补填官网',
      websiteUrl: null,
      optimizationTarget: '企业服务',
      supplementalInfo: '补充信息',
      questionsLockedAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    } as unknown as ProjectDetail
    const fillHtml = renderToStaticMarkup(<ProjectFormModal project={lockedWithoutWebsite} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />)
    expect(fillHtml).toContain('补填客户官网')
    expect(fillHtml).toContain('保存官网')
    expect(fillHtml).toMatch(/id="company-name"[^>]*disabled=""/)
    expect(fillHtml).toMatch(/id="optimization-target"[^>]*disabled=""/)
    expect(fillHtml).toMatch(/id="supplemental-info"[^>]*disabled=""/)
    expect(fillHtml).toMatch(/id="website-url"[^>]*>/)
    expect(fillHtml).not.toMatch(/id="website-url"[^>]*disabled=""/)

    const lockedWithWebsite = { ...lockedWithoutWebsite, websiteUrl: 'https://example.test' } as unknown as ProjectDetail
    const readOnlyHtml = renderToStaticMarkup(<ProjectFormModal project={lockedWithWebsite} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />)
    expect(readOnlyHtml).toContain('编辑项目信息')
    expect(readOnlyHtml).toMatch(/id="company-name"[^>]*disabled=""/)
    expect(readOnlyHtml).toMatch(/id="website-url"[^>]*disabled=""/)
    expect(readOnlyHtml).toMatch(/class="button button--primary"[^>]*disabled=""/)
    expect(appSource).toContain("t('form.confirmWebsite')")
    expect(appSource).toContain('focusManagement')
    expect(appSource).not.toContain('修改资料并清空项目数据？')
  })

  it('restores mounted async guards after StrictMode effect replay', () => {
    expect(appSource).toContain('mountedRef.current = true')
    expect(appSource).toContain('mountedRef.current = false')
    expect(appSource).toContain('liveProjectRef.current = project')
    expect(appSource).toContain('liveProjectRef.current = null')
  })

  it('renders the four stages in the required order', () => {
    const html = renderToStaticMarkup(
      <PhaseNav
        active="scope"
        states={{ scope: 'available', diagnosis: 'disabled', optimization: 'disabled', monitoring: 'disabled' }}
        onSelect={() => undefined}
      />,
    )

    expect(html).toContain('phase-nav')
    let previousIndex = -1
    for (const stage of stages) {
      const index = html.indexOf(stage.label)
      expect(index).toBeGreaterThan(previousIndex)
      previousIndex = index
    }
  })

  it('opens the website-fill editor from completed optimization without a website', () => {
    const completeWithoutWebsite = {
      id: 'optimization-entry-without-website',
      companyName: '待补官网公司',
      websiteUrl: null,
      questionsLockedAt: '2026-09-08T00:00:00.000Z',
      initialDiagnosisStatus: 'completed',
      initialDiagnosis: {
        run: { id: 'optimization-entry-run', runType: 'initial', status: 'completed' },
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' })),
        reportPdfReady: true,
      },
      questions: [],
      questionsGeneration: { status: 'completed' },
      websiteCrawl: { status: 'not_started', incomplete: false },
    } as unknown as ProjectDetail
    const completeWithWebsite = { ...completeWithoutWebsite, id: 'optimization-entry-with-website', websiteUrl: 'https://example.test' } as unknown as ProjectDetail
    const incomplete = { ...completeWithoutWebsite, id: 'optimization-entry-incomplete', initialDiagnosisStatus: 'running' } as unknown as ProjectDetail

    expect(stageStates(completeWithoutWebsite)).toMatchObject({ optimization: 'available', monitoring: 'disabled' })
    expect(stageStates(completeWithWebsite)).toMatchObject({ optimization: 'available', monitoring: 'available' })
    expect(stageStates(incomplete)).toMatchObject({ optimization: 'disabled', monitoring: 'disabled' })

    const html = renderToStaticMarkup(<ProjectWorkspace project={completeWithoutWebsite} projectState="ready" onRetry={() => undefined} onEdit={() => undefined} onUpdated={() => undefined} />)
    const optimizationButton = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].find((match) => match[0].includes('优化建议'))?.[0] ?? ''
    expect(optimizationButton).not.toContain('disabled=""')
    expect(html).not.toContain('optimization-stage')
    expect(appSource).toContain("if (stage === 'optimization' && project && isInitialDiagnosisComplete(project) && !project.websiteUrl)")
    expect(appSource).toContain("onEdit(undefined, () => setActiveStage('optimization'))")
  })

  it('consumes the optimization follow-up only after a matching project save', () => {
    const calls: string[] = []
    let pending: { projectId: string; onSaved: () => void } | null = { projectId: 'follow-up-project', onSaved: () => calls.push('optimization') }
    const save = (modalProjectId: string, savedProjectId: string) => {
      const callback = pendingProjectSaveCallback(pending, modalProjectId, savedProjectId)
      pending = null
      callback?.()
    }

    save('follow-up-project', 'follow-up-project')
    save('follow-up-project', 'follow-up-project')
    expect(calls).toEqual(['optimization'])

    let cancelledCalls = 0
    const cancelled = { projectId: 'cancelled-project', onSaved: () => { cancelledCalls += 1 } }
    expect(pendingProjectSaveCallback(cancelled, 'cancelled-project', 'other-project')).toBeNull()
    expect(cancelledCalls).toBe(0)

    let ordinaryCalls = 0
    const ordinary = { projectId: 'ordinary-project', onSaved: () => { ordinaryCalls += 1 } }
    expect(pendingProjectSaveCallback(ordinary, 'ordinary-project', 'ordinary-project')).toBeTypeOf('function')
    expect(ordinaryCalls).toBe(0)
    expect(appSource).toContain('pendingProjectSaveRef.current = null')
    expect(appSource).toContain('const openEdit = (initialValues?: Partial<ProjectFormValues>, onSaved?: () => void)')
  })

  it('keeps the project pipeline and stage content in separate layout layers', () => {
    const project = {
      id: 'structure-project',
      companyName: '结构测试公司',
      questionsLockedAt: null,
      initialDiagnosisCompletedAt: null,
      websiteUrl: null,
      questions: [],
      questionsGeneration: { status: 'not_started' },
      websiteCrawl: { status: 'not_started', incomplete: false },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(
      <ProjectWorkspace
        project={project}
        projectState="ready"
        onRetry={() => undefined}
        onEdit={() => undefined}
        onUpdated={() => undefined}
      />,
    )

    expect(html).toContain('<main class="page-content workspace-page">')
    expect(html).toContain('<div class="workspace-pipeline"><nav class="phase-nav"')
    expect(html).toContain('<div class="workspace-stage-viewport"><section class="scope-stage"')
    expect(html.indexOf('workspace-pipeline')).toBeLessThan(html.indexOf('workspace-stage-viewport'))
    expect(html.indexOf('phase-nav')).toBeLessThan(html.indexOf('scope-stage'))
  })

  it('keeps action errors isolated to the stage that produced them', () => {
    const errors = {
      scope: '问题生成失败',
      diagnosis: '豆包请求超时',
      optimization: '官网读取失败',
      monitoring: '监测失败',
    }

    expect(stageActionError(errors, 'scope')).toBe('问题生成失败')
    expect(stageActionError(errors, 'diagnosis')).toBe('豆包请求超时')
    expect(stageActionError(errors, 'optimization')).toBe('官网读取失败')
    expect(stageActionError(errors, 'monitoring')).toBe('监测失败')
    expect(stageActionError({ diagnosis: errors.diagnosis }, 'optimization')).toBe('')
  })


  it('starts diagnosis with the project returned after question confirmation', async () => {
    const confirmed = { id: 'confirmed-project' } as unknown as ProjectDetail
    const calls: string[] = []
    await confirmAndStartDiagnosis(
      'draft-project',
      '2026-09-08T07:00:00.000Z',
      (project) => calls.push(`confirmed:${project.id}`),
      undefined,
      {
        confirm: async (id, expectedUpdatedAt) => {
          calls.push(`confirm:${id}:${expectedUpdatedAt}`)
          return confirmed
        },
        start: async (id) => {
          calls.push(`start:${id}`)
          return confirmed
        },
      },
    )

    expect(calls).toEqual(['confirm:draft-project:2026-09-08T07:00:00.000Z', 'confirmed:confirmed-project', 'start:confirmed-project'])
  })

  it('shows the monitoring scope question list and crawl summary', () => {
    const project = {
      id: '1',
      companyName: '示例科技有限公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '企业数字化服务',
      supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z',
      questionsLockedAt: null,
      diagnosisStartedAt: null,
      initialDiagnosisCompletedAt: null,
      websiteLockedAt: null,
      websiteCrawlStatus: 'completed',
      websiteCrawlStartedAt: null,
      websiteCrawlCompletedAt: '2026-09-04T00:00:00.000Z',
      websiteCrawlError: null,
      websiteCrawlSource: 'links',
      websiteCrawlIncomplete: false,
      websitePagesDiscovered: 2,
      websitePagesSucceeded: 2,
      websitePagesFailed: 0,
      questionsGenerationStatus: 'completed',
      questionsGenerationStartedAt: null,
      questionsGenerationCompletedAt: '2026-09-04T00:00:00.000Z',
      questionsGenerationError: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      websiteCrawl: { status: 'completed', source: 'links', incomplete: false, error: null, discoveredCount: 2, successCount: 2, failedCount: 0, startedAt: null, completedAt: '2026-09-04T00:00:00.000Z' },
      questionsGeneration: { status: 'completed', error: null, startedAt: null, completedAt: '2026-09-04T00:00:00.000Z' },
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
    } as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('诊断提纲')
    expect(html).toContain('确认并开始诊断')
    expect(html).toContain('本次生成依据')
    expect(html).toContain('客户官网')
    expect(html).not.toContain('官网读取')
    expect(html).not.toContain('已保存 2 页官网资料')
    const scopeSidebar = html.match(/<aside class="scope-sidebar">([\s\S]*?)<\/aside>/)?.[1] ?? ''
    expect(scopeSidebar).not.toContain('正在保存官网资料，请稍候…')
    expect(html).toContain('class="scope-facts__supplemental-info">未提供</strong>')
    expect(html).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    const questionHeader = html.match(/<div class="operation-bar question-card__header">([\s\S]*?)<div class="question-card__tools">/)?.[1] ?? ''
    expect(questionHeader).toContain('诊断提纲')
    expect(questionHeader).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    const headerIndex = html.indexOf('<div class="operation-bar question-card__header">')
    const cardIndex = html.indexOf('<section class="question-card">')
    const scopeMainBeforeCard = html.match(/<div class="scope-main">([\s\S]*?)<section class="question-card">/)?.[1] ?? ''
    const cardHtml = html.slice(cardIndex, html.indexOf('</section>', cardIndex))
    expect(headerIndex).toBeGreaterThanOrEqual(0)
    expect(cardIndex).toBeGreaterThan(headerIndex)
    expect(scopeMainBeforeCard).toMatch(/^<div class="operation-bar question-card__header">/)
    expect(cardHtml).not.toContain('question-card__header')
    expect(html).not.toContain('；已锁定题集保持不变。')
    const lockCard = html.match(/<section class="scope-lock-card">([\s\S]*?)<\/section>/)?.[1] ?? ''
    const lockHeader = lockCard.match(/<div class="scope-lock-card__header">([\s\S]*?)<\/div>/)?.[1] ?? ''
    expect(lockHeader).toContain('开始诊断后将锁定')
    expect(lockCard.indexOf('开始诊断后将锁定')).toBeLessThan(lockCard.indexOf('<p>后续监测始终复用'))

    const longSupplementalInfo = '第一行补充说明：这是需要完整展示的长文本。\n第二行补充说明：这里保留换行并继续展示更多内容。'
    const longHtml = renderToStaticMarkup(<MonitoringScope project={{ ...project, supplementalInfo: longSupplementalInfo } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(longHtml).toContain('class="scope-facts__supplemental-info">')
    expect(longHtml).toContain('第一行补充说明：这是需要完整展示的长文本。')
    expect(longHtml).toContain('第二行补充说明：这里保留换行并继续展示更多内容。')
    expect(appCss).toMatch(/\.scope-facts \.scope-facts__supplemental-info \{[\s\S]*?overflow: visible;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?text-overflow: clip;[\s\S]*?white-space: pre-wrap;/)
  })

  it('renders per-question lock and delete controls with legacy-category protection', () => {
    const project = {
      id: 'question-controls', companyName: '题目操作公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'completed', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [
        { id: 'q-1', position: 1, question: '推荐问题', generatedAt: '', category: 'recommendation', isLocked: false },
        { id: 'q-2', position: 2, question: '已锁定问题', generatedAt: '', category: 'selection', isLocked: true },
        { id: 'q-3', position: 3, question: '决策问题', generatedAt: '', category: 'decision', isLocked: false },
      ],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('aria-label="锁定第1题，重新生成时保留"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="删除第1题"')
    expect(html).toContain('aria-label="解锁第2题"')
    expect(html).toContain('aria-label="删除第2题（当前已锁定）"')
    expect(html).toContain('question-list__lock-button--active')
    expect(html).toContain('aria-label="3个监测问题"')
    const headerHtml = html.match(/<div class="question-list__header"[\s\S]*?<\/div>/)?.[0] ?? ''
    const headerLabels = ['序号', '问题清单', '类别', '锁定', '删除']
    let previousHeaderIndex = -1
    for (const label of headerLabels) {
      const index = headerHtml.indexOf(label)
      expect(index).toBeGreaterThan(previousHeaderIndex)
      previousHeaderIndex = index
    }
    const questionList = html.match(/<ol class="question-list"[\s\S]*?<\/ol>/)?.[0] ?? ''
    const firstQuestion = questionList.match(/<li[\s\S]*?<\/li>/)?.[0] ?? ''
    expect(firstQuestion).toContain('question-index">1</span>')
    expect(firstQuestion).toContain('question-list__text">推荐问题</span>')
    expect(firstQuestion).toContain('question-list__category">推荐类</span>')
    const firstColumnClasses = ['question-index', 'question-list__text', 'question-list__category', 'question-list__lock-button', 'question-list__delete-button']
    let previousColumnIndex = -1
    for (const className of firstColumnClasses) {
      const index = firstQuestion.indexOf(className)
      expect(index).toBeGreaterThan(previousColumnIndex)
      previousColumnIndex = index
    }
    expect(questionList.match(/lucide-lock-keyhole-open/g)).toHaveLength(2)
    expect(questionList.match(/lucide-lock-keyhole(?!-open)/g)).toHaveLength(1)

    const legacyHtml = renderToStaticMarkup(<MonitoringScope project={{ ...project, questions: [{ ...project.questions[0], category: null }] } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(legacyHtml).not.toContain('当前题集缺少完整分类，请先完整重新生成一次后再逐题锁定或删除。')
    expect(legacyHtml).toContain('question-list__category">未分类</span>')
    expect(legacyHtml).toMatch(/aria-label="锁定第1题，重新生成时保留"[^>]*disabled=""/)
    expect(legacyHtml).toMatch(/aria-label="删除第1题"[^>]*disabled=""/)

    const confirmedLegacyHtml = renderToStaticMarkup(<MonitoringScope project={{ ...project, questionsLockedAt: '2026-09-05T00:00:00.000Z', questions: [{ ...project.questions[0], category: null }] } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(confirmedLegacyHtml).not.toContain('请先完整重新生成一次')
    expect(questionCategoryLabel('unexpected')).toBe('未分类')
  })

  it('blocks regeneration only when all twenty individual questions are locked', () => {
    const project = {
      id: 'all-questions-locked', companyName: '全锁公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'completed', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: Array.from({ length: 20 }, (_, index) => ({ id: `q-${index + 1}`, position: index + 1, question: `问题${index + 1}`, generatedAt: '', category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision', isLocked: true })),
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generationButton = html.match(/<button[^>]*>[\s\S]*?<span>重新生成<\/span><\/button>/)?.[0] ?? ''

    expect(generationButton).toContain('disabled=""')
    expect(html).toContain('全部问题已锁定，请先解锁需要更新的问题')
    expect(html).toContain('确认并开始诊断')
  })

  it('places question generation progress between the heading and actions', () => {
    const project = {
      id: 'question-generating', companyName: '生成中公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: Array.from({ length: 20 }, (_, index) => ({ id: `q-${index + 1}`, position: index + 1, question: `问题${index + 1}`, generatedAt: '', category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision', isLocked: false })),
    } as unknown as ProjectDetail
    const generatingHtml = renderToStaticMarkup(<MonitoringScope project={project} busy generating actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const titleIndex = generatingHtml.indexOf('诊断提纲')
    const mixIndex = generatingHtml.indexOf('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    const progressIndex = generatingHtml.indexOf('正在生成问题，请稍候…')
    const toolsIndex = generatingHtml.indexOf('<div class="question-card__tools">')
    const generatingButton = generatingHtml.match(/<button[\s\S]*?<span>生成中…<\/span><\/button>/)?.[0] ?? ''

    expect(generatingHtml).toContain('question-card__header--generating')
    expect(generatingButton).toContain('button--generating')
    expect(generatingHtml.match(/正在生成问题，请稍候…/g)).toHaveLength(1)
    expect(titleIndex).toBeGreaterThanOrEqual(0)
    expect(mixIndex).toBeGreaterThan(titleIndex)
    expect(progressIndex).toBeGreaterThan(mixIndex)
    expect(progressIndex).toBeLessThan(toolsIndex)

    const completedGeneratingHtml = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationProgress={{ completedCount: 20, total: 20, questions: [] }}
      generationLockedQuestions={[]}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    const generationWrapperIndex = completedGeneratingHtml.indexOf('question-generation-progress')
    const checkingIndex = completedGeneratingHtml.indexOf('正在校验…')
    const generationBarIndex = completedGeneratingHtml.indexOf('question-generation-progress__bar')
    expect(completedGeneratingHtml).toContain('已生成 <strong>20 / 20</strong>')
    expect(completedGeneratingHtml.match(/正在校验…/g)).toHaveLength(1)
    expect(generationWrapperIndex).toBeGreaterThanOrEqual(0)
    expect(checkingIndex).toBeGreaterThan(generationWrapperIndex)
    expect(checkingIndex).toBeLessThan(generationBarIndex)

    const idleHtml = renderToStaticMarkup(<MonitoringScope project={{ ...project, questionsGeneration: { status: 'completed', error: null } } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(idleHtml).not.toContain('正在生成问题，请稍候…')
    const idleButton = idleHtml.match(/<button[\s\S]*?<span>生成问题<\/span><\/button>/)?.[0] ?? ''
    expect(idleButton).not.toContain('button--generating')
  })

  it('animates only the question-generation refresh icon and honors reduced motion', () => {
    const animationRules = cssRulesForClass(appCss, 'button--generating').join('\n')
    expect(animationRules).toContain('transform-origin: center;')
    expect(animationRules).toContain('animation: button-generating-spin 1s linear infinite;')
    expect(appCss).toContain('@keyframes button-generating-spin')
    expect(appCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.button--generating \.button__icon svg[\s\S]*?animation:\s*none;/)
  })

  it('shows only the current preview while regenerating', () => {
    const project = {
      id: 'question-draft', companyName: '增量题集公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [
        { id: 'q-2', position: 2, question: '保留的锁定问题', generatedAt: '', category: 'selection', isLocked: true },
        { id: 'q-4', position: 4, question: '旧的未锁定问题', generatedAt: '', category: 'decision', isLocked: false },
      ],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationToken={7}
      generationLockedQuestions={[project.questions[0]]}
      generationProgress={{ completedCount: 1, total: 1, questions: [{ question: '本次新增问题', category: 'recommendation' }] }}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)

    expect(html).toContain('已生成 <strong>1 / 19</strong>')
    expect(html).not.toContain('正在生成问题，请稍候…')
    expect(html).toContain('保留的锁定问题')
    expect(html).not.toContain('旧的未锁定问题')
    expect(html).toContain('<section class="question-card">')
    expect(html).not.toContain('question-generation-preview')
    expect(html).toContain('本次新增问题')
    expect(html).toContain('aria-valuenow="1"')
    const questionList = html.match(/<ol class="question-list"[\s\S]*?<\/ol>/)?.[0] ?? ''
    expect(questionList.match(/class="question-list__item/g)).toHaveLength(2)
    expect([...questionList.matchAll(/class="question-index">(\d+)<\/span>/g)].map((match) => Number(match[1]))).toEqual([1, 2])
    expect(questionList).toContain('aria-label="解锁第2题"')
    expect(questionList).toContain('本次新增问题')
    expect(questionList).not.toContain('旧的未锁定问题')
    expect(questionList).toMatch(/aria-label="解锁第2题"[^>]*disabled=""/)
    expect(questionList).toMatch(/aria-label="锁定第1题，重新生成时保留"[^>]*disabled=""/)
  })

  it('keeps locked rows visible when generation progress is zero', () => {
    const lockedQuestion = { id: 'q-3', position: 3, question: '进度为零时仍保留的锁定问题', generatedAt: '', category: 'selection' as const, isLocked: true }
    const project = {
      id: 'question-preview-zero', companyName: '零进度公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [lockedQuestion, { id: 'q-4', position: 4, question: '应隐藏的旧未锁定问题', generatedAt: '', category: 'decision', isLocked: false }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationLockedQuestions={[lockedQuestion]}
      generationProgress={{ completedCount: 0, total: 19, questions: [] }}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)

    expect(html).toContain('进度为零时仍保留的锁定问题')
    expect(html).not.toContain('应隐藏的旧未锁定问题')
    expect(html).toContain('<section class="question-card">')
    const questionList = html.match(/<ol class="question-list"[\s\S]*?<\/ol>/)?.[0] ?? ''
    expect(questionList.match(/class="question-list__item/g)).toHaveLength(1)
    expect(questionList).toContain('class="question-index">3</span>')
    expect(questionList).toContain('aria-label="解锁第3题"')
  })

  it('restores every original question and lock state after generation failure', () => {
    const originalQuestions = [
      { id: 'q-1', position: 1, question: '失败后恢复的锁定问题', generatedAt: '', category: 'recommendation', isLocked: true },
      { id: 'q-2', position: 2, question: '失败后恢复的未锁定问题', generatedAt: '', category: 'selection', isLocked: false },
    ]
    const project = {
      id: 'question-preview-failed', companyName: '失败恢复公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'failed', error: '本次生成失败' },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: originalQuestions,
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('失败后恢复的锁定问题')
    expect(html).toContain('失败后恢复的未锁定问题')
    expect(html).toContain('aria-label="解锁第1题"')
    expect(html).toContain('aria-label="锁定第2题，重新生成时保留"')
    expect(html).not.toContain('question-generation-preview')
  })

  it('shows the complete formal result after generation succeeds', () => {
    const project = {
      id: 'question-preview-completed', companyName: '成功替换公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-10T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'completed', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [
        { id: 'new-q-1', position: 1, question: '成功保存的新问题', generatedAt: '', category: 'recommendation', isLocked: false },
        { id: 'new-q-2', position: 2, question: '成功保存的第二题', generatedAt: '', category: 'selection', isLocked: false },
      ],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('<section class="question-card">')
    expect(html).toContain('成功保存的新问题')
    expect(html).toContain('成功保存的第二题')
    expect(html).not.toContain('question-generation-preview')
  })

  it('keeps the local two-question stream preview over a stale one-question task snapshot', () => {
    const project = {
      id: 'question-stream-precedence', companyName: '流式题集公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: '2026-09-04T00:00:00.000Z', questionsLockedAt: null,
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [],
    } as unknown as ProjectDetail
    const twoQuestionProgress: QuestionGenerationProgress = {
      completedCount: 2,
      total: 2,
      questions: [
        { question: '第一道实时问题', category: 'recommendation' },
        { question: '第二道实时问题', category: 'selection' },
      ],
    }
    const streamingHtml = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationProgress={twoQuestionProgress}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    expect(streamingHtml).toContain('<section class="question-card">')
    expect(streamingHtml.match(/class="question-list__item/g)).toHaveLength(2)
    expect(streamingHtml).not.toContain('question-generation-preview')
    expect(streamingHtml).toContain('第一道实时问题')
    expect(streamingHtml).toContain('第二道实时问题')

    // A failed or completed observer clears its local session. A stale
    // running-task snapshot is not a prop of MonitoringScope and therefore
    // cannot recreate the old preview rows.
    const clearedHtml = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationProgress={null}
      actionError="问题生成失败"
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    expect(clearedHtml).not.toContain('question-generation-preview')
    expect(clearedHtml).not.toContain('第一道实时问题')
    expect(clearedHtml).not.toContain('第二道实时问题')

    const completedHtml = renderToStaticMarkup(<MonitoringScope
      project={{ ...project, questionsGeneration: { status: 'completed', error: null } } as unknown as ProjectDetail}
      busy={false}
      generationProgress={null}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    expect(completedHtml).not.toContain('question-generation-preview')
    expect(completedHtml).not.toContain('第一道实时问题')
  })

  it('keeps all twenty generation rows visible in the formal card', () => {
    const project = {
      id: 'question-preview-full', companyName: '完整预览公司', websiteUrl: null, optimizationTarget: '企业数字化服务', supplementalInfo: null,
      questionsGeneratedAt: null, questionsLockedAt: null,
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      questions: [],
    } as unknown as ProjectDetail
    const progress: QuestionGenerationProgress = {
      completedCount: 20,
      total: 20,
      questions: Array.from({ length: 20 }, (_, index) => ({
        question: `预览问题${index + 1}`,
        category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision',
      })),
    }
    const html = renderToStaticMarkup(<MonitoringScope
      project={project}
      busy
      generating
      generationProgress={progress}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)

    expect(html.match(/class="question-list__item/g)).toHaveLength(20)
    expect(html).toContain('<section class="question-card">')
    expect(html).not.toContain('question-generation-preview')
    const questionListRules = cssRulesForClass(appCss, 'question-list').join('\n')
    expect(questionListRules).toContain('overflow-y: auto;')
    expect(questionListRules).not.toContain('max-height: 260px;')

    const withExistingQuestion = renderToStaticMarkup(<MonitoringScope
      project={{ ...project, questions: [{ id: 'q-1', position: 1, question: '已存在正式问题', generatedAt: '', category: 'recommendation', isLocked: false }] } as unknown as ProjectDetail}
      busy
      generating
      generationProgress={progress}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    expect(withExistingQuestion).toContain('<section class="question-card">')
    expect(withExistingQuestion).not.toContain('已存在正式问题')

    const emptyIdle = renderToStaticMarkup(<MonitoringScope
      project={{ ...project, questionsGeneration: { status: 'not_started', error: null } } as unknown as ProjectDetail}
      busy={false}
      actionError=""
      onGenerate={() => undefined}
      onConfirm={() => undefined}
    />)
    expect(emptyIdle).toContain('<section class="question-card">')
    expect(emptyIdle).toContain('暂无诊断问题')
  })

  it('stacks every question, diagnosis, and monitoring progress bar below centered copy', () => {
    const questionRules = cssRulesForClass(appCss, 'question-generation-progress')
    const questionBarRules = cssRulesForClass(appCss, 'question-generation-progress__bar')
    const questionCopyRules = cssRulesForClass(appCss, 'question-generation-progress__copy')
    const diagnosisRules = cssRulesForClass(appCss, 'diagnosis-feedback-progress')
    const diagnosisBarRules = cssRulesForClass(appCss, 'diagnosis-feedback-progress__bar')
    const diagnosisLabelRules = cssRulesForClass(appCss, 'diagnosis-feedback-progress__label')
    const questionLayoutOverride = questionRules.find((rule) => rule.includes('operation-feedback')) ?? ''
    const diagnosisLayoutOverride = diagnosisRules.find((rule) => rule.includes('operation-feedback')) ?? ''
    const questionBars = questionBarRules.join('\n')
    const diagnosisBars = diagnosisBarRules.join('\n')

    expect(questionLayoutOverride).toContain('display: flex;')
    expect(questionLayoutOverride).toContain('flex-direction: column;')
    expect(questionLayoutOverride).toContain('align-items: center;')
    expect(questionLayoutOverride).toContain('width: 100%;')
    expect(questionBars).toMatch(/width:\s*100%;/)
    expect(questionBars).toContain('height: 6px;')
    expect(questionBars).toMatch(/flex:\s*(?:none|0\s+0(?:\s+[^;]+)?);/)
    expect(questionCopyRules.join('\n')).toContain('white-space: normal;')
    expect(questionCopyRules.join('\n')).toContain('overflow-wrap: anywhere;')

    expect(diagnosisLayoutOverride).toContain('display: flex;')
    expect(diagnosisLayoutOverride).toContain('flex-direction: column;')
    expect(diagnosisLayoutOverride).toContain('align-items: center;')
    expect(diagnosisLayoutOverride).toContain('width: 100%;')
    expect(diagnosisBars).toMatch(/width:\s*100%;/)
    expect(diagnosisBars).toContain('height: 6px;')
    expect(diagnosisBars).toMatch(/flex:\s*(?:none|0\s+0(?:\s+[^;]+)?);/)
    expect(diagnosisLabelRules.join('\n')).toContain('white-space: normal;')
    expect(diagnosisLabelRules.join('\n')).toContain('overflow-wrap: anywhere;')
  })

  it('keeps question generation manual and uses the same action label for the first and later generation', () => {
    const base = {
      id: 'manual-generation', companyName: '手动生成公司', websiteUrl: null, optimizationTarget: '企业数字化服务', questions: [],
      questionsGeneration: { status: 'not_started', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
    } as unknown as ProjectDetail
    const initialHtml = renderToStaticMarkup(<MonitoringScope project={base} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(initialHtml).toContain('生成问题')
    expect(initialHtml).toContain('诊断问题')
    expect(initialHtml).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    expect(operationBarCenter(initialHtml)).toContain('点击“生成问题”')
    const emptyQuestions = initialHtml.slice(initialHtml.indexOf('<div class="questions-empty">'), initialHtml.indexOf('</div>', initialHtml.indexOf('<div class="questions-empty">')) + '</div>'.length)
    expect(emptyQuestions).toContain('暂无诊断问题')
    expect(emptyQuestions).not.toContain('点击“生成问题”')
    expect(initialHtml).not.toContain('重新生成')
    expect(initialHtml).not.toContain('已保存')
    expect(initialHtml).not.toContain('正在保存官网资料，请稍候…')

    const regeneratedHtml = renderToStaticMarkup(<MonitoringScope project={{ ...base, questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '' })), questionsGeneration: { status: 'failed', error: '本次失败' } } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    expect(regeneratedHtml).toContain('重新生成')
    expect(regeneratedHtml).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    expect(regeneratedHtml).toContain('本次失败')
    expect(regeneratedHtml).toContain('确认并开始诊断')
  })

  it('shows the question mix rule for a locked question set without changing locked controls', () => {
    const project = {
      id: 'locked-questions', companyName: '已锁定公司', websiteUrl: null,
      questionsLockedAt: '2026-09-04T00:00:00.000Z',
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      questionsGeneration: { status: 'completed', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    expect(html).toContain('问题已锁定')
    expect(html).not.toContain('lucide-lock-keyhole-open')
    expect(html).not.toContain(missingQuestionSourceMessage)
    expect(html).not.toContain('重新生成')
    expect(html).not.toContain('确认并开始诊断')
  })

  it('blocks generation without business source information and hides stale retry guidance', () => {
    const project = {
      id: 'missing-question-source', companyName: '仅有名称公司', websiteUrl: '  ', optimizationTarget: '\t', supplementalInfo: '\n', questions: [],
      questionsGeneration: { status: 'failed', error: '旧生成失败' },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="旧操作失败" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generationButton = html.match(/<button[^>]*>[\s\S]*?<span>生成问题<\/span><\/button>/)?.[0] ?? ''

    expect(html).toContain(missingQuestionSourceMessage)
    expect(html).toContain('问题配比（共20个）：推荐类10个、选型类6个、决策咨询类4个。')
    expect(generationButton).not.toBe('')
    expect(generationButton).toContain('disabled=""')
    expect(html).not.toContain('旧生成失败')
    expect(html).not.toContain('旧操作失败')
    expect(html).not.toContain('>重试<')
    expect(html).not.toContain('点击“生成问题”')
  })

  it('keeps existing unlocked questions and the original confirmation condition without source information', () => {
    const project = {
      id: 'existing-question-source-missing', companyName: '已有题集公司', websiteUrl: null, optimizationTarget: ' ', supplementalInfo: '\t', questionsLockedAt: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `已有问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      questionsGeneration: { status: 'failed', error: '旧生成失败' },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generationButton = html.match(/<button[^>]*>[\s\S]*?<span>重新生成<\/span><\/button>/)?.[0] ?? ''
    const confirmationButton = [...html.matchAll(/<button[\s\S]*?<\/button>/g)].find((match) => match[0].includes('确认并开始诊断'))?.[0] ?? ''

    expect(html).toContain(missingQuestionSourceMessage)
    expect(html).toContain('已有问题20')
    expect(generationButton).not.toBe('')
    expect(generationButton).toContain('disabled=""')
    expect(confirmationButton).not.toBe('')
    expect(confirmationButton).not.toContain('disabled=""')
  })

  it.each([
    ['优化对象', { optimizationTarget: '企业数字化服务' }],
    ['客户官网', { websiteUrl: 'https://example.test' }],
    ['补充信息', { supplementalInfo: '面向制造业客户提供咨询和实施服务。' }],
  ])('restores question generation when %s is provided', (_label, field) => {
    const project = {
      id: 'question-source-restored', companyName: '资料补充公司', websiteUrl: null, optimizationTarget: null, supplementalInfo: null, questions: [],
      questionsGeneration: { status: 'not_started', error: null },
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      ...field,
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generationButton = html.match(/<button[^>]*>[\s\S]*?<span>生成问题<\/span><\/button>/)?.[0] ?? ''

    expect(html).not.toContain(missingQuestionSourceMessage)
    expect(generationButton).not.toBe('')
    expect(generationButton).not.toContain('disabled=""')
    expect(html).toContain('点击“生成问题”')
  })

  it('does not surface website crawl progress in the question scope', () => {
    const project = {
      id: 'crawling-project', companyName: '采集中公司', websiteUrl: 'https://example.test', questions: [],
      questionsGeneration: { status: 'failed', error: '问题生成失败' },
      websiteCrawl: { status: 'crawling', incomplete: false, error: null, successCount: 0, discoveredCount: 2, failedCount: 0 },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="问题生成失败" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).not.toContain('question-card__header--generating')
    expect(html).not.toContain('正在保存官网资料，请稍候…')
    expect(html).not.toContain('正在采集官网资料')
    expect(html).toContain('问题生成失败')
    expect(html).toContain('确认并开始诊断')
    expect(websiteCrawlIsActive(project)).toBe(true)
  })

  it('uses the same manual question-generation prompt regardless of legacy crawl status', () => {
    const base = {
      id: 'empty-question-guide-order', companyName: '提示顺序公司', websiteUrl: 'https://example.test', questions: [],
      questionsGeneration: { status: 'not_started', error: null },
      websiteCrawl: { status: 'crawling', incomplete: false, error: null, successCount: 0, discoveredCount: 2, failedCount: 0 },
    } as unknown as ProjectDetail

    const crawling = renderToStaticMarkup(<MonitoringScope project={base} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const crawlingCenter = operationBarCenter(crawling)
    expect(crawlingCenter).toContain('点击“生成问题”')
    expect(crawlingCenter).not.toContain('正在保存官网资料，请稍候…')

    const completed = renderToStaticMarkup(<MonitoringScope project={{
      ...base,
      questionsGeneration: { status: 'completed', error: null },
      websiteCrawl: { ...base.websiteCrawl, status: 'completed', successCount: 2, discoveredCount: 2 },
    } as unknown as ProjectDetail} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const completedCenter = operationBarCenter(completed)
    expect(completedCenter).toContain('点击“生成问题”')
    expect(completedCenter).not.toContain('正在保存官网资料，请稍候…')

    const generating = renderToStaticMarkup(<MonitoringScope project={{
      ...base,
      questionsGeneration: { status: 'generating', error: '旧生成失败' },
      websiteCrawl: { ...base.websiteCrawl, status: 'completed', successCount: 2, discoveredCount: 2 },
    } as unknown as ProjectDetail} busy generating actionError="旧操作失败" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const generatingCenter = operationBarCenter(generating)
    expect(generatingCenter.match(/正在生成问题，请稍候…/g)).toHaveLength(1)
    expect(generatingCenter).not.toContain('正在保存官网资料，请稍候…')
  })

  it('does not let legacy crawl state override question-generation progress', () => {
    const project = {
      id: 'crawling-and-generating-project', companyName: '采集生成中公司', websiteUrl: 'https://example.test', questions: [],
      questionsGeneration: { status: 'generating', error: null },
      websiteCrawl: { status: 'crawling', incomplete: false, error: null, successCount: 0, discoveredCount: 2, failedCount: 0 },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringScope project={project} busy={false} generating actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)

    expect(html).toContain('question-card__header--generating')
    expect(html.match(/正在生成问题，请稍候…/g)).toHaveLength(1)
    expect(html).not.toContain('正在保存官网资料，请稍候…')
  })

  it('does not gate the workflow on a legacy crawl result', () => {
    const project = {
      id: 'empty-crawl', companyName: '无正文公司', websiteUrl: 'https://example.test', questions: [],
      questionsGeneration: { status: 'not_started', error: null },
      websiteCrawl: { status: 'failed', incomplete: true, error: 'HTTP 403', successCount: 0, discoveredCount: 1, failedCount: 1 },
    } as unknown as ProjectDetail
    const scopeHtml = renderToStaticMarkup(<MonitoringScope project={project} busy={false} actionError="" onGenerate={() => undefined} onConfirm={() => undefined} />)
    const optimizationHtml = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(scopeHtml).not.toContain('已保存 0 页官网资料')
    expect(scopeHtml).not.toContain('仅使用已填写的客户资料生成问题')
    expect(optimizationHtml).not.toContain('已保存 0 页官网资料')
    expect(optimizationHtml).not.toContain('HTTP 403')
    expect(optimizationHtml).toContain('内容优化任务')
    expect(optimizationHtml).toContain('方案设计')
    expect(optimizationHtml).not.toContain('暂时不能生成文章')
  })

  it('does not show a success crawl notice after a complete website crawl in optimization', () => {
    const project = {
      id: 'complete-crawl', companyName: '完整采集公司', websiteUrl: 'https://example.test', questions: [],
      websiteCrawl: { status: 'completed', incomplete: false, error: null, successCount: 3, discoveredCount: 3, failedCount: 0 },
      questionsGeneration: { status: 'not_started', error: null }, articleBatches: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(html).not.toContain('已保存 3 页官网资料')
    expect(html).not.toContain('optimization-crawl-notice')
    expect(html).toContain('内容优化任务')
    expect(html).toContain('方案设计')
    expect(html).toContain('官网内容检查')
    expect(html).toContain('暂无检查结果。')
    expect(html).not.toContain('暂无检查结果，请点击“内容检查”开始检查。')
    expect(html).not.toContain('官网读取不完整')
  })

  it('keeps scheme design gated while content checking runs but allows failed checks and writing', () => {
    const project = {
      id: 'content-audit-gate', companyName: '内容核查门槛公司', websiteUrl: 'https://example.test', articleBatches: [{ id: 'batch-1', articles: [
        { id: 'article-1', projectId: 'content-audit-gate', batchId: 'batch-1', title: '待写作标题', questionPositions: [1], contentHtml: null, generatedAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', writingStatus: 'pending' as const, writingError: null, optimizationType: 'FAQ', publishStatus: 'pending' as const, confirmedAt: null },
      ] }], websiteCrawl: { status: 'completed', incomplete: false, error: null, successCount: 2, discoveredCount: 2, failedCount: 0 },
    } as unknown as ProjectDetail
    const props = { onSaveWebsite: () => undefined, onGenerate: () => undefined, onConfirmPublished: async () => undefined, onContentAuditCheck: () => undefined }
    const missing = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" contentAuditRecord={null} {...props} />)
    const checking = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" contentAuditRecord={contentAuditRecord('checking')} {...props} />)
    const failed = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" contentAuditRecord={contentAuditRecord('failed')} {...props} />)
    const completed = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" contentAuditRecord={contentAuditRecord('completed')} {...props} />)

    const schemeButton = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<span>(?:方案设计|生成中…)<\/span><\/button>/g)][0]?.[0] ?? ''
    const writingButton = (html: string) => [...html.matchAll(/<button[^>]*aria-label="写稿：待写作标题"[\s\S]*?<\/button>/g)][0]?.[0] ?? ''
    expect(schemeButton(missing)).toContain('disabled=""')
    expect(schemeButton(checking)).toContain('disabled=""')
    expect(schemeButton(failed)).not.toContain('disabled=""')
    expect(schemeButton(completed)).not.toContain('disabled=""')
    expect(writingButton(missing)).not.toContain('disabled=""')
    expect(writingButton(checking)).not.toContain('disabled=""')
    expect(writingButton(failed)).not.toContain('disabled=""')
    expect(writingButton(missing)).not.toContain('请先完成官网内容检查')
    expect(contentAuditGenerationReady(contentAuditRecord('completed'))).toBe(true)
    expect(contentAuditGenerationReady(contentAuditRecord('failed'))).toBe(false)
    expect(contentAuditGenerationReady(contentAuditRecord('completed', { items: [] }))).toBe(false)
  })

  it('routes content-audit task errors separately from status-read errors', () => {
    expect(appSource).toContain("contentAuditTaskError = ''")
    expect(appSource).toContain('taskError={contentAuditTaskError}')
    expect(appSource).toContain('contentAuditLoadError={contentAuditLoadError} contentAuditTaskError={contentAuditTaskError}')
    expect(appSource).not.toContain('contentAuditLoadError={contentAuditLoadError || contentAuditTaskError}')
  })

  it('passes real status loading separately from the active background task', () => {
    expect(appSource).toContain('contentAuditLoading={contentAuditLoading}')
    expect(appSource).toContain('taskActive={contentAuditTaskActive}')
    expect(appSource).not.toContain('contentAuditLoading={contentAuditLoading || contentAuditTaskActive}')
    expect(appSource).toContain('contentAuditLoadError={contentAuditLoadError}')
  })

  it('requires the same terminal and reviewed-candidate guards as the backend', () => {
    const ready = contentAuditRecord('completed')
    expect(contentAuditGenerationReady(ready)).toBe(true)
    expect(contentAuditGenerationReady({ ...ready, completedAt: null })).toBe(false)
    expect(contentAuditGenerationReady({ ...ready, error: '核查失败' })).toBe(false)
    expect(contentAuditGenerationReady({
      ...ready,
      progress: { ...ready.progress, processedPages: ready.progress.totalPages - 1 },
    })).toBe(false)
    expect(contentAuditGenerationReady({
      ...ready,
      progress: { ...ready.progress, totalClaims: 1, processedClaims: 0 },
    })).toBe(false)
    const oneFinding = contentAuditRecord('completed', { items: [{} as never] })
    expect(contentAuditGenerationReady({
      ...oneFinding,
      progress: { ...oneFinding.progress, totalClaims: 0, processedClaims: 0 },
    })).toBe(false)
  })

  it('guards crawl polling responses by both project and website URL', () => {
    const current = { id: 'poll-project', websiteUrl: 'https://current.example', updatedAt: 'v2' } as unknown as ProjectDetail
    expect(isCurrentProjectWebsite(current, 'poll-project', 'https://current.example')).toBe(true)
    expect(isCurrentProjectWebsite(current, 'poll-project', 'https://old.example')).toBe(false)
    expect(isCurrentProjectWebsite(current, 'other-project', 'https://current.example')).toBe(false)
    expect(isCurrentProjectSnapshot(current, 'poll-project', 'https://current.example', 'v2')).toBe(true)
    expect(isCurrentProjectSnapshot(current, 'poll-project', 'https://current.example', 'v1')).toBe(false)
  })

  it('renders the diagnosis report metrics, answer, and citation', () => {
    const project = {
      id: '2',
      companyName: '诊断示例公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: null,
      supplementalInfo: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `诊断问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      initialDiagnosis: {
        run: { id: '1', runType: 'initial', status: 'completed', startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z', summaryAnalysis: { results: [] }, summaryModel: 'test-model', summaryError: null, recommendationRate: 0.25, officialCitationRate: 0.5 },
        answers: [{ position: 1, question: '诊断问题1', status: 'success', answerText: '# 诊断结论\n\n**这是豆包的原始回答。**\n\n[查看来源](https://example.test/source)\n\n<script>alert(1)</script>', citationUrls: ['https://example.test/source'], responseModel: 'test-model', recommended: true, officialCitation: true, error: null, startedAt: '2026-09-04T00:00:01.000Z', completedAt: '2026-09-04T00:00:02.000Z' }],
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)

    expect(html).toContain('<h2>诊断结果</h2>')
    expect(html).not.toContain('20个问题的诊断结果')
    expect(html).toContain('5 / 20')
    expect(html).toContain('待刷新')
    expect(html).toContain('<h1>诊断结论</h1>')
    expect(html).toContain('<strong>这是豆包的原始回答。</strong>')
    expect(html).not.toContain('**这是豆包的原始回答。**')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('<a href="https://example.test/source">查看来源</a>')
    expect(html).toContain('https://example.test/source')
    expect(html).not.toContain('answer-highlight--citation')
    expect(html).toContain('answer-highlight--recommendation')
    expect(html).toContain('AI 推荐：是')
    expect(html).toContain('answer-citations')
    expect(html).toContain('<h3>原始引用链接</h3>')
    const answerList = html.match(/<ol class="diagnosis-answer-list"[\s\S]*?<\/ol>/)?.[0] ?? ''
    expect(answerList).toContain('官网引用：是')
    expect(answerList).toContain('AI 推荐：是')
    expect(html).toContain('diagnosis-report-layout')
    expect(html).toContain('诊断口径')
    expect(html).toContain('20个问题')
    expect(html).toContain('豆包API · 单次调用')
    expect(html).not.toContain('客户官网：')
    expect(html.indexOf('诊断口径')).toBeLessThan(html.indexOf('推荐率'))
    expect(html.indexOf('推荐率')).toBeLessThan(html.indexOf('官网引用率'))
    const answerTableHeader = html.match(/<div class="diagnosis-answer-table-header">[\s\S]*?<\/div>/)?.[0] ?? ''
    const qaCardStart = html.indexOf('<section class="diagnosis-qa-card">')
    const answerTableHeaderStart = html.indexOf('<div class="diagnosis-answer-table-header">')
    const answerExplorerStart = html.indexOf('<div class="answer-explorer diagnosis-layout answer-explorer--diagnosis">')
    expect(answerTableHeader).toContain('诊断问题')
    expect(answerTableHeader).toContain('AI 回答全文')
    expect(html.match(/diagnosis-answer-table-header/g)).toHaveLength(1)
    expect(answerTableHeaderStart).toBeGreaterThan(qaCardStart)
    expect(answerTableHeaderStart).toBeLessThan(answerExplorerStart)
    const reportMainPrefix = html.match(/<div class="diagnosis-report-main">([\s\S]*?)<section class="diagnosis-qa-card">/)?.[1] ?? ''
    const headerStart = html.indexOf('<div class="operation-bar diagnosis-qa-card__header">')
    const actionsStart = html.indexOf('<div class="diagnosis-qa-card__actions">')
    expect(reportMainPrefix).toMatch(/^<div class="operation-bar diagnosis-qa-card__header">/)
    expect(headerStart).toBeGreaterThanOrEqual(0)
    expect(actionsStart).toBeGreaterThan(headerStart)
    expect(actionsStart).toBeLessThan(qaCardStart)
    expect(html).toContain('</div><aside class="diagnosis-metrics" aria-label="诊断汇总指标">')
    expect(html.indexOf('diagnosis-qa-card')).toBeLessThan(html.indexOf('diagnosis-metrics'))
  })

  it('renders the diagnosis progress bar only for an incomplete run', () => {
    const project = {
      id: 'diagnosis-progress-bar',
      companyName: '诊断进度公司',
      websiteUrl: null,
      questions: [],
      initialDiagnosis: {
        run: { id: 'diagnosis-progress-bar', runType: 'initial', status: 'running', startedAt: '2026-09-08T00:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: null, recommendationRate: null, officialCitationRate: null },
        answers: [],
      },
    } as unknown as ProjectDetail
    const incompleteHtml = renderToStaticMarkup(<DiagnosisReport project={project} busy actionError="" progress={{ completedCount: 3, failedCount: 0, total: 20 }} onStart={() => undefined} />)
    const incompleteCenter = operationBarCenter(incompleteHtml)

    expect(incompleteCenter).toContain('3 / 20 已完成')
    expect(incompleteCenter).toContain('role="progressbar"')
    expect(incompleteCenter).toContain('aria-label="诊断进度"')
    expect(incompleteCenter).toContain('aria-valuemin="0"')
    expect(incompleteCenter).toContain('aria-valuemax="20"')
    expect(incompleteCenter).toContain('aria-valuenow="3"')
    expect(incompleteCenter).toContain('style="width:15%"')

    const completedHtml = renderToStaticMarkup(<DiagnosisReport project={{ ...project, initialDiagnosis: { ...project.initialDiagnosis, run: { ...project.initialDiagnosis.run, status: 'completed' } } } as unknown as ProjectDetail} busy={false} actionError="" progress={{ completedCount: 3, failedCount: 0, total: 20 }} onStart={() => undefined} />)
    expect(completedHtml).not.toContain('diagnosis-feedback-progress')
    expect(completedHtml).not.toContain('3 / 20 已完成')
  })

  it('renders a direct export button without an offscreen source when the server PDF is ready', () => {
    const project = {
      id: 'exportable-diagnosis',
      companyName: '可导出公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '企业服务',
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      initialDiagnosis: {
        run: { id: 'exportable-diagnosis', runType: 'initial', status: 'completed', completedAt: '2026-09-04T00:01:00.000Z', recommendationRate: 0.25, officialCitationRate: 0.5 },
        reportPdfReady: true,
        reportPdfGeneratedAt: '2026-09-04T00:02:00.000Z',
        answers: Array.from({ length: 20 }, (_, index) => ({
          position: index + 1,
          question: `问题${index + 1}`,
          status: 'success' as const,
          answerText: `回答${index + 1}`,
          citationUrls: [],
          responseModel: 'test-model',
          recommended: index % 2 === 0,
          officialCitation: index % 3 === 0,
          error: null,
          startedAt: null,
          completedAt: '2026-09-04T00:01:00.000Z',
        })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)

    expect(html).toContain('导出诊断报告')
    expect(html).not.toContain('已开始下载 PDF')
    expect(html).not.toContain('diagnosis-report-export-source')
    const exportButton = html.match(/<button[^>]*>[\s\S]*?<span>导出诊断报告<\/span><\/button>/)?.[0] ?? ''
    expect(exportButton).not.toContain('disabled=""')
    expect(appSource).not.toContain('已开始下载 PDF')
    expect(appSource).toContain("t('diagnosis.pdf.downloading')")
    expect(appSource).toContain("t('report.downloadError'")
  })

  it('does not render a browser PDF source while a completed diagnosis PDF is not saved', () => {
    const project = {
      id: 'pending-pdf-diagnosis',
      companyName: '待保存公司',
      websiteUrl: null,
      optimizationTarget: null,
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      initialDiagnosis: {
        run: { id: 'pending-pdf-diagnosis', runType: 'initial', status: 'completed', completedAt: '2026-09-04T00:01:00.000Z' },
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
        answers: Array.from({ length: 20 }, (_, index) => ({
          position: index + 1,
          question: `问题${index + 1}`,
          status: 'success' as const,
          answerText: `回答${index + 1}`,
          citationUrls: [],
          responseModel: 'test-model',
          recommended: false,
          officialCitation: false,
          error: null,
          startedAt: null,
          completedAt: '2026-09-04T00:01:00.000Z',
        })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)

    expect(html).toContain('导出诊断报告')
    const exportButton = html.match(/<button[^>]*>[\s\S]*?<span>导出诊断报告<\/span><\/button>/)?.[0] ?? ''
    expect(exportButton).toContain('disabled=""')
    expect(html).not.toContain('diagnosis-report-export-source')
    expect(html).not.toContain('GEO 诊断报告')
  })

  it('keeps a recovery entry for twenty completed answers whose aggregate summary failed', () => {
    const project = {
      id: '20',
      companyName: '待汇总公司',
      websiteUrl: 'https://example.test',
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      initialDiagnosis: {
        run: { id: '20', runType: 'initial', status: 'failed', startedAt: '2026-09-04T00:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: '汇总失败，请重试', recommendationRate: null, officialCitationRate: null },
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, status: 'success' as const, answerText: `回答${index + 1}`, citationUrls: [], responseModel: 'test-model', recommended: null, officialCitation: null, error: null, startedAt: null, completedAt: null })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} reporting={false} actionError="" progress={null} onStart={() => undefined} onRetrySummary={() => undefined} />)

    expect(html).not.toContain('继续诊断')
    expect(html).toContain('重试汇总')
    expect(html).not.toContain('正在计算引用率和推荐率并生成诊断报告…')
    expect(html).not.toContain('20 / 20')
    expect(html).not.toContain('个失败')
  })

  it.each([
    {
      name: '0 answers while diagnosing',
      answers: [],
      run: { id: 'gate-0', runType: 'initial', status: 'running', completedAt: null, summaryError: null },
      initialDiagnosisCompletedAt: null,
      busy: true,
      progress: { completedCount: 0, failedCount: 0, total: 20 },
      expectSummaryStatus: false,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: false,
    },
    {
      name: '19 answers while diagnosing',
      answers: Array.from({ length: 19 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-19', runType: 'initial', status: 'running', completedAt: null, summaryError: null },
      initialDiagnosisCompletedAt: null,
      busy: true,
      progress: { completedCount: 19, failedCount: 0, total: 20 },
      expectSummaryStatus: false,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: false,
    },
    {
      name: '20 answers while the diagnosis request is still running',
      answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-running', runType: 'initial', status: 'running', completedAt: null, summaryError: null },
      initialDiagnosisCompletedAt: null,
      busy: true,
      progress: { completedCount: 20, failedCount: 0, total: 20 },
      expectSummaryStatus: false,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: false,
    },
    {
      name: '20 answers while aggregate analysis is running',
      answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-analyzing', runType: 'initial', status: 'analyzing', completedAt: null, summaryError: null },
      initialDiagnosisCompletedAt: null,
      busy: false,
      progress: null,
      expectSummaryStatus: true,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: false,
    },
    {
      name: '20 answers with aggregate analysis failed',
      answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-failed', runType: 'initial', status: 'failed', completedAt: null, summaryError: '汇总失败，请重试' },
      initialDiagnosisCompletedAt: null,
      busy: false,
      progress: null,
      expectSummaryStatus: false,
      expectRecovery: true,
      expectError: '汇总失败，请重试',
      reportPdfReady: false,
    },
    {
      name: 'completed diagnosis with PDF pending',
      answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-pending-pdf', runType: 'initial', status: 'completed', completedAt: '2026-09-04T00:01:00.000Z', summaryError: null },
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      busy: false,
      progress: null,
      expectSummaryStatus: false,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: false,
    },
    {
      name: 'completed diagnosis with saved PDF',
      answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' as const })),
      run: { id: 'gate-ready-pdf', runType: 'initial', status: 'completed', completedAt: '2026-09-04T00:01:00.000Z', summaryError: null },
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      busy: false,
      progress: null,
      expectSummaryStatus: false,
      expectRecovery: false,
      expectError: null,
      reportPdfReady: true,
    },
  ])('gates diagnosis report export for $name', ({ answers, run, initialDiagnosisCompletedAt, busy, progress, expectSummaryStatus, expectRecovery, expectError, reportPdfReady }) => {
    const answerDetails = answers.map((answer) => ({
      ...answer,
      question: `问题${answer.position}`,
      answerText: `回答${answer.position}`,
      citationUrls: [],
      responseModel: 'test-model',
      recommended: null,
      officialCitation: null,
      error: null,
      startedAt: null,
      completedAt: null,
    }))
    const project = {
      id: 'diagnosis-report-gate',
      companyName: '报告门禁公司',
      websiteUrl: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}` })),
      initialDiagnosisCompletedAt,
      initialDiagnosis: {
        run,
        reportPdfReady,
        reportPdfGeneratedAt: reportPdfReady ? '2026-09-04T00:02:00.000Z' : null,
        answers: answerDetails,
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={busy} actionError="" progress={progress} onStart={() => undefined} onRetrySummary={() => undefined} onGenerateReport={() => undefined} />)
    const reportButton = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((button) => button.includes('<span>导出诊断报告</span>'))

    expect(reportButton).toBeDefined()
    if (reportPdfReady) expect(reportButton).not.toContain('disabled=""')
    else expect(reportButton).toContain('disabled=""')
    if (expectSummaryStatus) {
      expect(html).toContain('正在整理诊断结果…')
      expect(html).not.toContain('<span>生成诊断报告</span>')
    }
    if (expectRecovery) expect(html).toContain('重试汇总')
    if (expectError) expect(html).toContain(expectError)
  })

  it('shows the disabled report state while aggregate analysis is running', () => {
    const project = {
      id: '21',
      companyName: '报告生成中公司',
      websiteUrl: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      initialDiagnosis: {
        run: { id: '21', runType: 'initial', status: 'analyzing', startedAt: '2026-09-04T00:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: null, recommendationRate: null, officialCitationRate: null },
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, status: 'success' as const, answerText: `回答${index + 1}`, citationUrls: [], responseModel: 'test-model', recommended: null, officialCitation: null, error: null, startedAt: null, completedAt: null })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} reporting={true} actionError="" progress={null} onStart={() => undefined} onGenerateReport={() => undefined} />)

    expect(html).toContain('正在整理诊断结果…')
    expect(html).not.toContain('<span>生成诊断报告</span>')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('继续诊断')
    expect(html).toContain('diagnosis-answer-table-header')
    expect(html).toContain('AI 回答全文')
  })

  it('places the interrupted notice in the operation-bar center and hides it during the active request', () => {
    const project = {
      id: '22',
      companyName: '部分完成公司',
      websiteUrl: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, generatedAt: '2026-09-04T00:00:00.000Z' })),
      initialDiagnosis: {
        run: { id: '22', runType: 'initial', status: 'failed', startedAt: '2026-09-04T00:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: '部分问题未完成，请点击重试', recommendationRate: null, officialCitationRate: null },
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, status: index === 19 ? 'failed' as const : 'success' as const, answerText: index === 19 ? null : `回答${index + 1}`, citationUrls: [], responseModel: index === 19 ? null : 'test-model', recommended: null, officialCitation: null, error: index === 19 ? '豆包请求超时' : null, startedAt: null, completedAt: null })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="" progress={null} onStart={() => undefined} onGenerateReport={() => undefined} />)
    const busyHtml = renderToStaticMarkup(<DiagnosisReport project={project} busy actionError="" progress={null} onStart={() => undefined} onGenerateReport={() => undefined} />)
    const genericErrorHtml = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="部分问题未完成，请点击重试" progress={{ completedCount: 19, failedCount: 1, total: 20 }} onStart={() => undefined} onGenerateReport={() => undefined} />)
    const specificErrorHtml = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="豆包请求超时" progress={{ completedCount: 19, failedCount: 1, total: 20 }} onStart={() => undefined} onGenerateReport={() => undefined} />)

    expect(html).toContain('继续诊断')
    expect(html).toContain('部分问题未完成，请点击继续诊断')
    expect(html).not.toContain('（部分问题未完成，请点击继续诊断）')
    expect(operationBarCenter(html)).toContain('部分问题未完成，请点击继续诊断')
    expect(html).not.toContain('diagnosis-qa-card__interrupted')
    expect(html).toContain('diagnosis-answer-table-header')
    expect(html).toContain('AI 回答全文')
    expect(operationBarCenter(busyHtml)).not.toContain('部分问题未完成，请点击继续诊断')
    expect(busyHtml).toContain('diagnosis-answer-table-header')
    expect(operationBarCenter(genericErrorHtml).match(/部分问题未完成，请点击继续诊断/g)).toHaveLength(1)
    expect(operationBarCenter(genericErrorHtml)).not.toContain('请点击重试')
    expect(operationBarCenter(genericErrorHtml)).toContain('19 / 20 已完成')
    expect(operationBarCenter(specificErrorHtml)).toContain('豆包请求超时')
    expect(operationBarCenter(specificErrorHtml)).not.toContain('部分问题未完成，请点击继续诊断')
    expect(operationBarCenter(specificErrorHtml).match(/豆包请求超时/g)).toHaveLength(1)
  })

  it('labels the diagnosis action as retrying only failed answers', () => {
    const project = {
      id: 'partial-retry-label',
      companyName: '部分失败重试公司',
      websiteUrl: null,
      questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}` })),
      initialDiagnosis: {
        run: { id: 'partial-retry-run', runType: 'initial' as const, status: 'failed' as const, startedAt: '2026-09-04T00:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: '部分问题未完成', recommendationRate: null, officialCitationRate: null },
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}`, status: index === 19 ? 'failed' as const : 'success' as const, answerText: index === 19 ? null : `回答${index + 1}`, citationUrls: [], responseModel: 'test-model', recommended: null, officialCitation: null, error: index === 19 ? '请求失败' : null, startedAt: null, completedAt: null })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DiagnosisReport project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const actionButton = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((button) => button.includes('重试失败部分'))
    expect(actionButton).toBeDefined()
    expect(actionButton).not.toContain('disabled=""')
  })

  it('renders a restricted exportable report only after a completed diagnosis', () => {
    const report = {
      id: '3',
      companyName: '报告示例公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: '企业服务',
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      initialDiagnosis: {
        run: { id: '3', runType: 'initial', status: 'completed', requestedModel: 'test-model', startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z', summaryAnalysis: { results: [] }, summaryModel: 'test-model', summaryError: null, recommendationRate: 0.25, officialCitationRate: 0.5 },
        reportPdfReady: true,
        reportPdfGeneratedAt: '2026-09-04T00:02:00.000Z',
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `报告问题${index + 1}`, status: 'success' as const, answerText: '回答原文不应出现', citationUrls: [], responseModel: 'test-model', recommended: index % 2 === 0, officialCitation: index % 3 === 0, error: null, startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z' })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<ProjectReportPage project={report} projectState="ready" onRetry={() => undefined} onBack={() => undefined} />)

    expect(html).toContain('报告示例公司')
    expect(html).toContain('5 / 20')
    expect(html).toContain('报告问题20')
    expect(html).not.toContain('已开始下载 PDF')
    expect(html).toContain('<span>下载 PDF</span>')
    expect(html).not.toContain('回答原文不应出现')
    expect(html).not.toContain('生成依据')
    expect(html).not.toContain('优化建议')
    expect(appSource).toContain("t('diagnosis.redownload')")
    expect(appSource).toContain("t('report.retryDownload')")
  })

  it('allows exporting a completed diagnosis when citation fields are unavailable', () => {
    const report = {
      id: '31',
      companyName: '官网后补公司',
      websiteUrl: 'https://example.test',
      optimizationTarget: null,
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      initialDiagnosis: {
        run: { id: '31', runType: 'initial', status: 'completed', requestedModel: 'test-model', startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z', summaryAnalysis: null, summaryModel: 'test-model', summaryError: null, recommendationRate: null, officialCitationRate: null },
        reportPdfReady: true,
        reportPdfGeneratedAt: '2026-09-04T00:02:00.000Z',
        answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `报告问题${index + 1}`, status: 'success' as const, answerText: '回答', citationUrls: [], responseModel: 'test-model', recommended: null, officialCitation: null, error: null, startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z' })),
      },
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<ProjectReportPage project={report} projectState="ready" onRetry={() => undefined} onBack={() => undefined} />)

    expect(html).toContain('GEO 诊断报告')
    expect(html).toContain('待判断')
    expect(html).not.toContain('官网引用</span><strong>否</strong>')
    expect(html).not.toContain('初始诊断尚未完整完成')
  })

  it('copies article content as rich and plain text when ClipboardItem is available', async () => {
    let written: unknown[] = []
    let itemParts: Record<string, Blob> | null = null
    await copyArticleContent(
      { title: '文章标题', contentHtml: '<p>文章正文</p>' },
      {
        clipboard: { write: async (items) => { written = items } },
        createItem: (parts) => { itemParts = parts; return parts },
      },
    )
    expect(written).toHaveLength(1)
    expect(itemParts).not.toBeNull()
    const parts = itemParts as unknown as Record<string, Blob>
    expect(await parts['text/html']?.text()).toContain('<h1>文章标题</h1>')
    expect(await parts['text/plain']?.text()).toContain('文章正文')
  })

  it('falls back to plain text copying when rich clipboard is unavailable', async () => {
    let copied = ''
    const mode = await copyArticleContent(
      { title: '文章标题', contentHtml: '<p>文章正文</p>' },
      { clipboard: { writeText: async (text) => { copied = text } }, createItem: null },
    )
    expect(mode).toBe('plain')
    expect(copied).toContain('文章标题')
    expect(copied).toContain('文章正文')
  })

  it('renders the website setup state and article list state from the same optimization stage', () => {
    const base = {
      id: '4',
      companyName: '优化示例公司',
      websiteUrl: null,
      optimizationTarget: null,
      supplementalInfo: null,
      initialDiagnosisCompletedAt: '2026-09-04T00:01:00.000Z',
      websitePagesSucceeded: 0,
      websiteCrawlIncomplete: false,
      articleBatches: [],
    } as unknown as ProjectDetail
    const setupHtml = renderToStaticMarkup(<OptimizationSuggestions project={base} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(setupHtml).toContain('请先添加客户官网')
    expect(setupHtml).not.toContain('开始优化前，需要填写客户官网')
    expect(setupHtml).not.toContain('保存官网')
    expect(setupHtml).not.toContain('一键优化 · 资料采集成功后可用')

    const article = {
    id: 'article-1', projectId: '4', batchId: 'batch-1', title: '企业服务选择指南', questionPositions: [1, 2, 4],
      contentHtml: '<p>正文</p>', generatedAt: '2026-09-04T01:00:00.000Z', publishStatus: 'pending' as const, confirmedAt: null, optimizationDirection: '主题内容补充',
    }
    const listHtml = renderToStaticMarkup(<OptimizationSuggestions project={{ ...base, websiteUrl: 'https://example.test', websitePagesSucceeded: 2, articleBatches: [{ id: 'batch-1', projectId: '4', requestedModel: 'm', responseModel: 'm', generatedAt: article.generatedAt, articles: [article] }] } as unknown as ProjectDetail} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(listHtml).toContain('内容优化任务')
    expect(listHtml).toContain('方案设计')
    expect(listHtml).toContain('企业服务选择指南')
    expect(listHtml).toContain('Q01')
    expect(listHtml).toContain('主题内容补充')
    expect(listHtml).toContain('待发布')

    const emptyListHtml = renderToStaticMarkup(<OptimizationSuggestions project={{ ...base, websiteUrl: 'https://example.test', websitePagesSucceeded: 2, articleBatches: [] } as unknown as ProjectDetail} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(operationBarCenter(emptyListHtml)).toContain('点击右侧“方案设计”生成文章标题，再逐篇写稿。')
    expect(emptyListHtml).toContain('暂无文章')
    expect(emptyListHtml).not.toContain('生成3篇文章')
  })

  it('does not require a website cache before one-click optimization', () => {
    const project = {
      id: '6',
      companyName: '待读取官网公司',
      websiteUrl: 'https://example.test',
      websiteCrawlStatus: 'not_started',
      websiteCrawlIncomplete: false,
      websitePagesSucceeded: 0,
      articleBatches: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)

    expect(html).toContain('内容优化任务')
    expect(html).toContain('方案设计')
    expect(html).not.toContain('官网读取未得到可用页面')
    const schemeButton = html.match(/<button class="button button--primary"[^>]*>[\s\S]*?<span>方案设计<\/span><\/button>/)?.[0] ?? ''
    expect(schemeButton).not.toContain('disabled=""')
  })

  it('shows scheme-design progress only in the operation-bar center', () => {
    const project = {
      id: 'generating-project',
      companyName: '方案设计公司',
      websiteUrl: 'https://example.test',
      websiteCrawl: { status: 'completed', incomplete: false, error: null, successCount: 2, discoveredCount: 2, failedCount: 0 },
      articleBatches: [],
    } as unknown as ProjectDetail
    const props = { onSaveWebsite: () => undefined, onGenerate: () => undefined, onConfirmPublished: async () => undefined }
    const generating = renderToStaticMarkup(<OptimizationSuggestions project={project} busy generating actionError="旧错误" generationNotice="旧完成提示" {...props} />)
    const titleIndex = generating.indexOf('内容优化任务')
    const statusIndex = generating.indexOf('正在根据诊断结果与官网内容检查设计方案…')
    const buttonIndex = generating.indexOf('生成中…')
    expect(statusIndex).toBeGreaterThan(titleIndex)
    expect(statusIndex).toBeLessThan(buttonIndex)
    expect(operationBarCenter(generating)).toContain('正在根据诊断结果与官网内容检查设计方案…')
    expect(operationBarCenter(generating)).toMatch(/class="article-writing-spinner"[^>]*><\/span>正在根据诊断结果与官网内容检查设计方案…/)
    expect(generating).toContain('class="operation-feedback operation-feedback--neutral"')
    expect(generating).toContain('aria-live="polite"')
    expect(generating).not.toContain('旧错误')
    expect(generating).not.toContain('旧完成提示')

    const idle = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="" generationNotice="已新增 1 个标题。" {...props} />)
    expect(idle).toContain('已新增 1 个标题。')
    expect(idle).not.toContain('正在根据诊断结果与官网内容检查设计方案…')
    expect(operationBarCenter(idle)).toContain('已新增 1 个标题。')
    expect(operationBarCenter(idle)).not.toContain('article-writing-spinner')
    expect(idle).toContain('class="operation-feedback operation-feedback--neutral"')

    const nonGeneratingBusy = renderToStaticMarkup(<OptimizationSuggestions project={project} busy generating={false} actionError="" {...props} />)
    expect(nonGeneratingBusy).toContain('>方案设计<')
    expect(nonGeneratingBusy).not.toContain('正在根据诊断结果与官网内容检查设计方案…')
    expect(operationBarCenter(nonGeneratingBusy)).toContain('点击右侧“方案设计”生成文章标题，再逐篇写稿。')

    const failed = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="方案设计失败" generationNotice="旧完成提示" {...props} />)
    expect(failed).toContain('方案设计失败')
    expect(operationBarCenter(failed)).toContain('class="operation-feedback operation-feedback--error"')
    expect(failed.indexOf('方案设计失败')).toBeGreaterThan(failed.indexOf('内容优化任务'))
    expect(failed.indexOf('方案设计失败')).toBeLessThan(failed.indexOf('>方案设计<'))
    expect(failed).not.toContain('旧完成提示')
    expect(failed).not.toContain('正在根据诊断结果与官网内容检查设计方案…')
  })

  it('shows optimization errors in the operation-bar center without a retry card or button', () => {
    const project = {
      id: 'optimization-error',
      companyName: '内容生成失败公司',
      websiteUrl: 'https://example.test',
      websiteCrawl: { status: 'not_started', incomplete: false, error: null, successCount: 0, discoveredCount: 0, failedCount: 0 },
      articleBatches: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError="生成优化失败，请稍后重试" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    const titleIndex = html.indexOf('内容优化任务')
    const errorIndex = html.indexOf('operation-feedback--error')
    expect(titleIndex).toBeGreaterThan(-1)
    expect(errorIndex).toBeGreaterThan(titleIndex)
    expect(errorIndex).toBeLessThan(html.indexOf('>方案设计<'))
    expect(html).toContain('role="alert"')
    expect(html).toContain('生成优化失败，请稍后重试')
    expect(html).not.toContain('optimization-error')
    expect(html).not.toContain('inline-notice')
    expect(html).not.toContain('>重试<')
  })

  it('keeps persisted article failures in the center without duplicating the active error', () => {
    const failedArticle = { ...entryArticle({ id: 'failed-article', writingStatus: 'failed' }), title: '失败文章', contentHtml: null, writingError: '接口超时' }
    const writingArticle = { ...entryArticle({ id: 'writing-article', writingStatus: 'writing' }), title: '写作中文章', contentHtml: null, writingError: '上次失败' }
    const project = {
      id: 'article-errors',
      companyName: '文章失败公司',
      websiteUrl: 'https://example.test',
      websiteCrawl: { status: 'completed', incomplete: false, error: null, successCount: 2, discoveredCount: 2, failedCount: 0 },
      articleBatches: [{ id: 'batch-1', projectId: 'article-errors', requestedModel: 'fixture', responseModel: 'fixture', generatedAt: '2026-09-08T00:00:00.000Z', articles: [failedArticle, writingArticle] }],
    } as unknown as ProjectDetail
    const actionError = '文章“失败文章”写作失败：接口超时'
    const html = renderToStaticMarkup(<OptimizationSuggestions project={project} busy={false} actionError={actionError} onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    const center = operationBarCenter(html)

    expect(center.match(/文章“失败文章”写作失败：接口超时/g)).toHaveLength(1)
    expect(center).toContain('文章“写作中文章”正在写作…')
    expect(center).not.toContain('文章“写作中文章”写作失败：上次失败')
  })

  it('renders the read-only article preview actions', () => {
    const article = { id: 'article-2', projectId: '4', batchId: 'batch-1', title: '预览标题', questionPositions: [2], contentHtml: '<p>预览正文</p>', generatedAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z', writingStatus: 'ready' as const, writingError: null, optimizationType: '新增专题文章', optimizationDirection: '主题内容补充', publishStatus: 'pending' as const, confirmedAt: null }
    const html = renderToStaticMarkup(<ArticlePreviewModal article={article} onClose={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(html).toContain('文章预览')
    expect(html).toContain('预览正文')
    expect(html).toContain('优化方向：主题内容补充')
    expect(html).toContain('复制全文')
    expect(html).toContain('确认已发布')
  })

  it('renders an update target and the left-side single-record delete action', () => {
    const article = { id: 'article-update', projectId: '4', batchId: 'batch-1', title: '更新标题', questionPositions: [], contentHtml: '<p>完整更新稿</p>', generatedAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z', writingStatus: 'ready' as const, writingError: null, optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/original', targetPageTitle: '原文标题', publishStatus: 'pending' as const, confirmedAt: null }
    const html = renderToStaticMarkup(<ArticlePreviewModal article={article} onClose={() => undefined} onConfirmPublished={async () => undefined} onDeleteArticle={async () => undefined} />)
    expect(html).toContain('原文标题')
    expect(html).toContain('优化方向：补充 FAQ')
    expect(html).toContain('https://example.test/original')
    expect(html).toContain('删除')
    expect(html).toContain('preview-modal__delete-group')
  })

  it('renders title-first article states without an operation column', () => {
    const base = {
      id: 'title-first-project', companyName: '标题先行公司', websiteUrl: 'https://example.test',
      websiteCrawl: { status: 'completed', incomplete: false, error: null, successCount: 2, discoveredCount: 2, failedCount: 0 },
      articleBatches: [{ id: 'title-batch', projectId: 'title-first-project', requestedModel: 'fixture', responseModel: 'fixture', generatedAt: '2026-09-04T01:00:00.000Z', articles: [
        { id: 'pending-article', projectId: 'title-first-project', batchId: 'title-batch', title: '待写作标题', questionPositions: [1], contentHtml: null, generatedAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z', writingStatus: 'pending' as const, writingError: null, optimizationType: '补充 FAQ', publishStatus: 'pending' as const, confirmedAt: null },
        { id: 'writing-article', projectId: 'title-first-project', batchId: 'title-batch', title: '写作中标题', questionPositions: [2], contentHtml: null, generatedAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z', writingStatus: 'writing' as const, writingError: null, optimizationType: '新增专题文章', publishStatus: 'pending' as const, confirmedAt: null },
        { id: 'ready-article', projectId: 'title-first-project', batchId: 'title-batch', title: '待发布标题', questionPositions: [3], contentHtml: '<p>正文</p>', generatedAt: '2026-09-04T01:00:00.000Z', updatedAt: '2026-09-04T01:00:00.000Z', writingStatus: 'ready' as const, writingError: null, optimizationType: '更新现有页面', publishStatus: 'pending' as const, confirmedAt: null },
      ] }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<OptimizationSuggestions project={base} busy={false} actionError="" onSaveWebsite={() => undefined} onGenerate={() => undefined} onConfirmPublished={async () => undefined} />)
    expect(html).toContain('文章标题')
    expect(html).toContain('优化方式')
    expect(html).toContain('最近更新')
    expect(html).toContain('待写作标题')
    expect(html).toContain('写稿：待写作标题')
    expect(html).toContain('写作中：写作中标题')
    expect(html).toContain('待发布')
    expect(html).not.toContain('articles-table__action')
  })

  it('merges out-of-order article snapshots by article timestamp and preserves new titles', () => {
    const current = {
      id: 'merge-project', updatedAt: '2026-09-06T02:00:00.000Z', articleBatches: [{ id: 'batch-1', projectId: 'merge-project', requestedModel: 'fixture', responseModel: 'fixture', generatedAt: '2026-09-06T01:00:00.000Z', articles: [
        { id: '1', projectId: 'merge-project', batchId: 'batch-1', title: '已有正文', questionPositions: [1], contentHtml: '<p>ready</p>', generatedAt: '2026-09-06T01:00:00.000Z', updatedAt: '2026-09-06T02:00:00.000Z', writingStatus: 'ready' as const, writingError: null, optimizationType: 'FAQ', publishStatus: 'pending' as const, confirmedAt: null },
      ] }],
    } as unknown as ProjectDetail
    const staleIncoming = {
      ...current,
      updatedAt: '2026-09-06T02:00:00.000Z',
      articleBatches: [{ ...current.articleBatches[0], articles: [
        { ...current.articleBatches[0].articles[0], contentHtml: null, updatedAt: '2026-09-06T01:30:00.000Z', writingStatus: 'writing' as const },
        { id: '2', projectId: 'merge-project', batchId: 'batch-1', title: '新增标题', questionPositions: [2], contentHtml: null, generatedAt: '2026-09-06T02:00:00.000Z', updatedAt: '2026-09-06T02:00:00.000Z', writingStatus: 'pending' as const, writingError: null, optimizationType: '专题', publishStatus: 'pending' as const, confirmedAt: null },
      ] }],
    } as unknown as ProjectDetail
    const merged = mergeProjectArticleSnapshots(current, staleIncoming)
    const mergedArticles = merged.articleBatches[0].articles
    expect(mergedArticles.find((article) => article.id === '1')?.writingStatus).toBe('ready')
    expect(mergedArticles.find((article) => article.id === '1')?.contentHtml).toContain('ready')
    expect(mergedArticles.some((article) => article.id === '2')).toBe(true)
  })

  it('does not resurrect an article explicitly deleted from the session', () => {
    const current = {
      id: 'delete-merge-project', updatedAt: '2026-09-06T02:00:00.000Z', articleBatches: [{ id: 'batch-1', projectId: 'delete-merge-project', requestedModel: 'fixture', responseModel: null, generatedAt: '2026-09-06T01:00:00.000Z', articles: [] }],
    } as unknown as ProjectDetail
    const staleIncoming = {
      ...current,
      articleBatches: [{ ...current.articleBatches[0], articles: [entryArticle({ id: 'deleted-1' })] }],
    } as unknown as ProjectDetail
    const merged = mergeProjectArticleSnapshots(current, staleIncoming, new Set(['deleted-1']))
    expect(merged.articleBatches.flatMap((batch) => batch.articles).map((article) => article.id)).not.toContain('deleted-1')
  })

  it('keeps article update time readable in the narrow table column', () => {
    expect(formatArticleUpdatedAt('2026-09-06T08:07:00.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatArticleUpdatedAt(null)).toBe('—')
  })

  it('renders current publish count and the latest completed round metrics', () => {
    const answers = Array.from({ length: 20 }, (_, index) => ({
      position: index + 1,
      question: `监测问题${index + 1}`,
      status: 'success' as const,
      answerText: `监测回答${index + 1}`,
      citationUrls: index === 0 ? ['https://example.test/source'] : [],
      responseModel: 'monitor-model',
      recommended: index < 8,
      officialCitation: index < 5,
      error: null,
      startedAt: '2026-09-04T01:00:00.000Z',
      completedAt: '2026-09-04T01:01:00.000Z',
    }))
    const project = {
      id: '5', companyName: '监测示例公司', websiteUrl: 'https://example.test', optimizationTarget: null, supplementalInfo: null,
      initialRecommendationRate: 0.25, initialOfficialCitationRate: 0.2,
      articleBatches: [{ id: 'published-batch', articles: [{ id: 'published-1', publishStatus: 'published' as const }] }],
      monitoringRuns: [
        { id: 'monitor-2', runType: 'monitoring' as const, roundNumber: 2, status: 'completed' as const, requestedModel: 'monitor-model', publishedArticleCount: 3, startedAt: '2026-09-04T01:00:00.000Z', completedAt: '2026-09-04T01:01:00.000Z', summaryAnalysis: null, summaryModel: 'monitor-model', summaryError: null, recommendationRate: 0.4, officialCitationRate: 0.35, answers },
        { id: 'monitor-1', runType: 'monitoring' as const, roundNumber: 1, status: 'failed' as const, requestedModel: 'monitor-model', publishedArticleCount: 1, startedAt: '2026-09-03T01:00:00.000Z', completedAt: null, summaryAnalysis: null, summaryModel: null, summaryError: '失败', recommendationRate: null, officialCitationRate: null, answers: [] },
      ],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)

    expect(html).toContain('monitoring-report-layout')
    expect(html).toContain('monitoring-main')
    expect(html.indexOf('monitoring-main')).toBeLessThan(html.indexOf('diagnosis-metrics monitoring-metrics'))
    expect(html).toContain('8 / 20')
    expect(html).toContain('7 / 20')
    expect(html).not.toContain('5 / 20 → 8 / 20')
    expect(html).not.toContain('4 / 20 → 7 / 20')
    expect(html).not.toContain('提升3个问题')
    expect(html).toContain('第 2 轮监测')
    expect(html).toContain('第 1 轮监测')
    expect(html).toContain('1篇')
    expect(html).toContain('当前已确认发布数量')
    expect(html).toContain('最近一次成功监测')
    expect(html).toContain('监测回答1')
    expect(html).not.toContain('diagnosis-answer-table-header')
    expect(html).not.toContain('AI 回答全文')

    const metrics = html.slice(html.indexOf('<aside class="diagnosis-metrics monitoring-metrics"'))
    expect(metrics.indexOf('已确认发布')).toBeLessThan(metrics.indexOf('推荐率'))
    expect(metrics.indexOf('推荐率')).toBeLessThan(metrics.indexOf('官网引用率'))
  })

  it('counts current published articles even when no monitoring has run', () => {
    const project = {
      id: 'monitoring-empty-metrics', companyName: '无监测公司', websiteUrl: null,
      initialRecommendationRate: 0.4, initialOfficialCitationRate: 0.3,
      articleBatches: [], questions: [], monitoringRuns: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const metrics = html.slice(html.indexOf('<aside class="diagnosis-metrics monitoring-metrics"'))

    expect(metrics).toContain('0篇')
    expect(metrics).toContain('当前已确认发布数量')
    expect(metrics).toContain('尚未监测')
    expect(metrics).toContain('未配置官网')
    expect(metrics).not.toContain('未配置官网 / 不可计算')
    expect(metrics).not.toContain('待诊断')
    expect(metrics).not.toContain('最近一次成功监测')
  })

  it('reflects article confirmation and a new completed run from the updated project snapshot without mutating the old one', () => {
    const article = {
      id: 'article-1', projectId: 'monitoring-update', batchId: 'batch-1', title: '文章', publishStatus: 'pending' as const,
    }
    const completedRun = {
      id: 'round-1', runType: 'monitoring' as const, roundNumber: 1, status: 'completed' as const,
      requestedModel: 'monitor-model', publishedArticleCount: 0, startedAt: '2026-09-04T01:00:00.000Z', completedAt: '2026-09-04T01:01:00.000Z',
      summaryAnalysis: null, summaryModel: 'monitor-model', summaryError: null, recommendationRate: 0.2, officialCitationRate: 0.1, answers: [],
    }
    const before = {
      id: 'monitoring-update', companyName: '更新公司', websiteUrl: 'https://example.test',
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [],
      articleBatches: [{ id: 'batch-1', articles: [article] }], monitoringRuns: [completedRun],
    } as unknown as ProjectDetail
    const after = {
      ...before,
      articleBatches: [{ id: 'batch-1', articles: [{ ...article, publishStatus: 'published' as const }] }],
      monitoringRuns: [{ ...completedRun, id: 'round-2', roundNumber: 2, recommendationRate: 0.3, officialCitationRate: 0.25 }],
    } as unknown as ProjectDetail

    const beforeHtml = renderToStaticMarkup(<MonitoringDashboard project={before} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const afterHtml = renderToStaticMarkup(<MonitoringDashboard project={after} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const beforeMetrics = beforeHtml.slice(beforeHtml.indexOf('<aside class="diagnosis-metrics monitoring-metrics"'))
    const afterMetrics = afterHtml.slice(afterHtml.indexOf('<aside class="diagnosis-metrics monitoring-metrics"'))

    expect(beforeMetrics).toContain('0篇')
    expect(beforeMetrics).toContain('4 / 20')
    expect(afterMetrics).toContain('1篇')
    expect(afterMetrics).toContain('6 / 20')
    expect(afterMetrics).toContain('5 / 20')
    expect(before.articleBatches[0].articles[0].publishStatus).toBe('pending')
  })

  it('keeps the latest successful metrics while newer running or failed rounds are present', () => {
    const run = (overrides: Record<string, unknown>) => ({
      id: 'run', runType: 'monitoring' as const, roundNumber: 1, status: 'completed' as const,
      requestedModel: 'monitor-model', publishedArticleCount: 0, startedAt: '2026-09-04T01:00:00.000Z', completedAt: '2026-09-04T01:01:00.000Z',
      summaryAnalysis: null, summaryModel: 'monitor-model', summaryError: null, recommendationRate: null, officialCitationRate: null, answers: [],
      ...overrides,
    })
    const project = {
      id: 'monitoring-in-flight', companyName: '进行中公司', websiteUrl: 'https://example.test',
      initialRecommendationRate: 0.1, initialOfficialCitationRate: 0.1, questions: [], articleBatches: [],
      // Deliberately unsorted: a failed round is newest, while the completed
      // round is the only valid source for the right-side metrics.
      monitoringRuns: [
        run({ id: 'failed-4', roundNumber: 4, status: 'failed', completedAt: null, summaryError: '失败' }),
        run({ id: 'completed-2', roundNumber: 2, recommendationRate: 0.45, officialCitationRate: 0.35 }),
        run({ id: 'running-3', roundNumber: 3, status: 'running', completedAt: null }),
      ],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const metrics = html.slice(html.indexOf('<aside class="diagnosis-metrics monitoring-metrics"'))

    expect(metrics).toContain('9 / 20')
    expect(metrics).toContain('7 / 20')
    expect(metrics).not.toContain('尚未监测')
    expect(html).toContain('第 4 轮监测')
    expect(html).toContain('第 3 轮监测')
    expect(html).toContain('第 2 轮监测')
  })

  it('uses the 开始监测 action with no monitoring history', () => {
    const project = {
      id: 'monitoring-empty', companyName: '尚未监测公司', websiteUrl: null,
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [], monitoringRuns: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('开始监测')
    expect(html).toContain('导出交付报告')
    expect(html).not.toContain('一键优化')
    expect(actionArea).not.toContain('继续监测')
    expect(actionArea).not.toContain('>重试<')
    expect(actionArea).not.toContain('disabled=""')
    expect(actionArea).not.toContain('role="alert"')
  })

  it('keeps monitoring failure feedback without a retry action', () => {
    const project = {
      id: 'monitoring-failed', companyName: '监测失败公司', websiteUrl: null,
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [],
      monitoringRuns: [{
        id: 'failed-round', runType: 'monitoring' as const, roundNumber: 1, status: 'failed' as const,
        requestedModel: 'monitor-model', publishedArticleCount: 0,
        startedAt: '2026-09-04T01:00:00.000Z', completedAt: null,
        summaryAnalysis: null, summaryModel: null, summaryError: '豆包请求超时，请点击重试',
        recommendationRate: null, officialCitationRate: null, answers: [],
      }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('开始监测')
    expect(actionArea).toContain('本轮监测失败，请点击开始监测 原始错误：豆包请求超时，请点击重试')
    expect(actionArea).toContain('role="alert"')
    expect(actionArea).not.toContain('继续监测')
    expect(actionArea).not.toContain('>重试<')
    expect(actionArea).not.toContain('monitoring-operation-retry')
  })

  it('shows a start monitoring instruction when a failed run has no summary error', () => {
    const project = {
      id: 'monitoring-failed-empty-summary', companyName: '监测汇总失败公司', websiteUrl: null,
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [],
      monitoringRuns: [{
        id: 'failed-round-empty-summary', runType: 'monitoring' as const, roundNumber: 1, status: 'failed' as const,
        requestedModel: 'monitor-model', publishedArticleCount: 0,
        startedAt: '2026-09-04T01:00:00.000Z', completedAt: null,
        summaryAnalysis: null, summaryModel: null, summaryError: null,
        recommendationRate: null, officialCitationRate: null, answers: [],
      }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('本轮监测失败，请点击开始监测')
    expect(actionArea).toContain('role="alert"')
    expect(actionArea).not.toContain('重试')
    expect(actionArea).not.toContain('继续监测')
  })

  it('directs monitoring action errors to 开始监测 while preserving the error reason', () => {
    const project = {
      id: 'monitoring-action-error', companyName: '监测操作失败公司', websiteUrl: null,
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [], monitoringRuns: [],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="数据库连接失败，请稍后重试" progress={null} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('数据库连接失败，请稍后重试')
    expect(actionArea).toContain('开始监测')
    expect(actionArea).toContain('role="alert"')
    expect(actionArea).toContain('请稍后重试')
    expect(actionArea).not.toContain('>重试<')
    expect(actionArea).not.toContain('继续监测')
  })

  it('keeps normal monitoring progress in the original operation feedback position', () => {
    const html = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 4, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('4 / 20 已完成')
    expect(actionArea).not.toContain('正在统计推荐和引用')
  })

  it('shows a continuous monitoring progress bar only while monitoring is busy', () => {
    const running = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 4, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const runningActionArea = monitoringActionArea(running)
    expect(runningActionArea.match(/4 \/ 20 已完成/g)).toHaveLength(1)
    expect(runningActionArea).toContain('role="progressbar"')
    expect(runningActionArea).toContain('aria-label="持续监测进度"')
    expect(runningActionArea).toContain('aria-valuemin="0"')
    expect(runningActionArea).toContain('aria-valuemax="20"')
    expect(runningActionArea).toContain('aria-valuenow="4"')
    expect(runningActionArea).toContain('style="width:20%"')
    expect(runningActionArea).toContain('diagnosis-feedback-progress')
    expect(runningActionArea).toContain('monitoring-feedback-progress__label')

    const complete = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 20, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const completeActionArea = monitoringActionArea(complete)
    expect(completeActionArea).toContain('20 / 20 已完成 · 正在统计推荐和引用…')
    expect(completeActionArea).toContain('aria-valuenow="20"')
    expect(completeActionArea).toContain('style="width:100%"')

    const failed = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 19, failedCount: 1, total: 20 }} actionError="" onStart={() => undefined} />)
    const failedActionArea = monitoringActionArea(failed)
    expect(failedActionArea).toContain('19 / 20 已完成 · 1 个失败')
    expect(failedActionArea).toContain('style="width:95%"')

    const idle = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy={false} progress={{ completedCount: 4, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    expect(monitoringActionArea(idle)).not.toContain('role="progressbar"')

    const clamped = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 25, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const clampedActionArea = monitoringActionArea(clamped)
    expect(clampedActionArea).toContain('aria-valuenow="20"')
    expect(clampedActionArea).toContain('style="width:100%"')
  })

  it('shows the recommendation and citation aggregation state at 20 / 20', () => {
    const html = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 20, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('20 / 20 已完成 · 正在统计推荐和引用…')
  })

  it('keeps the failure count for incomplete monitoring progress and hides progress while idle', () => {
    const incompleteHtml = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy progress={{ completedCount: 19, failedCount: 1, total: 20 }} actionError="" onStart={() => undefined} />)
    const incompleteActionArea = monitoringActionArea(incompleteHtml)
    expect(incompleteActionArea).toContain('19 / 20 已完成 · 1 个失败')
    expect(incompleteActionArea).not.toContain('正在统计推荐和引用')

    const idleHtml = renderToStaticMarkup(<MonitoringDashboard project={monitoringProgressProject()} busy={false} progress={{ completedCount: 20, failedCount: 0, total: 20 }} actionError="" onStart={() => undefined} />)
    const idleActionArea = monitoringActionArea(idleHtml)
    expect(idleActionArea).not.toContain('monitoring-operation-feedback')
    expect(idleActionArea).not.toContain('正在统计推荐和引用')
  })

  it('keeps PDF preparation and saving state handling without an independent process notice', () => {
    expect(appSource).not.toContain('deliveryReportNotice')
    expect(appSource).not.toContain('monitoring-delivery-report-status')
    expect(appSource).toContain("t('monitoring.pdfPreparing')")
    expect(appSource).toContain("t('monitoring.pdfSaving')")
    expect(appSource).toContain("setReportPdfState('generating')")
    expect(appSource).toContain("setReportPdfState('saving')")
  })

  it('keeps streamed monitoring runs in round order and ignores late answers after completion', () => {
    const persistedAnswer: DiagnosisAnswer = {
      position: 1,
      question: '监测问题1',
      status: 'success',
      answerText: '已保存回答',
      citationUrls: [],
      responseModel: 'monitor-model',
      recommended: true,
      officialCitation: true,
      error: null,
      startedAt: '2026-09-08T07:00:00.000Z',
      completedAt: '2026-09-08T07:00:01.000Z',
    }
    const current = {
      ...monitoringProgressProject(),
      monitoringRuns: [
        monitoringRunFixture({ id: 'monitoring-run-4', roundNumber: 4, status: 'completed', answers: [] }),
        monitoringRunFixture({ id: 'monitoring-run-2', roundNumber: 2, status: 'failed', answers: [] }),
      ],
    }
    const streamedRun = monitoringRunFixture({ id: 'monitoring-run-5', roundNumber: 5, answers: [persistedAnswer] })

    const withRun = mergeMonitoringUpdate(current, current.id, { type: 'run', run: streamedRun })
    expect(withRun?.monitoringRuns.map((run) => run.id)).toEqual(['monitoring-run-5', 'monitoring-run-4', 'monitoring-run-2'])

    const completedRun = { ...streamedRun, status: 'completed' as const, completedAt: '2026-09-08T07:01:00.000Z' }
    const completed = mergeMonitoringUpdate(withRun, current.id, { type: 'run', run: completedRun })
    expect(completed?.monitoringRuns.map((run) => run.id)).toEqual(['monitoring-run-5', 'monitoring-run-4', 'monitoring-run-2'])

    const lateAnswer = {
      ...persistedAnswer,
      answerText: null,
      responseModel: null,
      recommended: null,
      officialCitation: null,
      completedAt: null,
    }
    const afterLateAnswer = mergeMonitoringUpdate(completed, current.id, { type: 'answer', runId: streamedRun.id, answer: lateAnswer })
    expect(afterLateAnswer).toBe(completed)
    expect(afterLateAnswer?.monitoringRuns[0].answers[0]).toEqual(persistedAnswer)
  })

  it('prioritizes live monitoring progress over an earlier failure', () => {
    const project = {
      id: 'monitoring-busy', companyName: '监测进行中公司', websiteUrl: null,
      initialRecommendationRate: null, initialOfficialCitationRate: null, questions: [],
      monitoringRuns: [{
        id: 'failed-round-before-busy', runType: 'monitoring' as const, roundNumber: 1, status: 'failed' as const,
        requestedModel: 'monitor-model', publishedArticleCount: 0,
        startedAt: '2026-09-04T01:00:00.000Z', completedAt: null,
        summaryAnalysis: null, summaryModel: null, summaryError: '上一轮失败，请点击重试',
        recommendationRate: null, officialCitationRate: null, answers: [],
      }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy actionError="监测暂时失败，请稍后重试" progress={{ completedCount: 4, failedCount: 1, total: 20 }} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('监测进行中…')
    expect(actionArea).toContain('4 / 20 已完成 · 1 个失败')
    expect(actionArea).toContain('disabled=""')
    expect(actionArea).not.toContain('上一轮失败')
    expect(actionArea).not.toContain('监测暂时失败')
    expect(actionArea).not.toContain('开始监测')
    expect(actionArea).not.toContain('继续监测')
    expect(actionArea).not.toContain('重试')
    expect(actionArea).not.toContain('role="alert"')
  })

  it('uses the 开始监测 action after a completed monitoring history', () => {
    const project = {
      id: 'monitoring-completed', companyName: '已完成监测公司', websiteUrl: null,
      initialRecommendationRate: 0.25, initialOfficialCitationRate: null, questions: [],
      monitoringRuns: [{
        id: 'completed-round', runType: 'monitoring' as const, roundNumber: 1, status: 'completed' as const,
        requestedModel: 'monitor-model', publishedArticleCount: 2,
        startedAt: '2026-09-04T01:00:00.000Z', completedAt: '2026-09-04T01:01:00.000Z',
        summaryAnalysis: { results: [] }, summaryModel: 'monitor-model', summaryError: null,
        recommendationRate: 0.4, officialCitationRate: null, answers: [],
      }],
    } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<MonitoringDashboard project={project} busy={false} actionError="" progress={null} onStart={() => undefined} />)
    const actionArea = monitoringActionArea(html)

    expect(actionArea).toContain('开始监测')
    expect(actionArea).not.toContain('继续监测')
    expect(actionArea).not.toContain('重试')
    expect(actionArea).not.toContain('role="alert"')
    expect(actionArea).not.toContain('disabled=""')
  })

  it('keeps the settings icon space without a visible frame', () => {
    const html = renderToStaticMarkup(<GlobalHeader onHome={() => undefined} />)

    expect(html).toContain('settings-button')
  })
})
