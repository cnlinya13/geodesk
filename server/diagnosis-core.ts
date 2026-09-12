import {
  extractCitationUrls,
  extractResponseModel,
  extractResponseText,
  parseJsonText,
  requestDoubaoResponses,
  DoubaoResponsesError,
  type DoubaoFetch,
} from './doubao-client.ts'
import {
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from '../src/business-rules.ts'

export type DiagnosisAnswerStatus = 'pending' | 'running' | 'success' | 'failed'

export type DiagnosisQuestion = {
  position: number
  question: string
}

export type DiagnosisAnswerState = {
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

export type DiagnosisProjectContext = {
  companyName: string
  websiteUrl: string | null
  optimizationTarget: string | null
  supplementalInfo: string | null
}

export type DiagnosisProgress = {
  position: number
  status: 'success' | 'failed'
  completedCount: number
  failedCount: number
  total: number
  /** The answer that was just persisted; used to update the UI incrementally. */
  answer: DiagnosisAnswerState
}

export type DiagnosisSummaryOutcome = {
  status: 'completed' | 'failed' | 'not_started'
  analysis: unknown | null
  model: string | null
  error: string | null
  recommendationRate: number | null
  officialCitationRate: number | null
}

export type DiagnosisCoreResult = {
  answers: DiagnosisAnswerState[]
  summary: DiagnosisSummaryOutcome
  stopped: boolean
}

export type DiagnosisCoreOptions = {
  project: DiagnosisProjectContext
  questions: DiagnosisQuestion[]
  answers: DiagnosisAnswerState[]
  apiKey: string
  modelId: string
  rawFetch?: DoubaoFetch
  analysisFetch?: DoubaoFetch
  endpoint?: string
  timeoutMs?: number
  signal?: AbortSignal
  analysisCompleted?: boolean
  /** Answer every unfinished question but leave aggregate analysis to the caller. */
  deferAnalysis?: boolean
  onAnswer?: (answer: DiagnosisAnswerState) => void | Promise<void>
  onAnalysisStart?: () => void | Promise<void>
  onProgress?: (progress: DiagnosisProgress) => void | Promise<void>
  shouldContinue?: () => boolean
}

export class DiagnosisCoreError extends Error {}

const RAW_TOOLS: Array<Record<string, unknown>> = [{ type: 'web_search' }]

/** Keep a run on its first usable model; a missing API configuration does not fix a model prematurely. */
export function resolveRequestedModel(requestedModel: string | null | undefined, configuredModel: string, apiKey: string): string | null {
  const fixed = requestedModel?.trim()
  if (fixed) return fixed
  if (!configuredModel.trim() || !apiKey.trim()) return null
  return configuredModel.trim()
}

function nowIso(): string {
  return new Date().toISOString()
}

function nullableText(value: string | null): string {
  return value?.trim() || '未提供'
}

function normaliseAnswer(question: DiagnosisQuestion, current?: DiagnosisAnswerState): DiagnosisAnswerState {
  return {
    position: question.position,
    question: question.question,
    status: current?.status ?? 'pending',
    answerText: current?.answerText ?? null,
    citationUrls: current?.citationUrls ?? [],
    responseModel: current?.responseModel ?? null,
    recommended: current?.recommended ?? null,
    officialCitation: current?.officialCitation ?? null,
    error: current?.error ?? null,
    startedAt: current?.startedAt ?? null,
    completedAt: current?.completedAt ?? null,
  }
}

function userFacingError(error: unknown, fallback: string): string {
  if (error instanceof DoubaoResponsesError) return error.message
  if (error instanceof Error && error.message && !error.message.includes('Bearer')) return error.message
  return fallback
}

/** True when a citation points to the configured host or one of its subdomains. */
export function isOfficialCitation(citationUrl: string, websiteUrl: string): boolean {
  try {
    const citation = new URL(citationUrl)
    const website = new URL(websiteUrl)
    if ((citation.protocol !== 'http:' && citation.protocol !== 'https:') || (website.protocol !== 'http:' && website.protocol !== 'https:')) return false
    const citationHost = citation.hostname.toLocaleLowerCase().replace(/\.$/, '')
    const websiteHost = website.hostname.toLocaleLowerCase().replace(/\.$/, '')
    return citationHost === websiteHost || citationHost.endsWith(`.${websiteHost}`)
  } catch {
    return false
  }
}

export function computeOfficialCitation(websiteUrl: string | null, citationUrls: string[]): boolean | null {
  if (!websiteUrl) return null
  return citationUrls.some((citationUrl) => isOfficialCitation(citationUrl, websiteUrl))
}

function buildAnalysisInput(project: DiagnosisProjectContext, answers: DiagnosisAnswerState[]): string {
  const rows = answers
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((answer) => ({
      position: answer.position,
      question: answer.question,
      answer: answer.answerText ?? '',
      citationUrls: answer.citationUrls,
    }))
  return [
    `请根据客户资料和${QUESTION_TOTAL}个问题的实际回答，判断每个回答是否对客户形成了明确的正面推荐。`,
    '只有明确建议选择、购买、联系或使用该客户时才算推荐；普通提及、客观介绍、负面评价或没有结论都不算推荐。',
    '只返回结构化结果中的recommended布尔值，不要添加confidence、score、rationale或suggestion。',
    `客户公司全名：${nullableText(project.companyName)}`,
    `客户官网：${nullableText(project.websiteUrl)}`,
    `优化对象：${nullableText(project.optimizationTarget)}`,
    `补充信息：${nullableText(project.supplementalInfo)}`,
    '问题与回答：',
    JSON.stringify(rows),
  ].join('\n')
}

function analysisFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    name: 'geo_diagnosis_recommendations',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          minItems: QUESTION_TOTAL,
          maxItems: QUESTION_TOTAL,
          items: {
            type: 'object',
            properties: {
              position: { type: 'integer', minimum: QUESTION_POSITION_MIN, maximum: QUESTION_POSITION_MAX },
              recommended: { type: 'boolean' },
            },
            required: ['position', 'recommended'],
            additionalProperties: false,
          },
        },
      },
      required: ['results'],
      additionalProperties: false,
    },
  }
}

