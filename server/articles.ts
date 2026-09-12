import process from 'node:process'
import {
  claimArticleWriting,
  completeArticleWriting,
  failArticleWriting,
  getArticleProjectId,
  getContentAuditRecord,
  assertContentAuditCurrent,
  contentAuditResultEligible,
  getProjectDetail,
  saveArticleTitles,
  withArticleTitleGenerationLock,
  type ProjectDetail,
} from './db.ts'
import {
  ArticleGenerationError,
  type ArticleBodyTargetPage,
  generateArticleBody,
  generateArticleTitles,
  type ArticleGenerationInput,
  type ArticleGenerationOptions,
} from './article-generator.ts'
import type { DoubaoTimingEvent } from './doubao-client.ts'
import { DirectWebsiteReader, type DirectWebsiteReaderOptions } from './content-audit-direct-reader.ts'
import type { ContentAuditResult } from '../src/content-audit.ts'
import { isInitialDiagnosisComplete } from '../src/initial-diagnosis-completion.ts'
import { QUESTION_TOTAL } from '../src/business-rules.ts'

export class ArticleServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArticleServiceError'
  }
}

type ArticleServiceOptions = Pick<ArticleGenerationOptions, 'fetch' | 'endpoint' | 'maxContextChars'> & {
  timeoutMs?: number
  titleTimeoutMs?: number
  bodyTimeoutMs?: number
  signal?: AbortSignal
  expectedProjectUpdatedAt?: string
  taskId?: string
  /** Isolated-test hook; production always uses the safe direct reader below. */
  readTargetPage?: (rootUrl: string, targetUrl: string, signal?: AbortSignal) => Promise<ArticleBodyTargetPage>
  /** Safe-reader controls for an isolated caller; no full-site read is exposed. */
  websiteReaderOptions?: Omit<DirectWebsiteReaderOptions, 'signal'>
  onTiming?: (event: ArticleTimingEvent) => void
}

export type ArticleTimingEvent = DoubaoTimingEvent & {
  phase: 'titles' | 'body'
  projectId: string
  articleId: string | null
}

function configuration(): { apiKey: string; modelId: string } {
  return {
    apiKey: process.env.DOUBAO_API_KEY?.trim() ?? '',
    modelId: process.env.DOUBAO_MODEL_ID?.trim() ?? '',
  }
}

function latestDiagnosis(detail: ProjectDetail) {
  const latestMonitoring = (detail.monitoringRuns ?? [])
    .filter((run) => run.status === 'completed')
    .slice()
    .sort((a, b) => b.roundNumber - a.roundNumber)[0]
  return latestMonitoring ?? (detail.initialDiagnosis.run?.status === 'completed' ? {
    ...detail.initialDiagnosis.run,
    answers: detail.initialDiagnosis.answers,
  } : null)
}

function articleInputs(
  detail: ProjectDetail,
  diagnosis: NonNullable<ReturnType<typeof latestDiagnosis>>,
  contentAudit: ContentAuditResult | null,
): ArticleGenerationInput {
  const articles = detail.articleBatches.flatMap((batch) => batch.articles)
  const existingArticles = articles.map((article) => {
    const optimizationType = normalizedOptimizationType(article)
    return {
      title: article.title,
      // Existing generated content is planning-only material for semantic
      // de-duplication.  The body prompt does not serialize these rows, so a
      // prior draft can never become website evidence or writing input.
      contentHtml: article.contentHtml,
      confirmedAt: article.confirmedAt,
      writingStatus: article.writingStatus,
      optimizationType,
      optimizationDirection: article.optimizationDirection ?? null,
      targetPageUrl: optimizationType === '更新已有文章' ? normalizedPageUrl(article.targetPageUrl) : null,
      targetPageTitle: optimizationType === '更新已有文章' ? article.targetPageTitle?.trim() || null : null,
    }
  })
  return {
    project: {
      companyName: detail.companyName,
      websiteUrl: detail.websiteUrl,
      optimizationTarget: detail.optimizationTarget,
      supplementalInfo: detail.supplementalInfo,
    },
    questions: detail.questions.map((question) => ({ position: question.position, question: question.question })),
    diagnosisAnswers: diagnosis.answers.map((answer) => ({
      position: answer.position,
      question: answer.question,
      answerText: answer.answerText,
      citationUrls: answer.citationUrls,
      recommended: answer.recommended,
      officialCitation: answer.officialCitation,
    })),
    existingTitles: articles.map((article) => article.title),
    existingArticles,
    confirmedArticles: existingArticles.filter((article) => article.confirmedAt !== null),
    contentAudit,
  }
}

