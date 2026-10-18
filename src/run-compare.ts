import type { DiagnosisAnswer, DiagnosisRun } from './types'

/**
 * 轮次对比（跨模型对比 v1：历史轮次对比）。
 *
 * 只比较结构化信号：推荐状态翻转、官网引用状态翻转、引用链接增减。
 * 答案文本的措辞差异不算变化（模型每次措辞都不同，否则每题都有"变化"）。
 *
 * compareDiagnosisRuns 是成对比较的纯函数：未来多模型同跑时，
 * 同一套题在多个模型各跑一轮，任意两轮之间同样可以用它对比。
 */

export type CompareRunInput = {
  run: Pick<
    DiagnosisRun,
    'id' | 'runType' | 'status' | 'roundNumber' | 'summaryModel' | 'completedAt' | 'recommendationRate' | 'officialCitationRate'
  >
  answers: DiagnosisAnswer[]
}

export type CompareRunSummary = {
  id: string
  runType: DiagnosisRun['runType']
  roundNumber: number
  model: string | null
  completedAt: string | null
  recommendationRate: number | null
  officialCitationRate: number | null
}

export type AnswerChangeKind = 'recommended' | 'citation' | 'citationUrls'

export type AnswerSnapshot = {
  recommended: boolean | null
  officialCitation: boolean | null
  citationUrls: string[]
}

export type AnswerChange = {
  position: number
  question: string
  kinds: AnswerChangeKind[]
  previous: AnswerSnapshot
  current: AnswerSnapshot
  addedUrls: string[]
  removedUrls: string[]
}

export type UnchangedAnswer = {
  position: number
  question: string
}

export type RunComparison = {
  current: CompareRunSummary
  previous: CompareRunSummary
  changes: AnswerChange[]
  unchanged: UnchangedAnswer[]
}

function normalizeUrl(url: string): string {
  return url.trim()
}

function snapshotAnswer(answer: DiagnosisAnswer): AnswerSnapshot {
  return {
    recommended: answer.recommended,
    officialCitation: answer.officialCitation,
    citationUrls: answer.citationUrls.map(normalizeUrl).filter((url) => url.length > 0),
  }
}

function summarizeRun(input: CompareRunInput): CompareRunSummary {
  return {
    id: input.run.id,
    runType: input.run.runType,
    roundNumber: input.run.roundNumber,
    model: input.run.summaryModel,
    completedAt: input.run.completedAt,
    recommendationRate: input.run.recommendationRate,
    officialCitationRate: input.run.officialCitationRate,
  }
}

/**
 * 比较两轮同一题的结构化快照。返回 null 表示无结构化变化。
 */
export function diffAnswerSnapshots(previous: AnswerSnapshot, current: AnswerSnapshot): Omit<AnswerChange, 'position' | 'question'> | null {
  const kinds: AnswerChangeKind[] = []
  if (previous.recommended !== current.recommended) kinds.push('recommended')
  if (previous.officialCitation !== current.officialCitation) kinds.push('citation')

  const previousUrls = new Set(previous.citationUrls)
  const currentUrls = new Set(current.citationUrls)
  const addedUrls = current.citationUrls.filter((url) => !previousUrls.has(url))
  const removedUrls = previous.citationUrls.filter((url) => !currentUrls.has(url))
  if (addedUrls.length > 0 || removedUrls.length > 0) kinds.push('citationUrls')

  if (kinds.length === 0) return null
  return { kinds, previous, current, addedUrls, removedUrls }
}

export function compareDiagnosisRuns(current: CompareRunInput, previous: CompareRunInput): RunComparison {
  const previousByPosition = new Map<number, DiagnosisAnswer>()
  for (const answer of previous.answers) {
    if (!previousByPosition.has(answer.position)) previousByPosition.set(answer.position, answer)
  }

  const changes: AnswerChange[] = []
  const unchanged: UnchangedAnswer[] = []
  const seen = new Set<number>()

  for (const answer of current.answers) {
    if (seen.has(answer.position)) continue
    seen.add(answer.position)
    const previousAnswer = previousByPosition.get(answer.position)
    if (!previousAnswer) continue
    const diff = diffAnswerSnapshots(snapshotAnswer(previousAnswer), snapshotAnswer(answer))
    if (diff) {
      changes.push({ position: answer.position, question: answer.question, ...diff })
    } else {
      unchanged.push({ position: answer.position, question: answer.question })
    }
  }

  changes.sort((a, b) => a.position - b.position)
  unchanged.sort((a, b) => a.position - b.position)

  return {
    current: summarizeRun(current),
    previous: summarizeRun(previous),
    changes,
    unchanged,
  }
}

type SequencedRun = CompareRunInput & { sequence: number }

/**
 * 找到指定轮次之前最近一个已完成的轮次。
 * 顺序：初始诊断（第 0 轮）在前，之后按监测轮次号升序。
 * 中间失败/未完成的轮次跳过；没有则返回 null。
 */
export function findPreviousCompletedRun(
  monitoringRuns: CompareRunInput[],
  currentRunId: string,
  initialRun: CompareRunInput | null,
): CompareRunInput | null {
  const sequenced: SequencedRun[] = []
  if (initialRun) sequenced.push({ ...initialRun, sequence: 0 })
  for (const run of monitoringRuns) {
    sequenced.push({ ...run, sequence: run.run.runType === 'monitoring' ? run.run.roundNumber : 0 })
  }
  sequenced.sort((a, b) => a.sequence - b.sequence || a.run.id.localeCompare(b.run.id))

  const index = sequenced.findIndex((item) => item.run.id === currentRunId)
  if (index <= 0) return null
  for (let i = index - 1; i >= 0; i--) {
    if (sequenced[i].run.status === 'completed') return sequenced[i]
  }
  return null
}
