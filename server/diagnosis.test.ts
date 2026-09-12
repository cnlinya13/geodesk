import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosisCoreOptions } from './diagnosis-core.ts'
import type { MonitoringUpdateEvent } from '../src/types.ts'

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getInitialDiagnosis: vi.fn(),
  getProjectDetail: vi.fn(),
  createOrResumeDiagnosis: vi.fn(),
  markDiagnosisRunAnalyzing: vi.fn(),
  markDiagnosisRunFailed: vi.fn(),
  saveDiagnosisAnswer: vi.fn(),
  saveDiagnosisSummary: vi.fn(),
  setDiagnosisRunRequestedModel: vi.fn(),
  resolveRequestedModel: vi.fn((requestedModel: string | null | undefined) => requestedModel?.trim() || null),
  runDiagnosisCore: vi.fn(),
  startDiagnosisReportRefresh: vi.fn(),
  DiagnosisCoreError: class extends Error {},
}))

vi.mock('./db.ts', () => ({
  createOrResumeDiagnosis: mocks.createOrResumeDiagnosis,
  getProject: mocks.getProject,
  getInitialDiagnosis: mocks.getInitialDiagnosis,
  getProjectDetail: mocks.getProjectDetail,
  markDiagnosisRunAnalyzing: mocks.markDiagnosisRunAnalyzing,
  markDiagnosisRunFailed: mocks.markDiagnosisRunFailed,
  saveDiagnosisAnswer: mocks.saveDiagnosisAnswer,
  saveDiagnosisSummary: mocks.saveDiagnosisSummary,
  setDiagnosisRunRequestedModel: mocks.setDiagnosisRunRequestedModel,
}))
vi.mock('./diagnosis-core.ts', () => ({
  DiagnosisCoreError: mocks.DiagnosisCoreError,
  resolveRequestedModel: mocks.resolveRequestedModel,
  runDiagnosisCore: mocks.runDiagnosisCore,
}))
vi.mock('./diagnosis-report-service.ts', () => ({
  startDiagnosisReportRefresh: mocks.startDiagnosisReportRefresh,
}))

const {
  generateInitialDiagnosisReport,
  startOrResumeInitialDiagnosis,
  startOrResumeMonitoring,
} = await import('./diagnosis.ts')

const originalApiKey = process.env.DOUBAO_API_KEY
const originalModelId = process.env.DOUBAO_MODEL_ID

const questions = Array.from({ length: 20 }, (_, index) => ({
  position: index + 1,
  question: `问题${index + 1}`,
}))
const answers = questions.map((question) => ({
  ...question,
  status: 'success' as const,
  answerText: '回答',
  citationUrls: [],
  responseModel: 'model',
  recommended: true,
  officialCitation: true,
  error: null,
  startedAt: null,
  completedAt: null,
}))

const project = {
  id: 'project-1',
  companyName: '示例公司',
  websiteUrl: 'https://example.test',
  optimizationTarget: '服务',
  supplementalInfo: null,
  questionsLockedAt: '2026-09-08T00:00:00.000Z',
  initialDiagnosisStatus: 'completed',
}

function diagnosisRun(runType: 'initial' | 'monitoring', status: 'running' | 'completed' = 'running') {
  return {
    id: `${runType}-run-1`,
    runType,
    status,
    requestedModel: 'test-model',
    roundNumber: runType === 'monitoring' ? 1 : 0,
    publishedArticleCount: runType === 'monitoring' ? 0 : null,
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: status === 'completed' ? '2026-09-08T00:01:00.000Z' : null,
    summaryAnalysis: null,
    summaryModel: null,
    summaryError: null,
    recommendationRate: null,
    officialCitationRate: null,
  }
}

function detail(initialRun = diagnosisRun('initial')) {
  return {
    ...project,
    questions,
    initialDiagnosis: { run: initialRun, answers, reportPdfReady: false, reportPdfGeneratedAt: null },
  }
}

const initialDiagnosis = {
  run: { id: 'initial-run-1', status: 'completed' },
  answers,
  reportPdfReady: true,
}