async function planningContentAudit(projectId: string, queryClient?: Parameters<typeof getContentAuditRecord>[1]): Promise<{ result: ContentAuditResult | null; startedAt: string }> {
  const record = await getContentAuditRecord(projectId, queryClient)
  if (!record) throw new ArticleServiceError('content_audit_required')
  if (record.status === 'checking') throw new ArticleServiceError('content_audit_in_progress')
  // A failed current run is an explicit terminal state. It contributes no
  // website findings and must not fall back to a previous check or cache.
  if (record.status === 'failed') return { result: null, startedAt: record.startedAt }
  if (!contentAuditResultEligible(record)) throw new ArticleServiceError('content_audit_required')
  return { result: record.result, startedAt: record.startedAt }
}

function preflight(detail: ProjectDetail): NonNullable<ReturnType<typeof latestDiagnosis>> {
  const diagnosis = latestDiagnosis(detail)
  if (!isInitialDiagnosisComplete(detail) || !diagnosis) throw new ArticleServiceError('diagnosis_incomplete')
  if (detail.questions.length !== QUESTION_TOTAL) {
    throw new ArticleServiceError('diagnosis_incomplete')
  }
  if (!detail.websiteUrl) throw new ArticleServiceError('website_required')
  return diagnosis
}

function errorMessage(error: unknown): string {
  const raw = error instanceof ArticleGenerationError || error instanceof ArticleServiceError
    ? error.message
    : error instanceof Error
      ? error.message
      : '文章生成失败，请稍后重试'
  return raw
    .replace(/Bearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[-_ ]?key|access[-_ ]?token|token|secret|password|cookie)\s*[:=]\s*[^\s,;}]+/gi, 'credential=[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360) || '文章生成失败，请稍后重试'
}

function normalizedPageUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:api[-_]?key|access[-_]?token|auth(?:entication)?|credential|cookie|jwt|password|secret|session(?:[-_]?id)?|signature|sig|token)$/iu.test(key)) return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function isUpdateOptimizationType(value: string | null | undefined): boolean {
  const normalized = value?.trim()
  return normalized === '更新已有文章' || normalized === '更新现有页面'
}

/**
 * Legacy rows may carry an update label without any original-page binding.
 * They remain untouched in storage but are treated as new articles for
 * display/input compatibility.  Once a non-empty target was saved, however,
 * it is an update even when the URL is now invalid or temporarily unreadable;
 * writing must fail rather than silently changing the operation.
 */
function hasBoundUpdateTarget(article: { optimizationType?: string | null; targetPageUrl?: string | null }): boolean {
  return isUpdateOptimizationType(article.optimizationType) && Boolean(article.targetPageUrl?.trim())
}

function normalizedOptimizationType(
  article: { optimizationType?: string | null; targetPageUrl?: string | null },
): '新增文章' | '更新已有文章' {
  return hasBoundUpdateTarget(article) ? '更新已有文章' : '新增文章'
}

/**
 * Read exactly the saved update target using the project's original root as
 * the reader scope. The reader itself applies robots, DNS/HTTP, redirect,
 * login and attachment safeguards; this function never touches the website
 * cache or discovers a second page.
 */
