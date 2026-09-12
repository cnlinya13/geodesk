import process from 'node:process'
import {
  createOrResumeDiagnosis,
  getInitialDiagnosis,
  getProject,
  getProjectDetail,
  markDiagnosisRunAnalyzing,
  markDiagnosisRunFailed,
  saveDiagnosisAnswer,
  saveDiagnosisSummary,
  setDiagnosisRunRequestedModel,
} from './db.ts'
import { DiagnosisCoreError, resolveRequestedModel, runDiagnosisCore, type DiagnosisProgress } from './diagnosis-core.ts'
import { startDiagnosisReportRefresh } from './diagnosis-report-service.ts'
import type { DiagnosisReportLocale } from './diagnosis-report-locale.ts'
import type { MonitoringUpdateEvent } from '../src/types.ts'
import { isInitialDiagnosisComplete } from '../src/initial-diagnosis-completion.ts'
import { QUESTION_TOTAL } from '../src/business-rules.ts'

export class InitialDiagnosisError extends Error {}

export type InitialDiagnosisCallbacks = {
  onProgress?: (progress: DiagnosisProgress) => void | Promise<void>
  onMonitoringUpdate?: (update: MonitoringUpdateEvent) => void | Promise<void>
  shouldContinue?: () => boolean
  signal?: AbortSignal
  taskId?: string
  onRunCreated?: (runId: string) => void | Promise<void>
  /** Locale captured by the accepting browser request for the persisted PDF. */
  reportLocale?: DiagnosisReportLocale
}

export type DiagnosisRunType = 'initial' | 'monitoring'

function configuration(): { apiKey: string; modelId: string } {
  return {
    apiKey: process.env.DOUBAO_API_KEY?.trim() ?? '',
    modelId: process.env.DOUBAO_MODEL_ID?.trim() ?? '',
  }
}

async function startOrResumeDiagnosis(
  projectId: string,
  runType: DiagnosisRunType,
  callbacks: InitialDiagnosisCallbacks = {},
): Promise<Awaited<ReturnType<typeof getProjectDetail>>> {
  const project = await getProject(projectId)
  if (!project) return null
  if (!project.questionsLockedAt) throw new InitialDiagnosisError('questions_not_locked')
  if (runType === 'monitoring') {
    const initialDiagnosis = await getInitialDiagnosis(projectId)
    if (!isInitialDiagnosisComplete({ initialDiagnosisStatus: project.initialDiagnosisStatus, initialDiagnosis })) {
      throw new InitialDiagnosisError('initial_diagnosis_incomplete')
    }
  }

  const prepared = await createOrResumeDiagnosis(projectId, runType, callbacks.taskId)
  if (!prepared) return null
  if (prepared.run.status === 'completed') {
    // Report preparation is a non-AI backend operation.  It must not extend
    // the diagnosis request or depend on the report page staying mounted.
    if (runType === 'initial') void (callbacks.reportLocale
      ? startDiagnosisReportRefresh(projectId, { locale: callbacks.reportLocale })
      : startDiagnosisReportRefresh(projectId)).catch(() => undefined)
    return getProjectDetail(projectId)
  }
  await callbacks.onRunCreated?.(prepared.run.id)

  const detail = await getProjectDetail(projectId)
  if (!detail) return null
  const config = configuration()

  try {
    let requestedModel = resolveRequestedModel(prepared.run.requestedModel, config.modelId, config.apiKey)
    if (!prepared.run.requestedModel && requestedModel) {
      requestedModel = await setDiagnosisRunRequestedModel(prepared.run.id, requestedModel)
    }
    if (runType === 'monitoring') {
      await callbacks.onMonitoringUpdate?.({
        type: 'run',
        run: {
          ...prepared.run,
          runType: 'monitoring',
          requestedModel: requestedModel ?? prepared.run.requestedModel,
          answers: prepared.answers,
        },
      })
    }
    const result = await runDiagnosisCore({
      project: {
        companyName: detail.companyName,
        websiteUrl: detail.websiteUrl,
        optimizationTarget: detail.optimizationTarget,
        supplementalInfo: detail.supplementalInfo,
      },
      questions: detail.questions.map((question) => ({ position: question.position, question: question.question })),
      answers: prepared.answers,
      apiKey: config.apiKey,
      modelId: requestedModel ?? '',
      onAnswer: async (answer) => {
        const saved = await saveDiagnosisAnswer(prepared.run!.id, answer, projectId)
        if (saved === false) throw new InitialDiagnosisError('diagnosis_stale')
        if (runType === 'monitoring') {
          await callbacks.onMonitoringUpdate?.({ type: 'answer', runId: prepared.run!.id, answer })
        }
      },
      onAnalysisStart: async () => {
        const marked = await markDiagnosisRunAnalyzing(prepared.run!.id, projectId, runType)
        if (marked === false) throw new InitialDiagnosisError('diagnosis_stale')
        if (runType === 'monitoring') {
          await callbacks.onMonitoringUpdate?.({ type: 'analyzing', runId: prepared.run!.id })
        }
      },
      timeoutMs: 0,
      signal: callbacks.signal,
      onProgress: callbacks.onProgress,
      shouldContinue: callbacks.shouldContinue ?? (callbacks.signal ? () => !callbacks.signal?.aborted : undefined),
    })

    if (result.stopped) return getProjectDetail(projectId)
    if (result.summary.status === 'completed' && result.summary.analysis !== null && result.summary.recommendationRate !== null) {
      const saved = await saveDiagnosisSummary(prepared.run.id, projectId, result.answers, {
        analysis: result.summary.analysis,
        model: result.summary.model,
        recommendationRate: result.summary.recommendationRate,
        officialCitationRate: result.summary.officialCitationRate,
      }, runType)
      if (saved === false) throw new InitialDiagnosisError('diagnosis_stale')
      if (runType === 'initial') void (callbacks.reportLocale
        ? startDiagnosisReportRefresh(projectId, { locale: callbacks.reportLocale })
        : startDiagnosisReportRefresh(projectId)).catch(() => undefined)
    } else if (result.summary.status === 'failed') {
      await markDiagnosisRunFailed(prepared.run.id, projectId, result.summary.error || '诊断汇总失败，请重试', runType)
    } else if (result.answers.some((answer) => answer.status !== 'success')) {
      await markDiagnosisRunFailed(prepared.run.id, projectId, '部分问题未完成，请点击重试', runType)
    }
  } catch (error) {
    const message = error instanceof DiagnosisCoreError || error instanceof Error ? error.message : '诊断暂时失败，请重试'
    await markDiagnosisRunFailed(prepared.run.id, projectId, message, runType)
  }

  return getProjectDetail(projectId)
}