function coreOptions(): { timeoutMs?: number } {
  const call = mocks.runDiagnosisCore.mock.calls.at(-1)
  if (!call) throw new Error('runDiagnosisCore was not called')
  return call[0] as { timeoutMs?: number }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DOUBAO_API_KEY = 'test-key'
  process.env.DOUBAO_MODEL_ID = 'test-model'
  mocks.resolveRequestedModel.mockImplementation((requestedModel: string | null | undefined) => requestedModel?.trim() || null)
  mocks.getProject.mockResolvedValue(project)
  mocks.getInitialDiagnosis.mockResolvedValue(initialDiagnosis)
  mocks.getProjectDetail.mockResolvedValue(detail())
  mocks.createOrResumeDiagnosis.mockResolvedValue({ run: diagnosisRun('initial'), answers: [] })
  mocks.runDiagnosisCore.mockResolvedValue({
    answers,
    summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null },
    stopped: true,
  })
})

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.DOUBAO_API_KEY
  else process.env.DOUBAO_API_KEY = originalApiKey
  if (originalModelId === undefined) delete process.env.DOUBAO_MODEL_ID
  else process.env.DOUBAO_MODEL_ID = originalModelId
})

describe('diagnosis timeout selection', () => {
  it('disables the client-side timeout for monitoring runs', async () => {
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('monitoring'), answers: [] })

    await startOrResumeMonitoring('project-1')

    expect(mocks.runDiagnosisCore).toHaveBeenCalledTimes(1)
    expect(coreOptions().timeoutMs).toBe(0)
  })

  it('disables the client-side timeout for initial diagnosis runs', async () => {
    await startOrResumeInitialDiagnosis('project-1')

    expect(mocks.runDiagnosisCore).toHaveBeenCalledTimes(1)
    expect(coreOptions().timeoutMs).toBe(0)
  })

  it('aggregates persisted answers before accepting non-AI report refresh', async () => {
    const summary = {
      status: 'completed' as const,
      analysis: { results: [] },
      model: 'test-model',
      error: null,
      recommendationRate: 0.5,
      officialCitationRate: 0.25,
    }
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      await options.onAnalysisStart?.()
      return { answers, summary, stopped: false }
    })

    await generateInitialDiagnosisReport('project-1')

    expect(mocks.runDiagnosisCore).toHaveBeenCalledTimes(1)
    expect(mocks.saveDiagnosisSummary).toHaveBeenCalledWith('initial-run-1', 'project-1', answers, {
      analysis: summary.analysis,
      model: summary.model,
      recommendationRate: summary.recommendationRate,
      officialCitationRate: summary.officialCitationRate,
    }, 'initial')
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('project-1')
  })

  it('passes the captured report locale only to the persisted PDF refresh', async () => {
    const summary = {
      status: 'completed' as const,
      analysis: { results: [] },
      model: 'test-model',
      error: null,
      recommendationRate: 0.5,
      officialCitationRate: 0.25,
    }
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      await options.onAnalysisStart?.()
      return { answers, summary, stopped: false }
    })

    await generateInitialDiagnosisReport('project-1', { reportLocale: 'en' })

    expect(coreOptions()).not.toHaveProperty('reportLocale')
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('project-1', { locale: 'en' })
  })

  it('keeps the captured locale when initial diagnosis completion queues automatic PDF refresh', async () => {
    const summary = {
      status: 'completed' as const,
      analysis: { results: [] },
      model: 'test-model',
      error: null,
      recommendationRate: 0.5,
      officialCitationRate: 0.25,
    }
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      await options.onAnalysisStart?.()
      return { answers, summary, stopped: false }
    })

    await startOrResumeInitialDiagnosis('project-1', { reportLocale: 'en' })

    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('project-1', { locale: 'en' })
  })
})