export async function readTemporaryArticleTargetPage(
  rootUrl: string,
  targetUrl: string,
  options: Omit<DirectWebsiteReaderOptions, 'signal'> = {},
  signal?: AbortSignal,
): Promise<ArticleBodyTargetPage> {
  let reader: DirectWebsiteReader | undefined
  try {
    reader = new DirectWebsiteReader(rootUrl, { ...options, signal })
    const page = await reader.readPage(targetUrl)
    if (page.isSitemap || !page.text.trim()) throw new ArticleServiceError('article_target_unavailable')
    return { url: page.url, title: page.title.trim() || '未提供', bodyText: page.text }
  } catch (error) {
    if (error instanceof ArticleServiceError) throw error
    // Do not persist provider/network diagnostics from the direct reader as
    // article content or a new-article fallback.
    throw new ArticleServiceError('article_target_unavailable')
  } finally {
    reader?.close()
  }
}

function articleTimingCallback(
  phase: ArticleTimingEvent['phase'],
  projectId: string,
  articleId: string | null,
  external: ArticleServiceOptions['onTiming'],
): NonNullable<ArticleGenerationOptions['onTiming']> {
  return (event) => {
    const enriched: ArticleTimingEvent = { ...event, phase, projectId, articleId }
    try {
      external?.(enriched)
    } catch {
      // Consumer timing hooks are diagnostic-only and cannot affect generation.
    }
    const fields = [
      `phase=${phase}`,
      `project=${projectId}`,
      `article=${articleId ?? '-'}`,
      `correlation=${event.correlationId}`,
      `event=${event.event}`,
      `elapsedMs=${event.elapsedMs}`,
      `timeoutMs=${event.timeoutMs}`,
      ...(event.headersElapsedMs === undefined ? [] : [`headersElapsedMs=${event.headersElapsedMs}`]),
      ...(event.bodyReadMs === undefined ? [] : [`bodyReadMs=${event.bodyReadMs}`]),
      ...(event.bodyReadIncludesJson === undefined ? [] : [`bodyReadIncludesJson=${event.bodyReadIncludesJson}`]),
      ...(event.httpStatus === undefined ? [] : [`httpStatus=${event.httpStatus}`]),
      ...(event.failurePhase === undefined ? [] : [`failurePhase=${event.failurePhase}`]),
      ...(event.failureKind === undefined ? [] : [`failureKind=${event.failureKind}`]),
    ]
    const line = `[article-timing] ${fields.join(' ')}`
    if (event.event === 'request_failed') console.warn(line)
    else console.info(line)
  }
}

async function timedStage<T>(stage: 'titles' | 'body', projectId: string, articleId: string | null, operation: () => Promise<T>): Promise<T> {
  const started = Date.now()
  let failed = false
  try {
    return await operation()
  } catch (error) {
    failed = true
    console.warn(`[article] stage=${stage} project=${projectId} article=${articleId ?? '-'} elapsedMs=${Date.now() - started} outcome=failed`)
    throw error
  } finally {
    if (!failed && Date.now() - started >= 1000) {
      console.info(`[article] stage=${stage} project=${projectId} article=${articleId ?? '-'} elapsedMs=${Date.now() - started}`)
    }
  }
}