export async function startOrResumeInitialDiagnosis(
  projectId: string,
  callbacks: InitialDiagnosisCallbacks = {},
): Promise<Awaited<ReturnType<typeof getProjectDetail>>> {
  return startOrResumeDiagnosis(projectId, 'initial', callbacks)
}

export async function startOrResumeMonitoring(
  projectId: string,
  callbacks: InitialDiagnosisCallbacks = {},
): Promise<Awaited<ReturnType<typeof getProjectDetail>>> {
  return startOrResumeDiagnosis(projectId, 'monitoring', callbacks)
}

/**
 * Aggregate the already-persisted initial answers into the diagnosis summary.
 * This is deliberately separate from the non-AI report-refresh service: the
 * accepted `diagnosis_report` task owns this model call, while report PDF
 * preparation starts only after the summary has been saved successfully.
 */
export async function generateInitialDiagnosisReport(
  projectId: string,
  options: InitialDiagnosisCallbacks = {},
): Promise<Awaited<ReturnType<typeof getProjectDetail>>> {
  const detail = await getProjectDetail(projectId)
  if (!detail) return null
  if (!detail.questionsLockedAt) throw new InitialDiagnosisError('questions_not_locked')

  const run = detail.initialDiagnosis.run
  const answers = detail.initialDiagnosis.answers
  const answersComplete = answers.length === QUESTION_TOTAL && answers.every((answer) => answer.status === 'success')
  if (!run || !answersComplete) throw new InitialDiagnosisError('answers_incomplete')
  if (run.status === 'completed') {
    void (options.reportLocale
      ? startDiagnosisReportRefresh(projectId, { locale: options.reportLocale })
      : startDiagnosisReportRefresh(projectId)).catch(() => undefined)
    return detail
  }

  const config = configuration()
  let requestedModel = resolveRequestedModel(run.requestedModel, config.modelId, config.apiKey)

  try {
    if (!requestedModel) {
      if (!config.apiKey) throw new DiagnosisCoreError('未配置DOUBAO_API_KEY')
      throw new DiagnosisCoreError('未配置DOUBAO_MODEL_ID')
    }
    if (!run.requestedModel) requestedModel = await setDiagnosisRunRequestedModel(run.id, requestedModel)
    await options.onRunCreated?.(run.id)

    const result = await runDiagnosisCore({
      project: {
        companyName: detail.companyName,
        websiteUrl: detail.websiteUrl,
        optimizationTarget: detail.optimizationTarget,
        supplementalInfo: detail.supplementalInfo,
      },
      questions: detail.questions.map((question) => ({ position: question.position, question: question.question })),
      answers,
      apiKey: config.apiKey,
      modelId: requestedModel ?? '',
      onAnalysisStart: async () => {
        const marked = await markDiagnosisRunAnalyzing(run.id, projectId, 'initial')
        if (marked === false) throw new InitialDiagnosisError('diagnosis_stale')
      },
      signal: options.signal,
      shouldContinue: options.shouldContinue ?? (options.signal ? () => !options.signal?.aborted : undefined),
    })

    if (result.stopped) return getProjectDetail(projectId)
    if (result.summary.status === 'completed' && result.summary.analysis !== null && result.summary.recommendationRate !== null) {
      const saved = await saveDiagnosisSummary(run.id, projectId, result.answers, {
        analysis: result.summary.analysis,
        model: result.summary.model,
        recommendationRate: result.summary.recommendationRate,
        officialCitationRate: result.summary.officialCitationRate,
      }, 'initial')
      if (saved === false) throw new InitialDiagnosisError('diagnosis_stale')
      void (options.reportLocale
        ? startDiagnosisReportRefresh(projectId, { locale: options.reportLocale })
        : startDiagnosisReportRefresh(projectId)).catch(() => undefined)
    } else {
      await markDiagnosisRunFailed(run.id, projectId, result.summary.error || '诊断汇总失败，请重试', 'initial')
    }
  } catch (error) {
    const message = error instanceof DiagnosisCoreError || error instanceof Error ? error.message : '诊断汇总失败，请重试'
    await markDiagnosisRunFailed(run.id, projectId, message, 'initial')
  }

  return getProjectDetail(projectId)
}