describe('initial diagnosis persisted flow', () => {
  it('runs aggregate analysis after the twenty answers and saves one summary', async () => {
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('initial'), answers: [] })
    const summary = {
      status: 'completed' as const,
      analysis: { results: [] },
      model: 'test-model',
      error: null,
      recommendationRate: 0.5,
      officialCitationRate: 0.25,
    }
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      await options.onAnalysisStart?.()
      return { answers, summary, stopped: false }
    })

    await startOrResumeInitialDiagnosis('project-1')

    expect((coreOptions() as DiagnosisCoreOptions).deferAnalysis).toBeUndefined()
    expect(mocks.markDiagnosisRunAnalyzing).toHaveBeenCalledTimes(1)
    expect(mocks.markDiagnosisRunAnalyzing).toHaveBeenCalledWith('initial-run-1', 'project-1', 'initial')
    expect(mocks.saveDiagnosisSummary).toHaveBeenCalledTimes(1)
    expect(mocks.saveDiagnosisSummary).toHaveBeenCalledWith('initial-run-1', 'project-1', answers, {
      analysis: summary.analysis,
      model: summary.model,
      recommendationRate: summary.recommendationRate,
      officialCitationRate: summary.officialCitationRate,
    }, 'initial')
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('project-1')
  })

  it('does not save a summary when one of the twenty answers fails', async () => {
    const partialAnswers = answers.map((answer, index) => index === 0
      ? { ...answer, status: 'failed' as const, answerText: null, responseModel: null, recommended: null, officialCitation: null, error: '请求失败' }
      : answer)
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('initial'), answers: [] })
    mocks.runDiagnosisCore.mockResolvedValueOnce({
      answers: partialAnswers,
      summary: { status: 'not_started', analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null },
      stopped: false,
    })

    await startOrResumeInitialDiagnosis('project-1')

    expect(mocks.saveDiagnosisSummary).not.toHaveBeenCalled()
    expect(mocks.markDiagnosisRunFailed).toHaveBeenCalledWith('initial-run-1', 'project-1', '部分问题未完成，请点击重试', 'initial')
  })

  it('marks the run failed after summary failure while retaining persisted answers', async () => {
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('initial'), answers: [] })
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      await options.onAnswer?.(answers[0]!)
      return {
        answers,
        summary: { status: 'failed', analysis: null, model: null, error: '汇总失败', recommendationRate: null, officialCitationRate: null },
        stopped: false,
      }
    })

    await startOrResumeInitialDiagnosis('project-1')

    expect(mocks.saveDiagnosisAnswer).toHaveBeenCalledWith('initial-run-1', answers[0], 'project-1')
    expect(mocks.saveDiagnosisSummary).not.toHaveBeenCalled()
    expect(mocks.markDiagnosisRunFailed).toHaveBeenCalledWith('initial-run-1', 'project-1', '汇总失败', 'initial')
  })

  it('resumes with twenty persisted answers and performs analysis without answering again', async () => {
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('initial'), answers })
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      expect(options.answers).toEqual(answers)
      await options.onAnalysisStart?.()
      return {
        answers,
        summary: { status: 'completed', analysis: { results: [] }, model: 'test-model', error: null, recommendationRate: 0.5, officialCitationRate: 0.25 },
        stopped: false,
      }
    })

    await startOrResumeInitialDiagnosis('project-1')

    expect(mocks.saveDiagnosisAnswer).not.toHaveBeenCalled()
    expect(mocks.saveDiagnosisSummary).toHaveBeenCalledTimes(1)
    expect(mocks.startDiagnosisReportRefresh).toHaveBeenCalledWith('project-1')
  })
})

