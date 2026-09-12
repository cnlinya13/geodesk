import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  ApiError,
  confirmAndStartDiagnosis,
  confirmArticlePublished,
  createProject,
  deleteArticle,
  deleteProject,
  downloadDiagnosisReportPdf,
  downloadMonitoringDeliveryReportPdf,
  deleteQuestion as deleteQuestionRequest,
  fetchDiagnosisReportRefresh,
  fetchContentAudit,
  fetchProjectAiTasks,
  fetchProject,
  fetchProjects,
  generateInitialDiagnosisReport,
  generateProjectArticles,
  observeQuestionGenerationTask,
  regenerateQuestions,
  saveMonitoringDeliveryReportPdf,
  startDiagnosisReportRefresh,
  startContentAudit,
  startOrResumeDiagnosis,
  startOrResumeMonitoring,
  setQuestionLocked as setQuestionLockedRequest,
  updateProject,
  writeProjectArticle,
  type ProjectFormValues,
  type QuestionGenerationProgress,
} from './api'
import { copyArticleContent } from './article-copy'
import { Button, Field, GlobalHeader, Icon, IconButton, MetricCard, Modal, OperationBar, OperationFeedback, PhaseNav, stages, StatusBadge } from './components/UI'
import { TechnicalAuditPanel } from './components/TechnicalAuditPanel'
import { ContentAuditPanel } from './components/ContentAuditPanel'
import { apiErrorMessage, localizeServerMessage, resolveUiMessage, taskErrorMessage, translate, uiMessage, useI18n, type Locale, type UiMessage } from './i18n'
import { buildDeliveryReportFilename, prepareDeliveryReportPdf } from './delivery-report-pdf'
import { DeliveryReportSheet } from './delivery-report-sheet'
import { isInitialDiagnosisComplete } from './initial-diagnosis-completion'
import {
  ARTICLE_OPTIMIZATION_DIRECTIONS,
  QUESTION_GROUP_COUNTS,
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from './business-rules'
import type { AiTask, AiTaskKind, DeliveryReportMetadata, DiagnosisAnswer, MonitoringRun, MonitoringUpdateEvent, Project, ProjectArticle, ProjectDetail, Question, QuestionCategory, StageId, StageState } from './types'
import type { DiagnosisReportRefreshMetadata, DiagnosisReportRefreshStatus } from './types'
import type { ContentAuditRecord } from './content-audit'

const emptyForm: ProjectFormValues = {
  companyName: '',
  websiteUrl: '',
  optimizationTarget: '',
  supplementalInfo: '',
}

export function normalizeProjectFormValues(values: ProjectFormValues): ProjectFormValues {
  return {
    companyName: values.companyName.trim(),
    websiteUrl: values.websiteUrl.trim(),
    optimizationTarget: values.optimizationTarget.trim(),
    supplementalInfo: values.supplementalInfo.trim(),
  }
}

export function projectFormValues(project: Pick<ProjectDetail, 'companyName' | 'websiteUrl' | 'optimizationTarget' | 'supplementalInfo'>): ProjectFormValues {
  return normalizeProjectFormValues({
    companyName: project.companyName,
    websiteUrl: project.websiteUrl ?? '',
    optimizationTarget: project.optimizationTarget ?? '',
    supplementalInfo: project.supplementalInfo ?? '',
  })
}

export function projectFormValuesEqual(left: ProjectFormValues, right: ProjectFormValues): boolean {
  const a = normalizeProjectFormValues(left)
  const b = normalizeProjectFormValues(right)
  return a.companyName === b.companyName
    && a.websiteUrl === b.websiteUrl
    && a.optimizationTarget === b.optimizationTarget
    && a.supplementalInfo === b.supplementalInfo
}

export function shouldClearUnconfirmedOutline(
  project: Pick<ProjectDetail, 'questions' | 'companyName' | 'websiteUrl' | 'optimizationTarget' | 'supplementalInfo'> | null,
  normalized: ProjectFormValues,
  projectLocked: boolean,
): boolean {
  if (!project || projectLocked || project.questions.length === 0) return false
  const profileChanged = normalized.companyName !== project.companyName
    || normalized.optimizationTarget !== (project.optimizationTarget ?? '')
    || normalized.supplementalInfo !== (project.supplementalInfo ?? '')
  const websiteChanged = normalized.websiteUrl !== (project.websiteUrl ?? '')
  return profileChanged || (websiteChanged && !normalized.optimizationTarget && !normalized.supplementalInfo)
}

export function projectWebsiteValidationError(websiteUrl: string): string | null {
  const value = websiteUrl.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return '客户官网必须是HTTP或HTTPS地址'
    }
  } catch {
    return '客户官网必须是HTTP或HTTPS地址'
  }
  return null
}

export function questionCategoryLabel(category: unknown, locale: Locale = 'zh-CN'): string {
  if (category === 'recommendation') return translate(locale, 'category.recommendation')
  if (category === 'selection') return translate(locale, 'category.selection')
  if (category === 'decision') return translate(locale, 'category.decision')
  return translate(locale, 'category.unknown')
}

type Route = { kind: 'list' } | { kind: 'project'; projectId: string } | { kind: 'report'; projectId: string }
type LoadState = 'idle' | 'loading' | 'error' | 'ready'
export type StageActionErrors = Partial<Record<StageId, UiMessage>>
export type PendingProjectSave = { projectId: string; onSaved: () => void }

export function pendingProjectSaveCallback(
  pending: PendingProjectSave | null,
  modalProjectId: string | null | undefined,
  savedProjectId: string,
): (() => void) | null {
  if (!pending || pending.projectId !== savedProjectId || modalProjectId !== savedProjectId) return null
  return pending.onSaved
}

export function stageActionError(errors: StageActionErrors, stage: StageId): UiMessage {
  return errors[stage] ?? ''
}

function clearStageActionError(errors: StageActionErrors, stage: StageId): StageActionErrors {
  if (!(stage in errors)) return errors
  const next = { ...errors }
  delete next[stage]
  return next
}