function parseRecommendations(text: string): Map<number, boolean> {
  let parsed: unknown
  try {
    parsed = parseJsonText(text)
  } catch {
    throw new DiagnosisCoreError('豆包诊断汇总不是有效JSON')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).results)) {
    throw new DiagnosisCoreError('豆包诊断汇总缺少20个推荐结果')
  }
  const values = (parsed as { results: unknown[] }).results
  if (values.length !== QUESTION_TOTAL) throw new DiagnosisCoreError(`豆包诊断汇总结果不是${QUESTION_TOTAL}个`)
  const result = new Map<number, boolean>()
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new DiagnosisCoreError('豆包诊断汇总包含无效结果')
    const item = value as Record<string, unknown>
    if (Object.keys(item).some((key) => key !== 'position' && key !== 'recommended')) {
      throw new DiagnosisCoreError('豆包诊断汇总包含未允许的字段')
    }
    const position = item.position
    if (typeof position !== 'number' || !Number.isInteger(position) || position < QUESTION_POSITION_MIN || position > QUESTION_POSITION_MAX) {
      throw new DiagnosisCoreError('豆包诊断汇总包含无效题号')
    }
    if (typeof item.recommended !== 'boolean') throw new DiagnosisCoreError('豆包诊断汇总包含无效推荐值')
    if (result.has(position)) throw new DiagnosisCoreError('豆包诊断汇总包含重复题号')
    result.set(position, item.recommended)
  }
  if (result.size !== QUESTION_TOTAL) throw new DiagnosisCoreError('豆包诊断汇总缺少题目')
  return result
}

function rate(value: number, total: number): number {
  return Number((value / total).toFixed(4))
}

/**
 * Answers unfinished questions in parallel, then performs one aggregate
 * recommendation analysis. Persistence is supplied by the caller so each
 * answer can be committed immediately and successful answers are never
 * replaced by a retry.
 */
