import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetail } from './db.ts'

const mocks = vi.hoisted(() => ({
  getProjectDetail: vi.fn(),
  saveArticleTitles: vi.fn(),
  withArticleTitleGenerationLock: vi.fn(),
  claimArticleWriting: vi.fn(),
  completeArticleWriting: vi.fn(),
  failArticleWriting: vi.fn(),
  assertContentAuditCurrent: vi.fn(),
  getArticleProjectId: vi.fn(),
  getContentAuditRecord: vi.fn(),
  contentAuditResultEligible: vi.fn(),
  generateArticleTitles: vi.fn(),
  generateArticleBody: vi.fn(),
  ArticleGenerationError: class extends Error {},
}))

vi.mock('./db.ts', () => ({
  getProjectDetail: mocks.getProjectDetail,
  saveArticleTitles: mocks.saveArticleTitles,
  withArticleTitleGenerationLock: mocks.withArticleTitleGenerationLock,
  claimArticleWriting: mocks.claimArticleWriting,
  completeArticleWriting: mocks.completeArticleWriting,
  failArticleWriting: mocks.failArticleWriting,
  assertContentAuditCurrent: mocks.assertContentAuditCurrent,
  getArticleProjectId: mocks.getArticleProjectId,
  getContentAuditRecord: mocks.getContentAuditRecord,
  contentAuditResultEligible: mocks.contentAuditResultEligible,
}))
vi.mock('./article-generator.ts', () => ({
  ArticleGenerationError: mocks.ArticleGenerationError,
  generateArticleTitles: mocks.generateArticleTitles,
  generateArticleBody: mocks.generateArticleBody,
}))

const { ArticleServiceError, generateProjectArticles, startArticleWriting } = await import('./articles.ts')

const completedAudit = {
  status: 'completed' as const,
  startedAt: '2026-09-06T05:03:30.000Z',
  completedAt: '2026-09-06T05:03:31.000Z',
  progress: { stage: 'checking' as const, totalPages: 1, processedPages: 1, totalClaims: 0, processedClaims: 0 },
  result: { checkedAt: '2026-09-06T05:03:31.000Z', items: [] },
  error: null,
  executionErrors: [],
  usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getArticleProjectId.mockResolvedValue('1')
  mocks.getContentAuditRecord.mockResolvedValue(completedAudit)
  mocks.contentAuditResultEligible.mockImplementation((record: unknown) => record === completedAudit)
  mocks.assertContentAuditCurrent.mockResolvedValue(undefined)
})

function detail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: '1',
    companyName: '示例公司',
    websiteUrl: 'https://example.test',
    optimizationTarget: '服务',
    supplementalInfo: null,
    questionsGeneratedAt: '2026-09-06T05:00:00.000Z',
    questionsLockedAt: '2026-09-06T05:01:00.000Z',
    diagnosisStartedAt: '2026-09-06T05:02:00.000Z',
    initialDiagnosisCompletedAt: '2026-09-06T05:03:00.000Z',
    initialDiagnosisStatus: 'completed',
    initialRecommendationRate: 1,
    initialOfficialCitationRate: 1,
    initialDiagnosisAt: '2026-09-06T05:03:00.000Z',
    latestMonitoringAt: null,
    latestRecommendationRate: null,
    latestOfficialCitationRate: null,
    websiteLockedAt: null,
    websiteCrawlStatus: 'completed',
    websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    websiteCrawlCompletedAt: '2026-09-06T05:00:01.000Z',
    websiteCrawlError: null,
    websiteCrawlSource: 'links',
    websiteCrawlIncomplete: false,
    websitePagesDiscovered: 1,
    websitePagesSucceeded: 1,
    websitePagesFailed: 0,
    questionsGenerationStatus: 'completed',
    questionsGenerationStartedAt: '2026-09-06T05:00:00.000Z',
    questionsGenerationCompletedAt: '2026-09-06T05:00:00.000Z',
    questionsGenerationError: null,
    createdAt: '2026-09-06T05:00:00.000Z',
    updatedAt: '2026-09-06T05:03:00.000Z',
    websiteCrawl: {
      status: 'completed', source: 'links', incomplete: false, error: null,
      discoveredCount: 1, successCount: 1, failedCount: 0,
      startedAt: '2026-09-06T05:00:00.000Z', completedAt: '2026-09-06T05:00:01.000Z',
    },
    questionsGeneration: { status: 'completed', error: null, startedAt: null, completedAt: null },
    questions: Array.from({ length: 20 }, (_, index) => ({
      id: `question-${index + 1}`,
      position: index + 1,
      question: `问题${index + 1}`,
      generatedAt: '2026-09-06T05:00:00.000Z',
      category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision',
      isLocked: false,
    })),
    initialDiagnosis: {
      run: {
        id: 'run-1', runType: 'initial', status: 'completed', requestedModel: 'model', roundNumber: 0,
        publishedArticleCount: null, startedAt: '2026-09-06T05:02:00.000Z', completedAt: '2026-09-06T05:03:00.000Z',
        summaryAnalysis: null, summaryModel: 'model', summaryError: null, recommendationRate: 1, officialCitationRate: 1,
      },
      answers: Array.from({ length: 20 }, (_, index) => ({
        position: index + 1, question: `问题${index + 1}`, status: 'success' as const,
        answerText: '回答', citationUrls: [], responseModel: 'model', recommended: true,
        officialCitation: true, error: null, startedAt: null, completedAt: null,
      })),
      reportPdfReady: true, reportPdfGeneratedAt: '2026-09-06T05:03:01.000Z',
    },
    monitoringRuns: [],
    articleBatches: [],
    deliveryReport: { reportPdfReady: false, reportPdfGeneratedAt: null, sourceRunId: null },
    ...overrides,
  }
}