function routeFromLocation(): Route {
  if (typeof window === 'undefined') return { kind: 'list' }
  const reportMatch = window.location.hash.match(/^#\/project\/(\d+)\/diagnosis-report$/)
  if (reportMatch?.[1]) return { kind: 'report', projectId: reportMatch[1] }
  const match = window.location.hash.match(/^#\/project\/(\d+)$/)
  return match?.[1] ? { kind: 'project', projectId: match[1] } : { kind: 'list' }
}

function navigate(route: Route, replace = false): void {
  const hash = route.kind === 'list' ? '' : route.kind === 'report' ? `#/project/${route.projectId}/diagnosis-report` : `#/project/${route.projectId}`
  const next = `${window.location.pathname}${window.location.search}${hash}`
  if (replace) window.history.replaceState(null, '', next)
  else window.history.pushState(null, '', next)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function projectEntryStage(project: ProjectDetail): StageId {
  if (!project.questionsLockedAt) return 'scope'
  if (!isInitialDiagnosisComplete(project)) return 'diagnosis'
  // A completed diagnosis re-enters on optimization.  Article or monitoring
  // history must not silently change the entry page.
  return 'optimization'
}

export function stageStates(project: ProjectDetail): Record<StageId, StageState> {
  const initialComplete = isInitialDiagnosisComplete(project)
  const questionsLocked = Boolean(project.questionsLockedAt)
  const websiteConfigured = Boolean(project.websiteUrl)
  return {
    scope: 'available',
    diagnosis: questionsLocked ? 'available' : 'disabled',
    optimization: initialComplete ? 'available' : 'disabled',
    monitoring: initialComplete && websiteConfigured ? 'available' : 'disabled',
  }
}

function formatDate(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return translate(locale, 'date.notMonitored')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return translate(locale, 'date.notMonitored')
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function formatDateTime(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return translate(locale, 'common.none')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return translate(locale, 'common.none')
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatArticleUpdatedAt(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return translate(locale, 'common.none')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return translate(locale, 'common.none')
  if (locale === 'en') {
    return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
  }
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function formatReportDate(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return translate(locale, 'common.none')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return translate(locale, 'common.none')
  if (locale === 'en') return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function triggerDiagnosisReportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function buildDiagnosisReportFilename(companyName: string, diagnosisDate: string | null): string {
  const clean = (value: string): string => value
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
  return `${clean(companyName) || '未命名公司'}-${clean(diagnosisDate ?? '') || '未标注日期'}.pdf`
}

function rateLabel(value: number | null, locale: Locale = 'zh-CN'): string {
  return value === null ? (locale === 'en' ? 'Pending diagnosis' : '待诊断') : locale === 'en'
    ? `${Math.round(value * 100)}% (${Math.round(value * QUESTION_TOTAL)} / ${QUESTION_TOTAL})`
    : `${Math.round(value * 100)}%（${Math.round(value * QUESTION_TOTAL)} / ${QUESTION_TOTAL}）`
}

function websiteCitationLabel(project: Project, locale: Locale = 'zh-CN'): string {
  return project.websiteUrl ? rateLabel(project.latestOfficialCitationRate ?? project.initialOfficialCitationRate, locale) : translate(locale, 'common.notConfigured')
}

function recommendationRateLabel(project: Project, locale: Locale = 'zh-CN'): string {
  return rateLabel(project.latestRecommendationRate ?? project.initialRecommendationRate, locale)
}

/**
 * Keep the crawl state access in one place.  The API returns the same values
 * both on the project summary and on `websiteCrawl`; accepting either shape
 * also keeps the UI safe while a project detail is being refreshed.
 */
export function websiteCrawlStatus(project: Pick<ProjectDetail, 'websiteCrawlStatus' | 'websiteCrawl'>): Project['websiteCrawlStatus'] {
  return project.websiteCrawl?.status ?? project.websiteCrawlStatus ?? 'not_started'
}

export function websiteCrawlSuccessCount(project: Pick<ProjectDetail, 'websitePagesSucceeded' | 'websiteCrawl'>): number {
  return project.websiteCrawl?.successCount ?? project.websitePagesSucceeded ?? 0
}

export function websiteCrawlIncomplete(project: Pick<ProjectDetail, 'websiteCrawlIncomplete' | 'websiteCrawl'>): boolean {
  return project.websiteCrawl?.incomplete ?? project.websiteCrawlIncomplete ?? false
}

export function websiteCrawlError(project: Pick<ProjectDetail, 'websiteCrawlError' | 'websiteCrawl'>): string | null {
  return project.websiteCrawl?.error ?? project.websiteCrawlError ?? null
}

export function websiteCrawlIsActive(project: Pick<ProjectDetail, 'websiteUrl' | 'websiteCrawlStatus' | 'websiteCrawl'>): boolean {
  return Boolean(project.websiteUrl && websiteCrawlStatus(project) === 'crawling')
}

/**
 * Keep non-AI crawl cleanup behavior intact. A persisted failed AI task is
 * retained when the task list is available so partial results can be retried;
 * the compatibility fallback still clears legacy transient failure markers.
 */
export function normalizeProjectOnInitialLoad(project: ProjectDetail, aiTasks?: readonly AiTask[]): ProjectDetail {
  // Keep a normal failed AI task and its partial result visible when the task
  // endpoint is available. On a service restart incomplete task rows are
  // removed by the backend cleanup, so the legacy fallback remains safe for
  // older servers without this endpoint.
  const preserveFailedTask = (kind: AiTaskKind, targetId?: string): boolean => aiTasks?.some((task) => (
    task.status === 'failed'
      && task.kind === kind
      && (targetId === undefined || task.targetId === targetId)
  )) ?? false
  const questionsGenerationFailed = !preserveFailedTask('questions') && (project.questionsGeneration.status === 'failed'
    || project.questionsGenerationStatus === 'failed')
  const websiteCrawlFailed = project.websiteCrawl.status === 'failed'
    || project.websiteCrawlStatus === 'failed'
  const initialDiagnosisRunFailed = project.initialDiagnosis.run?.status === 'failed'
  const initialDiagnosisTaskFailed = preserveFailedTask('diagnosis') || preserveFailedTask('diagnosis_report')
  // A task list from the current server is authoritative even when it is
  // empty: startup cleanup may remove the failed report task after retaining
  // the failed run and its successful answers. Only the legacy server path
  // should discard a failed initial diagnosis snapshot on the first load.
  const initialDiagnosisFailed = aiTasks === undefined && !initialDiagnosisTaskFailed && (initialDiagnosisRunFailed
    || (!project.initialDiagnosis.run && project.initialDiagnosisStatus === 'failed'))

  const normalizedQuestionsGeneration = questionsGenerationFailed
    ? {
        ...project.questionsGeneration,
        status: 'not_started' as const,
        error: null,
        startedAt: null,
        completedAt: null,
      }
    : project.questionsGeneration
  const normalizedWebsiteCrawl = websiteCrawlFailed
    ? {
        ...project.websiteCrawl,
        status: 'not_started' as const,
        error: null,
        startedAt: null,
        completedAt: null,
        incomplete: false,
      }
    : project.websiteCrawl
  const normalizedInitialDiagnosis = initialDiagnosisFailed
    ? {
        ...project.initialDiagnosis,
        run: null,
        answers: [],
        reportPdfReady: false,
        reportPdfGeneratedAt: null,
      }
    : project.initialDiagnosis
  const normalizedMonitoringRuns = project.monitoringRuns.filter((run) => run.status !== 'failed' || preserveFailedTask('monitoring'))
  const normalizedArticleBatches = project.articleBatches.map((batch) => {
    let changed = false
    const articles = batch.articles.map((article) => {
      if (article.writingStatus !== 'failed' || preserveFailedTask('article_body', article.id)) return article
      changed = true
      return { ...article, writingStatus: 'pending' as const, writingError: null }
    })
    return changed ? { ...batch, articles } : batch
  })

  return {
    ...project,
    ...(questionsGenerationFailed ? {
      questionsGenerationStatus: 'not_started' as const,
      questionsGenerationStartedAt: null,
      questionsGenerationCompletedAt: null,
      questionsGenerationError: null,
      questionsGeneration: normalizedQuestionsGeneration,
    } : {}),
    ...(websiteCrawlFailed ? {
      websiteCrawlStatus: 'not_started' as const,
      websiteCrawlStartedAt: null,
      websiteCrawlCompletedAt: null,
      websiteCrawlError: null,
      websiteCrawlIncomplete: false,
      websiteCrawl: normalizedWebsiteCrawl,
    } : {}),
    ...(initialDiagnosisFailed ? {
      initialDiagnosisStatus: 'not_started' as const,
      diagnosisStartedAt: null,
      initialDiagnosisCompletedAt: null,
      initialRecommendationRate: null,
      initialOfficialCitationRate: null,
      initialDiagnosisAt: null,
      initialDiagnosis: normalizedInitialDiagnosis,
    } : {}),
    ...(normalizedMonitoringRuns.length !== project.monitoringRuns.length ? { monitoringRuns: normalizedMonitoringRuns } : {}),
    ...(normalizedArticleBatches.some((batch, index) => batch !== project.articleBatches[index]) ? { articleBatches: normalizedArticleBatches } : {}),
  }
}

export function isCurrentProjectWebsite(project: Pick<ProjectDetail, 'id' | 'websiteUrl'> | null, projectId: string, websiteUrl: string | null): boolean {
  return Boolean(project && project.id === projectId && project.websiteUrl === websiteUrl)
}

export function isCurrentProjectSnapshot(project: Pick<ProjectDetail, 'id' | 'websiteUrl' | 'updatedAt'> | null, projectId: string, websiteUrl: string | null, updatedAt: string | null | undefined): boolean {
  return isCurrentProjectWebsite(project, projectId, websiteUrl) && project?.updatedAt === updatedAt
}

const WEBSITE_CRAWL_POLL_INTERVAL_MS = 1_000
const CONTENT_AUDIT_POLL_INTERVAL_MS = 1_000
const CONTENT_AUDIT_REQUIRED_MESSAGE = '请先手动点击“内容检查”并完成检查，再进行方案设计或写稿。'

export function contentAuditGenerationReady(record: ContentAuditRecord | null | undefined): boolean {
  return Boolean(record?.status === 'completed'
    && record.completedAt?.trim()
    && record.error === null
    && record.result
    && record.result.scope === 'website_internal'
    && Array.isArray(record.executionErrors)
    && record.executionErrors.length === 0
    && record.progress.processedPages === record.progress.totalPages
    && record.progress.processedClaims === record.progress.totalClaims
    && record.result.items.length <= record.progress.processedClaims)
}

export function contentAuditUiStatus(record: ContentAuditRecord | null | undefined, loadError = ''): 'unavailable' | 'idle' | 'checking' | 'completed' | 'failed' {
  if (loadError.trim() && !record) return 'unavailable'
  return record?.status ?? 'idle'
}

export function normalizeContentAuditRecordForLoad(record: ContentAuditRecord | null, _initialLoad = false, _preserveFailedTask = false): ContentAuditRecord | null {
  // The persisted content-audit record is authoritative.  Backend startup
  // cleanup removes only abandoned task rows, not the terminal audit result;
  // an empty task list must therefore not make a failed check disappear on
  // project re-entry.
  return record
}

/** Keep content-audit polling keyed to the active task identity, not to its
 * progress snapshot. The task can bootstrap polling while the saved audit
 * record still shows the previous terminal run. */
export function contentAuditTaskForPolling(tasks: readonly AiTask[]): AiTask | null {
  return tasks.find((task) => task.status === 'running' && task.kind === 'content_audit') ?? null
}

/** A terminal record belongs to the current task only once its run timestamp
 * is at or after that task's acceptance timestamp. */
export function contentAuditPollingNeeded(
  record: Pick<ContentAuditRecord, 'status' | 'startedAt'> | null | undefined,
  task: Pick<AiTask, 'startedAt'> | null | undefined,
): boolean {
  if (record?.status === 'checking') return true
  return Boolean(task && (!record || record.startedAt < task.startedAt))
}

type AiTaskProgressForDisplay = {
  completedCount: number
  failedCount: number
  total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read progress from the task list without requiring a task-detail request. */
export function aiTaskProgressForDisplay(task: AiTask | null | undefined): AiTaskProgressForDisplay | null {
  if (!task || task.status !== 'running' || !isRecord(task.result.progress)) return null
  const completedCount = task.result.progress.completedCount
  const failedCount = task.result.progress.failedCount
  const total = task.result.progress.total
  if (typeof completedCount !== 'number' || !Number.isFinite(completedCount)
    || typeof failedCount !== 'number' || !Number.isFinite(failedCount)
    || typeof total !== 'number' || !Number.isFinite(total)) return null
  return {
    completedCount: Math.max(0, Math.trunc(completedCount)),
    failedCount: Math.max(0, Math.trunc(failedCount)),
    total: Math.max(0, Math.trunc(total)),
  }
}

export function questionGenerationTaskProgress(task: AiTask | null | undefined): QuestionGenerationProgress | null {
  const progress = aiTaskProgressForDisplay(task)
  if (!progress || !isRecord(task?.result.progress)) return null
  const rawQuestions = task.result.progress.questions
  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.flatMap((question) => {
        if (!isRecord(question) || typeof question.question !== 'string' || !question.question.trim() || !isQuestionCategory(question.category)) return []
        return [{ question: question.question, category: question.category }]
      })
    : []
  return { ...progress, questions }
}

function questionGenerationProgressExtends(previous: QuestionGenerationProgress, next: QuestionGenerationProgress): boolean {
  return next.total === previous.total
    && next.completedCount >= previous.completedCount
    && previous.questions.every((question, index) => {
      const candidate = next.questions[index]
      return candidate?.question === question.question && candidate.category === question.category
    })
}

/** Keep a newer questions task list from replacing a streamed prefix with an
 * older database snapshot. Other task kinds retain their existing behavior. */
function mergeQuestionTaskSnapshots(previous: AiTask | undefined, next: AiTask): AiTask {
  if (!previous || previous.kind !== 'questions' || next.kind !== 'questions' || previous.status !== 'running' || next.status !== 'running') return next
  const previousProgress = questionGenerationTaskProgress(previous)
  const nextProgress = questionGenerationTaskProgress(next)
  if (!previousProgress || !nextProgress) {
    return previousProgress
      ? { ...next, result: { ...next.result, progress: previous.result.progress } }
      : next
  }
  return questionGenerationProgressExtends(previousProgress, nextProgress)
    ? next
    : { ...next, result: { ...next.result, progress: previous.result.progress } }
}

function mergeQuestionTaskList(previous: AiTask[], next: AiTask[]): AiTask[] {
  return next.map((task) => mergeQuestionTaskSnapshots(previous.find((candidate) => candidate.id === task.id), task))
}

/** Keep an already-open observer keyed by its task id after polling records
 * that same task as completed/failed. Its stream must deliver the terminal
 * snapshot before project-switch or unmount cleanup closes it. */
export function questionTaskIdForObservation(tasks: readonly AiTask[], observedTaskId: string | null): string | null {
  return tasks.find((task) => task.status === 'running' && task.kind === 'questions')?.id ?? observedTaskId
}

function articleWritingIsActive(project: ProjectDetail): boolean {
  return articleList(project).some((article) => articleWritingStatus(article) === 'writing')
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="inline-notice inline-notice--error" role="alert">
      <span>{message}</span>
      <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

function LoadingState({ label, compact = false }: { label?: string; compact?: boolean }) {
  const { t } = useI18n()
  const resolvedLabel = label ?? t('loading.project')
  return <div className={`loading-state ${compact ? 'loading-state--compact' : ''}`} role="status" aria-live="polite"><span className="loading-state__dot" aria-hidden="true" />{resolvedLabel}</div>
}

function formatRecentDateTime(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return translate(locale, 'date.notMonitored')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return translate(locale, 'date.notMonitored')
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  if (sameDay) return translate(locale, 'date.today', { time })
  if (date.toDateString() === yesterday.toDateString()) return translate(locale, 'date.yesterday', { time })
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function ProjectList({
  projects,
  state,
  search,
  onSearch,
  onCreate,
  onRetry,
  onOpen,
}: {
  projects: Project[]
  state: LoadState
  search: string
  onSearch: (value: string) => void
  onCreate: () => void
  onRetry: () => void
  onOpen: (project: Project) => void
}) {
  const { t, locale } = useI18n()
  return (
    <main className="page-content project-list-page">
      <OperationBar
        className="list-toolbar"
        left={<h1>{t('list.title')}</h1>}
        center={<OperationFeedback tone={state === 'error' ? 'error' : 'neutral'}>{state === 'loading' ? t('list.loading') : state === 'error' ? t('list.loadError') : null}</OperationFeedback>}
        right={(
          <div className="list-toolbar__actions">
            <label className="search-field">
              <span className="sr-only">{t('list.searchAria')}</span>
              <Icon name="search" size={16} />
              <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t('list.searchPlaceholder')} />
            </label>
            {state === 'error' ? <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button> : null}
            <Button icon={<Icon name="plus" size={16} />} onClick={onCreate}>{t('list.create')}</Button>
          </div>
        )}
      />
      <section className="table-card" aria-label={t('list.aria')}>
        {state === 'ready' && projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__mark" aria-hidden="true"><Icon name="plus" size={20} /></div>
            <h2>{search.trim() ? t('list.emptySearchTitle') : t('list.emptyTitle')}</h2>
            <p>{search.trim() ? t('list.emptySearchDescription') : t('list.emptyDescription')}</p>
            {!search.trim() ? <Button icon={<Icon name="plus" size={16} />} onClick={onCreate}>{t('list.create')}</Button> : null}
          </div>
        ) : null}
        {state === 'ready' && projects.length > 0 ? (
          <div className="table-scroll">
            <table className="projects-table">
              <colgroup>
                <col className="projects-table__company-col" />
                <col className="projects-table__target-col" />
                <col className="projects-table__metric-col" />
                <col className="projects-table__metric-col" />
                <col />
              </colgroup>
              <thead>
                <tr><th>{t('list.company')}</th><th>{t('list.target')}</th><th>{t('list.recommendationRate')}</th><th>{t('list.citationRate')}</th><th>{t('list.latestMonitoring')}</th></tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} onClick={() => onOpen(project)} onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onOpen(project)
                    }
                  }} tabIndex={0}>
                    <td className="company-cell">{project.companyName}</td>
                    <td>{project.optimizationTarget || t('common.companyOverall')}</td>
                    <td className={recommendationRateLabel(project, locale) === (locale === 'en' ? 'Pending diagnosis' : '待诊断') ? 'metric-cell metric-cell--pending' : 'metric-cell'}>{recommendationRateLabel(project, locale)}</td>
                    <td className={project.websiteUrl ? (websiteCitationLabel(project, locale) === (locale === 'en' ? 'Pending diagnosis' : '待诊断') ? 'website-cell website-cell--pending' : 'website-cell') : 'website-cell website-cell--unconfigured'}>{websiteCitationLabel(project, locale)}</td>
                    <td className="recent-cell"><span>{formatRecentDateTime(project.latestMonitoringAt, locale)}</span><Icon name="chevron-right" size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export function projectDeletionMessage(companyName: string, locale: Locale = 'zh-CN'): string {
  return translate(locale, 'form.confirmDelete', { companyName })
}

export async function confirmAndDeleteProject(
  companyName: string,
  confirmFn: (message: string) => boolean,
  deleteFn: () => Promise<void>,
  locale: Locale = 'zh-CN',
): Promise<boolean> {
  if (!confirmFn(projectDeletionMessage(companyName, locale))) return false
  await deleteFn()
  return true
}

export function ProjectFormModal({ project, initialValues, onClose, onSaved, onDeleted }: {
  project: ProjectDetail | null
  initialValues?: Partial<ProjectFormValues>
  onClose: () => void
  onSaved: (project: ProjectDetail, resetConfirmed?: boolean) => void
  onDeleted?: () => void
}) {
  const { t, locale } = useI18n()
  const [values, setValues] = useState<ProjectFormValues>(() => ({
    ...(project ? projectFormValues(project) : emptyForm),
    ...initialValues,
  }))
  const [error, setError] = useState<UiMessage>('')
  const [companyError, setCompanyError] = useState<UiMessage>('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const submitInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const projectLocked = Boolean(project?.questionsLockedAt)
  const websiteFillOnly = Boolean(projectLocked && !project?.websiteUrl)
  const fieldsDisabled = submitting || projectLocked
  const websiteDisabled = submitting || (projectLocked && Boolean(project?.websiteUrl))

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateValue = (key: keyof ProjectFormValues, value: string) => {
    setValues((current) => ({ ...current, [key]: value }))
    if (key === 'companyName') setCompanyError('')
    setError('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitInFlightRef.current) return
    const normalized = normalizeProjectFormValues(values)
    if (!normalized.companyName) {
      setCompanyError(uiMessage('form.validation.companyRequired'))
      return
    }
    const websiteError = projectWebsiteValidationError(normalized.websiteUrl)
    if (websiteError) {
      setError(uiMessage('form.validation.website'))
      return
    }
    if (project && projectLocked) {
      if (project.websiteUrl) {
        setError(uiMessage('form.locked'))
        return
      }
      if (!normalized.websiteUrl) {
        setError(uiMessage('form.websiteRequired'))
        return
      }
      // The backend enforces the same one-time website-fill rule.  Keep all
      // frozen business fields in the payload so the response is a full
      // project snapshot rather than a partial client merge.
    }
    if (project && projectFormValuesEqual(normalized, projectFormValues(project))) {
      onClose()
      return
    }

    // Before the question set is confirmed, changing the business profile can
    // invalidate the unconfirmed outline.  The backend requires an explicit
    // resetConfirmed flag for that narrow question-only cleanup; it must never
    // be confused with resetting the project's diagnosis, monitoring, article,
    // or report history.
    const clearsUnconfirmedOutline = shouldClearUnconfirmedOutline(project, normalized, projectLocked)
    let resetConfirmed = false
    if (clearsUnconfirmedOutline) {
      if (typeof window === 'undefined' || !window.confirm(t('form.confirmReset'))) return
      resetConfirmed = true
    }
    if (websiteFillOnly) {
      if (typeof window === 'undefined' || !window.confirm(t('form.confirmWebsite'))) return
    }
    submitInFlightRef.current = true
    setSubmitting(true)
    setError('')
    setCompanyError('')
    try {
      const saved = project
        ? await updateProject(project.id, normalized, {
          expectedUpdatedAt: project.updatedAt,
          ...(resetConfirmed ? { resetConfirmed: true } : {}),
        })
        : await createProject(normalized)
      if (mountedRef.current) onSaved(saved, resetConfirmed)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'company_name_exists') setCompanyError(apiErrorMessage(cause, 'error.server.company_name_exists'))
      else if (cause instanceof ApiError && cause.code === 'website_url_invalid') setError(apiErrorMessage(cause, 'error.server.website_url_invalid'))
      else setError(apiErrorMessage(cause, 'error.server.project_unavailable'))
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
  }

  const handleClose = () => {
    if (submitting) return
    onClose()
  }

  const formFeedbackMessage = submitting
    ? deleting
      ? t('form.feedbackDeleting')
      : websiteFillOnly
        ? t('form.feedbackWebsite')
        : t('form.feedbackSaving')
    : resolveUiMessage(error, locale)
  const formFeedbackTone = resolveUiMessage(error, locale) ? 'error' : 'neutral'
  const remove = async () => {
    if (!project || submitting || submitInFlightRef.current || typeof window === 'undefined') return
    setError('')
    let confirmed = false
    try {
      confirmed = await confirmAndDeleteProject(
        project.companyName,
        (message) => window.confirm(message),
        async () => {
          submitInFlightRef.current = true
          setSubmitting(true)
          setDeleting(true)
          await deleteProject(project.id)
        },
        locale,
      )
    } catch (cause) {
      if (mountedRef.current) setError(apiErrorMessage(cause, 'error.server.project_delete_failed'))
      submitInFlightRef.current = false
      if (mountedRef.current) {
        setSubmitting(false)
        setDeleting(false)
      }
      return
    }
    if (confirmed) onDeleted?.()
  }
  const footer = project ? (
    <div key="edit-project-footer" className="modal__footer project-form-modal__footer">
      <Button type="button" variant="danger" onClick={() => void remove()} disabled={submitting}>{deleting ? t('common.deleting') : t('common.delete')}</Button>
      <div className="project-form-modal__feedback"><OperationFeedback tone={formFeedbackTone}>{formFeedbackMessage}</OperationFeedback></div>
      <div className="project-form-modal__footer-actions">
        <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>{t('common.cancel')}</Button>
        <Button type="submit" icon={<Icon name="arrow-right" size={16} />} disabled={submitting || (projectLocked && Boolean(project.websiteUrl))}>{submitting ? (deleting ? t('common.deleting') : t('common.saving')) : websiteFillOnly ? t('form.saveWebsite') : t('form.saveChanges')}</Button>
      </div>
    </div>
  ) : (
    <div className="modal__footer project-form-modal__footer">
      <span className="project-form-modal__footer-spacer" aria-hidden="true" />
      <div className="project-form-modal__feedback"><OperationFeedback tone={formFeedbackTone}>{formFeedbackMessage}</OperationFeedback></div>
      <div className="project-form-modal__footer-actions">
        <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>{t('common.cancel')}</Button>
        <Button type="submit" icon={<Icon name="plus" size={16} />} disabled={submitting}>{submitting ? t('common.saving') : t('form.createSubmit')}</Button>
      </div>
    </div>
  )

  return (
    <Modal
      title={project ? (websiteFillOnly ? t('form.fillWebsiteTitle') : t('form.editTitle')) : t('form.createTitle')}
      onSubmit={submit}
      onClose={handleClose}
      submitting={submitting}
      submitLabel={project ? t('form.saveChanges') : t('form.createSubmit')}
      footer={footer}
      className="project-form-modal"
      focusManagement
    >
      <>
          <Field id="company-name" label={t('form.companyName')} required value={values.companyName} onChange={(event) => updateValue('companyName', event.target.value)} error={resolveUiMessage(companyError, locale)} disabled={fieldsDisabled} placeholder={t('form.companyNamePlaceholder')} autoFocus />
          <Field id="optimization-target" label={t('form.optimizationTarget')} value={values.optimizationTarget} onChange={(event) => updateValue('optimizationTarget', event.target.value)} disabled={fieldsDisabled} placeholder={t('form.optimizationTargetPlaceholder')} />
          <Field id="website-url" label={websiteFillOnly ? t('form.website') : t('form.websiteOptional')} required={websiteFillOnly} value={values.websiteUrl} onChange={(event) => updateValue('websiteUrl', event.target.value)} disabled={websiteDisabled} placeholder="https://" inputMode="url" />
          <div className="project-form-modal__supplemental">
            <div className="field">
              <label htmlFor="supplemental-info">{t('form.supplemental')}</label>
              <p id="supplemental-info-guidance" className="project-form-modal__supplemental-guidance">{t('form.supplementalGuidance')}</p>
              <textarea
                id="supplemental-info"
                rows={5}
                value={values.supplementalInfo}
                onChange={(event) => updateValue('supplementalInfo', event.target.value)}
                disabled={fieldsDisabled}
                aria-invalid={false}
                aria-describedby="supplemental-info-guidance"
                placeholder={t('form.supplementalPlaceholder')}
              />
            </div>
            <details className="project-form-modal__supplemental-example">
              <summary>{t('form.exampleSummary')}</summary>
              <div className="project-form-modal__supplemental-example-content">
                <p>{t('form.example')}</p>
              </div>
            </details>
          </div>
      </>
    </Modal>
  )
}

function ScopeSummary({ project }: { project: ProjectDetail }) {
  const { t } = useI18n()
  return (
    <aside className="scope-sidebar">
      <section className="scope-side-card scope-source-card">
        <div className="scope-side-card__title-row"><h2>{t('scope.basis')}</h2></div>
        <div className="scope-facts">
          <div><Icon name="building-2" size={16} /><span><small>{t('scope.company')}</small><strong>{project.companyName}</strong></span></div>
          <div><Icon name="target" size={16} /><span><small>{t('scope.target')}</small><strong>{project.optimizationTarget || t('common.companyOverall')}</strong></span></div>
          <div><Icon name="globe" size={16} /><span><small>{t('scope.website')}</small><strong>{project.websiteUrl || t('common.notConfigured')}</strong></span></div>
          <div><Icon name="message-square" size={16} /><span><small>{t('scope.supplemental')}</small><strong className="scope-facts__supplemental-info">{project.supplementalInfo || t('common.notProvided')}</strong></span></div>
        </div>
      </section>
      <section className="scope-lock-card">
        <div className="scope-lock-card__header">
          <Icon name="lock-keyhole" size={20} />
          <h2>{t('scope.lockTitle')}</h2>
        </div>
        <p>{t('scope.lockDescription', { count: QUESTION_TOTAL })}</p>
      </section>
    </aside>
  )
}

function isQuestionCategory(value: unknown): value is QuestionCategory {
  return value === 'recommendation' || value === 'selection' || value === 'decision'
}

type QuestionGenerationProfile = Pick<ProjectDetail, 'companyName' | 'websiteUrl' | 'optimizationTarget' | 'supplementalInfo'>

type QuestionGenerationSession = {
  token: number
  projectId: string
  profile: QuestionGenerationProfile
  lockedQuestions: Question[]
  total: number
  progress: QuestionGenerationProgress
}

function questionGenerationProfile(project: QuestionGenerationProfile): QuestionGenerationProfile {
  return {
    companyName: project.companyName,
    websiteUrl: project.websiteUrl,
    optimizationTarget: project.optimizationTarget,
    supplementalInfo: project.supplementalInfo,
  }
}

function questionGenerationProfilesEqual(left: QuestionGenerationProfile, right: QuestionGenerationProfile): boolean {
  return left.companyName === right.companyName
    && left.websiteUrl === right.websiteUrl
    && left.optimizationTarget === right.optimizationTarget
    && left.supplementalInfo === right.supplementalInfo
}

type QuestionGenerationPreviewItem = {
  kind: 'locked' | 'pending'
  id?: string
  position: number
  question: string
  category: QuestionCategory | null
}

function questionGenerationPreviewItems(
  lockedQuestions: readonly Question[],
  generatedQuestions: QuestionGenerationProgress['questions'],
): QuestionGenerationPreviewItem[] {
  const lockedPositions = new Set(lockedQuestions.map((question) => question.position))
  const availablePositions = Array.from({ length: QUESTION_TOTAL }, (_, index) => index + QUESTION_POSITION_MIN)
    .filter((position) => !lockedPositions.has(position))
  const pendingItems = generatedQuestions.flatMap((question, index) => {
    const position = availablePositions[index]
    return position === undefined
      ? []
      : [{ kind: 'pending' as const, position, question: question.question, category: question.category }]
  })
  const lockedItems: QuestionGenerationPreviewItem[] = lockedQuestions.map((question) => ({
    kind: 'locked',
    id: question.id,
    position: question.position,
    question: question.question,
    category: question.category,
  }))
  return [...lockedItems, ...pendingItems].sort((left, right) => left.position - right.position)
}

export function MonitoringScope({ project, busy, questionMutationBusy = false, questionMutationQuestionId = null, generating = false, generationLockedQuestions, generationProgress = null, actionError, onGenerate, onConfirm, questionActionError, onToggleQuestion, onDeleteQuestion }: {
  project: ProjectDetail
  busy: boolean
  questionMutationBusy?: boolean
  questionMutationQuestionId?: string | null
  generating?: boolean
  generationProgress?: QuestionGenerationProgress | null
  /** Snapshot of persisted locked rows to keep visible during generation. */
  generationLockedQuestions?: Question[]
  /** @deprecated Accepted for callers from the draft-row implementation. */
  generationToken?: number
  actionError: UiMessage
  onGenerate: () => void
  onConfirm: () => void
  questionActionError?: UiMessage
  onToggleQuestion?: (questionId: string, isLocked: boolean) => void
  onDeleteQuestion?: (questionId: string, isLocked: boolean) => void
}) {
  const { t, locale } = useI18n()
  const actionErrorText = resolveUiMessage(actionError, locale)
  const questionActionErrorText = resolveUiMessage(questionActionError, locale)
  // During generation, keep only persisted locked rows on screen. The old
  // unlocked rows stay in project state for failure recovery but are not mixed
  // into this one-list preview.
  const draftGenerationActive = Boolean(generationProgress)
  const visibleQuestions = project.questions
  const preservedLockedQuestions = generationLockedQuestions ?? project.questions.filter((question) => question.isLocked)
  const questionsReady = visibleQuestions.length === QUESTION_TOTAL
  const hasQuestionBasis = Boolean(project.questionsGeneratedAt) || project.questions.length > 0
  const hasMissingQuestionCategory = project.questions.length > 0 && project.questions.some((question) => !isQuestionCategory(question.category))
  const allQuestionsLocked = project.questions.length === QUESTION_TOTAL && project.questions.every((question) => question.isLocked === true)
  const generationFailed = project.questionsGeneration.status === 'failed'
  const isLocked = Boolean(project.questionsLockedAt)
  const missingQuestionSource = !isLocked && ![project.optimizationTarget, project.websiteUrl, project.supplementalInfo].some((value) => value?.trim())
  const generationInProgress = project.questionsGeneration.status === 'generating' || generating || draftGenerationActive
  const lockedCount = preservedLockedQuestions.length
  const generationTotal = Math.max(0, QUESTION_TOTAL - lockedCount)
  const generationCompletedCount = generationProgress ? Math.min(generationProgress.completedCount, generationTotal) : 0
  const generationProgressPercent = generationTotal > 0 ? Math.min(100, Math.round((generationCompletedCount / generationTotal) * 100)) : 100
  const generateLabel = hasQuestionBasis ? t('scope.regenerate') : t('scope.generate')
  const generationError = missingQuestionSource || generationInProgress ? '' : actionErrorText || (generationFailed ? (project.questionsGeneration.error ? localizeServerMessage(project.questionsGeneration.error, locale, { kind: 'questions', status: 'failed' }) : t('scope.sourceRequired')) : '')
  const questionControlsDisabled = isLocked || busy || generationInProgress || hasMissingQuestionCategory
  const questionMix = t('scope.questionMix', { total: QUESTION_TOTAL, recommendation: QUESTION_GROUP_COUNTS.recommendation, selection: QUESTION_GROUP_COUNTS.selection, decision: QUESTION_GROUP_COUNTS.decision })
  const questionsEmptyGuide = !generationInProgress && !missingQuestionSource && !generationError && project.questions.length === 0
    ? t('scope.emptyGuide', { label: generateLabel, count: QUESTION_TOTAL })
    : null
  const operationMessages = [
    generationInProgress && !generationProgress ? t('scope.generating') : null,
    allQuestionsLocked && !isLocked ? t('scope.allLocked') : null,
    questionActionErrorText || null,
    missingQuestionSource ? t('scope.sourceRequired') : null,
    generationError || null,
    questionsEmptyGuide,
  ].filter((message): message is string => Boolean(message))
  const operationError = Boolean(questionActionErrorText || generationError)
  const operationWarning = (allQuestionsLocked && !isLocked) || missingQuestionSource
  const generationPreview = generationInProgress
    ? questionGenerationPreviewItems(preservedLockedQuestions, generationProgress?.questions ?? [])
    : []

  return (
    <section className="scope-stage">
      <div className="scope-layout">
        <div className="scope-main">
          <OperationBar
            className={`question-card__header${generationInProgress ? ' question-card__header--generating' : ''}`}
            left={(
              <div className="question-card__heading">
                <h2>{hasQuestionBasis ? t('scope.outline') : t('scope.questions')}</h2>
                <span className="question-card__hint">{questionMix}</span>
              </div>
            )}
            center={(
            <OperationFeedback tone={operationError ? 'error' : operationWarning ? 'warning' : 'neutral'}>
              {generationInProgress && generationProgress ? (
                <span className="question-generation-progress">
                  <span className="question-generation-progress__copy">
                    {t('scope.generated')} <strong>{generationCompletedCount} / {generationTotal}</strong>
                    {generationCompletedCount >= generationTotal ? <> <span className="question-generation-progress__status">{t('scope.validating')}</span></> : null}
                  </span>
                  <span className="diagnosis-progress question-generation-progress__bar" role="progressbar" aria-label={t('scope.progressAria')} aria-valuemin={0} aria-valuemax={generationTotal} aria-valuenow={generationCompletedCount}>
                    <span style={{ width: `${generationProgressPercent}%` }} />
                  </span>
                </span>
              ) : null}
              {operationMessages.map((message) => <span key={message}>{message}</span>)}
            </OperationFeedback>
            )}
            right={(
              <div className="question-card__tools">
                {!isLocked ? <Button variant="secondary" className={generationInProgress ? 'button--generating' : undefined} icon={<Icon name="refresh-cw" size={16} />} aria-disabled={questionMutationBusy || undefined} disabled={missingQuestionSource || allQuestionsLocked || busy || generationInProgress} onClick={() => { if (!questionMutationBusy) onGenerate() }}>{generationInProgress ? t('scope.generateBusy') : generateLabel}</Button> : null}
                {!isLocked ? <Button icon={<Icon name="play" size={16} />} aria-disabled={questionMutationBusy || undefined} disabled={!questionsReady || busy || generationInProgress} onClick={() => { if (!questionMutationBusy) onConfirm() }}>{t('scope.confirmStart')}</Button> : <StatusBadge tone="success">{t('scope.locked')}</StatusBadge>}
              </div>
            )}
          />
          <section className="question-card">
            {!missingQuestionSource && !generationInProgress && !generationError && project.questions.length === 0 ? (
              <div className="questions-empty"><span className="questions-empty__icon" aria-hidden="true"><Icon name="list-checks" size={20} /></span><p>{t('scope.empty')}</p></div>
            ) : null}
            {generationInProgress || visibleQuestions.length > 0 ? (
              <>
                <div className="question-list__header" aria-hidden="true">
                  <span>{t('scope.index')}</span>
                  <span>{t('scope.questionList')}</span>
                  <span>{t('scope.category')}</span>
                  <span>{t('scope.lock')}</span>
                  <span>{t('scope.delete')}</span>
                </div>
                <ol className="question-list" aria-label={t('scope.questionCount', { count: generationInProgress ? generationPreview.length : visibleQuestions.length })}>
                  {(generationInProgress ? generationPreview : visibleQuestions).map((question) => {
                    const isPreviewItem = 'kind' in question
                    const questionId = isPreviewItem ? undefined : question.id
                    const questionIsLocked = isPreviewItem ? question.kind === 'locked' : Boolean(question.isLocked)
                    const locked = Boolean(questionIsLocked || isLocked)
                    const questionMutationPending = !isPreviewItem && questionMutationQuestionId === question.id
                    const lockLabel = isLocked
                      ? t('scope.lockedQuestion', { position: question.position })
                      : locked
                        ? t('scope.unlockQuestion', { position: question.position })
                        : t('scope.lockQuestion', { position: question.position })
                    const deleteLabel = locked ? t('scope.deleteLockedQuestion', { position: question.position }) : t('scope.deleteQuestion', { position: question.position })
                    const questionKey = isPreviewItem
                      ? `generation-${question.kind}-${question.id ?? question.position}`
                      : question.id || String(question.position)
                    return (
                      <li key={questionKey} className={locked ? 'question-list__item question-list__item--locked' : 'question-list__item'}>
                        <span className="question-index">{String(question.position)}</span>
                        <span className="question-list__text">{question.question}</span>
                        <span className="question-list__category">{questionCategoryLabel(question.category, locale)}</span>
                        <IconButton
                          className={`icon-button--small question-list__lock-button${locked ? ' question-list__lock-button--active' : ''}`}
                          label={lockLabel}
                          aria-pressed={locked}
                          disabled={questionControlsDisabled || questionMutationPending || !questionId}
                          onClick={() => { if (questionId) onToggleQuestion?.(questionId, !questionIsLocked) }}
                        >
                          <Icon name={locked ? 'lock-keyhole' : 'lock-keyhole-open'} size={14} />
                        </IconButton>
                        <IconButton
                          className="icon-button--small question-list__delete-button"
                          label={deleteLabel}
                          disabled={questionControlsDisabled || !questionId}
                          onClick={() => { if (questionId) onDeleteQuestion?.(questionId, questionIsLocked) }}
                        >
                          <Icon name="trash-2" size={14} />
                        </IconButton>
                      </li>
                    )
                  })}
                </ol>
              </>
            ) : null}
          </section>
        </div>
        <ScopeSummary project={project} />
      </div>
    </section>
  )
}

function diagnosisStatusLabel(status: DiagnosisAnswer['status'] | undefined, locale: Locale = 'zh-CN'): string {
  if (status === 'success') return translate(locale, 'diagnosis.status.completed')
  if (status === 'failed') return translate(locale, 'diagnosis.status.failed')
  if (status === 'running') return translate(locale, 'diagnosis.status.running')
  return translate(locale, 'diagnosis.status.pending')
}

function diagnosisStatusTone(status: DiagnosisAnswer['status'] | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'warning'
  return 'neutral'
}

function runStatusLabel(status: 'running' | 'analyzing' | 'completed' | 'failed' | undefined, locale: Locale = 'zh-CN'): string {
  if (status === 'running') return translate(locale, 'diagnosis.run.running')
  if (status === 'analyzing') return translate(locale, 'diagnosis.run.analyzing')
  if (status === 'completed') return translate(locale, 'diagnosis.run.completed')
  if (status === 'failed') return translate(locale, 'diagnosis.run.failed')
  return translate(locale, 'diagnosis.run.pending')
}

function formatRate(value: number | null, locale: Locale = 'zh-CN'): string {
  return value === null ? translate(locale, 'common.none') : locale === 'en'
    ? `${Math.round(value * 100)}% (${Math.round(value * QUESTION_TOTAL)} / ${QUESTION_TOTAL})`
    : `${Math.round(value * 100)}%（${Math.round(value * QUESTION_TOTAL)} / ${QUESTION_TOTAL}）`
}

function safeMarkdownUrl(url: string): string {
  const candidate = url.trim()
  if (!candidate) return ''

  try {
    const parsed = new URL(candidate, 'https://geodesk.local')
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return candidate
    if (parsed.origin === 'https://geodesk.local' && (/^(?:\/|\.\/|\.\.\/|#)/.test(candidate)) && !candidate.startsWith('//')) return candidate
  } catch {
    return ''
  }

  return ''
}

function emptyAnswer(project: ProjectDetail, position: number, locale: Locale = 'zh-CN'): DiagnosisAnswer {
  return {
    position,
    question: project.questions.find((question) => question.position === position)?.question ?? translate(locale, 'common.question', { position }),
    status: 'pending',
    answerText: null,
    citationUrls: [],
    responseModel: null,
    recommended: null,
    officialCitation: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

export function AnswerExplorer({ project, answers, selectedPosition, onSelect, completedCount: _completedCount, layoutClassName = 'diagnosis-layout', mode = 'diagnosis', suppressOfficialCitation: _suppressOfficialCitation = false }: {
  project: ProjectDetail
  answers: DiagnosisAnswer[]
  selectedPosition: number
  onSelect: (position: number) => void
  completedCount: number
  layoutClassName?: string
  mode?: 'diagnosis' | 'monitoring'
  suppressOfficialCitation?: boolean
}) {
  const { t, locale } = useI18n()
  const answersByPosition = new Map(answers.map((answer) => [answer.position, answer]))
  const answerFor = (position: number): DiagnosisAnswer => answersByPosition.get(position) ?? emptyAnswer(project, position, locale)
  const selected = answerFor(selectedPosition)
  const allAnswers = Array.from({ length: QUESTION_TOTAL }, (_, index) => answerFor(index + QUESTION_POSITION_MIN))
  const monitoringMode = mode === 'monitoring'

  const statusLabel = (value: boolean | null, unavailable = false): string => {
    if (unavailable) return t('common.unknown')
    if (value === true) return t('common.yes')
    if (value === false) return t('common.no')
    return t('common.pending')
  }

  const statusClass = (value: boolean | null, unavailable = false): string => {
    if (unavailable || value !== true) return 'answer-status answer-status--muted'
    return 'answer-status answer-status--positive'
  }

  const answerList = (
    <section className="diagnosis-answer-card">
      <ol className="diagnosis-answer-list" aria-label={monitoringMode ? t('diagnosis.answers.monitoringList') : t('diagnosis.answers.diagnosisList')}>
        {allAnswers.map((answer) => {
          // A missing website is the only case in which the official-citation
          // dimension cannot be judged.  PDF/report readiness is unrelated to
          // the answer evidence and must not hide a saved result.
          const unavailable = !project.websiteUrl
          return (
            <li key={answer.position}>
              <button type="button" className={selectedPosition === answer.position ? 'diagnosis-answer-list__item diagnosis-answer-list__item--active' : 'diagnosis-answer-list__item'} onClick={() => onSelect(answer.position)}>
                <span className="question-index">{String(answer.position)}</span>
                <span className="diagnosis-answer-list__content">
                  <span className="diagnosis-answer-list__question">{answer.question}</span>
                  <span className="diagnosis-answer-list__facts">
                    <span className={statusClass(answer.officialCitation, unavailable)}>{t('diagnosis.answers.citation', { value: statusLabel(answer.officialCitation, unavailable) })}</span>
                    <span className={statusClass(answer.recommended)}>{t('diagnosis.answers.recommendation', { value: statusLabel(answer.recommended) })}</span>
                  </span>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )

  const answerDetail = (
    <article className="diagnosis-answer-detail" aria-live="polite">
      <div className="diagnosis-answer-detail__scroll">
        {selected.status === 'failed' ? <div className="diagnosis-detail-error" role="alert">{selected.error || t('diagnosis.answers.failed')}</div> : null}
        {selected.answerText ? (
          <div className={'diagnosis-answer-detail__body ' + (monitoringMode ? 'diagnosis-answer-detail__body--monitoring' : '')}>
            <ReactMarkdown skipHtml urlTransform={safeMarkdownUrl}>{selected.answerText}</ReactMarkdown>
            {selected.recommended === true ? <p className="answer-highlight answer-highlight--recommendation">{t('diagnosis.answers.recommendation', { value: t('common.yes') })}</p> : null}
          </div>
        ) : selected.status !== 'failed' ? <p className="diagnosis-detail-empty">{t('diagnosis.answers.receiving')}</p> : null}
        {selected.citationUrls.length > 0 ? (
          <section className="answer-citations" aria-label={t('diagnosis.answers.citations')}>
            <h3>{t('diagnosis.answers.citations')}</h3>
            <ul>
              {selected.citationUrls.map((citation, index) => {
                const href = safeMarkdownUrl(citation)
                if (!href) return null
                return <li key={`${href}-${index}`}><a href={href} target="_blank" rel="noopener noreferrer">{href}</a></li>
              })}
            </ul>
          </section>
        ) : null}
        <span className="sr-only">{selected.question}</span>
      </div>
    </article>
  )

  return (
    <div className={'answer-explorer ' + layoutClassName + ' ' + (monitoringMode ? 'answer-explorer--monitoring' : 'answer-explorer--diagnosis').trim()}>
      {monitoringMode ? <section className="monitoring-answer-panel"><header className="monitoring-answer-panel__header"><h2>{t('diagnosis.answers.heading')}</h2></header><div className="monitoring-answer-body">{answerList}{answerDetail}</div></section> : <>{answerList}{answerDetail}</>}
    </div>
  )
}

export function DiagnosisReportSheet({ project }: { project: ProjectDetail }) {
  const { t, locale } = useI18n()
  const run = project.initialDiagnosis.run
  const answers = project.initialDiagnosis.answers.slice().sort((a, b) => a.position - b.position)

  return (
    <section className="report-sheet" aria-label={t('diagnosis.report.aria')}>
      <header className="report-sheet__header">
        <div>
          <h1>{t('diagnosis.report.title')}</h1>
          <p className="report-sheet__company">{project.companyName}</p>
        </div>
        <div className="report-sheet__brand">{t('diagnosis.report.brand')}</div>
      </header>
      <section className="report-meta-grid">
        <div><span>{t('diagnosis.report.date')}</span><strong>{formatReportDate(run?.completedAt ?? project.initialDiagnosisCompletedAt, locale)}</strong></div>
        <div><span>{t('diagnosis.report.optimizationTarget')}</span><strong>{project.optimizationTarget || t('common.companyOverall')}</strong></div>
        <div><span>{t('diagnosis.report.website')}</span><strong>{project.websiteUrl || t('common.notConfigured')}</strong></div>
      </section>
      <section className="report-rates">
        <div><span>{t('diagnosis.report.recommendationRate')}</span><strong>{formatRate(run?.recommendationRate ?? null, locale)}</strong><small>{t('diagnosis.report.lockedQuestions', { count: QUESTION_TOTAL })}</small></div>
        <div><span>{t('diagnosis.report.citationRate')}</span><strong>{project.websiteUrl ? formatRate(run?.officialCitationRate ?? null, locale) : t('common.notConfigured')}</strong><small>{t('diagnosis.report.lockedQuestions', { count: QUESTION_TOTAL })}</small></div>
        <div><span>{t('diagnosis.report.callBasis')}</span><strong>{t('diagnosis.report.calls', { count: QUESTION_TOTAL })}</strong><small>{t('diagnosis.report.api')}</small></div>
      </section>
      <section className="report-questions">
        <div className="report-questions__heading"><h2>{t('diagnosis.report.detailHeading', { count: QUESTION_TOTAL })}</h2><span>{t('diagnosis.report.yesMeaning')}</span></div>
        <ol>
          <li className="report-question report-question--header" aria-hidden="true"><span>{t('diagnosis.report.question')}</span><span>{t('diagnosis.report.recommendation')}</span><span>{t('diagnosis.report.citation')}</span></li>
          {answers.map((answer) => (
            <li className="report-question" key={answer.position}>
              <span className="report-question__text">Q{String(answer.position).padStart(2, '0')}  {answer.question}</span>
              <span className={answer.recommended ? 'report-question__result report-question__result--yes' : 'report-question__result'}>{answer.recommended ? t('common.yes') : t('common.no')}</span>
              <span className={answer.officialCitation === true ? 'report-question__result report-question__result--yes' : 'report-question__result'}>{!project.websiteUrl ? t('common.unknown') : answer.officialCitation === true ? t('common.yes') : answer.officialCitation === false ? t('common.no') : t('common.pending')}</span>
            </li>
          ))}
        </ol>
      </section>
      <footer className="report-sheet__footer"><span>{t('diagnosis.report.footer', { count: QUESTION_TOTAL })}</span><span>{t('diagnosis.report.page')}</span></footer>
    </section>
  )
}

export function reportRefreshStatus(project: ProjectDetail): DiagnosisReportRefreshStatus {
  const status = project.initialDiagnosis.reportRefreshStatus
  if (status === 'not_started' || status === 'running' || status === 'ready' || status === 'failed') return status
  return project.initialDiagnosis.reportPdfReady === true ? 'ready' : 'not_started'
}

function safeReportRefreshError(value: UiMessage | null | undefined, locale: Locale = 'zh-CN'): string {
  const rawValue = resolveUiMessage(value, locale) || translate(locale, 'error.reportGeneration')
  const raw = rawValue
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[-_ ]?key|access[-_ ]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
}

type DiagnosisReportProps = {
  project: ProjectDetail
  busy: boolean
  /** Compatibility alias for callers that still name the persisted refresh as reporting. */
  reporting?: boolean
  /** An independent AI aggregate task, distinct from non-AI PDF refresh. */
  summarying?: boolean
  actionError: UiMessage
  progress: { completedCount: number; failedCount: number; total: number } | null
  onStart: () => void
  onRetrySummary?: () => void | Promise<void>
  onRefreshReport?: () => void | Promise<void>
  /** @deprecated Use onRefreshReport. This alias does not invoke an AI task. */
  onGenerateReport?: () => void | Promise<void>
  /** @deprecated Kept for source compatibility; the server owns PDF metadata now. */
  onReportPdfReady?: (metadata: { reportPdfReady: boolean; reportPdfGeneratedAt: string | null }) => void
  refreshKind?: 'initial' | 'website'
}

export function DiagnosisReport({
  project,
  busy,
  reporting = false,
  summarying = false,
  actionError,
  progress,
  onStart,
  onRetrySummary,
  onRefreshReport,
  onGenerateReport,
  refreshKind = 'initial',
}: DiagnosisReportProps) {
  const { t, locale } = useI18n()
  const [selectedPosition, setSelectedPosition] = useState(QUESTION_POSITION_MIN)
  const [exportState, setExportState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')
  const [exportError, setExportError] = useState<UiMessage>('')
  const run = project.initialDiagnosis.run
  const completedCount = progress?.completedCount ?? project.initialDiagnosis.answers.filter((answer) => answer.status === 'success').length
  const completed = run?.status === 'completed'
  const refreshStatus = reportRefreshStatus(project)
  const refreshCallback = onRefreshReport ?? onGenerateReport
  const reportBusy = reporting || summarying || refreshStatus === 'running' || run?.status === 'analyzing' || (busy && completedCount === QUESTION_TOTAL && !completed)
  const reportCanBePrepared = completed && canExportDiagnosisReport(project)
  const summaryFailed = run?.status === 'failed' && completedCount === QUESTION_TOTAL && project.initialDiagnosis.answers.length === QUESTION_TOTAL && project.initialDiagnosis.answers.every((answer) => answer.status === 'success')
  const reportPdfReady = reportCanBePrepared && refreshStatus === 'ready' && project.initialDiagnosis.reportPdfReady === true
  const canRefreshReport = reportCanBePrepared && !reportBusy && refreshStatus !== 'ready' && Boolean(refreshCallback)
  const reportDate = formatReportDate(run?.completedAt ?? project.initialDiagnosisCompletedAt, locale)
  const diagnosisInterrupted = Boolean(run) && !busy && !reportBusy && !completed && completedCount < QUESTION_TOTAL
  const actionErrorText = resolveUiMessage(actionError, locale)
  const diagnosisError = actionErrorText || (!completed && completedCount === QUESTION_TOTAL ? (run?.summaryError ? localizeServerMessage(run.summaryError, locale, { kind: 'diagnosis_report', status: 'failed' }) : '') : '')
  const diagnosisContinuationMessage = t('diagnosis.partial')
  const diagnosisFeedbackError = diagnosisError === '部分问题未完成，请点击重试' ? diagnosisContinuationMessage : diagnosisError
  const reportError = refreshStatus === 'failed' ? safeReportRefreshError(project.initialDiagnosis.reportRefreshError, locale) : ''
  const exportErrorText = resolveUiMessage(exportError, locale)
  const reportMessage = refreshKind === 'website' ? t('diagnosis.report.refreshing') : t('diagnosis.report.generating')
  const diagnosisFeedbackMessages = [
    diagnosisFeedbackError
      ? <span key="diagnosis-error">{diagnosisFeedbackError}</span>
      : diagnosisInterrupted ? <span key="interrupted">{diagnosisContinuationMessage}</span> : null,
    !completed && completedCount < QUESTION_TOTAL ? (
        <span key="diagnosis-progress" className="diagnosis-feedback-progress">
        <span className="diagnosis-feedback-progress__label">{t('diagnosis.progress', { completed: completedCount, total: QUESTION_TOTAL })}</span>
        <span className="diagnosis-progress diagnosis-feedback-progress__bar" role="progressbar" aria-label={t('diagnosis.progressAria')} aria-valuemin={0} aria-valuemax={QUESTION_TOTAL} aria-valuenow={completedCount}>
          <span style={{ width: String(Math.min(100, Math.max(0, (completedCount / QUESTION_TOTAL) * 100))) + '%' }} />
        </span>
      </span>
    ) : null,
    summarying ? <span key="diagnosis-summary-running">{t('diagnosis.summarying')}</span> : null,
    reportBusy && completed && refreshStatus === 'running' ? <span key="report-refreshing">{reportMessage}</span> : null,
    run?.status === 'analyzing' && !completed ? <span key="diagnosis-summary">{t('diagnosis.summarying')}</span> : null,
    !reportBusy && reportError ? <span key="report-error">{reportError}</span> : null,
    exportState === 'downloading' ? <span key="diagnosis-export-loading">{t('diagnosis.pdf.downloading')}</span> : null,
    exportState === 'error' ? <span key="diagnosis-export-error">{t('diagnosis.pdf.downloadFailed', { detail: exportErrorText || t('common.retry') })}</span> : null,
  ].filter(Boolean)
  const diagnosisFeedbackHasError = Boolean(diagnosisError || reportError || exportState === 'error')
  const diagnosisFeedbackTone = diagnosisFeedbackHasError ? 'error' : exportState === 'success' ? 'success' : 'neutral'

  const exportReport = useCallback(async () => {
    if (!reportPdfReady || exportState === 'downloading') return
    setExportState('downloading')
    setExportError('')
    try {
      const downloaded = await downloadDiagnosisReportPdf(project.id)
      triggerDiagnosisReportDownload(downloaded.blob, downloaded.filename ?? buildDiagnosisReportFilename(project.companyName, reportDate))
      setExportState('success')
    } catch (cause) {
      setExportState('error')
      setExportError(apiErrorMessage(cause, 'error.server.diagnosis_report_pdf_unavailable'))
    }
  }, [exportState, project.companyName, project.id, reportDate, reportPdfReady])

  useEffect(() => {
    setExportState('idle')
    setExportError('')
  }, [project.id, refreshStatus, project.initialDiagnosis?.reportPdfGeneratedAt])

  const actionLabel = busy
    ? t('diagnosis.action.running')
    : project.initialDiagnosis.answers.some((answer) => answer.status === 'failed')
      ? t('diagnosis.action.retryFailed')
      : run
        ? t('diagnosis.action.continue')
        : t('diagnosis.action.start')

  return (
    <section className="diagnosis-stage">
      <div className="diagnosis-report-layout">
        <div className="diagnosis-report-main">
          <OperationBar
            className="diagnosis-qa-card__header"
            left={<h2>{t('diagnosis.result')}</h2>}
            center={<OperationFeedback tone={diagnosisFeedbackTone}>{diagnosisFeedbackMessages}</OperationFeedback>}
            right={(
              <div className="diagnosis-qa-card__actions">
                {!completed && completedCount < QUESTION_TOTAL ? <Button disabled={busy || reportBusy || summarying} onClick={onStart}>{actionLabel}</Button> : null}
                {summaryFailed && onRetrySummary ? <Button variant="secondary" disabled={busy || reportBusy || summarying} onClick={() => void onRetrySummary()}>{summarying ? t('diagnosis.summaryingShort') : t('diagnosis.retrySummary')}</Button> : null}
                {canRefreshReport ? <Button variant="secondary" onClick={() => void refreshCallback?.()}>{refreshStatus === 'failed' ? t('diagnosis.retryReport') : t('diagnosis.generateReport')}</Button> : null}
                <Button
                  variant="secondary"
                  icon={<Icon name="download" size={16} />}
                  disabled={!reportPdfReady || busy || reportBusy || exportState === 'downloading'}
                  onClick={() => void exportReport()}
                >{exportState === 'downloading' ? t('common.downloading') : exportState === 'error' ? t('diagnosis.retryDownload') : t('diagnosis.export')}</Button>
              </div>
            )}
          />
          <section className="diagnosis-qa-card">
            <div className="diagnosis-answer-table-header">
              <span>{t('diagnosis.answers.heading')}</span>
              <span>{t('diagnosis.fullAnswer')}</span>
            </div>
            <AnswerExplorer
              project={project}
              answers={project.initialDiagnosis.answers}
              selectedPosition={selectedPosition}
              onSelect={setSelectedPosition}
              completedCount={completedCount}
            />
          </section>
        </div>
        <aside className="diagnosis-metrics" aria-label={t('diagnosis.metrics.aria')}>
          <MetricCard icon={<Icon name="ruler" size={16} />} label={t('diagnosis.metrics.basis')} value={t('diagnosis.metrics.questions', { count: QUESTION_TOTAL })} caption={t('diagnosis.metrics.singleCall')} />
          <MetricCard icon={<Icon name="badge-check" size={16} />} label={t('diagnosis.metrics.recommendation')} value={formatRate(run?.recommendationRate ?? project.initialRecommendationRate, locale)} caption={t('diagnosis.metrics.initial')} />
          <MetricCard icon={<Icon name="link" size={16} />} label={t('diagnosis.metrics.citation')} value={!project.websiteUrl ? t('common.notConfigured') : reportPdfReady ? formatRate(run?.officialCitationRate ?? project.initialOfficialCitationRate, locale) : t('diagnosis.metrics.refresh')} caption={!project.websiteUrl ? t('diagnosis.metrics.noWebsite') : reportPdfReady ? t('diagnosis.metrics.website') : t('diagnosis.metrics.refresh')} />
        </aside>
      </div>
    </section>
  )
}

function canExportDiagnosisReport(project: ProjectDetail): boolean {
  const run = project.initialDiagnosis.run
  return Boolean(
    run?.status === 'completed'
      && project.initialDiagnosis.answers.length === QUESTION_TOTAL
      && project.initialDiagnosis.answers.every((answer) => answer.status === 'success'),
  )
}

function ReportUnavailable({ onBack, onRefresh, refreshBusy = false, pdfPending = false, status = 'not_started', error = '' }: {
  onBack: () => void
  onRefresh?: () => void | Promise<void>
  refreshBusy?: boolean
  pdfPending?: boolean
  status?: DiagnosisReportRefreshStatus
  error?: UiMessage
}) {
  const { t, locale } = useI18n()
  const running = status === 'running'
  const failed = status === 'failed'
  return (
    <section className="report-unavailable" role="alert">
      <div className="stage-placeholder__symbol" aria-hidden="true"><Icon name="file-check" size={28} /></div>
      <h1>{running ? t('diagnosis.reportUnavailable.runningTitle') : failed ? t('diagnosis.reportUnavailable.failedTitle') : pdfPending ? t('diagnosis.reportUnavailable.pendingTitle') : t('diagnosis.reportUnavailable.unavailableTitle')}</h1>
      <p>{running ? t('diagnosis.reportUnavailable.runningDescription') : failed ? safeReportRefreshError(error, locale) : pdfPending ? t('diagnosis.reportUnavailable.pendingDescription') : t('diagnosis.reportUnavailable.unavailableDescription')}</p>
      {!running && onRefresh && pdfPending ? <Button variant="secondary" onClick={() => void onRefresh()} disabled={refreshBusy}>{refreshBusy ? t('diagnosis.reportUnavailable.generating') : failed ? t('diagnosis.retryReport') : t('diagnosis.generateReport')}</Button> : null}
      <Button variant="secondary" onClick={onBack}>{t('diagnosis.reportUnavailable.back')}</Button>
    </section>
  )
}

export function ProjectReportPage({ project, projectState, onRetry, onBack, onReportRefreshMetadata }: {
  project: ProjectDetail | null
  projectState: LoadState
  onRetry: () => void
  onBack: () => void
  onReportRefreshMetadata?: (metadata: DiagnosisReportRefreshMetadata) => void
}) {
  const { t, locale } = useI18n()
  const [exportState, setExportState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')
  const [exportError, setExportError] = useState<UiMessage>('')
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<UiMessage>('')
  const [refreshMetadata, setRefreshMetadata] = useState<DiagnosisReportRefreshMetadata | null>(null)
  const autoStartKeyRef = useRef<string | null>(null)
  const persistedRefreshStatus = project ? reportRefreshStatus(project) : 'not_started'
  const refreshStatus = refreshMetadata?.status ?? persistedRefreshStatus
  const refreshPdfReady = refreshMetadata?.reportPdfReady ?? project?.initialDiagnosis.reportPdfReady === true
  const ready = Boolean(project && canExportDiagnosisReport(project) && refreshStatus === 'ready' && refreshPdfReady)
  const reportDate = project ? formatReportDate(project.initialDiagnosis.run?.completedAt ?? project.initialDiagnosisCompletedAt, locale) : null

  const applyRefreshMetadata = useCallback((metadata: DiagnosisReportRefreshMetadata): void => {
    setRefreshMetadata(metadata)
    setRefreshError('')
    onReportRefreshMetadata?.(metadata)
  }, [onReportRefreshMetadata])

  const refreshReport = useCallback(async (): Promise<void> => {
    if (!project || refreshBusy || !canExportDiagnosisReport(project)) return
    setRefreshBusy(true)
    setRefreshError('')
    try {
      const metadata = await startDiagnosisReportRefresh(project.id)
      applyRefreshMetadata(metadata)
    } catch (cause) {
      setRefreshError(apiErrorMessage(cause, 'error.server.diagnosis_report_refresh_unavailable'))
    } finally {
      setRefreshBusy(false)
    }
  }, [applyRefreshMetadata, project, refreshBusy])

  useEffect(() => {
    autoStartKeyRef.current = null
    setRefreshMetadata(null)
    setRefreshError('')
  }, [project?.id, project?.initialDiagnosis.run?.id])

  // The report route can outlive the workspace route.  Start a not-started
  // report once and poll the persisted lifecycle here so a route change or
  // refresh cannot strand a running backend render.
  useEffect(() => {
    if (!project || projectState !== 'ready' || !canExportDiagnosisReport(project) || refreshStatus !== 'not_started') return
    const key = `${project.id}:${project.initialDiagnosis.run?.id ?? ''}`
    if (autoStartKeyRef.current === key) return
    autoStartKeyRef.current = key
    void refreshReport()
  }, [project, projectState, refreshReport, refreshStatus])

  useEffect(() => {
    if (!project || projectState !== 'ready' || refreshStatus !== 'running') return
    const projectId = project.id
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const metadata = await fetchDiagnosisReportRefresh(projectId)
        if (cancelled) return
        applyRefreshMetadata(metadata)
        if (metadata.status === 'running') timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
      } catch (cause) {
        if (cancelled) return
        setRefreshError(apiErrorMessage(cause, 'error.server.diagnosis_report_refresh_unavailable'))
        timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
      }
    }
    timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [applyRefreshMetadata, project, projectState, refreshStatus])

  const exportReport = useCallback(async () => {
    if (!project || !ready || exportState === 'downloading') return
    setExportState('downloading')
    setExportError('')
    try {
      const downloaded = await downloadDiagnosisReportPdf(project.id)
      triggerDiagnosisReportDownload(downloaded.blob, downloaded.filename ?? buildDiagnosisReportFilename(project.companyName, reportDate))
      setExportState('success')
    } catch (cause) {
      setExportState('error')
      setExportError(apiErrorMessage(cause, 'error.server.diagnosis_report_pdf_unavailable'))
    }
  }, [exportState, project, ready, reportDate])

  useEffect(() => {
    setExportState('idle')
    setExportError('')
  }, [project?.id])

  if (projectState === 'error') {
    return (
      <main className="page-content report-page">
        <OperationBar
          className="report-page__actions"
          left={<h1 className="report-page__title">{t('report.pageTitle')}</h1>}
          center={<OperationFeedback tone="error">{t('report.loadError')}</OperationFeedback>}
          right={<Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}
        />
      </main>
    )
  }
  if (projectState === 'loading' || !project) {
    return (
      <main className="page-content report-page">
        <OperationBar
          className="report-page__actions"
          left={<h1 className="report-page__title">{t('report.pageTitle')}</h1>}
          center={<OperationFeedback>{t('report.loading')}</OperationFeedback>}
        />
      </main>
    )
  }
  if (!ready) {
    const reportError = resolveUiMessage(refreshError, locale) || project.initialDiagnosis.reportRefreshError || ''
    return <main className="page-content report-page"><ReportUnavailable onBack={onBack} onRefresh={refreshReport} refreshBusy={refreshBusy} pdfPending={canExportDiagnosisReport(project)} status={refreshStatus} error={reportError} /></main>
  }

  return (
    <main className="page-content report-page">
      <OperationBar
        className="report-page__actions"
        center={<OperationFeedback tone={exportState === 'error' ? 'error' : exportState === 'success' ? 'success' : 'neutral'}>
          {exportState === 'downloading' ? t('diagnosis.pdf.downloading') : null}
          {exportState === 'error' ? t('report.downloadError', { detail: resolveUiMessage(exportError, locale) || t('common.retry') }) : null}
        </OperationFeedback>}
        right={(
          <div className="report-page__action-buttons">
            <Button variant="secondary" onClick={() => void exportReport()} disabled={exportState === 'downloading'}>{exportState === 'success' ? t('diagnosis.redownload') : exportState === 'error' ? t('report.retryDownload') : t('diagnosis.download')}</Button>
            <Button variant="quiet" onClick={onBack}>{t('report.back')}</Button>
          </div>
        )}
      />
      <DiagnosisReportSheet project={project} />
    </main>
  )
}

function articleIdSortValue(id: string): number | null {
  const value = Number(id)
  return Number.isFinite(value) ? value : null
}

function compareArticleIdsDesc(a: string, b: string): number {
  const aNumber = articleIdSortValue(a)
  const bNumber = articleIdSortValue(b)
  if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return bNumber - aNumber
  return String(b).localeCompare(String(a))
}

function articleCreatedTimestamp(article: ProjectArticle): number {
  const value = new Date(article.generatedAt).getTime()
  return Number.isFinite(value) ? value : 0
}

function articleUpdatedTimestamp(article: ProjectArticle): number | null {
  const value = new Date(article.updatedAt || article.generatedAt).getTime()
  return Number.isFinite(value) ? value : null
}

function articleStateRank(article: ProjectArticle): number {
  if (article.publishStatus === 'published') return 4
  const status = articleWritingStatus(article)
  if (status === 'ready' && article.contentHtml) return 3
  if (status === 'writing') return 2
  return 1
}

function newerArticleSnapshot(current: ProjectArticle | undefined, incoming: ProjectArticle): ProjectArticle {
  if (!current) return incoming
  const currentTime = articleUpdatedTimestamp(current)
  const incomingTime = articleUpdatedTimestamp(incoming)
  if (currentTime !== null && incomingTime !== null) {
    if (incomingTime > currentTime) return incoming
    if (incomingTime < currentTime) return current
  }
  // A claim/complete response can leave the project.updatedAt unchanged. Do
  // not let an equal-timestamp stale response regress a more complete row.
  return articleStateRank(incoming) >= articleStateRank(current) ? incoming : current
}

/**
 * Merge detail snapshots without inventing timestamps. Article writes update
 * article.updatedAt independently from project.updatedAt, so project-level
 * comparisons alone can lose a newer title/body when responses arrive out of
 * order. This pure merge keeps all title rows and chooses each row by its own
 * server timestamp/state.
 */
export function mergeProjectArticleSnapshots(current: ProjectDetail | null, incoming: ProjectDetail, deletedArticleIds: ReadonlySet<string> = new Set()): ProjectDetail {
  if (!current || current.id !== incoming.id) {
    if (deletedArticleIds.size === 0) return incoming
    return {
      ...incoming,
      articleBatches: (incoming.articleBatches ?? []).map((batch) => ({
        ...batch,
        articles: batch.articles.filter((article) => !deletedArticleIds.has(article.id)),
      })),
    }
  }
  const incomingBatches = incoming.articleBatches ?? []
  const currentBatches = current.articleBatches ?? []
  const currentById = new Map<string, ProjectArticle>()
  for (const batch of currentBatches) {
    for (const article of batch.articles) {
      if (!deletedArticleIds.has(article.id)) currentById.set(article.id, article)
    }
  }

  const seenIds = new Set<string>()
  const mergedBatches = incomingBatches.map((batch) => ({
    ...batch,
    articles: batch.articles.filter((article) => !deletedArticleIds.has(article.id)).map((article) => {
      seenIds.add(article.id)
      return newerArticleSnapshot(currentById.get(article.id), article)
    }),
  }))

  // A stale response may not include a title inserted by a newer response.
  // Keep that row in its original batch rather than deleting user-visible work.
  for (const currentBatch of currentBatches) {
    const target = mergedBatches.find((batch) => batch.id === currentBatch.id)
    if (target) {
      for (const article of currentBatch.articles) {
        if (deletedArticleIds.has(article.id)) continue
        if (seenIds.has(article.id)) continue
        seenIds.add(article.id)
        target.articles.push(article)
      }
      continue
    }
    mergedBatches.push({ ...currentBatch, articles: currentBatch.articles.filter((article) => !deletedArticleIds.has(article.id)) })
    for (const article of currentBatch.articles) if (!deletedArticleIds.has(article.id)) seenIds.add(article.id)
  }

  const incomingTime = incoming.updatedAt ? new Date(incoming.updatedAt).getTime() : Number.NaN
  const currentTime = current.updatedAt ? new Date(current.updatedAt).getTime() : Number.NaN
  const base = Number.isFinite(incomingTime) && Number.isFinite(currentTime) && incomingTime < currentTime ? current : incoming
  return { ...base, articleBatches: mergedBatches }
}

function articleList(project: ProjectDetail): ProjectArticle[] {
  return (project.articleBatches ?? [])
    .flatMap((batch) => batch.articles)
    .slice()
    .sort((a, b) => {
      const created = articleCreatedTimestamp(b) - articleCreatedTimestamp(a)
      return created || compareArticleIdsDesc(b.id, a.id)
    })
}

function mergeMonitoringAnswers(currentAnswers: DiagnosisAnswer[], incomingAnswers: DiagnosisAnswer[]): DiagnosisAnswer[] {
  const byPosition = new Map<number, DiagnosisAnswer>()
  for (const answer of currentAnswers) byPosition.set(answer.position, answer)
  for (const answer of incomingAnswers) {
    const current = byPosition.get(answer.position)
    // A late running/failed event must never regress an answer that has
    // already been persisted as successful.  A successful retry may still
    // replace an older failed/running snapshot.
    if (current?.status === 'success' && answer.status !== 'success') continue
    byPosition.set(answer.position, answer)
  }
  return [...byPosition.values()].sort((a, b) => a.position - b.position)
}

export function mergeMonitoringUpdate(current: ProjectDetail | null, projectId: string, update: MonitoringUpdateEvent): ProjectDetail | null {
  if (!current || current.id !== projectId) return null
  const runs = current.monitoringRuns ?? []
  if (update.type === 'run') {
    const index = runs.findIndex((run) => run.id === update.run.id)
    if (index < 0) {
      const nextRuns = [...runs, update.run].sort((a, b) => b.roundNumber - a.roundNumber)
      return { ...current, monitoringRuns: nextRuns }
    }
    const previous = runs[index]
    if (previous?.status === 'completed' && update.run.status !== 'completed') return current
    const nextRun: MonitoringRun = {
      ...update.run,
      answers: mergeMonitoringAnswers(previous?.answers ?? [], update.run.answers),
    }
    const nextRuns = runs.slice()
    nextRuns[index] = nextRun
    return { ...current, monitoringRuns: nextRuns }
  }

  const index = runs.findIndex((run) => run.id === update.runId)
  if (index < 0) return current
  const previous = runs[index]
  if (update.type === 'analyzing') {
    if (previous.status === 'completed') return current
    const nextRun: MonitoringRun = { ...previous, status: 'analyzing', summaryError: null, completedAt: null }
    const nextRuns = runs.slice()
    nextRuns[index] = nextRun
    return { ...current, monitoringRuns: nextRuns }
  }

  if (previous.status === 'completed') return current
  const currentAnswer = previous.answers.find((answer) => answer.position === update.answer.position)
  if (currentAnswer?.status === 'success' && update.answer.status !== 'success') return current
  const answers = mergeMonitoringAnswers(previous.answers, [update.answer])
  const nextRun: MonitoringRun = { ...previous, answers }
  const nextRuns = runs.slice()
  nextRuns[index] = nextRun
  return { ...current, monitoringRuns: nextRuns }
}

function articleWritingStatus(article: ProjectArticle): 'pending' | 'writing' | 'ready' | 'failed' {
  // Keep old fixtures and an already-loaded project usable during the
  // additive API/schema rollout. New API responses include this field.
  if (article.writingStatus) return article.writingStatus
  return article.contentHtml ? 'ready' : 'pending'
}

function articleStatus(article: ProjectArticle, writingStatus = articleWritingStatus(article), locale: Locale = 'zh-CN'): { tone: 'success' | 'warning' | 'neutral'; label: string } {
  if (article.publishStatus === 'published') return { tone: 'success', label: translate(locale, 'article.status.published') }
  if (writingStatus === 'writing') return { tone: 'warning', label: translate(locale, 'article.status.writing') }
  if (writingStatus === 'ready') return { tone: 'warning', label: translate(locale, 'article.status.pendingPublish') }
  return { tone: 'neutral', label: translate(locale, 'article.status.pendingWriting') }
}

function articleQuestionLabel(article: ProjectArticle, locale: Locale = 'zh-CN'): string {
  const label = (article.questionPositions ?? [])
    .slice()
    .sort((a, b) => a - b)
    .map((position) => `Q${String(position).padStart(2, '0')}`)
    .join('·')
  return label || translate(locale, 'article.contentAudit')
}

function articleHasValidTarget(article: ProjectArticle): boolean {
  const optimizationType = article.optimizationType?.trim()
  if (optimizationType !== '更新已有文章' && optimizationType !== '更新现有页面') return false
  try {
    const target = new URL(article.targetPageUrl?.trim() ?? '')
    return target.protocol === 'http:' || target.protocol === 'https:'
  } catch {
    // A legacy update without a usable target is shown conservatively as new.
    return false
  }
}

function articleOptimizationLabel(article: ProjectArticle, locale: Locale = 'zh-CN'): string {
  return articleHasValidTarget(article) ? translate(locale, 'article.update') : translate(locale, 'article.new')
}

const articleOptimizationDirections = new Set<string>(ARTICLE_OPTIMIZATION_DIRECTIONS)

function articleOptimizationDirectionLabel(article: ProjectArticle, locale: Locale = 'zh-CN'): string | null {
  const direction = article.optimizationDirection?.trim()
  if (!direction || !articleOptimizationDirections.has(direction)) return null
  if (locale === 'zh-CN') return direction
  if (direction === '主题内容补充') return translate(locale, 'optimization.direction.topic')
  if (direction === '补充 FAQ') return translate(locale, 'optimization.direction.faq')
  if (direction === '补充权威来源') return translate(locale, 'optimization.direction.authority')
  return direction
}

export function ArticlePreviewModal({ article, busy, onClose, onConfirmPublished, onDeleteArticle }: {
  article: ProjectArticle
  busy?: boolean
  onClose: () => void
  onConfirmPublished: (articleId: string) => Promise<void>
  onDeleteArticle?: (articleId: string) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'success' | 'error'>('idle')
  const [publishState, setPublishState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [deleteState, setDeleteState] = useState<'idle' | 'confirming' | 'deleting' | 'error'>('idle')
  const deleteInFlightRef = useRef(false)
  const writingStatus = articleWritingStatus(article)
  const hasBody = writingStatus === 'ready' && Boolean(article.contentHtml?.trim())

  useEffect(() => {
    setCopyState('idle')
    setPublishState('idle')
    setDeleteState('idle')
  }, [article.id, article.contentHtml, article.writingStatus])

  const copy = async () => {
    if (!hasBody) return
    setCopyState('copying')
    try {
      await copyArticleContent(article)
      setCopyState('success')
    } catch {
      setCopyState('error')
    }
  }

  const confirm = async () => {
    if (!hasBody || article.publishStatus === 'published') return
    setPublishState('saving')
    try {
      await onConfirmPublished(article.id)
      setPublishState('idle')
      onClose()
    } catch {
      setPublishState('error')
    }
  }

  const remove = async () => {
    if (!onDeleteArticle || article.publishStatus === 'published' || deleteState === 'deleting' || deleteInFlightRef.current) return
    deleteInFlightRef.current = true
    setDeleteState('deleting')
    try {
      await onDeleteArticle(article.id)
      setDeleteState('idle')
      onClose()
    } catch {
      setDeleteState('error')
    } finally {
      deleteInFlightRef.current = false
    }
  }

  const copyLabel = copyState === 'copying' ? t('optimization.copying') : copyState === 'success' ? t('optimization.copyDone') : t('optimization.copy')
  const publishLabel = article.publishStatus === 'published' ? t('optimization.confirmedPublish') : publishState === 'saving' ? t('common.saving') : t('optimization.confirmPublish')
  const deleteLabel = deleteState === 'deleting' ? t('common.deleting') : deleteState === 'confirming' ? t('optimization.confirmDelete') : t('common.delete')
  const previewFeedbackMessages = [
    copyState === 'copying' ? <span key="copying">{t('optimization.copying')}</span> : null,
    copyState === 'success' ? <span key="copy-success">{t('optimization.copied')}</span> : null,
    copyState === 'error' ? <span key="copy-error">{t('optimization.copyFailed')}</span> : null,
    publishState === 'saving' ? <span key="publish-saving">{t('optimization.savingPublish')}</span> : null,
    publishState === 'error' ? <span key="publish-error">{t('optimization.publishFailed')}</span> : null,
    deleteState === 'deleting' ? <span key="delete-deleting">{t('optimization.deletingArticle')}</span> : null,
    deleteState === 'error' ? <span key="delete-error">{t('optimization.deleteFailed')}</span> : null,
  ].filter(Boolean)
  const previewFeedbackHasError = copyState === 'error' || publishState === 'error' || deleteState === 'error'
  const previewFeedbackTone = previewFeedbackHasError ? 'error' : copyState === 'success' ? 'success' : 'neutral'
  return (
    <Modal
      title={t('optimization.preview')}
      onSubmit={(event) => event.preventDefault()}
      onClose={onClose}
      submitting={Boolean(busy) || publishState === 'saving' || deleteState === 'deleting'}
      submitLabel={t('optimization.confirmPublish')}
      className="preview-modal"
      focusManagement
      footer={(
        <div className="modal__footer preview-modal__footer">
          {onDeleteArticle && article.publishStatus !== 'published' ? (
            <div className="preview-modal__delete-group">
              {deleteState === 'confirming' ? <Button type="button" variant="secondary" onClick={() => setDeleteState('idle')}>{t('common.cancel')}</Button> : null}
              <Button type="button" variant="danger" icon={<Icon name="trash-2" size={16} />} onClick={() => { if (deleteState === 'confirming') void remove(); else setDeleteState('confirming') }} disabled={Boolean(busy) || publishState === 'saving' || deleteState === 'deleting'}>{deleteLabel}</Button>
            </div>
          ) : null}
          <div className="preview-modal__feedback"><OperationFeedback tone={previewFeedbackTone}>{previewFeedbackMessages}</OperationFeedback></div>
          <div className="preview-modal__footer-actions">
            <Button type="button" variant="secondary" icon={<Icon name="copy" size={16} />} onClick={() => void copy()} disabled={Boolean(busy) || !hasBody || copyState === 'copying' || deleteState !== 'idle'}>{copyLabel}</Button>
            <Button type="button" icon={<Icon name="circle-check" size={16} />} onClick={() => void confirm()} disabled={Boolean(busy) || !hasBody || article.publishStatus === 'published' || publishState === 'saving' || deleteState !== 'idle'}>{publishLabel}</Button>
          </div>
        </div>
      )}
    >
      <div className="preview-modal__content">
        <h1>{article.title}</h1>
        <div className="article-preview-meta">
          <span>{t('optimization.methodLabel', { value: articleOptimizationLabel(article, locale) })}</span>
          {articleOptimizationDirectionLabel(article, locale) ? <span>{t('optimization.directionLabel', { value: articleOptimizationDirectionLabel(article, locale) ?? '' })}</span> : null}
          {articleHasValidTarget(article) && article.targetPageUrl ? <span>{t('optimization.original', { title: article.targetPageTitle || t('optimization.originalArticle') })} <a href={article.targetPageUrl} target="_blank" rel="noopener noreferrer">{article.targetPageUrl}</a></span> : null}
        </div>
        {writingStatus === 'writing' ? <div className="article-preview-empty" role="status">{t('optimization.writingBody')}</div> : null}
        {writingStatus !== 'writing' && !hasBody ? (
          <div className="article-preview-empty" role={article.writingError ? 'alert' : 'status'}>
            <strong>{t('optimization.notStartedWriting')}</strong>
            {article.writingError ? <span>{t('optimization.lastWritingFailed', { detail: article.writingError })}</span> : null}
          </div>
        ) : null}
        {hasBody ? <div className="article-rich-text" dangerouslySetInnerHTML={{ __html: article.contentHtml ?? '' }} /> : null}
      </div>
    </Modal>
  )
}

export function OptimizationSuggestions({ project, busy, generating = false, actionError, generationNotice = '', onSaveWebsite: _onSaveWebsite, onGenerate, onWriteArticle, onProjectRefresh, onConfirmPublished, onDeleteArticle, contentAuditRecord, contentAuditLoading = false, contentAuditLoadError = '', contentAuditTaskError = '', onContentAuditCheck, writingTaskIds = [], contentAuditTaskActive = false, contentAuditTaskFailed = false }: {
  project: ProjectDetail
  busy: boolean
  generating?: boolean
  actionError: UiMessage
  generationNotice?: string
  /** @deprecated Website completion is exposed only by the project-info modal. */
  onSaveWebsite?: (websiteUrl: string) => void
  onGenerate: () => void | Promise<number>
  onWriteArticle?: (articleId: string) => Promise<void>
  onProjectRefresh?: (project: ProjectDetail) => void
  onConfirmPublished: (articleId: string) => Promise<void>
  onDeleteArticle?: (articleId: string) => Promise<void>
  contentAuditRecord?: ContentAuditRecord | null
  contentAuditLoading?: boolean
  contentAuditLoadError?: UiMessage
  contentAuditTaskError?: UiMessage
  onContentAuditCheck?: () => void | Promise<void>
  writingTaskIds?: readonly string[]
  contentAuditTaskActive?: boolean
  contentAuditTaskFailed?: boolean
}) {
  const { t, locale } = useI18n()
  const actionErrorText = resolveUiMessage(actionError, locale)
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [localWritingIds, setLocalWritingIds] = useState<Set<string>>(() => new Set())
  const [localGenerationNotice, setLocalGenerationNotice] = useState('')
  const generationInFlightRef = useRef(false)
  const generationRequestTokenRef = useRef(0)
  const writingTaskIdSet = useMemo(() => new Set(writingTaskIds), [writingTaskIds])
  const articles = articleList(project)
  const selectedArticle = selectedArticleId ? articles.find((article) => article.id === selectedArticleId) ?? null : null
  const selectedArticleForPreview = selectedArticle && localWritingIds.has(selectedArticle.id) && articleWritingStatus(selectedArticle) !== 'ready'
    ? { ...selectedArticle, writingStatus: 'writing' as const, writingError: null }
    : selectedArticle
  const contentAuditEnabled = contentAuditRecord !== undefined || contentAuditLoading || Boolean(resolveUiMessage(contentAuditLoadError, locale)) || Boolean(resolveUiMessage(contentAuditTaskError, locale)) || Boolean(onContentAuditCheck)
  const contentAuditReady = !contentAuditEnabled || contentAuditGenerationReady(contentAuditRecord)
  const contentAuditFailed = contentAuditRecord?.status === 'failed' || contentAuditTaskFailed
  // A failed check is an explicit terminal result: it may not be used as
  // generation input, but it must not prevent the operator from designing a
  // plan.  Missing, invalid, or running checks remain a manual gate.
  const contentAuditBlocked = contentAuditEnabled && !contentAuditFailed && (!contentAuditReady || contentAuditTaskActive)
  const activeWritingMessages = articles
    .filter((article) => articleWritingStatus(article) === 'writing' || localWritingIds.has(article.id) || writingTaskIdSet.has(article.id))
    .map((article) => t('optimization.activeWriting', { title: article.title }))
  const articleErrors = articles
    .filter((article) => Boolean(article.writingError?.trim())
      && articleWritingStatus(article) !== 'writing'
      && !localWritingIds.has(article.id))
    .map((article) => t('optimization.writeFailed', { title: article.title, detail: article.writingError ?? '' }))
  const articlesEmptyGuide = !generating && articles.length === 0 && !actionErrorText && !generationNotice && !localGenerationNotice
    ? t('optimization.guide')
    : null
  const operationMessages = [
    generating ? t('optimization.planGenerating') : null,
    ...activeWritingMessages,
    !generating && actionErrorText ? actionErrorText : null,
    ...articleErrors.filter((message) => message !== actionErrorText),
    !generating && !actionErrorText && generationNotice ? generationNotice : null,
    !generating && !actionErrorText && localGenerationNotice ? localGenerationNotice : null,
    articlesEmptyGuide,
  ].filter((message): message is string => Boolean(message))
  const operationError = Boolean((!generating && actionErrorText) || articleErrors.length > 0)
  const operationTone = operationError ? 'error' : 'neutral'

  useEffect(() => {
    setSelectedArticleId(null)
    setLocalWritingIds(new Set())
    setLocalGenerationNotice('')
    generationRequestTokenRef.current += 1
    generationInFlightRef.current = false
  }, [project.id])

  useEffect(() => {
    const completed = new Set(
      articles
        .filter((article) => {
          const status = articleWritingStatus(article)
          return status === 'ready'
        })
        .map((article) => article.id),
    )
    setLocalWritingIds((current) => {
      const next = new Set([...current].filter((id) => !completed.has(id)))
      return next.size === current.size ? current : next
    })
  }, [articles])

  useEffect(() => {
    if (localWritingIds.size === 0 && writingTaskIdSet.size === 0 || !onProjectRefresh) return
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const refreshed = await fetchProject(project.id)
        if (cancelled) return
        onProjectRefresh(refreshed)
      } catch {
        // The write request remains the source of truth; a transient refresh
        // failure should not release the local writing guard.
      }
      if (!cancelled && (localWritingIds.size > 0 || writingTaskIdSet.size > 0)) {
        timer = window.setTimeout(() => { void poll() }, WEBSITE_CRAWL_POLL_INTERVAL_MS)
      }
    }
    timer = window.setTimeout(() => { void poll() }, WEBSITE_CRAWL_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [localWritingIds.size, onProjectRefresh, project.id, writingTaskIdSet.size])

  const handleGenerate = async () => {
    if (generationInFlightRef.current || contentAuditBlocked) return
    generationInFlightRef.current = true
    const requestToken = ++generationRequestTokenRef.current
    const projectId = project.id
    setLocalGenerationNotice('')
    try {
      const addedCount = await onGenerate()
      if (project.id !== projectId || generationRequestTokenRef.current !== requestToken) return
      if (typeof addedCount !== 'number') return
      setLocalGenerationNotice(addedCount > 0 ? t('optimization.addedTitles', { count: addedCount }) : t('optimization.noNewTitles'))
    } catch {
      // The parent owns the red action-bar error. Keep this handler quiet so
      // one failure cannot create a second competing error surface.
    } finally {
      if (generationRequestTokenRef.current === requestToken) generationInFlightRef.current = false
    }
  }

  const startWriting = async (article: ProjectArticle) => {
    if (!onWriteArticle || articleWritingStatus(article) === 'ready' || article.publishStatus === 'published') return
    if (localWritingIds.has(article.id) || writingTaskIdSet.has(article.id) || articleWritingStatus(article) === 'writing') return
    setLocalWritingIds((current) => new Set(current).add(article.id))
    try {
      await onWriteArticle(article.id)
    } catch {
      // The parent stores the error for the action bar. Release the local
      // guard so a failed article can be started again.
      setLocalWritingIds((current) => {
        const next = new Set(current)
        next.delete(article.id)
        return next
      })
    }
  }

  if (!project.websiteUrl) {
    return (
      <section className="optimization-stage" aria-label={t('optimization.aria')}>
        <div className="stage-placeholder__card">
          <div className="stage-placeholder__symbol" aria-hidden="true"><Icon name="globe" size={28} /></div>
          <div className="stage-placeholder__copy"><h2>{t('optimization.websiteRequiredTitle')}</h2><p>{t('optimization.websiteRequiredDescription')}</p></div>
        </div>
      </section>
    )
  }

  return (
    <section className="optimization-stage">
      <div className="optimization-layout">
        <TechnicalAuditPanel projectId={project.id} websiteUrl={project.websiteUrl} />
        <section className="optimization-articles" aria-label={t('optimization.articlesAria')}>
          {contentAuditEnabled ? (
            <ContentAuditPanel
              record={contentAuditRecord}
              loading={contentAuditLoading}
              taskActive={contentAuditTaskActive}
              loadError={contentAuditLoadError}
              taskError={contentAuditTaskError}
              onCheck={onContentAuditCheck}
            />
          ) : <ContentAuditPanel result={null} status="unavailable" />}
          <div className="optimization-article-list">
            <OperationBar
              className="article-action-bar"
              left={<h2 className="article-action-bar__title">{t('optimization.tasks')}</h2>}
              center={(
                <OperationFeedback tone={operationTone}>
                  {operationMessages.map((message, index) => (
                    <span key={message}>
                      {generating && index === 0 ? <span className="article-writing-spinner" aria-hidden="true" style={{ marginRight: 6, verticalAlign: '-1px' }} /> : null}
                      {message}
                    </span>
                  ))}
                </OperationFeedback>
              )}
              right={(
                <Button icon={<Icon name="sparkles" size={16} />} disabled={busy || generating || contentAuditBlocked} title={contentAuditBlocked ? t('optimization.contentAuditRequired') : undefined} onClick={() => void handleGenerate()}>{generating ? t('optimization.generating') : t('optimization.generateTitle')}</Button>
              )}
            />
            <section className="articles-table-card" aria-label={t('optimization.articlesAria')}>
              <div className="articles-table-scroll">
                <table className="articles-table">
                  <colgroup>
                    <col />
                    <col className="articles-table__optimization-col" />
                    <col className="articles-table__question-col" />
                    <col className="articles-table__time-col" />
                    <col className="articles-table__status-col" />
                  </colgroup>
                  <thead>
                    <tr><th>{t('optimization.title')}</th><th>{t('optimization.method')}</th><th>{t('optimization.question')}</th><th>{t('optimization.updated')}</th><th>{t('optimization.status')}</th></tr>
                  </thead>
                  <tbody>
                    {articles.map((article) => {
                      const writingStatus = articleWritingStatus(article)
                      const isWriting = writingStatus === 'writing' || localWritingIds.has(article.id) || writingTaskIdSet.has(article.id)
                      const displayWritingStatus = isWriting && writingStatus !== 'ready' ? 'writing' : writingStatus
                      const status = articleStatus(article, displayWritingStatus, locale)
                      const canStartWriting = !isWriting && writingStatus !== 'ready' && article.publishStatus !== 'published'
                      return (
                        <tr key={article.id} tabIndex={0} onClick={() => setSelectedArticleId(article.id)} onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setSelectedArticleId(article.id)
                          }
                        }}>
                          <td title={article.title} className={`articles-table__title-cell${canStartWriting || isWriting ? ' articles-table__title-cell--with-action' : ''}`}>
                            <span className="articles-table__title">{article.title}</span>
                            {canStartWriting ? <Button
                              type="button"
                              variant="secondary"
                              className="article-start-writing"
                              disabled={writingTaskIdSet.has(article.id)}
                              aria-label={t('optimization.ariaWrite', { title: article.title })}
                              onClick={(event) => {
                                event.stopPropagation()
                                void startWriting(article)
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >{t('optimization.write')}</Button> : null}
                            {isWriting ? <Button
                              type="button"
                              variant="secondary"
                              className="article-start-writing article-start-writing--writing"
                              disabled
                              aria-label={t('optimization.ariaWriting', { title: article.title })}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            ><span className="article-writing-spinner" aria-hidden="true" />{t('optimization.writing')}</Button> : null}
                          </td>
                          <td><span className="article-optimization-cell"><span>{articleOptimizationLabel(article, locale)}</span>{articleOptimizationDirectionLabel(article, locale) ? <small>{articleOptimizationDirectionLabel(article, locale)}</small> : null}</span></td>
                          <td>{articleQuestionLabel(article, locale)}</td>
                          <td className="articles-table__updated-cell" title={formatDateTime(article.updatedAt || article.generatedAt, locale)}>{formatArticleUpdatedAt(article.updatedAt || article.generatedAt, locale)}</td>
                          <td><StatusBadge tone={status.tone}>{status.label}</StatusBadge></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {articles.length === 0 ? <div className="articles-empty">{t('optimization.empty')}</div> : null}
              </div>
            </section>
          </div>
          {selectedArticleForPreview ? <ArticlePreviewModal article={selectedArticleForPreview} busy={busy} onClose={() => setSelectedArticleId(null)} onConfirmPublished={async (articleId) => {
            await onConfirmPublished(articleId)
          }} onDeleteArticle={onDeleteArticle && selectedArticleForPreview.publishStatus !== 'published' ? async (articleId) => {
            await onDeleteArticle(articleId)
          } : undefined} /> : null}
        </section>
      </div>
    </section>
  )
}

function monitoringRunStatusLabel(status: MonitoringRun['status'], locale: Locale = 'zh-CN'): string {
  if (status === 'completed') return translate(locale, 'monitoring.status.completed')
  if (status === 'failed') return translate(locale, 'monitoring.status.failed')
  if (status === 'analyzing') return translate(locale, 'monitoring.status.analyzing')
  return translate(locale, 'monitoring.status.running')
}

function monitoringRunStatusTone(status: MonitoringRun['status']): 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

function monitoringFailureMessage(message: string | null | undefined, locale: Locale = 'zh-CN', task?: { kind: string; status?: string | null }): string {
  const detail = message?.trim()
  if (!detail) return translate(locale, 'monitoring.failure')
  return task ? localizeServerMessage(detail, locale, task) : detail
}

export function isCompleteMonitoringRun(run: MonitoringRun | null | undefined): boolean {
  if (!run || run.status !== 'completed' || !run.completedAt || !Array.isArray(run.answers) || run.answers.length !== QUESTION_TOTAL) return false
  const positions = run.answers.map((answer) => answer.position)
  return new Set(positions).size === QUESTION_TOTAL
    && positions.every((position) => Number.isInteger(position) && position >= QUESTION_POSITION_MIN && position <= QUESTION_POSITION_MAX)
    && run.answers.every((answer) => answer.status === 'success')
}

export function latestSuccessfulMonitoringRun(runs: readonly MonitoringRun[]): MonitoringRun | null {
  return runs
    .filter((run) => isCompleteMonitoringRun(run))
    .slice()
    .sort((a, b) => b.roundNumber - a.roundNumber || (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0] ?? null
}

export function monitoringDeliveryReportKey(projectId: string, run: MonitoringRun | null): string {
  return `${projectId}:${run?.id ?? ''}:${run?.completedAt ?? ''}`
}

export function deliveryMetadataIsNewer(
  current: DeliveryReportMetadata | null,
  incoming: DeliveryReportMetadata,
  runs: readonly MonitoringRun[],
): boolean {
  if (incoming.reportPdfReady !== true) return false
  if (!current || current.reportPdfReady !== true) return true
  if (incoming.sourceRunId === current.sourceRunId) {
    const incomingTime = incoming.reportPdfGeneratedAt ? Date.parse(incoming.reportPdfGeneratedAt) : Number.NaN
    const currentTime = current.reportPdfGeneratedAt ? Date.parse(current.reportPdfGeneratedAt) : Number.NaN
    if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) return incomingTime >= currentTime
    return incoming.reportPdfGeneratedAt !== null || current.reportPdfGeneratedAt === null
  }
  const incomingRound = runs.find((run) => run.id === incoming.sourceRunId)?.roundNumber
  const currentRound = runs.find((run) => run.id === current.sourceRunId)?.roundNumber
  if (incomingRound !== undefined && currentRound !== undefined && incomingRound !== currentRound) return incomingRound > currentRound
  const incomingTime = incoming.reportPdfGeneratedAt ? Date.parse(incoming.reportPdfGeneratedAt) : Number.NaN
  const currentTime = current.reportPdfGeneratedAt ? Date.parse(current.reportPdfGeneratedAt) : Number.NaN
  return Number.isFinite(incomingTime) && (!Number.isFinite(currentTime) || incomingTime >= currentTime)
}

function deliveryReportDateForFilename(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(date).replaceAll('/', '-')
}

type MonitoringDeliveryReportPdfState = 'idle' | 'generating' | 'saving' | 'ready' | 'generation_error' | 'save_error'

type PreparedMonitoringDeliveryReportPdf = {
  key: string
  blob: Blob
  filename: string
  sourceRunId: string
}

export function MonitoringDashboard({ project, busy, actionError, progress, onStart, onDeliveryReportReady, activeMonitoringRunId }: {
  project: ProjectDetail
  busy: boolean
  actionError: UiMessage
  progress: { completedCount: number; failedCount: number; total: number } | null
  onStart: () => void | Promise<ProjectDetail | null | void>
  onDeliveryReportReady?: (metadata: DeliveryReportMetadata) => void
  activeMonitoringRunId?: string | null
}) {
  const { t, locale } = useI18n()
  const runs = project.monitoringRuns ?? []
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.id ?? null)
  const [selectedPosition, setSelectedPosition] = useState(QUESTION_POSITION_MIN)
  const [exportState, setExportState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')
  const [exportError, setExportError] = useState<UiMessage>('')
  const [reportPdfState, setReportPdfState] = useState<MonitoringDeliveryReportPdfState>('idle')
  const [reportPdfError, setReportPdfError] = useState<UiMessage>('')
  const reportSheetRef = useRef<HTMLElement | null>(null)
  const reportVersionRef = useRef<string | null>(null)
  const reportStartedKeyRef = useRef<string | null>(null)
  const preparedReportRef = useRef<PreparedMonitoringDeliveryReportPdf | null>(null)
  const mountedRef = useRef(false)
  const autoSelectedRunRef = useRef<string | null>(null)
  const localMetadataRef = useRef<{ projectId: string; metadata: DeliveryReportMetadata | null }>({ projectId: project.id, metadata: project.deliveryReport ?? null })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // A late project refresh can still contain deliveryReport:false after the
  // upload response already succeeded. Keep the local success metadata for the
  // current project until the server returns a newer saved version.
  if (localMetadataRef.current.projectId !== project.id) {
    localMetadataRef.current = { projectId: project.id, metadata: project.deliveryReport ?? null }
  } else if (project.deliveryReport?.reportPdfReady === true
    && deliveryMetadataIsNewer(localMetadataRef.current.metadata, project.deliveryReport, project.monitoringRuns ?? [])) {
    localMetadataRef.current.metadata = project.deliveryReport
  }
  const deliveryReportMetadata = localMetadataRef.current.metadata ?? project.deliveryReport ?? null

  useEffect(() => {
    if (!runs.some((run) => run.id === selectedRunId)) setSelectedRunId(runs[0]?.id ?? null)
  }, [runs, selectedRunId])

  useEffect(() => {
    if (!activeMonitoringRunId) {
      autoSelectedRunRef.current = null
      return
    }
    if (autoSelectedRunRef.current === activeMonitoringRunId || !runs.some((run) => run.id === activeMonitoringRunId)) return
    autoSelectedRunRef.current = activeMonitoringRunId
    setSelectedRunId(activeMonitoringRunId)
  }, [activeMonitoringRunId, runs])

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null
  const latestCompletedForMetrics = runs
    .filter((run) => run.status === 'completed')
    .slice()
    .sort((a, b) => b.roundNumber - a.roundNumber || (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0] ?? null
  const latestReportRun = latestSuccessfulMonitoringRun(runs)
  const reportKey = monitoringDeliveryReportKey(project.id, latestReportRun)
  const hasSavedDeliveryReport = deliveryReportMetadata?.reportPdfReady === true
  const hasCurrentDeliveryReport = Boolean(hasSavedDeliveryReport && latestReportRun && deliveryReportMetadata?.sourceRunId === latestReportRun.id)
  const reportNeedsPreparation = Boolean(latestReportRun && !hasCurrentDeliveryReport)
  const reportErrorState = reportPdfState === 'generation_error' || reportPdfState === 'save_error'
  const reportBusy = busy || reportPdfState === 'generating' || reportPdfState === 'saving'
    || (reportNeedsPreparation && !reportErrorState)
  const canExportDeliveryReport = hasSavedDeliveryReport && !reportBusy
  const selectedAnswers = selectedRun?.answers ?? []
  const liveProgress = busy ? progress : null
  const completedCount = liveProgress?.completedCount ?? selectedAnswers.filter((answer) => answer.status === 'success').length
  const failedCount = liveProgress?.failedCount ?? selectedAnswers.filter((answer) => answer.status === 'failed').length
  const retryableFailure = selectedRun?.answers.some((answer) => answer.status === 'failed') ?? false
  const actionLabel = busy ? t('monitoring.action.running') : retryableFailure ? t('monitoring.action.retryFailed') : t('monitoring.action.start')
  const confirmedPublishedCount = articleList(project).filter((article) => article.publishStatus === 'published').length
  const recommendationValue = latestCompletedForMetrics ? formatRate(latestCompletedForMetrics.recommendationRate, locale) : t('monitoring.notStarted')
  const citationValue = !project.websiteUrl
    ? t('common.notConfigured')
    : latestCompletedForMetrics
      ? formatRate(latestCompletedForMetrics.officialCitationRate, locale)
      : t('monitoring.notStarted')
  const monitoringCaption = latestCompletedForMetrics ? t('monitoring.latestSuccess') : undefined

  const reportIsCurrent = useCallback((key: string): boolean => (
    mountedRef.current && reportVersionRef.current === key
  ), [])

  const uploadPreparedReport = useCallback(async (prepared: PreparedMonitoringDeliveryReportPdf, key: string): Promise<void> => {
    if (!reportIsCurrent(key)) return
    setReportPdfState('saving')
    setReportPdfError('')
    try {
      const metadata = await saveMonitoringDeliveryReportPdf(project.id, prepared.sourceRunId, prepared.blob)
      if (!reportIsCurrent(key)) return
      localMetadataRef.current.metadata = metadata
      setReportPdfState('ready')
      onDeliveryReportReady?.(metadata)
    } catch (cause) {
      if (!reportIsCurrent(key)) return
      setReportPdfState('save_error')
      setReportPdfError(apiErrorMessage(cause, 'error.server.delivery_report_pdf_unavailable'))
    }
  }, [onDeliveryReportReady, project.id, reportIsCurrent])

  useEffect(() => {
    if (reportVersionRef.current !== reportKey) {
      reportVersionRef.current = reportKey
      reportStartedKeyRef.current = null
      preparedReportRef.current = null
      setReportPdfState(hasCurrentDeliveryReport ? 'ready' : 'idle')
      setReportPdfError('')
    } else if (hasCurrentDeliveryReport && reportPdfState !== 'ready') {
      setReportPdfState('ready')
      setReportPdfError('')
    }
  }, [hasCurrentDeliveryReport, reportKey, reportPdfState])

  useEffect(() => {
    if (!latestReportRun || !reportNeedsPreparation || !reportSheetRef.current || reportStartedKeyRef.current === reportKey) return
    reportStartedKeyRef.current = reportKey
    const element = reportSheetRef.current
    const reportRun = latestReportRun
    void (async () => {
      let prepared = preparedReportRef.current?.key === reportKey ? preparedReportRef.current : null
      try {
        if (!prepared) {
          if (!reportIsCurrent(reportKey)) return
          setReportPdfState('generating')
          const result = await prepareDeliveryReportPdf({
            companyName: project.companyName,
            monitoringDate: reportRun.completedAt ?? reportRun.startedAt,
            element,
          })
          if (!reportIsCurrent(reportKey)) return
          prepared = { key: reportKey, blob: result.blob, filename: result.filename, sourceRunId: reportRun.id }
          preparedReportRef.current = prepared
        }
        if (!reportIsCurrent(reportKey)) return
        await uploadPreparedReport(prepared, reportKey)
      } catch (cause) {
        if (!reportIsCurrent(reportKey)) return
        setReportPdfState('generation_error')
        setReportPdfError(apiErrorMessage(cause, 'error.server.delivery_report_pdf_unavailable'))
      }
    })()
  }, [latestReportRun, project.companyName, reportIsCurrent, reportKey, reportNeedsPreparation, reportPdfState, uploadPreparedReport])

  const retryDeliveryReport = useCallback(() => {
    if (!latestReportRun || !reportNeedsPreparation || reportPdfState === 'generating' || reportPdfState === 'saving') return
    if (reportPdfState === 'save_error' && preparedReportRef.current?.key === reportKey) {
      void uploadPreparedReport(preparedReportRef.current, reportKey)
      return
    }
    reportStartedKeyRef.current = null
    setReportPdfError('')
    setReportPdfState('idle')
  }, [latestReportRun, reportNeedsPreparation, reportKey, reportPdfState, uploadPreparedReport])

  const exportDeliveryReport = useCallback(async () => {
    if (!canExportDeliveryReport || exportState === 'downloading') return
    setExportState('downloading')
    setExportError('')
    try {
      const downloaded = await downloadMonitoringDeliveryReportPdf(project.id)
      triggerDiagnosisReportDownload(downloaded.blob, downloaded.filename ?? buildDeliveryReportFilename(project.companyName, deliveryReportDateForFilename(latestReportRun?.completedAt ?? latestReportRun?.startedAt ?? null)))
      setExportState('success')
    } catch (cause) {
      setExportState('error')
      setExportError(apiErrorMessage(cause, 'error.server.delivery_report_pdf_unavailable'))
    }
  }, [canExportDeliveryReport, exportState, latestReportRun, project.companyName, project.id])

  useEffect(() => {
    setExportState('idle')
    setExportError('')
  }, [project.id])

  const startMonitoring = async () => {
    const updated = await onStart()
    const newestRun = updated?.monitoringRuns?.slice().sort((a, b) => b.roundNumber - a.roundNumber)[0]
    if (newestRun) setSelectedRunId(newestRun.id)
  }
  const actionErrorText = resolveUiMessage(actionError, locale)
  const reportPdfErrorText = resolveUiMessage(reportPdfError, locale)
  const exportErrorText = resolveUiMessage(exportError, locale)
  const feedback = busy
    ? ''
      : actionErrorText
      ? monitoringFailureMessage(actionErrorText, locale)
      : selectedRun?.status === 'failed'
        ? monitoringFailureMessage(selectedRun.summaryError, locale, { kind: 'monitoring', status: 'failed' })
        : ''
  const progressFeedback = completedCount === QUESTION_TOTAL && failedCount === 0
    ? t('monitoring.progressComplete', { count: QUESTION_TOTAL, total: QUESTION_TOTAL })
    : `${t('monitoring.progress', { completed: completedCount, total: QUESTION_TOTAL })}${failedCount > 0 ? t('monitoring.failedCount', { count: failedCount }) : ''}`
  const safeCompletedCount = Number.isFinite(completedCount) ? completedCount : 0
  const monitoringProgressNow = Math.min(QUESTION_TOTAL, Math.max(0, safeCompletedCount))
  const monitoringProgressPercent = Math.min(100, Math.max(0, (safeCompletedCount / QUESTION_TOTAL) * 100))
  const deliveryReportError = reportPdfState === 'generation_error'
    ? t('monitoring.pdfGenerationFailed', { detail: reportPdfErrorText || t('common.retry'), suffix: hasSavedDeliveryReport ? (locale === 'en' ? ' The last successfully saved version remains available.' : ' 当前仍可下载上次成功保存的版本。') : '' })
    : reportPdfState === 'save_error'
      ? t('monitoring.pdfSaveFailed', { detail: reportPdfErrorText || t('common.retry'), suffix: hasSavedDeliveryReport ? (locale === 'en' ? ' The last successfully saved version remains available.' : ' 当前仍可下载上次成功保存的版本。') : '' })
      : ''
  const monitoringFeedbackMessages = [
    !busy && feedback ? feedback : null,
    reportPdfState === 'generating' ? t('monitoring.pdfPreparing') : null,
    reportPdfState === 'saving' ? t('monitoring.pdfSaving') : null,
    deliveryReportError || null,
    exportState === 'downloading' ? t('monitoring.pdfDownload') : null,
    exportState === 'error' ? t('monitoring.pdfDownloadFailed', { detail: exportErrorText || t('common.retry') }) : null,
  ].filter((message): message is string => Boolean(message))
  const monitoringFeedbackHasError = Boolean(feedback || deliveryReportError || exportState === 'error')
  const monitoringFeedbackTone = monitoringFeedbackHasError ? 'error' : exportState === 'success' ? 'success' : 'neutral'

  return (
    <section className="monitoring-stage">
      <div className="diagnosis-report-layout monitoring-report-layout">
        <div className="monitoring-main">
          <OperationBar
            className="monitoring-operation-bar"
            left={<>
              <Button icon={<Icon name="play" size={16} />} disabled={busy} onClick={() => void startMonitoring()}>{actionLabel}</Button>
            </>}
            center={<OperationFeedback tone={monitoringFeedbackTone}>
              {busy ? (
                <span className="diagnosis-feedback-progress monitoring-feedback-progress">
                  <span className="diagnosis-feedback-progress__label monitoring-feedback-progress__label">{progressFeedback}</span>
                    <span className="diagnosis-progress diagnosis-feedback-progress__bar monitoring-feedback-progress__bar" role="progressbar" aria-label={t('monitoring.progressAria')} aria-valuemin={0} aria-valuemax={QUESTION_TOTAL} aria-valuenow={monitoringProgressNow}>
                    <span style={{ width: `${monitoringProgressPercent}%` }} />
                  </span>
                </span>
              ) : null}
              {monitoringFeedbackMessages.map((message) => <span key={message}>{message}</span>)}
            </OperationFeedback>}
            right={(
              <div className="monitoring-operation-actions">
                {deliveryReportError ? <Button variant="secondary" onClick={retryDeliveryReport}>{t('monitoring.retryDelivery')}</Button> : null}
                {exportState === 'error' ? <Button variant="secondary" onClick={() => void exportDeliveryReport()}>{t('monitoring.retryDownload')}</Button> : null}
                <Button variant="secondary" icon={<Icon name="download" size={16} />} disabled={!canExportDeliveryReport || exportState === 'downloading'} onClick={() => void exportDeliveryReport()}>{exportState === 'downloading' ? t('common.downloading') : t('monitoring.exportDelivery')}</Button>
              </div>
            )}
          />
          <div className="monitoring-layout">
            <aside className="monitoring-history-card" aria-label={t('monitoring.historyAria')}>
              <div className="monitoring-history-card__header"><h2>{t('monitoring.history')}</h2></div>
              {runs.length > 0 ? (
                <ol className="monitoring-history-list">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button type="button" className={selectedRun?.id === run.id ? 'monitoring-history-list__item monitoring-history-list__item--active' : 'monitoring-history-list__item'} onClick={() => setSelectedRunId(run.id)}>
                        <span><strong>{formatDateTime(run.completedAt ?? run.startedAt, locale)}</strong><small>{run.status === 'completed' ? `${t('monitoring.recommendationShort')} ${formatRate(run.recommendationRate, locale)}  ·  ${t('monitoring.citationShort')} ${project.websiteUrl ? formatRate(run.officialCitationRate, locale) : t('common.unknown')}` : monitoringRunStatusLabel(run.status, locale)}</small><span className="sr-only">{t('monitoring.round', { round: run.roundNumber })}</span></span>
                        <Icon name="chevron-right" size={14} />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : <p className="monitoring-history-empty">{t('monitoring.historyEmpty')}</p>}
            </aside>
            <AnswerExplorer
              project={project}
              answers={selectedAnswers}
              selectedPosition={selectedPosition}
              onSelect={setSelectedPosition}
              completedCount={completedCount}
              layoutClassName="monitoring-answer-explorer"
              mode="monitoring"
            />
          </div>
        </div>
        <aside className="diagnosis-metrics monitoring-metrics" aria-label={t('monitoring.metricsAria')}>
          <MetricCard className="metric-card--published" icon={<Icon name="file-check" size={16} />} label={t('monitoring.published')} value={t('monitoring.articleCount', { count: confirmedPublishedCount })} caption={t('monitoring.publishedCaption')} />
          <MetricCard icon={<Icon name="badge-check" size={16} />} label={t('diagnosis.metrics.recommendation')} value={recommendationValue} {...(monitoringCaption ? { caption: monitoringCaption } : {})} />
          <MetricCard icon={<Icon name="link" size={16} />} label={t('diagnosis.metrics.citation')} value={citationValue} {...(monitoringCaption ? { caption: monitoringCaption } : {})} />
        </aside>
      </div>
      {latestReportRun && reportNeedsPreparation ? <div className="delivery-report-export-source" aria-hidden="true"><DeliveryReportSheet ref={reportSheetRef} project={project} run={latestReportRun} /></div> : null}
    </section>
  )
}

function StagePlaceholder({ stage }: { stage: Exclude<StageId, 'scope'> }) {
  const { t } = useI18n()
  const detail = {
    diagnosis: { eyebrow: t('stage.diagnosisEyebrow'), title: t('phase.diagnosis'), description: t('stage.diagnosisDescription', { count: QUESTION_TOTAL }), status: t('common.notStarted'), action: t('diagnosis.action.start') },
    optimization: { eyebrow: t('stage.optimizationEyebrow'), title: t('phase.optimization'), description: t('stage.optimizationDescription'), status: t('stage.waitDiagnosis'), action: t('optimization.generateTitle') },
    monitoring: { eyebrow: t('stage.monitoringEyebrow'), title: t('phase.monitoring'), description: t('stage.monitoringDescription'), status: t('stage.waitDiagnosis'), action: t('monitoring.action.start') },
  }[stage]

  return (
    <section className="stage-placeholder">
      <div className="stage-placeholder__heading">
        <div><p className="eyebrow">{detail.eyebrow}</p><h1>{detail.title}</h1></div>
        <StatusBadge tone="neutral">{detail.status}</StatusBadge>
      </div>
      <div className="stage-placeholder__card">
        <div className="stage-placeholder__symbol" aria-hidden="true"><Icon name="file-check" size={28} /></div>
        <div className="stage-placeholder__copy"><h2>{t('stage.notConnected')}</h2><p>{detail.description}</p></div>
        <Button disabled>{detail.action}</Button>
      </div>
      <div className="stage-placeholder__note"><span aria-hidden="true"><Icon name="message-square" size={14} /></span><span>{t('stage.note')}</span></div>
    </section>
  )
}

export function ProjectWorkspace({ project, projectState, onRetry, onEdit, onUpdated, deletedArticleIds, onArticleDeleted }: {
  project: ProjectDetail | null
  projectState: LoadState
  onRetry: () => void
  onEdit: (initialValues?: Partial<ProjectFormValues>, onSaved?: () => void) => void
  onUpdated: (project: ProjectDetail) => void
  deletedArticleIds?: ReadonlySet<string>
  onArticleDeleted?: (articleId: string) => void
}) {
  const { t, locale } = useI18n()
  const [activeStage, setActiveStage] = useState<StageId>('scope')
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [action, setAction] = useState<'idle' | 'generating' | 'question' | 'confirming' | 'diagnosing' | 'monitoring'>('idle')
  const [actionErrors, setActionErrors] = useState<StageActionErrors>({})
  const [questionActionError, setQuestionActionError] = useState<UiMessage>('')
  const [questionMutationQuestionId, setQuestionMutationQuestionId] = useState<string | null>(null)
  const [questionGeneration, setQuestionGeneration] = useState<QuestionGenerationSession | null>(null)
  const [diagnosisProgress, setDiagnosisProgress] = useState<{ completedCount: number; failedCount: number; total: number } | null>(null)
  const [activeMonitoringRunId, setActiveMonitoringRunId] = useState<string | null>(null)
  const [aiTasks, setAiTasks] = useState<AiTask[]>([])
  const liveProjectRef = useRef<ProjectDetail | null>(project)
  const questionMutationInFlightRef = useRef(false)
  const questionGenerationInFlightRef = useRef(false)
  const questionGenerationTokenRef = useRef(0)
  const questionGenerationObservedTaskRef = useRef<string | null>(null)
  const questionGenerationObservationControllerRef = useRef<AbortController | null>(null)
  const questionGenerationObserverProjectRef = useRef<string | null>(null)
  const onUpdatedRef = useRef(onUpdated)
  const articleWritingRequestsRef = useRef<Set<string>>(new Set())
  const articleGenerationInFlightRef = useRef(false)
  const articleGenerationTokenRef = useRef(0)
  const diagnosisInFlightRef = useRef(false)
  const diagnosisSummaryInFlightRef = useRef(false)
  const monitoringInFlightRef = useRef(false)
  const reportRefreshInFlightRef = useRef(false)
  const reportRefreshAutoStartKeyRef = useRef<string | null>(null)
  const previousWebsiteRef = useRef<string | null>(project?.websiteUrl ?? null)
  const [reportRefreshBusy, setReportRefreshBusy] = useState(false)
  const [reportRefreshKind, setReportRefreshKind] = useState<'initial' | 'website'>('initial')
  const aiTaskPollTokenRef = useRef(0)
  const contentAuditLoadTokenRef = useRef(0)
  const contentAuditStartInFlightRef = useRef(false)
  const [contentAuditRecord, setContentAuditRecord] = useState<ContentAuditRecord | null | undefined>(undefined)
  const [contentAuditLoading, setContentAuditLoading] = useState(false)
  const [contentAuditLoadError, setContentAuditLoadError] = useState<UiMessage>('')

  const clearActionError = (stage: StageId) => {
    setActionErrors((current) => clearStageActionError(current, stage))
  }

  const setActionError = (stage: StageId, message: UiMessage) => {
    setActionErrors((current) => ({ ...current, [stage]: message }))
  }

  const isCurrentProject = (projectId: string): boolean => liveProjectRef.current?.id === projectId
  const isCurrentProjectSnapshot = (projectId: string, expectedUpdatedAt: string): boolean => {
    const current = liveProjectRef.current
    return current?.id === projectId && current.updatedAt === expectedUpdatedAt
  }

  const activeAiTask = (kind: AiTaskKind, targetId?: string): AiTask | null => aiTasks.find((task) => (
    task.status === 'running'
      && task.kind === kind
      && (targetId === undefined || task.targetId === targetId)
  )) ?? null

  const activeContentAuditTask = contentAuditTaskForPolling(aiTasks)
  const contentAuditTaskId = activeContentAuditTask?.id ?? null
  const contentAuditTaskStartedAt = activeContentAuditTask?.startedAt ?? null

  const activeAiTasksOfKind = (kind: AiTaskKind): AiTask[] => aiTasks.filter((task) => task.status === 'running' && task.kind === kind)

  const latestAiTask = (kind: AiTaskKind, targetId?: string): AiTask | null => aiTasks
    .filter((task) => task.kind === kind && (targetId === undefined || task.targetId === targetId))
    .slice()
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id))[0] ?? null

  const acceptArticleProjectUpdate = (updated: ProjectDetail, projectId: string): boolean => {
    const current = liveProjectRef.current
    if (!current || current.id !== projectId || updated.id !== projectId) return false
    const merged = mergeProjectArticleSnapshots(current, updated, deletedArticleIds)
    liveProjectRef.current = merged
    onUpdated(merged)
    return true
  }

  const refreshArticleProject = useCallback((updated: ProjectDetail) => {
    const projectId = liveProjectRef.current?.id
    if (projectId) acceptArticleProjectUpdate(updated, projectId)
  }, [deletedArticleIds, onUpdated])

  useEffect(() => {
    liveProjectRef.current = project
  }, [project])

  useEffect(() => {
    onUpdatedRef.current = onUpdated
  }, [onUpdated])

  useEffect(() => {
    liveProjectRef.current = project
    return () => {
      liveProjectRef.current = null
      questionMutationInFlightRef.current = false
      questionGenerationTokenRef.current += 1
      questionGenerationInFlightRef.current = false
      questionGenerationObservationControllerRef.current?.abort()
      questionGenerationObservationControllerRef.current = null
      questionGenerationObservedTaskRef.current = null
      questionGenerationObserverProjectRef.current = null
      articleGenerationTokenRef.current += 1
      articleGenerationInFlightRef.current = false
      diagnosisInFlightRef.current = false
      diagnosisSummaryInFlightRef.current = false
      monitoringInFlightRef.current = false
      reportRefreshInFlightRef.current = false
      aiTaskPollTokenRef.current += 1
      articleWritingRequestsRef.current.clear()
      contentAuditLoadTokenRef.current += 1
      contentAuditStartInFlightRef.current = false
    }
  }, [])

  // Task state is persisted by the API, so this observer is intentionally
  // independent of the POST promise and of the current stage.  Navigating,
  // refreshing, or closing the tab cannot cancel the server task; returning
  // to the project simply reconstructs the disabled controls from this list.
  useEffect(() => {
    if (!project) {
      setAiTasks([])
      return
    }
    const projectId = project.id
    const pollToken = ++aiTaskPollTokenRef.current
    let cancelled = false
    let timer: number | undefined
    let previousNonQuestionTaskState: string | null = null
    let previousQuestionTaskState: string | null = null
    let hadFailedTasks = false

    const isLive = (): boolean => !cancelled
      && aiTaskPollTokenRef.current === pollToken
      && liveProjectRef.current?.id === projectId

    const poll = async (): Promise<void> => {
      try {
        const tasks = await fetchProjectAiTasks(projectId)
        if (!isLive()) return
        setAiTasks((current) => mergeQuestionTaskList(current, tasks))
        const running = tasks.filter((task) => task.status === 'running')
        const nonQuestionTasks = tasks.filter((task) => task.kind !== 'questions')
        const hasFailedTasks = tasks.some((task) => task.status === 'failed')
        const nonQuestionTaskState = nonQuestionTasks
          .map((task) => `${task.id}:${task.status}`)
          .sort()
          .join('|')
        const nonQuestionTaskStateChanged = previousNonQuestionTaskState !== null
          && previousNonQuestionTaskState !== nonQuestionTaskState
        const questionTaskState = tasks
          .filter((task) => task.kind === 'questions')
          .map((task) => `${task.id}:${task.status}`)
          .sort()
          .join('|')
        const questionTaskStateChanged = previousQuestionTaskState !== null
          && previousQuestionTaskState !== questionTaskState
        const questionTaskReachedTerminal = questionTaskStateChanged
          && !running.some((task) => task.kind === 'questions')
          && previousQuestionTaskState?.includes(':running') === true
        // A questions task's formal project snapshot is delivered by its
        // observer stream. Do not let the broad task poll write an older
        // project snapshot over that stream while it is still running. Once
        // the stream is gone, a terminal task transition still gets one
        // ordinary project read so a disconnected page can recover.
        const shouldRefreshProject = running.some((task) => task.kind !== 'questions')
          || nonQuestionTaskStateChanged
          || (questionTaskReachedTerminal && !questionGenerationInFlightRef.current)
          || (hasFailedTasks && !hadFailedTasks && !running.some((task) => task.kind === 'questions'))
        previousNonQuestionTaskState = nonQuestionTaskState
        previousQuestionTaskState = questionTaskState
        hadFailedTasks = hasFailedTasks

        // Every task detail contains the same project snapshot.  Refresh the
        // project at most once for this task-list read, rather than issuing a
        // request for every running/failed task and merging them out of order.
        if (shouldRefreshProject) {
          try {
            const refreshed = await fetchProject(projectId)
            if (isLive() && refreshed.id === projectId) {
              const current = liveProjectRef.current
              // A stream completion may have committed a newer project
              // snapshot than this concurrent poll read. Preserve that
              // terminal state instead of applying the stale response.
              const staleAgainstStream = Boolean(current?.updatedAt && refreshed.updatedAt && refreshed.updatedAt < current.updatedAt)
              if (!staleAgainstStream) {
                const merged = current ? mergeProjectArticleSnapshots(current, refreshed, deletedArticleIds) : refreshed
                liveProjectRef.current = merged
                onUpdated(merged)
                if (running.some((task) => task.kind === 'monitoring')) {
                  const latest = merged.monitoringRuns?.slice().sort((left, right) => right.roundNumber - left.roundNumber)[0]
                  if (latest) setActiveMonitoringRunId(latest.id)
                }
              }
            }
          } catch {
            // Keep the task list as the source of truth for disabled actions;
            // a later poll can refresh the business snapshot again.
          }
        }
        if (!cancelled) timer = window.setTimeout(() => { void poll() }, running.length > 0 ? 1000 : 2500)
      } catch {
        if (!cancelled) timer = window.setTimeout(() => { void poll() }, 2500)
      }
    }

    void poll()
    return () => {
      cancelled = true
      aiTaskPollTokenRef.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [deletedArticleIds, onUpdated, project?.id])

  // A questions task that was accepted before this workspace mounted is
  // observed through the task-detail stream rather than by another generate
  // request. The task id is remembered so a broken connection releases only
  // this page observer; it never causes an automatic reconnect or rerun.
  const runningQuestionTaskId = questionTaskIdForObservation(aiTasks, questionGenerationObservedTaskRef.current)
  useEffect(() => {
    if (questionGenerationObserverProjectRef.current !== (project?.id ?? null)) {
      questionGenerationObservationControllerRef.current?.abort()
      questionGenerationObservationControllerRef.current = null
      questionGenerationObservedTaskRef.current = null
      questionGenerationObserverProjectRef.current = project?.id ?? null
    }
    if (!project || !runningQuestionTaskId || questionGenerationInFlightRef.current) return
    if (questionGenerationObservedTaskRef.current === runningQuestionTaskId) return
    const task = aiTasks.find((candidate) => candidate.id === runningQuestionTaskId)
    if (!task) return

    const projectId = project.id
    const profile = questionGenerationProfile(project)
    const lockedQuestions = project.questions.filter((question) => question.isLocked)
    const taskProgress = questionGenerationTaskProgress(task)
    const total = taskProgress?.total ?? Math.max(0, QUESTION_TOTAL - lockedQuestions.length)
    const progress = taskProgress ?? { completedCount: 0, total, questions: [] }
    const token = ++questionGenerationTokenRef.current
    questionGenerationObservedTaskRef.current = runningQuestionTaskId
    questionGenerationInFlightRef.current = true
    const controller = new AbortController()
    questionGenerationObservationControllerRef.current = controller
    let cancelled = false
    setQuestionGeneration({ token, projectId, profile, lockedQuestions, total, progress })
    setAction('generating')
    clearActionError('scope')
    setQuestionActionError('')

    const acceptProgress = (next: QuestionGenerationProgress): void => {
      if (cancelled) return
      setAiTasks((current) => current.map((candidate) => candidate.id === runningQuestionTaskId
        ? { ...candidate, result: { ...candidate.result, progress: next } }
        : candidate))
      setQuestionGeneration((current) => current && current.token === token
        ? { ...current, progress: { ...next, total: current.total } }
        : current)
    }

    void observeQuestionGenerationTask(projectId, runningQuestionTaskId, acceptProgress, { signal: controller.signal })
      .then((updated) => {
        if (cancelled || controller.signal.aborted) return
        if (updated.id === projectId && liveProjectRef.current?.id === projectId) {
          liveProjectRef.current = updated
          onUpdatedRef.current(updated)
        }
        setQuestionGeneration((current) => current?.token === token ? null : current)
        questionGenerationInFlightRef.current = false
        if (isCurrentProject(projectId)) setAction((current) => current === 'generating' ? 'idle' : current)
      })
      .catch((cause) => {
        if (cancelled || controller.signal.aborted) return
        setQuestionGeneration((current) => current?.token === token ? null : current)
        questionGenerationInFlightRef.current = false
        if (isCurrentProject(projectId)) {
          setActionError('scope', apiErrorMessage(cause, 'error.server.generation_unavailable'))
          setAction((current) => current === 'generating' ? 'idle' : current)
        }
      })
      .finally(() => {
        if (questionGenerationObservationControllerRef.current === controller) {
          questionGenerationObservationControllerRef.current = null
        }
      })

    return () => {
      cancelled = true
      controller.abort()
      if (questionGenerationTokenRef.current === token) {
        questionGenerationInFlightRef.current = false
        if (isCurrentProject(projectId)) {
          setQuestionGeneration((current) => current?.token === token ? null : current)
          setAction((current) => current === 'generating' ? 'idle' : current)
        }
      }
    }
  }, [project?.id, runningQuestionTaskId])

  const refreshContentAudit = useCallback(async (projectId: string, showLoading = false): Promise<ContentAuditRecord | null> => {
    const requestToken = ++contentAuditLoadTokenRef.current
    if (showLoading) {
      setContentAuditLoading(true)
      setContentAuditLoadError('')
    }
    try {
      const record = await fetchContentAudit(projectId)
      if (contentAuditLoadTokenRef.current !== requestToken || liveProjectRef.current?.id !== projectId) return record
      const visibleRecord = normalizeContentAuditRecordForLoad(record, showLoading)
      setContentAuditRecord(visibleRecord)
      setContentAuditLoadError('')
      return visibleRecord
    } catch (cause) {
      if (contentAuditLoadTokenRef.current !== requestToken || liveProjectRef.current?.id !== projectId) throw cause
      const message = apiErrorMessage(cause, 'error.server.content_audit_unavailable')
      setContentAuditLoadError(message)
      throw cause
    } finally {
      if (contentAuditLoadTokenRef.current === requestToken && showLoading) setContentAuditLoading(false)
    }
  }, [])

  // Load only when the optimization stage is entered. Leaving the stage
  // invalidates UI updates, but deliberately does not abort the backend run.
  // Re-entering the stage always reads the current record again.
  useEffect(() => {
    if (!project || activeStage !== 'optimization') return
    const projectId = project.id
    setContentAuditRecord(undefined)
    setContentAuditLoadError('')
    setContentAuditLoading(true)
    void refreshContentAudit(projectId, true).catch(() => undefined)
    return () => {
      contentAuditLoadTokenRef.current += 1
    }
  }, [activeStage, project?.id, refreshContentAudit])

  useEffect(() => {
    if (!project || activeStage !== 'optimization' || !contentAuditPollingNeeded(contentAuditRecord, activeContentAuditTask)) return
    const projectId = project.id
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const record = await fetchContentAudit(projectId)
        if (cancelled || liveProjectRef.current?.id !== projectId) return
        setContentAuditRecord(record)
        setContentAuditLoadError('')
        if (contentAuditPollingNeeded(record, activeContentAuditTask)) timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
      } catch (cause) {
        if (cancelled || liveProjectRef.current?.id !== projectId) return
        setContentAuditLoadError(apiErrorMessage(cause, 'error.server.content_audit_unavailable'))
        timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
      }
    }
    timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeStage, contentAuditRecord?.startedAt, contentAuditRecord?.status, contentAuditTaskId, contentAuditTaskStartedAt, project?.id])

  const checkContentAudit = useCallback(async (): Promise<void> => {
    const current = liveProjectRef.current
    if (!current || contentAuditStartInFlightRef.current || contentAuditRecord?.status === 'checking' || contentAuditTaskId !== null) return
    const projectId = current.id
    contentAuditStartInFlightRef.current = true
    try {
      const record = await startContentAudit(projectId)
      if (liveProjectRef.current?.id === projectId) setContentAuditRecord(record)
    } catch (cause) {
      if (liveProjectRef.current?.id === projectId) {
        if (cause instanceof ApiError && cause.code === 'content_audit_in_progress') {
          void refreshContentAudit(projectId).catch(() => undefined)
        }
      }
      throw cause
    } finally {
      contentAuditStartInFlightRef.current = false
    }
  }, [contentAuditRecord?.status, contentAuditTaskId, refreshContentAudit])

  useEffect(() => () => {
    articleWritingRequestsRef.current.clear()
  }, [project?.id])

  useEffect(() => {
    if (project && project.id !== activeProjectId) {
      setActiveProjectId(project.id)
      setActiveStage(projectEntryStage(project))
      setReportRefreshKind('initial')
      previousWebsiteRef.current = project.websiteUrl
      reportRefreshAutoStartKeyRef.current = null
      setAction('idle')
      setActionErrors({})
      setQuestionActionError('')
      setQuestionMutationQuestionId(null)
      setQuestionGeneration(null)
      setDiagnosisProgress(null)
      setActiveMonitoringRunId(null)
      setAiTasks([])
      articleGenerationTokenRef.current += 1
      articleGenerationInFlightRef.current = false
      diagnosisInFlightRef.current = false
      diagnosisSummaryInFlightRef.current = false
      monitoringInFlightRef.current = false
      reportRefreshInFlightRef.current = false
      setReportRefreshBusy(false)
      articleWritingRequestsRef.current.clear()
      contentAuditLoadTokenRef.current += 1
      contentAuditStartInFlightRef.current = false
      setContentAuditRecord(undefined)
      setContentAuditLoading(false)
      setContentAuditLoadError('')
    }
  }, [activeProjectId, project])

  useEffect(() => {
    const session = questionGeneration
    if (!session || !project) return
    const currentProfile = questionGenerationProfile(project)
    if (session.projectId === project.id && questionGenerationProfilesEqual(session.profile, currentProfile)) return
    questionGenerationTokenRef.current += 1
    questionGenerationInFlightRef.current = false
    setQuestionGeneration(null)
    setAction((current) => current === 'generating' ? 'idle' : current)
  }, [project, questionGeneration])

  const states = useMemo<Record<StageId, StageState>>(
    () => project
      ? stageStates(project)
      : { scope: 'available', diagnosis: 'disabled', optimization: 'disabled', monitoring: 'disabled' },
    [project],
  )
  const selectStage = useCallback((stage: StageId) => {
    if (states[stage] === 'disabled') return
    if (stage === 'optimization' && project && isInitialDiagnosisComplete(project) && !project.websiteUrl) {
      onEdit(undefined, () => setActiveStage('optimization'))
      return
    }
    setActiveStage(stage)
  }, [onEdit, project, states])
  const generate = async () => {
    const currentProject = liveProjectRef.current
    if (!currentProject || !project || currentProject.id !== project.id || currentProject.questionsLockedAt || questionMutationInFlightRef.current || questionGenerationInFlightRef.current || activeAiTask('questions') || currentProject.questionsGeneration.status === 'generating') return
    const projectId = currentProject.id
    const expectedUpdatedAt = currentProject.updatedAt
    const profileSnapshot = questionGenerationProfile(currentProject)
    const lockedQuestions = currentProject.questions.filter((question) => question.isLocked)
    const total = Math.max(0, QUESTION_TOTAL - lockedQuestions.length)
    const requestToken = ++questionGenerationTokenRef.current
    const controller = new AbortController()
    questionGenerationObservationControllerRef.current = controller
    questionGenerationInFlightRef.current = true
    setQuestionGeneration({
      token: requestToken,
      projectId,
      profile: profileSnapshot,
      lockedQuestions,
      total,
      progress: { completedCount: 0, total, questions: [] },
    })
    setAction('generating')
    clearActionError('scope')
    setQuestionActionError('')
    const isActiveRequest = (): boolean => {
      const current = liveProjectRef.current
      return questionGenerationInFlightRef.current
        && questionGenerationTokenRef.current === requestToken
        && current?.id === projectId
        && questionGenerationProfilesEqual(questionGenerationProfile(current), profileSnapshot)
    }
    try {
      const updated = await regenerateQuestions(projectId, expectedUpdatedAt, (progress) => {
        if (!isActiveRequest()) return
        setQuestionGeneration((session) => session && session.token === requestToken
          ? { ...session, progress: { ...progress, total: session.total } }
          : session)
      }, (task) => {
        questionGenerationObservedTaskRef.current = task.id
      }, { signal: controller.signal })
      if (isActiveRequest()) {
        liveProjectRef.current = updated
        onUpdated(updated)
      }
    } catch (cause) {
      if (isActiveRequest()) {
        setActionError('scope', apiErrorMessage(cause, 'error.server.generation_unavailable'))
      }
    } finally {
      if (questionGenerationTokenRef.current === requestToken) {
        questionGenerationInFlightRef.current = false
        setQuestionGeneration(null)
        if (isCurrentProject(projectId)) setAction('idle')
      }
      if (questionGenerationObservationControllerRef.current === controller) {
        questionGenerationObservationControllerRef.current = null
      }
    }
  }

  const toggleQuestionLock = async (questionId: string, isLocked: boolean): Promise<void> => {
    const current = liveProjectRef.current
    if (!current || current.questionsLockedAt || questionMutationInFlightRef.current || questionGenerationInFlightRef.current || activeAiTask('questions')) return
    const question = current.questions.find((item) => item.id === questionId)
    if (!question || !isQuestionCategory(question.category) || question.isLocked === isLocked) return
    const projectId = current.id
    const expectedUpdatedAt = current.updatedAt
    questionMutationInFlightRef.current = true
    setQuestionMutationQuestionId(questionId)
    setQuestionActionError('')
    try {
      const updated = await setQuestionLockedRequest(projectId, questionId, isLocked, expectedUpdatedAt)
      if (isCurrentProjectSnapshot(projectId, expectedUpdatedAt) && updated.id === projectId) {
        const returnedQuestion = updated.questions.find((item) => item.id === questionId)
        const currentSnapshot = liveProjectRef.current
        if (returnedQuestion && currentSnapshot) {
          const merged: ProjectDetail = {
            ...currentSnapshot,
            updatedAt: updated.updatedAt,
            questions: currentSnapshot.questions.map((item) => item.id === questionId
              ? { ...item, isLocked: returnedQuestion.isLocked }
              : item),
          }
          liveProjectRef.current = merged
          onUpdated(merged)
        }
      }
    } catch (cause) {
      if (isCurrentProjectSnapshot(projectId, expectedUpdatedAt)) {
        setQuestionActionError(uiMessage('scope.questionError', { position: question.position, detail: apiErrorMessage(cause, 'error.server.project_changed') }))
      }
    } finally {
      questionMutationInFlightRef.current = false
      if (isCurrentProject(projectId)) setQuestionMutationQuestionId(null)
    }
  }

  const removeQuestion = async (questionId: string, wasLocked: boolean): Promise<void> => {
    const current = liveProjectRef.current
    if (!current || current.questionsLockedAt || questionMutationInFlightRef.current || questionGenerationInFlightRef.current || activeAiTask('questions')) return
    const question = current.questions.find((item) => item.id === questionId)
    if (!question || !isQuestionCategory(question.category)) return
    const lockNote = wasLocked || question.isLocked ? (locale === 'en' ? 'This question is locked and will not be kept on regeneration.' : '该题当前已锁定，删除后不会在重新生成时保留。') : ''
    const confirmation = locale === 'en'
      ? `Delete question ${question.position}?${lockNote ? ` ${lockNote}` : ''} Deleted questions will not be auto-replaced.`
      : `确认删除第${question.position}题？${lockNote ? ` ${lockNote}` : ''} 删除后不会自动补题。`
    if (typeof window === 'undefined' || !window.confirm(confirmation)) return
    const projectId = current.id
    const expectedUpdatedAt = current.updatedAt
    questionMutationInFlightRef.current = true
    setQuestionMutationQuestionId(questionId)
    setQuestionActionError('')
    setAction('question')
    try {
      const updated = await deleteQuestionRequest(projectId, questionId, expectedUpdatedAt)
      if (isCurrentProjectSnapshot(projectId, expectedUpdatedAt) && updated.id === projectId) {
        liveProjectRef.current = updated
        onUpdated(updated)
      }
    } catch (cause) {
      if (isCurrentProjectSnapshot(projectId, expectedUpdatedAt)) {
        setQuestionActionError(uiMessage('scope.questionError', { position: question.position, detail: apiErrorMessage(cause, 'error.server.question_not_found') }))
      }
    } finally {
      questionMutationInFlightRef.current = false
      if (isCurrentProject(projectId)) {
        setQuestionMutationQuestionId(null)
        setAction('idle')
      }
    }
  }

  const diagnose = async (projectId: string) => {
    if (diagnosisInFlightRef.current || activeAiTask('diagnosis')) return
    diagnosisInFlightRef.current = true
    setAction('diagnosing')
    clearActionError('diagnosis')
    const existingAnswers = liveProjectRef.current?.id === projectId
      ? liveProjectRef.current.initialDiagnosis.answers
      : []
    setDiagnosisProgress({
      completedCount: existingAnswers.filter((answer) => answer.status === 'success').length,
      failedCount: existingAnswers.filter((answer) => answer.status === 'failed').length,
      total: QUESTION_TOTAL,
    })
    try {
      const updated = await startOrResumeDiagnosis(projectId, (progress) => {
        setDiagnosisProgress({ completedCount: progress.completedCount, failedCount: progress.failedCount, total: progress.total })
        if (progress.answer) {
          const current = liveProjectRef.current
          if (current && current.id === projectId) {
            const answers = [...current.initialDiagnosis.answers.filter((answer) => answer.position !== progress.answer?.position), progress.answer]
              .sort((a, b) => a.position - b.position)
            const next = { ...current, initialDiagnosis: { ...current.initialDiagnosis, answers } }
            liveProjectRef.current = next
            onUpdated(next)
          }
        }
      })
      if (isCurrentProject(projectId)) onUpdated(updated)
    } catch (cause) {
      if (isCurrentProject(projectId)) setActionError('diagnosis', apiErrorMessage(cause, 'error.server.diagnosis_unavailable'))
    } finally {
      diagnosisInFlightRef.current = false
      if (isCurrentProject(projectId)) setAction('idle')
    }
  }

  const retryDiagnosisSummary = async (projectId: string): Promise<void> => {
    if (diagnosisSummaryInFlightRef.current || activeAiTask('diagnosis_report')) return
    diagnosisSummaryInFlightRef.current = true
    setAction('diagnosing')
    clearActionError('diagnosis')
    try {
      const updated = await generateInitialDiagnosisReport(projectId)
      if (isCurrentProject(projectId)) {
        liveProjectRef.current = updated
        onUpdated(updated)
      }
    } catch (cause) {
      if (isCurrentProject(projectId)) setActionError('diagnosis', apiErrorMessage(cause, 'error.server.diagnosis_report_failed'))
    } finally {
      diagnosisSummaryInFlightRef.current = false
      if (isCurrentProject(projectId)) setAction('idle')
    }
  }

  const monitor = async (projectId: string): Promise<ProjectDetail | null> => {
    if (monitoringInFlightRef.current || activeAiTask('monitoring')) return null
    monitoringInFlightRef.current = true
    setAction('monitoring')
    clearActionError('monitoring')
    setActiveMonitoringRunId(null)
    setDiagnosisProgress({ completedCount: 0, failedCount: 0, total: QUESTION_TOTAL })
    try {
      const updated = await startOrResumeMonitoring(projectId, (progress) => {
        if (isCurrentProject(projectId)) {
          setDiagnosisProgress({ completedCount: progress.completedCount, failedCount: progress.failedCount, total: progress.total })
        }
      }, (update: MonitoringUpdateEvent) => {
        if (!isCurrentProject(projectId)) return
        const current = liveProjectRef.current
        const merged = mergeMonitoringUpdate(current, projectId, update)
        if (!merged || merged === current) return
        liveProjectRef.current = merged
        onUpdated(merged)
        if (update.type === 'run') setActiveMonitoringRunId(update.run.id)
      })
      if (updated && updated.id === projectId && isCurrentProject(projectId)) {
        liveProjectRef.current = updated
        onUpdated(updated)
      }
      return updated
    } catch (cause) {
      if (isCurrentProject(projectId)) setActionError('monitoring', apiErrorMessage(cause, 'error.server.monitoring_unavailable'))
      return null
    } finally {
      monitoringInFlightRef.current = false
      if (isCurrentProject(projectId)) setAction('idle')
    }
  }

  const applyReportRefreshMetadata = useCallback((metadata: DiagnosisReportRefreshMetadata, projectId: string): void => {
    const current = liveProjectRef.current
    if (!current || current.id !== projectId) return
    const updated: ProjectDetail = {
      ...current,
      initialDiagnosis: {
        ...current.initialDiagnosis,
        reportRefreshStatus: metadata.status,
        reportRefreshStartedAt: metadata.startedAt,
        reportRefreshError: metadata.error,
        reportPdfReady: metadata.reportPdfReady,
        reportPdfGeneratedAt: metadata.reportPdfGeneratedAt,
      },
    }
    liveProjectRef.current = updated
    onUpdated(updated)
  }, [onUpdated])

  const refreshReport = useCallback(async (projectId = liveProjectRef.current?.id ?? ''): Promise<void> => {
    if (!projectId || reportRefreshInFlightRef.current || !isCurrentProject(projectId)) return
    reportRefreshInFlightRef.current = true
    setReportRefreshBusy(true)
    clearActionError('diagnosis')
    try {
      const metadata = await startDiagnosisReportRefresh(projectId)
      applyReportRefreshMetadata(metadata, projectId)
    } catch (cause) {
      if (isCurrentProject(projectId)) setActionError('diagnosis', apiErrorMessage(cause, 'error.server.diagnosis_report_refresh_unavailable'))
    } finally {
      reportRefreshInFlightRef.current = false
      if (isCurrentProject(projectId)) setReportRefreshBusy(false)
    }
  }, [applyReportRefreshMetadata, onUpdated])

  // A completed diagnosis always gets one server-side report refresh.  This
  // request is separate from AI task polling and is safe to resume after a
  // reload; a failed refresh is left for the explicit retry button.
  useEffect(() => {
    if (!project || !canExportDiagnosisReport(project)) return
    const status = reportRefreshStatus(project)
    if (status !== 'not_started') return
    const runId = project.initialDiagnosis.run?.id ?? ''
    const key = `${project.id}:${runId}`
    if (reportRefreshAutoStartKeyRef.current === key) return
    reportRefreshAutoStartKeyRef.current = key
    void refreshReport(project.id)
  }, [project, refreshReport])

  // Poll the persisted report lifecycle independently of AI tasks.  The PDF
  // download remains disabled until a ready snapshot is observed.
  useEffect(() => {
    if (!project || reportRefreshStatus(project) !== 'running') return
    const projectId = project.id
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const metadata = await fetchDiagnosisReportRefresh(projectId)
        if (cancelled || !isCurrentProject(projectId)) return
        applyReportRefreshMetadata(metadata, projectId)
        if (metadata.status === 'running') timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
      } catch (cause) {
        if (!cancelled) {
          if (isCurrentProject(projectId)) setActionError('diagnosis', apiErrorMessage(cause, 'error.server.diagnosis_report_refresh_unavailable'))
          timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
        }
      }
    }
    timer = window.setTimeout(() => { void poll() }, CONTENT_AUDIT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [applyReportRefreshMetadata, project?.id, project?.initialDiagnosis?.reportRefreshStatus])

  useEffect(() => {
    if (!project) return
    if (previousWebsiteRef.current === null && project.websiteUrl && canExportDiagnosisReport(project)) {
      setReportRefreshKind('website')
    }
    previousWebsiteRef.current = project.websiteUrl
  }, [project])

  const confirm = async () => {
    const currentProject = liveProjectRef.current
    if (!currentProject || !project || currentProject.id !== project.id || currentProject.questionsLockedAt || currentProject.questions.length !== QUESTION_TOTAL || questionMutationInFlightRef.current || questionGenerationInFlightRef.current || activeAiTask('questions') || currentProject.questionsGeneration.status === 'generating') return
    const projectId = currentProject.id
    const expectedUpdatedAt = currentProject.updatedAt
    if (diagnosisInFlightRef.current || activeAiTask('diagnosis')) return
    diagnosisInFlightRef.current = true
    setAction('confirming')
    clearActionError('scope')
    setQuestionActionError('')
    let diagnosisStarted = false
    try {
      const updated = await confirmAndStartDiagnosis(
        projectId,
        expectedUpdatedAt,
        (confirmed) => {
          diagnosisStarted = true
          clearActionError('diagnosis')
          liveProjectRef.current = confirmed
          onUpdated(confirmed)
          setActiveStage('diagnosis')
          setAction('diagnosing')
          setDiagnosisProgress({ completedCount: 0, failedCount: 0, total: QUESTION_TOTAL })
        },
        (progress) => {
          if (!isCurrentProject(projectId)) return
          setDiagnosisProgress({ completedCount: progress.completedCount, failedCount: progress.failedCount, total: progress.total })
          if (progress.answer) {
            const current = liveProjectRef.current
            if (current && current.id === projectId) {
              const answers = [...current.initialDiagnosis.answers.filter((answer) => answer.position !== progress.answer?.position), progress.answer]
                .sort((a, b) => a.position - b.position)
              const next = { ...current, initialDiagnosis: { ...current.initialDiagnosis, answers } }
              liveProjectRef.current = next
              onUpdated(next)
            }
          }
        },
        { shouldContinue: () => isCurrentProject(projectId) },
      )
      if (isCurrentProject(projectId)) {
        liveProjectRef.current = updated
        onUpdated(updated)
      }
    } catch (cause) {
      const stage: StageId = diagnosisStarted ? 'diagnosis' : 'scope'
      if (isCurrentProject(projectId)) setActionError(stage, apiErrorMessage(cause, diagnosisStarted ? 'error.server.diagnosis_unavailable' : 'error.server.questions_not_locked'))
    } finally {
      diagnosisInFlightRef.current = false
      if (isCurrentProject(projectId)) setAction('idle')
    }
  }

  const generateArticles = async (): Promise<number> => {
    if (!project || articleGenerationInFlightRef.current || activeAiTask('article_titles')) return 0
    const projectId = project.id
    const requestToken = ++articleGenerationTokenRef.current
    articleGenerationInFlightRef.current = true
    setAction('generating')
    clearActionError('optimization')
    try {
      const result = await generateProjectArticles(projectId)
      if (articleGenerationTokenRef.current === requestToken && isCurrentProject(projectId)) {
        acceptArticleProjectUpdate(result.project, projectId)
      }
      return result.addedCount
    } catch (cause) {
      if (articleGenerationTokenRef.current === requestToken && isCurrentProject(projectId)) {
        setActionError('optimization', apiErrorMessage(cause, 'error.server.article_generation_failed'))
      }
      throw cause
    } finally {
      if (articleGenerationTokenRef.current === requestToken && isCurrentProject(projectId)) {
        articleGenerationInFlightRef.current = false
        setAction('idle')
      }
    }
  }

  const writeArticle = async (articleId: string): Promise<void> => {
    const currentProject = liveProjectRef.current
    if (!currentProject || articleWritingRequestsRef.current.has(articleId) || activeAiTask('article_body', articleId)) return
    const article = articleList(currentProject).find((item) => item.id === articleId)
    if (!article || articleWritingStatus(article) === 'ready' || article.publishStatus === 'published') return
    const projectId = currentProject.id
    articleWritingRequestsRef.current.add(articleId)
    clearActionError('optimization')
    try {
      const updated = await writeProjectArticle(articleId)
      acceptArticleProjectUpdate(updated, projectId)
    } catch (cause) {
      if (isCurrentProject(projectId)) {
        setActionError('optimization', uiMessage('optimization.writeFailed', { title: article.title, detail: apiErrorMessage(cause, 'error.server.article_unavailable') }))
      }
      throw cause
    } finally {
      articleWritingRequestsRef.current.delete(articleId)
    }
  }

  const confirmPublished = async (articleId: string) => {
    const projectId = liveProjectRef.current?.id
    if (!projectId) return
    const updated = await confirmArticlePublished(articleId)
    acceptArticleProjectUpdate(updated, projectId)
  }

  const removeArticle = async (articleId: string): Promise<void> => {
    const projectId = liveProjectRef.current?.id
    if (!projectId) return
    const result = await deleteArticle(articleId)
    if (result.deletedArticleId !== articleId) throw new Error('article_delete_stale')
    onArticleDeleted?.(articleId)
    acceptArticleProjectUpdate(result.project, projectId)
  }

  const markReportPdfReady = useCallback((metadata: { reportPdfReady: boolean; reportPdfGeneratedAt: string | null }) => {
    const current = liveProjectRef.current
    if (!current || !project || current.id !== project.id) return
    const updated = {
      ...current,
      initialDiagnosis: { ...current.initialDiagnosis, ...metadata },
    }
    liveProjectRef.current = updated
    onUpdated(updated)
  }, [onUpdated, project])

  const markDeliveryReportReady = useCallback((metadata: DeliveryReportMetadata) => {
    const current = liveProjectRef.current
    if (!current || !project || current.id !== project.id) return
    const latestRun = latestSuccessfulMonitoringRun(current.monitoringRuns ?? [])
    if (latestRun && latestRun.id !== metadata.sourceRunId) return
    const updated = { ...current, deliveryReport: metadata }
    liveProjectRef.current = updated
    onUpdated(updated)
  }, [onUpdated, project])

  const questionsTask = activeAiTask('questions')
  const questionsTaskActive = Boolean(questionsTask)
  const diagnosisTaskActive = Boolean(activeAiTask('diagnosis'))
  const diagnosisSummaryTaskActive = Boolean(activeAiTask('diagnosis_report'))
  const monitoringTaskActive = Boolean(activeAiTask('monitoring'))
  const articleTitlesTaskActive = Boolean(activeAiTask('article_titles'))
  const articleBodyTaskIds = activeAiTasksOfKind('article_body').map((task) => task.targetId).filter((targetId): targetId is string => Boolean(targetId))
  const contentAuditTaskActive = contentAuditTaskId !== null
  const contentAuditTaskFailed = Boolean(latestAiTask('content_audit')?.status === 'failed')
  const failedTaskMessage = (kind: AiTaskKind, targetId?: string): UiMessage => {
    const task = latestAiTask(kind, targetId)
    return task?.status === 'failed' ? taskErrorMessage(kind, task.status, task.error) : ''
  }
  const scopeActionError = stageActionError(actionErrors, 'scope') || failedTaskMessage('questions')
  const diagnosisActionError = stageActionError(actionErrors, 'diagnosis') || failedTaskMessage('diagnosis') || failedTaskMessage('diagnosis_report')
  const optimizationActionError = stageActionError(actionErrors, 'optimization') || failedTaskMessage('article_titles')
  const monitoringActionError = stageActionError(actionErrors, 'monitoring') || failedTaskMessage('monitoring')
  const contentAuditTaskError = failedTaskMessage('content_audit')
  // The observer session is the sole source for the visible preview. The
  // task list is still used for discovery/disabled states, but its snapshot
  // can lag behind both a local POST stream and a terminal stream event.
  const visibleQuestionGeneration = questionGeneration
  const progressTask = [activeAiTask('diagnosis'), activeAiTask('monitoring')]
    .filter((task): task is AiTask => Boolean(task))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
  const taskProgress = aiTaskProgressForDisplay(progressTask)
  const visibleDiagnosisProgress = taskProgress ?? diagnosisProgress
  const questionsBusy = questionsTaskActive || questionGenerationInFlightRef.current || action === 'confirming'
  const questionMutationBusy = action === 'question'
  const diagnosisBusy = diagnosisTaskActive || diagnosisInFlightRef.current || action === 'diagnosing'
  const diagnosisSummaryBusy = diagnosisSummaryTaskActive || diagnosisSummaryInFlightRef.current
  const diagnosisReportBusy = reportRefreshBusy
  const monitoringBusy = monitoringTaskActive || monitoringInFlightRef.current || action === 'monitoring'

  if (projectState === 'error') return <main className="page-content"><ErrorNotice message={t('error.projectLoad')} onRetry={onRetry} /></main>
  if (projectState === 'loading' || !project) return <main className="page-content"><LoadingState label={t('loading.project')} /></main>

  return (
    <main className="page-content workspace-page">
      <div className="workspace-pipeline">
        <PhaseNav
          active={activeStage}
          states={states}
          onSelect={selectStage}
          disabledReasons={!project.websiteUrl && isInitialDiagnosisComplete(project)
             ? { monitoring: t('optimization.websiteRequiredTitle') }
             : undefined}
        />
      </div>
      <div className="workspace-stage-viewport">
        {activeStage === 'scope' ? <MonitoringScope project={project} busy={questionsBusy} questionMutationBusy={questionMutationBusy} questionMutationQuestionId={questionMutationQuestionId} generating={questionsTaskActive || questionGenerationInFlightRef.current} generationLockedQuestions={visibleQuestionGeneration?.lockedQuestions} generationProgress={visibleQuestionGeneration?.progress ?? null} actionError={scopeActionError} questionActionError={questionActionError} onGenerate={() => void generate()} onConfirm={() => void confirm()} onToggleQuestion={(questionId, isLocked) => void toggleQuestionLock(questionId, isLocked)} onDeleteQuestion={(questionId, isLocked) => void removeQuestion(questionId, isLocked)} /> : activeStage === 'diagnosis' ? <DiagnosisReport project={project} busy={diagnosisBusy} reporting={diagnosisReportBusy} summarying={diagnosisSummaryBusy} actionError={diagnosisActionError} progress={visibleDiagnosisProgress} onStart={() => void diagnose(project.id)} onRetrySummary={() => void retryDiagnosisSummary(project.id)} refreshKind={reportRefreshKind} onRefreshReport={() => void refreshReport(project.id)} /> : activeStage === 'optimization' ? <OptimizationSuggestions project={project} busy={false} generating={articleTitlesTaskActive || articleGenerationInFlightRef.current} actionError={optimizationActionError} onGenerate={generateArticles} onWriteArticle={writeArticle} onProjectRefresh={refreshArticleProject} onConfirmPublished={confirmPublished} onDeleteArticle={removeArticle} writingTaskIds={articleBodyTaskIds} contentAuditTaskActive={contentAuditTaskActive} contentAuditTaskFailed={contentAuditTaskFailed} contentAuditRecord={contentAuditRecord} contentAuditLoading={contentAuditLoading} contentAuditLoadError={contentAuditLoadError} contentAuditTaskError={contentAuditTaskError} onContentAuditCheck={checkContentAudit} /> : <MonitoringDashboard project={project} busy={monitoringBusy} actionError={monitoringActionError} progress={visibleDiagnosisProgress} onStart={() => monitor(project.id)} onDeliveryReportReady={markDeliveryReportReady} activeMonitoringRunId={activeMonitoringRunId} />}
      </div>
    </main>
  )
}

export default function App() {
  const { t } = useI18n()
  const [route, setRoute] = useState<Route>(() => routeFromLocation())
  const [projects, setProjects] = useState<Project[]>([])
  const [listState, setListState] = useState<LoadState>('idle')
  const [search, setSearch] = useState('')
  const [selectedProject, setSelectedProject] = useState<ProjectDetail | null>(null)
  const [projectState, setProjectState] = useState<LoadState>('idle')
  const [modalProject, setModalProject] = useState<ProjectDetail | null | undefined>(undefined)
  const [modalInitialValues, setModalInitialValues] = useState<Partial<ProjectFormValues> | undefined>(undefined)
  const selectedProjectLoadRef = useRef(0)
  const deletedArticleIdsRef = useRef<Set<string>>(new Set())
  const workspaceSessionRef = useRef(0)
  const pendingProjectSaveRef = useRef<PendingProjectSave | null>(null)
  const [workspaceSession, setWorkspaceSession] = useState(0)

  const invalidateWorkspaceSession = useCallback(() => {
    workspaceSessionRef.current += 1
    setWorkspaceSession(workspaceSessionRef.current)
  }, [])

  const loadList = useCallback(async () => {
    setListState('loading')
    try {
      setProjects(await fetchProjects(search))
      setListState('ready')
    } catch {
      setListState('error')
    }
  }, [search])

  const loadSelectedProject = useCallback(async (id: string) => {
    const requestId = ++selectedProjectLoadRef.current
    deletedArticleIdsRef.current.clear()
    setProjectState('loading')
    try {
      const [rawProject, tasks] = await Promise.all([
        fetchProject(id),
        fetchProjectAiTasks(id).catch(() => undefined),
      ])
      const loaded = normalizeProjectOnInitialLoad(rawProject, tasks)
      if (selectedProjectLoadRef.current !== requestId) return
      setSelectedProject(loaded)
      setProjectState('ready')
    } catch {
      if (selectedProjectLoadRef.current !== requestId) return
      setSelectedProject(null)
      setProjectState('error')
    }
  }, [])

  useEffect(() => {
    const onPopState = () => {
      pendingProjectSaveRef.current = null
      invalidateWorkspaceSession()
      setRoute(routeFromLocation())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [invalidateWorkspaceSession])

  useEffect(() => {
    if (route.kind === 'list') {
      selectedProjectLoadRef.current += 1
      void loadList()
    }
    else void loadSelectedProject(route.projectId)
  }, [loadList, loadSelectedProject, route])

  useEffect(() => {
    if (route.kind === 'list' || !selectedProject) return
    const shouldPollArticles = articleWritingIsActive(selectedProject)
    if (!shouldPollArticles) return

    const projectId = selectedProject.id
    const session = workspaceSessionRef.current
    let cancelled = false
    let timer: number | undefined

    const poll = async (): Promise<void> => {
      try {
        const refreshed = await fetchProject(projectId)
        if (cancelled || workspaceSessionRef.current !== session || refreshed.id !== projectId) return

        setSelectedProject((current) => {
          if (workspaceSessionRef.current !== session || current?.id !== projectId) return current
          return mergeProjectArticleSnapshots(current, refreshed, deletedArticleIdsRef.current)
        })

        if (articleWritingIsActive(refreshed)) {
          timer = window.setTimeout(() => { void poll() }, WEBSITE_CRAWL_POLL_INTERVAL_MS)
        }
      } catch {
        if (!cancelled && workspaceSessionRef.current === session) timer = window.setTimeout(() => { void poll() }, WEBSITE_CRAWL_POLL_INTERVAL_MS)
      }
    }

    timer = window.setTimeout(() => { void poll() }, WEBSITE_CRAWL_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [route.kind, selectedProject?.id, selectedProject?.updatedAt, selectedProject ? articleWritingIsActive(selectedProject) : false])

  const projectName = route.kind === 'project' || route.kind === 'report' ? selectedProject?.companyName : undefined
  const modalOpen = modalProject !== undefined
  const openProject = (project: Project) => {
    pendingProjectSaveRef.current = null
    invalidateWorkspaceSession()
    deletedArticleIdsRef.current.clear()
    setSelectedProject(null)
    setProjectState('loading')
    navigate({ kind: 'project', projectId: project.id })
  }
  const openCreate = () => {
    pendingProjectSaveRef.current = null
    setModalInitialValues(undefined)
    setModalProject(null)
  }
  const openEdit = (initialValues?: Partial<ProjectFormValues>, onSaved?: () => void) => {
    if (!selectedProject) return
    pendingProjectSaveRef.current = onSaved
      ? { projectId: selectedProject.id, onSaved }
      : null
    setModalInitialValues({ ...projectFormValues(selectedProject), ...initialValues })
    setModalProject(selectedProject)
  }
  const closeModal = () => {
    pendingProjectSaveRef.current = null
    setModalProject(undefined)
    setModalInitialValues(undefined)
  }
  const handleSaved = (project: ProjectDetail) => {
    const pendingProjectSave = pendingProjectSaveCallback(
      pendingProjectSaveRef.current,
      modalProject?.id,
      project.id,
    )
    pendingProjectSaveRef.current = null
    setModalProject(undefined)
    setModalInitialValues(undefined)
    setSelectedProject(project)
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
    if (route.kind === 'list') navigate({ kind: 'project', projectId: project.id })
    pendingProjectSave?.()
  }
  const handleDeleted = () => {
    const deletedProjectId = modalProject?.id ?? selectedProject?.id
    pendingProjectSaveRef.current = null
    invalidateWorkspaceSession()
    deletedArticleIdsRef.current.clear()
    setModalProject(undefined)
    setModalInitialValues(undefined)
    setSelectedProject(null)
    setProjectState('idle')
    if (deletedProjectId) setProjects((current) => current.filter((item) => item.id !== deletedProjectId))
    navigate({ kind: 'list' })
  }
  const handleHome = () => {
    pendingProjectSaveRef.current = null
    invalidateWorkspaceSession()
    deletedArticleIdsRef.current.clear()
    setSelectedProject(null)
    setProjectState('idle')
    navigate({ kind: 'list' })
  }
  const backToDiagnosis = () => {
    pendingProjectSaveRef.current = null
    if (selectedProject) navigate({ kind: 'project', projectId: selectedProject.id })
    else navigate({ kind: 'list' })
  }

  const content = route.kind === 'list' ? (
    <ProjectList projects={projects} state={listState} search={search} onSearch={setSearch} onCreate={openCreate} onRetry={() => void loadList()} onOpen={openProject} />
  ) : route.kind === 'report' ? (
    <ProjectReportPage project={selectedProject} projectState={projectState} onRetry={() => void loadSelectedProject(route.projectId)} onBack={backToDiagnosis} onReportRefreshMetadata={(metadata) => {
      setSelectedProject((current) => {
        if (!current || current.id !== route.projectId) return current
        return {
          ...current,
          initialDiagnosis: {
            ...current.initialDiagnosis,
            reportRefreshStatus: metadata.status,
            reportRefreshStartedAt: metadata.startedAt,
            reportRefreshError: metadata.error,
            reportPdfReady: metadata.reportPdfReady,
            reportPdfGeneratedAt: metadata.reportPdfGeneratedAt,
          },
        }
      })
    }} />
  ) : (
    <ProjectWorkspace key={`workspace-${route.projectId}-${workspaceSession}`} project={selectedProject} projectState={projectState} onRetry={() => void loadSelectedProject(route.projectId)} onEdit={openEdit} onUpdated={(updated) => {
      if (workspaceSessionRef.current === workspaceSession) setSelectedProject(updated)
    }} deletedArticleIds={deletedArticleIdsRef.current} onArticleDeleted={(articleId) => deletedArticleIdsRef.current.add(articleId)} />
  )

  return (
    <div className="app">
      {route.kind !== 'report' ? <GlobalHeader
        projectName={projectName}
        onHome={handleHome}
        onEdit={route.kind === 'project' && selectedProject ? () => openEdit() : undefined}
        editLabel={selectedProject?.questionsLockedAt && !selectedProject.websiteUrl ? t('header.addWebsite') : t('header.editProject')}
      /> : null}
      {content}
      {modalOpen ? <ProjectFormModal project={modalProject ?? null} initialValues={modalInitialValues} onClose={closeModal} onSaved={handleSaved} onDeleted={handleDeleted} /> : null}
    </div>
  )
}