describe('monitoring persisted updates', () => {
  const stoppedResult = {
    answers,
    summary: { status: 'not_started' as const, analysis: null, model: null, error: null, recommendationRate: null, officialCitationRate: null },
    stopped: true,
  }

  it('emits a complete new or resumed run with its persisted answers before core requests', async () => {
    const persistedAnswers = answers.map((answer, index) => index === 0
      ? { ...answer, status: 'failed' as const, answerText: null, responseModel: null, recommended: null, officialCitation: null, error: '上次失败' }
      : answer)
    const newRun = { ...diagnosisRun('monitoring'), id: 'monitoring-new', requestedModel: null }
    const resumedRun = { ...diagnosisRun('monitoring'), id: 'monitoring-resumed', requestedModel: 'test-model' }
    mocks.createOrResumeDiagnosis
      .mockResolvedValueOnce({ run: newRun, answers: persistedAnswers })
      .mockResolvedValueOnce({ run: resumedRun, answers: persistedAnswers })
    mocks.setDiagnosisRunRequestedModel.mockResolvedValueOnce('test-model')
    const order: string[] = []
    const updates: MonitoringUpdateEvent[] = []
    mocks.runDiagnosisCore
      .mockImplementationOnce(async () => { order.push('core:new'); return stoppedResult })
      .mockImplementationOnce(async () => { order.push('core:resumed'); return stoppedResult })

    await startOrResumeMonitoring('project-1', { onMonitoringUpdate: (update) => {
      order.push(`update:${update.type}:${update.type === 'run' ? update.run.id : ''}`)
      updates.push(update)
    } })
    await startOrResumeMonitoring('project-1', { onMonitoringUpdate: (update) => {
      order.push(`update:${update.type}:${update.type === 'run' ? update.run.id : ''}`)
      updates.push(update)
    } })

    expect(order).toEqual(['update:run:monitoring-new', 'core:new', 'update:run:monitoring-resumed', 'core:resumed'])
    expect(updates).toHaveLength(2)
    for (const [index, event] of updates.entries()) {
      expect(event).toMatchObject({ type: 'run', run: { runType: 'monitoring', answers: persistedAnswers } })
      expect(event.type === 'run' ? event.run.id : '').toBe(index === 0 ? 'monitoring-new' : 'monitoring-resumed')
    }
  })

  it('emits each answer and analyzing update only after the corresponding database write', async () => {
    const order: string[] = []
    const updates: MonitoringUpdateEvent[] = []
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('monitoring'), answers: [] })
    mocks.saveDiagnosisAnswer.mockImplementation(async (_runId: string, answer: { status: string }) => {
      order.push(`saved:${answer.status}`)
    })
    mocks.markDiagnosisRunAnalyzing.mockImplementation(async () => {
      order.push('saved:analyzing')
    })
    mocks.runDiagnosisCore.mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
      const running = { ...answers[0], status: 'running' as const, answerText: null, responseModel: null, recommended: null, officialCitation: null, error: null }
      await options.onAnswer?.(running)
      await options.onAnswer?.(answers[0])
      await options.onAnalysisStart?.()
      order.push('core:continued')
      return stoppedResult
    })

    await startOrResumeMonitoring('project-1', { onMonitoringUpdate: (update) => {
      order.push(`update:${update.type}`)
      updates.push(update)
    } })

    expect(order).toEqual([
      'update:run',
      'saved:running', 'update:answer',
      'saved:success', 'update:answer',
      'saved:analyzing', 'update:analyzing',
      'core:continued',
    ])
    expect(updates.map((update) => update.type)).toEqual(['run', 'answer', 'answer', 'analyzing'])
    expect(updates[1]).toMatchObject({ type: 'answer', runId: 'monitoring-run-1', answer: { status: 'running' } })
    expect(updates[2]).toMatchObject({ type: 'answer', runId: 'monitoring-run-1', answer: { status: 'success' } })
    expect(updates[3]).toEqual({ type: 'analyzing', runId: 'monitoring-run-1' })
  })

  it('does not emit an answer or analyzing update when its database write fails', async () => {
    const updates: MonitoringUpdateEvent[] = []
    mocks.createOrResumeDiagnosis.mockResolvedValueOnce({ run: diagnosisRun('monitoring'), answers: [] })
    mocks.runDiagnosisCore
      .mockImplementationOnce(async (options: DiagnosisCoreOptions) => {
        mocks.saveDiagnosisAnswer.mockRejectedValueOnce(new Error('answer write failed'))
        await expect(options.onAnswer?.(answers[0])).rejects.toThrow('answer write failed')
        mocks.markDiagnosisRunAnalyzing.mockRejectedValueOnce(new Error('analyzing write failed'))
        await expect(options.onAnalysisStart?.()).rejects.toThrow('analyzing write failed')
        return stoppedResult
      })

    await startOrResumeMonitoring('project-1', { onMonitoringUpdate: (update) => { updates.push(update) } })

    expect(updates.map((update) => update.type)).toEqual(['run'])
  })
})