export async function generateProjectArticles(
  projectId: string,
  options: ArticleServiceOptions = {},
): Promise<{ project: ProjectDetail; addedCount: number } | null> {
  const config = configuration()
  const result = await withArticleTitleGenerationLock(projectId, async (client) => {
    const detail = await getProjectDetail(projectId, client)
    if (!detail) return null
    const contentAudit = await planningContentAudit(projectId, client)
    const diagnosis = preflight(detail)
    const input = articleInputs(detail, diagnosis, contentAudit.result)
    const generated = await timedStage('titles', projectId, null, () => generateArticleTitles(input, {
      apiKey: config.apiKey,
      modelId: config.modelId,
      fetch: options.fetch,
      endpoint: options.endpoint,
      maxContextChars: options.maxContextChars,
      timeoutMs: options.titleTimeoutMs ?? options.timeoutMs ?? 0,
      signal: options.signal,
      onTiming: articleTimingCallback('titles', projectId, null, options.onTiming),
    }))
    if (options.signal?.aborted) throw new ArticleServiceError('article_generation_stale')
    if (generated.articles.length === 0) {
      // An empty plan is still a successful result that must be tied to the
      // exact audit lifecycle read before the model call. Re-check it under
      // the existing project lock so a late audit replacement (including a
      // failed run becoming a newer run) cannot turn an old zero-result
      // response into the current plan. The DB guard accepts both completed
      // and failed terminal records but never restores old website material.
      await assertContentAuditCurrent(projectId, contentAudit.startedAt, client)
      return { addedCount: 0, responseModel: generated.responseModel }
    }
    await saveArticleTitles(
      projectId,
      config.modelId,
      generated.responseModel,
      generated.articles,
      diagnosis.id,
      client,
      contentAudit.startedAt,
      options.expectedProjectUpdatedAt ?? detail.updatedAt,
      options.taskId,
    )
    return { addedCount: generated.articles.length, responseModel: generated.responseModel }
  })
  if (!result) return null
  const project = await getProjectDetail(projectId)
  if (!project) return null
  return { project, addedCount: result.addedCount }
}

export async function startArticleWriting(
  articleId: string,
  options: ArticleServiceOptions = {},
): Promise<{ project: ProjectDetail } | null> {
  const projectId = await getArticleProjectId(articleId)
  if (!projectId) return null
  // A valid saved article task can be written independently of the current
  // content-audit lifecycle.  The row claim remains the concurrency guard.
  const claim = await claimArticleWriting(articleId, options.taskId)
  if (!claim) return null
  const config = configuration()
  try {
    const detail = await getProjectDetail(projectId)
    if (!detail) throw new ArticleServiceError('project_not_found')
    const diagnosis = preflight(detail)
    const isUpdate = hasBoundUpdateTarget(claim.article)
    let targetPage: ArticleBodyTargetPage | null = null
    if (isUpdate) {
      const targetUrl = normalizedPageUrl(claim.article.targetPageUrl)
      if (!targetUrl || !detail.websiteUrl) throw new ArticleServiceError('article_target_unavailable')
      targetPage = options.readTargetPage
        ? await options.readTargetPage(detail.websiteUrl, targetUrl, options.signal)
        : await readTemporaryArticleTargetPage(detail.websiteUrl, targetUrl, options.websiteReaderOptions, options.signal)
      if (!targetPage.bodyText.trim()) throw new ArticleServiceError('article_target_unavailable')
    }
    // Writing an already-valid task is independent of the current content
    // audit.  In particular, a failed/unstarted audit must not block a retry;
    // its result is not used as a hidden website-content fallback here.
    const input = articleInputs(detail, diagnosis, null)
    const bodyOptions = {
      apiKey: config.apiKey,
      modelId: config.modelId,
      fetch: options.fetch,
      endpoint: options.endpoint,
      maxContextChars: options.maxContextChars,
      bodyTimeoutMs: options.bodyTimeoutMs ?? options.timeoutMs ?? 0,
      signal: options.signal,
      onTiming: articleTimingCallback('body', projectId, articleId, options.onTiming),
    }
    const generated = await timedStage('body', projectId, articleId, () => generateArticleBody(
      input,
      claim.article.title,
      claim.article.questionPositions,
      isUpdate ? '更新已有文章' : '新增文章',
      claim.article.optimizationDirection ?? null,
      bodyOptions,
      targetPage,
    ))
    if (options.signal?.aborted) throw new ArticleServiceError('article_write_stale')
    const completed = await completeArticleWriting(articleId, claim.attemptToken, generated.contentHtml, claim.source)
    if (!completed) throw new ArticleServiceError('article_write_stale')
    const project = await getProjectDetail(projectId)
    if (!project) throw new ArticleServiceError('project_not_found')
    return { project }
  } catch (error) {
    await failArticleWriting(articleId, claim.attemptToken, errorMessage(error))
    throw error
  }
}