export async function runDiagnosisCore(options: DiagnosisCoreOptions): Promise<DiagnosisCoreResult> {
  if (options.questions.length !== QUESTION_TOTAL) throw new DiagnosisCoreError('questions_count_invalid')
  if (!options.apiKey.trim()) throw new DiagnosisCoreError('未配置DOUBAO_API_KEY')
  if (!options.modelId.trim()) throw new DiagnosisCoreError('未配置DOUBAO_MODEL_ID')

  const answerMap = new Map<number, DiagnosisAnswerState>()
  for (const question of options.questions.slice().sort((a, b) => a.position - b.position)) {
    answerMap.set(question.position, normaliseAnswer(question, options.answers.find((answer) => answer.position === question.position)))
  }
  const orderedQuestions = options.questions.slice().sort((a, b) => a.position - b.position)
  const emitAnswer = async (answer: DiagnosisAnswerState): Promise<void> => {
    answerMap.set(answer.position, answer)
    await options.onAnswer?.(answer)
  }
  const emitProgress = async (answer: DiagnosisAnswerState): Promise<void> => {
    const values = [...answerMap.values()]
    await options.onProgress?.({
      position: answer.position,
      status: answer.status === 'success' ? 'success' : 'failed',
      completedCount: values.filter((item) => item.status === 'success').length,
      failedCount: values.filter((item) => item.status === 'failed').length,
      total: QUESTION_TOTAL,
      answer,
    })
  }

  // Surface persisted states first so a resumed run starts with the current
  // progress. Successful answers are skipped and failed answers are retried.
  for (const question of orderedQuestions) {
    const current = answerMap.get(question.position) as DiagnosisAnswerState
    if (current.status === 'success' || current.status === 'failed') await emitProgress(current)
  }

  let stopped = false
  const unfinishedQuestions = orderedQuestions.filter((question) => answerMap.get(question.position)?.status !== 'success')
  const runQuestion = async (question: DiagnosisQuestion): Promise<void> => {
    // Check before each launch to preserve the existing disconnect/cancellation
    // semantics. Once one launch observes a stop, do not start later questions.
    if (stopped) return
    if (options.shouldContinue && !options.shouldContinue()) {
      stopped = true
      return
    }
    if (options.signal?.aborted) {
      stopped = true
      return
    }

    const current = answerMap.get(question.position) as DiagnosisAnswerState
    const running: DiagnosisAnswerState = {
      ...current,
      status: 'running',
      answerText: null,
      citationUrls: [],
      responseModel: null,
      recommended: null,
      officialCitation: null,
      error: null,
      startedAt: nowIso(),
      completedAt: null,
    }

    // Start the provider request without waiting for the running-state write;
    // otherwise a slow persistence callback could serialize the twenty
    // independent provider requests. The write is still awaited before this
    // question emits its terminal state, and its failure is rethrown by the
    // allSettled boundary instead of being recorded as a question error.
    let runningPersistenceFailed = false
    let runningPersistenceError: unknown
    const runningPersistence = emitAnswer(running).catch((error: unknown) => {
      runningPersistenceFailed = true
      runningPersistenceError = error
    })
    let success: DiagnosisAnswerState | null = null
    let providerError: unknown = null
    try {
      const payload = await requestDoubaoResponses({
        apiKey: options.apiKey,
        modelId: options.modelId,
        input: question.question,
        tools: RAW_TOOLS,
        fetch: options.rawFetch,
        endpoint: options.endpoint,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      })
      const answerText = extractResponseText(payload)
      if (!answerText) throw new DiagnosisCoreError('豆包没有返回有效回答')
      success = {
        ...running,
        status: 'success',
        answerText,
        citationUrls: extractCitationUrls(payload),
        responseModel: extractResponseModel(payload),
        completedAt: nowIso(),
      }
    } catch (error) {
      providerError = error
    }

    await runningPersistence
    if (runningPersistenceFailed) throw runningPersistenceError

    if (providerError) {
      const failed: DiagnosisAnswerState = {
        ...running,
        status: 'failed',
        error: userFacingError(providerError, '该问题请求失败'),
        completedAt: nowIso(),
      }
      await emitAnswer(failed)
      await emitProgress(failed)
      return
    }

    if (!success) throw new DiagnosisCoreError('诊断问题没有返回结果')
    await emitAnswer(success)
    await emitProgress(success)
  }

  // Promise.allSettled lets every independent question finish even when one
  // provider request fails. Callback failures remain rejected and are
  // rethrown after all questions have settled below.
  const settled = await Promise.allSettled(unfinishedQuestions.map((question) => runQuestion(question)))
  const infrastructureFailure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
  if (infrastructureFailure) throw infrastructureFailure.reason

  if (stopped) {
    return { answers: orderedQuestions.map((item) => answerMap.get(item.position) as DiagnosisAnswerState), summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: true }
  }

  const answers = orderedQuestions.map((question) => answerMap.get(question.position) as DiagnosisAnswerState)
  if (answers.some((answer) => answer.status !== 'success')) {
    return { answers, summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: false }
  }
  if (options.analysisCompleted) {
    return { answers, summary: { status: 'completed', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: false }
  }
  if (options.deferAnalysis) {
    return { answers, summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: false }
  }
  if (options.shouldContinue && !options.shouldContinue()) {
    return { answers, summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: true }
  }
  if (options.signal?.aborted) {
    return { answers, summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null }, stopped: true }
  }

  try {
    await options.onAnalysisStart?.()
    const payload = await requestDoubaoResponses({
      apiKey: options.apiKey,
      modelId: options.modelId,
      input: buildAnalysisInput(options.project, answers),
      textFormat: analysisFormat(),
      fetch: options.analysisFetch ?? options.rawFetch,
      endpoint: options.endpoint,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    const text = extractResponseText(payload)
    if (!text) throw new DiagnosisCoreError('豆包没有返回诊断汇总')
    const recommendations = parseRecommendations(text)
    const enriched = answers.map((answer) => ({
      ...answer,
      recommended: recommendations.get(answer.position) ?? false,
      officialCitation: computeOfficialCitation(options.project.websiteUrl, answer.citationUrls),
    }))
    const recommendedCount = enriched.filter((answer) => answer.recommended === true).length
    const officialAnswers = options.project.websiteUrl ? enriched.filter((answer) => answer.officialCitation === true).length : 0
    return {
      answers: enriched,
      summary: {
        status: 'completed',
        analysis: parseJsonText(text),
        model: extractResponseModel(payload),
        error: null,
        recommendationRate: rate(recommendedCount, QUESTION_TOTAL),
        officialCitationRate: options.project.websiteUrl ? rate(officialAnswers, QUESTION_TOTAL) : null,
      },
      stopped: false,
    }
  } catch (error) {
    return {
      answers,
      summary: {
        status: 'failed',
        analysis: null,
        model: null,
        error: userFacingError(error, '诊断汇总失败，请重试'),
        recommendationRate: null,
        officialCitationRate: null,
      },
      stopped: false,
    }
  }
}
