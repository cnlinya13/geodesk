import type { QuestionCategory } from './business-rules'

export type CrawlStatus = 'not_started' | 'crawling' | 'completed' | 'failed'
export type QuestionsGenerationStatus = 'not_started' | 'generating' | 'completed' | 'failed'
export type InitialDiagnosisStatus = 'not_started' | 'running' | 'analyzing' | 'completed' | 'failed'
export type DiagnosisAnswerStatus = 'pending' | 'running' | 'success' | 'failed'
export type DiagnosisReportRefreshStatus = 'not_started' | 'running' | 'ready' | 'failed'

export type Project = {
  id: string
  companyName: string
  websiteUrl: string | null
  optimizationTarget: string | null
  supplementalInfo: string | null
  questionsGeneratedAt: string | null
  questionsLockedAt: string | null
  diagnosisStartedAt: string | null
  initialDiagnosisCompletedAt: string | null
  initialDiagnosisStatus: InitialDiagnosisStatus
  initialRecommendationRate: number | null
  initialOfficialCitationRate: number | null
  initialDiagnosisAt: string | null
  latestMonitoringAt: string | null
  latestRecommendationRate: number | null
  latestOfficialCitationRate: number | null
  websiteLockedAt: string | null
  websiteCrawlStatus: CrawlStatus
  websiteCrawlStartedAt: string | null
  websiteCrawlCompletedAt: string | null
  websiteCrawlError: string | null
  websiteCrawlSource: 'sitemap' | 'links' | null
  websiteCrawlIncomplete: boolean
  websitePagesDiscovered: number
  websitePagesSucceeded: number
  websitePagesFailed: number
  questionsGenerationStatus: QuestionsGenerationStatus
  questionsGenerationStartedAt: string | null
  questionsGenerationCompletedAt: string | null
  questionsGenerationError: string | null
  createdAt: string
  updatedAt: string
}

export type Question = {
  id: string
  position: number
  question: string
  generatedAt: string
  category: QuestionCategory | null
  isLocked: boolean
}

export type { QuestionCategory }

export type WebsiteCrawlSummary = {
  status: CrawlStatus
  source: 'sitemap' | 'links' | null
  incomplete: boolean
  error: string | null
  discoveredCount: number
  successCount: number
  failedCount: number
  startedAt: string | null
  completedAt: string | null
}

export type QuestionsGenerationSummary = {
  status: QuestionsGenerationStatus
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export type DiagnosisRun = {
  id: string
  runType: 'initial' | 'monitoring'
  status: Exclude<InitialDiagnosisStatus, 'not_started'>
  requestedModel: string | null
  roundNumber: number
  publishedArticleCount: number | null
  startedAt: string
  completedAt: string | null
  summaryAnalysis: unknown | null
  summaryModel: string | null
  summaryError: string | null
  recommendationRate: number | null
  officialCitationRate: number | null
}

export type DiagnosisAnswer = {
  position: number
  question: string
  status: DiagnosisAnswerStatus
  answerText: string | null
  citationUrls: string[]
  responseModel: string | null
  recommended: boolean | null
  officialCitation: boolean | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export type InitialDiagnosis = {
  run: DiagnosisRun | null
  answers: DiagnosisAnswer[]
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  reportRefreshStatus?: DiagnosisReportRefreshStatus
  reportRefreshStartedAt?: string | null
  reportRefreshError?: string | null
}

export type DiagnosisReportRefreshMetadata = {
  status: DiagnosisReportRefreshStatus
  startedAt: string | null
  error: string | null
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  sourceRunId: string | null
}

export type MonitoringRun = DiagnosisRun & {
  runType: 'monitoring'
  answers: DiagnosisAnswer[]
}

export type MonitoringUpdateEvent =
  | { type: 'run'; run: MonitoringRun }
  | { type: 'answer'; runId: string; answer: DiagnosisAnswer }
  | { type: 'analyzing'; runId: string }

export type ArticlePublishStatus = 'pending' | 'published'
export type ArticleWritingStatus = 'pending' | 'writing' | 'ready' | 'failed'

export type ProjectArticle = {
  id: string
  projectId: string
  batchId: string
  title: string
  questionPositions: number[]
  contentHtml: string | null
  generatedAt: string
  updatedAt: string
  writingStatus: ArticleWritingStatus
  writingError: string | null
  optimizationType: string
  optimizationDirection: string | null
  targetPageUrl?: string | null
  targetPageTitle?: string | null
  publishStatus: ArticlePublishStatus
  confirmedAt: string | null
}

export type ArticleBatch = {
  id: string
  projectId: string
  requestedModel: string
  responseModel: string | null
  generatedAt: string
  articles: ProjectArticle[]
}

export type DeliveryReportMetadata = {
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  sourceRunId: string | null
}

export type ProjectDetail = Project & {
  websiteCrawl: WebsiteCrawlSummary
  questionsGeneration: QuestionsGenerationSummary
  questions: Question[]
  initialDiagnosis: InitialDiagnosis
  monitoringRuns: MonitoringRun[]
  articleBatches: ArticleBatch[]
  deliveryReport?: DeliveryReportMetadata
}

export type StageId = 'scope' | 'diagnosis' | 'optimization' | 'monitoring'
export type StageState = 'active' | 'available' | 'disabled'

export type ApiErrorPayload = {
  ok?: boolean
  error?: string
  message?: string
}

export type AiTaskKind =
  | 'questions'
  | 'diagnosis'
  | 'diagnosis_report'
  | 'monitoring'
  | 'article_titles'
  | 'article_body'
  | 'content_audit'

export type AiTaskResult = Record<string, unknown>

/**
 * A persisted AI operation.  The task is deliberately separate from the
 * project snapshot: a project may be reloaded while the model call is still
 * running, and the task is the source of truth for the operation button.
 */
export type AiTask = {
  id: string
  projectId: string
  kind: AiTaskKind
  targetId: string | null
  status: 'running' | 'completed' | 'failed'
  error: string | null
  startedAt: string
  completedAt: string | null
  result: AiTaskResult
}