describe('title-first article service', () => {
  it('gates title generation on a completed content audit before the model call', async () => {
    mocks.getProjectDetail.mockResolvedValueOnce(detail())
    mocks.getContentAuditRecord.mockResolvedValueOnce(null)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockClear()

    await expect(generateProjectArticles('1')).rejects.toMatchObject({
      constructor: ArticleServiceError,
      message: 'content_audit_required',
    })
    expect(mocks.generateArticleTitles).not.toHaveBeenCalled()
    expect(mocks.saveArticleTitles).not.toHaveBeenCalled()
  })

  it('allows planning after a failed current content audit without reusing old website material', async () => {
    const current = detail()
    const failedAudit = {
      ...completedAudit,
      status: 'failed' as const,
      startedAt: '2026-09-06T06:03:30.000Z',
      completedAt: null,
      result: null,
      error: '官网内容检查失败',
      executionErrors: [{ stage: 'model', message: 'failed' }],
    }
    mocks.getContentAuditRecord.mockResolvedValue(failedAudit)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockResolvedValueOnce({ responseModel: 'model', articles: [{ title: '业务资料文章', questionPositions: [1], optimizationType: '新增文章', targetPageUrl: null }] })
    mocks.saveArticleTitles.mockResolvedValueOnce({ id: 'batch-1', articles: [] })

    await expect(generateProjectArticles('1')).resolves.toMatchObject({ addedCount: 1 })
    expect(mocks.generateArticleTitles.mock.calls[0]?.[0]).toMatchObject({ contentAudit: null })
    expect(mocks.saveArticleTitles).toHaveBeenCalledWith(
      '1', '', 'model', expect.any(Array), 'run-1', expect.any(Object), failedAudit.startedAt, current.updatedAt, undefined,
    )
  })

  it('accepts a zero-title plan after a failed audit while guarding the same audit lifecycle', async () => {
    const current = detail()
    const failedAudit = {
      ...completedAudit,
      status: 'failed' as const,
      startedAt: '2026-09-06T06:03:30.000Z',
      completedAt: '2026-09-06T06:03:31.000Z',
      result: null,
      error: '官网内容检查失败',
      executionErrors: [{ stage: 'model', message: 'failed' }],
    }
    mocks.getContentAuditRecord.mockResolvedValue(failedAudit)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockResolvedValueOnce({ responseModel: 'model', articles: [] })

    await expect(generateProjectArticles('1')).resolves.toMatchObject({ addedCount: 0 })
    expect(mocks.assertContentAuditCurrent).toHaveBeenCalledWith('1', failedAudit.startedAt, expect.any(Object))
    expect(mocks.saveArticleTitles).not.toHaveBeenCalled()
  })

  it('rechecks the current audit before accepting a zero-title plan', async () => {
    const current = detail()
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockResolvedValueOnce({ responseModel: 'model', articles: [] })

    await expect(generateProjectArticles('1')).resolves.toMatchObject({ addedCount: 0 })
    expect(mocks.assertContentAuditCurrent).toHaveBeenCalledWith('1', completedAudit.startedAt, expect.any(Object))
    expect(mocks.saveArticleTitles).not.toHaveBeenCalled()
  })

  it('does not gate an existing body task on the current content audit', async () => {
    const current = detail()
    mocks.getArticleProjectId.mockResolvedValueOnce('1')
    mocks.getContentAuditRecord.mockResolvedValueOnce(null)
    const claim = {
      article: {
        id: 'article-no-audit', projectId: '1', batchId: 'batch-1', title: '已有任务', questionPositions: [1],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '新增文章', optimizationDirection: '主题内容补充',
        targetPageUrl: null, targetPageTitle: null,
      },
      attemptToken: 'attempt-no-audit', source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: null },
    }
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockResolvedValueOnce({ contentHtml: '<p>正文</p>', responseModel: 'body-model' })
    mocks.completeArticleWriting.mockResolvedValueOnce({ ...claim.article, contentHtml: '<p>正文</p>', writingStatus: 'ready' })

    await expect(startArticleWriting('article-no-audit')).resolves.toMatchObject({ project: current })
    expect(mocks.claimArticleWriting).toHaveBeenCalledWith('article-no-audit', undefined)
    expect(mocks.generateArticleBody).toHaveBeenCalledTimes(1)
  })

  it('does not depend on the retired full website cache during planning', async () => {
    const current = detail({ websiteCrawlStatus: 'crawling', websitePagesSucceeded: 0 })
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockResolvedValueOnce({ responseModel: 'model', articles: [] })

    await expect(generateProjectArticles('1')).resolves.toMatchObject({ addedCount: 0 })
    expect(mocks.generateArticleTitles).toHaveBeenCalledTimes(1)
    expect(mocks.saveArticleTitles).not.toHaveBeenCalled()
  })

  it('saves titles with the website URL and crawl marker, without requesting bodies', async () => {
    const current = detail()
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleTitles.mockResolvedValue({
      responseModel: 'model',
      articles: Array.from({ length: 3 }, (_, index) => ({ title: `标题${index + 1}`, questionPositions: [index + 1], optimizationType: '新增文章', targetPageUrl: null })),
    })
    mocks.withArticleTitleGenerationLock.mockImplementation(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.saveArticleTitles.mockResolvedValue({ id: 'batch-1', articles: [] })

    const result = await generateProjectArticles('1')

    expect(mocks.saveArticleTitles).toHaveBeenCalledWith(
      '1', '', 'model', expect.any(Array),
      'run-1', expect.any(Object), completedAudit.startedAt, current.updatedAt, undefined,
    )
    expect(mocks.saveArticleTitles.mock.calls.at(-1)?.[3]).toHaveLength(3)
    expect(mocks.generateArticleTitles).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ timeoutMs: 0, onTiming: expect.any(Function) }),
    )
    expect(result).toMatchObject({ addedCount: 3, project: current })
  })

  it('passes dynamic title counts without a fixed cap', async () => {
    const current = detail()
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementation(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    for (const count of [1, 5, 21]) {
      mocks.generateArticleTitles.mockResolvedValue({
        responseModel: 'model',
        articles: Array.from({ length: count }, (_, index) => ({ title: `标题${count}-${index}`, questionPositions: [(index % 20) + 1], optimizationType: '新增文章', targetPageUrl: null })),
      })
      mocks.saveArticleTitles.mockClear()
      const result = await generateProjectArticles('1')
      expect(result?.addedCount).toBe(count)
      expect(mocks.saveArticleTitles.mock.calls.at(-1)?.[3]).toHaveLength(count)
    }
  })

  it('accepts an empty title result without creating a batch', async () => {
    const current = detail()
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.withArticleTitleGenerationLock.mockImplementationOnce(async (_id: string, operation: (client: unknown) => unknown) => operation({}))
    mocks.generateArticleTitles.mockResolvedValue({ responseModel: 'model', articles: [] })
    mocks.saveArticleTitles.mockClear()

    await expect(generateProjectArticles('1')).resolves.toMatchObject({ addedCount: 0 })
    expect(mocks.saveArticleTitles).not.toHaveBeenCalled()
  })

  it('writes exactly one claimed article body without calling title generation', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-1', projectId: '1', batchId: 'batch-1', title: '指定标题', questionPositions: [1],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '补充 FAQ', optimizationDirection: '补充 FAQ',
      },
      attemptToken: 'attempt-1',
      source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: current.websiteCrawlStartedAt },
    }
    mocks.generateArticleTitles.mockClear()
    mocks.generateArticleBody.mockClear()
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockResolvedValueOnce({ contentHtml: '<p>单篇正文</p>', responseModel: 'body-model' })
    mocks.completeArticleWriting.mockResolvedValueOnce({ ...claim.article, contentHtml: '<p>单篇正文</p>', writingStatus: 'ready' })
    mocks.failArticleWriting.mockClear()

    const result = await startArticleWriting('article-1')

    expect(result).toMatchObject({ project: current })
    expect(mocks.generateArticleTitles).not.toHaveBeenCalled()
    expect(mocks.generateArticleBody).toHaveBeenCalledTimes(1)
    expect(mocks.generateArticleBody).toHaveBeenCalledWith(
      expect.any(Object), '指定标题', [1], '新增文章', '补充 FAQ',
      expect.objectContaining({ bodyTimeoutMs: 0, onTiming: expect.any(Function) }), null,
    )
    expect(mocks.completeArticleWriting).toHaveBeenCalledWith(
      'article-1', 'attempt-1', '<p>单篇正文</p>', claim.source,
    )
    expect(mocks.failArticleWriting).not.toHaveBeenCalled()
  })

  it('reads only a bound update target temporarily and never loads the website cache', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-update-read', projectId: '1', batchId: 'batch-1', title: '更新标题', questionPositions: [],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ',
        targetPageUrl: 'https://example.test/services', targetPageTitle: '服务',
      },
      attemptToken: 'attempt-update-read', source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: null },
    }
    const readTargetPage = vi.fn().mockResolvedValue({
      url: 'https://example.test/services', title: '服务原文', bodyText: '原文正文',
    })
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockResolvedValueOnce({ contentHtml: '<p>更新正文</p>', responseModel: 'body-model' })
    mocks.completeArticleWriting.mockResolvedValueOnce({ ...claim.article, contentHtml: '<p>更新正文</p>', writingStatus: 'ready' })

    await expect(startArticleWriting('article-update-read', { readTargetPage })).resolves.toMatchObject({ project: current })
    expect(readTargetPage).toHaveBeenCalledWith(current.websiteUrl, claim.article.targetPageUrl, undefined)
    expect(mocks.generateArticleBody).toHaveBeenCalledWith(
      expect.any(Object), '更新标题', [], '更新已有文章', '补充 FAQ',
      expect.objectContaining({ bodyTimeoutMs: 0 }), expect.objectContaining({ bodyText: '原文正文' }),
    )
  })

  it('keeps a bound update task as an update when its temporary target read fails', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-update-failed', projectId: '1', batchId: 'batch-1', title: '更新标题', questionPositions: [1],
        contentHtml: '<p>旧草稿</p>', generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '更新已有文章', optimizationDirection: '主题内容补充',
        targetPageUrl: 'https://example.test/services', targetPageTitle: '服务',
      },
      attemptToken: 'attempt-update-failed', source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: null },
    }
    const readTargetPage = vi.fn().mockRejectedValue(new Error('target_fetch_failed'))
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.failArticleWriting.mockResolvedValueOnce(true)

    await expect(startArticleWriting('article-update-failed', { readTargetPage })).rejects.toThrow('target_fetch_failed')
    expect(mocks.generateArticleBody).not.toHaveBeenCalled()
    expect(mocks.completeArticleWriting).not.toHaveBeenCalled()
    expect(mocks.failArticleWriting).toHaveBeenCalledWith('article-update-failed', 'attempt-update-failed', 'target_fetch_failed')
  })

  it('treats an unbound legacy update row as a new article without rewriting its stored fields', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-legacy-update', projectId: '1', batchId: 'batch-1', title: '历史任务', questionPositions: [1],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '更新已有文章', optimizationDirection: null,
        targetPageUrl: null, targetPageTitle: null,
      },
      attemptToken: 'attempt-legacy-update', source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: null },
    }
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockResolvedValueOnce({ contentHtml: '<p>正文</p>', responseModel: 'body-model' })
    mocks.completeArticleWriting.mockResolvedValueOnce({ ...claim.article, contentHtml: '<p>正文</p>', writingStatus: 'ready' })

    await expect(startArticleWriting('article-legacy-update')).resolves.toMatchObject({ project: current })
    expect(mocks.generateArticleBody.mock.calls.at(-1)?.[3]).toBe('新增文章')
    expect(mocks.generateArticleBody.mock.calls.at(-1)?.[6]).toBeNull()
  })

  it('fails a bound update task when its original page binding is invalid', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-update', projectId: '1', batchId: 'batch-1', title: '更新标题', questionPositions: [1],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '更新已有文章', targetPageUrl: 'not-a-url', targetPageTitle: null,
      },
      attemptToken: 'attempt-update',
      source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: current.websiteCrawlStartedAt },
    }
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockClear()
    mocks.failArticleWriting.mockResolvedValueOnce(true)

    await expect(startArticleWriting('article-update')).rejects.toMatchObject({
      constructor: ArticleServiceError,
      message: 'article_target_unavailable',
    })
    expect(mocks.generateArticleBody).not.toHaveBeenCalled()
    expect(mocks.failArticleWriting).toHaveBeenCalledWith('article-update', 'attempt-update', 'article_target_unavailable')
  })

  it('normalizes legacy article categories to the same new/update input labels', async () => {
    const current = detail({
      articleBatches: [{
        id: 'batch-legacy', projectId: '1', requestedModel: 'model', responseModel: 'model', generatedAt: '2026-09-06T05:04:00.000Z',
        articles: [{
          id: 'legacy-article', projectId: '1', batchId: 'batch-legacy', title: '历史FAQ', questionPositions: [2], contentHtml: null,
          generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z', publishStatus: 'pending', confirmedAt: null,
          writingStatus: 'pending', writingError: null, optimizationType: '补充 FAQ', optimizationDirection: null, targetPageUrl: null, targetPageTitle: null,
        }],
      }],
    })
    const claim = {
      article: {
        id: 'article-new', projectId: '1', batchId: 'batch-1', title: '新文章', questionPositions: [1],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '新增专题文章', targetPageUrl: null, targetPageTitle: null,
      },
      attemptToken: 'attempt-new',
      source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: current.websiteCrawlStartedAt },
    }
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockResolvedValueOnce({ contentHtml: '<p>正文</p>', responseModel: 'body-model' })
    mocks.completeArticleWriting.mockResolvedValueOnce({ ...claim.article, contentHtml: '<p>正文</p>', writingStatus: 'ready' })

    await startArticleWriting('article-new')

    expect(mocks.generateArticleBody.mock.calls.at(-1)?.[0].existingArticles).toEqual([expect.objectContaining({
      title: '历史FAQ', optimizationType: '新增文章', targetPageUrl: null, targetPageTitle: null,
    })])
    expect(mocks.generateArticleBody.mock.calls.at(-1)?.[3]).toBe('新增文章')
  })

  it('records a body-generation failure with the claimed attempt token', async () => {
    const current = detail()
    const claim = {
      article: {
        id: 'article-2', projectId: '1', batchId: 'batch-1', title: '失败标题', questionPositions: [2],
        contentHtml: null, generatedAt: '2026-09-06T05:04:00.000Z', updatedAt: '2026-09-06T05:04:00.000Z',
        publishStatus: 'pending' as const, confirmedAt: null, writingStatus: 'writing' as const,
        writingError: null, optimizationType: '新增专题文章',
      },
      attemptToken: 'attempt-2',
      source: { websiteUrl: current.websiteUrl as string, websiteCrawlStartedAt: current.websiteCrawlStartedAt },
    }
    mocks.claimArticleWriting.mockResolvedValueOnce(claim)
    mocks.getProjectDetail.mockResolvedValue(current)
    mocks.generateArticleBody.mockRejectedValueOnce(new Error('body_fixture_failed'))
    mocks.failArticleWriting.mockResolvedValueOnce(true)

    await expect(startArticleWriting('article-2')).rejects.toThrow('body_fixture_failed')
    expect(mocks.generateArticleBody).toHaveBeenCalledTimes(1)
    expect(mocks.failArticleWriting).toHaveBeenCalledWith('article-2', 'attempt-2', 'body_fixture_failed')
    expect(mocks.completeArticleWriting).not.toHaveBeenCalled()
  })

  it('does not call a model when the article claim is already active', async () => {
    mocks.claimArticleWriting.mockRejectedValueOnce(new Error('article_writing_in_progress'))
    mocks.generateArticleTitles.mockClear()
    mocks.generateArticleBody.mockClear()
    mocks.failArticleWriting.mockClear()

    await expect(startArticleWriting('article-active')).rejects.toThrow('article_writing_in_progress')
    expect(mocks.generateArticleTitles).not.toHaveBeenCalled()
    expect(mocks.generateArticleBody).not.toHaveBeenCalled()
    expect(mocks.failArticleWriting).not.toHaveBeenCalled()
  })
})
