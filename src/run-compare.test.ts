import { describe, expect, it } from 'vitest'
import {
  compareDiagnosisRuns,
  diffAnswerSnapshots,
  findPreviousCompletedRun,
  type CompareRunInput,
} from './run-compare'
import type { DiagnosisAnswer, DiagnosisRun } from './types'

function makeRun(overrides: Partial<DiagnosisRun> = {}): DiagnosisRun {
  return {
    id: 'run-1',
    runType: 'monitoring',
    status: 'completed',
    requestedModel: null,
    roundNumber: 1,
    publishedArticleCount: null,
    startedAt: '2026-10-16T10:00:00.000Z',
    completedAt: '2026-10-16T10:05:00.000Z',
    summaryAnalysis: null,
    summaryModel: 'doubao-seed-1-6-250615',
    summaryError: null,
    recommendationRate: 0.6,
    officialCitationRate: 0.4,
    ...overrides,
  }
}

function makeAnswer(overrides: Partial<DiagnosisAnswer> = {}): DiagnosisAnswer {
  return {
    position: 1,
    question: '问题 1',
    status: 'success',
    answerText: '答案文本',
    citationUrls: [],
    responseModel: 'doubao-seed-1-6-250615',
    recommended: false,
    officialCitation: false,
    error: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function makeInput(run: DiagnosisRun, answers: DiagnosisAnswer[]): CompareRunInput {
  return { run, answers }
}

describe('diffAnswerSnapshots', () => {
  it('returns null when only the answer text differs', () => {
    const previous = { recommended: true, officialCitation: true, citationUrls: ['https://a.example/'] }
    const current = { recommended: true, officialCitation: true, citationUrls: ['https://a.example/'] }
    // 文本差异不在快照里：相同快照 => 无变化
    expect(diffAnswerSnapshots(previous, current)).toBeNull()
  })

  it('detects recommended flips', () => {
    const diff = diffAnswerSnapshots(
      { recommended: false, officialCitation: false, citationUrls: [] },
      { recommended: true, officialCitation: false, citationUrls: [] },
    )
    expect(diff?.kinds).toEqual(['recommended'])
  })

  it('detects citation flips', () => {
    const diff = diffAnswerSnapshots(
      { recommended: true, officialCitation: false, citationUrls: [] },
      { recommended: true, officialCitation: true, citationUrls: ['https://a.example/'] },
    )
    expect(diff?.kinds).toEqual(['citation', 'citationUrls'])
    expect(diff?.addedUrls).toEqual(['https://a.example/'])
    expect(diff?.removedUrls).toEqual([])
  })

  it('detects added and removed citation urls', () => {
    const diff = diffAnswerSnapshots(
      { recommended: true, officialCitation: true, citationUrls: ['https://a.example/', 'https://b.example/'] },
      { recommended: true, officialCitation: true, citationUrls: ['https://b.example/', 'https://c.example/'] },
    )
    expect(diff?.kinds).toEqual(['citationUrls'])
    expect(diff?.addedUrls).toEqual(['https://c.example/'])
    expect(diff?.removedUrls).toEqual(['https://a.example/'])
  })

  it('ignores blank urls after trimming (normalization in compareDiagnosisRuns)', () => {
    const previous = makeInput(makeRun({ id: 'prev' }), [
      makeAnswer({ position: 1, citationUrls: ['https://a.example/'] }),
    ])
    const current = makeInput(makeRun({ id: 'curr' }), [
      makeAnswer({ position: 1, citationUrls: ['  https://a.example/  ', ''] }),
    ])
    const comparison = compareDiagnosisRuns(current, previous)
    expect(comparison.changes).toEqual([])
    expect(comparison.unchanged.map((u) => u.position)).toEqual([1])
  })
})

describe('compareDiagnosisRuns', () => {
  it('splits changed and unchanged answers matched by position', () => {
    const previous = makeInput(makeRun({ id: 'prev' }), [
      makeAnswer({ position: 1, question: 'Q1', recommended: false }),
      makeAnswer({ position: 2, question: 'Q2', recommended: true, officialCitation: true }),
    ])
    const current = makeInput(makeRun({ id: 'curr', roundNumber: 2 }), [
      // 文本不同但结构相同 => 不算变化
      makeAnswer({ position: 1, question: 'Q1', answerText: '完全不同的措辞', recommended: false }),
      makeAnswer({ position: 2, question: 'Q2', recommended: false, officialCitation: true }),
    ])

    const comparison = compareDiagnosisRuns(current, previous)
    expect(comparison.current.id).toBe('curr')
    expect(comparison.previous.id).toBe('prev')
    expect(comparison.changes.map((c) => c.position)).toEqual([2])
    expect(comparison.changes[0].kinds).toEqual(['recommended'])
    expect(comparison.unchanged.map((u) => u.position)).toEqual([1])
  })

  it('skips positions missing on either side', () => {
    const previous = makeInput(makeRun({ id: 'prev' }), [makeAnswer({ position: 1 })])
    const current = makeInput(makeRun({ id: 'curr' }), [makeAnswer({ position: 1 }), makeAnswer({ position: 2 })])
    const comparison = compareDiagnosisRuns(current, previous)
    expect(comparison.changes).toEqual([])
    expect(comparison.unchanged.map((u) => u.position)).toEqual([1])
  })
})

describe('findPreviousCompletedRun', () => {
  const initial = makeInput(makeRun({ id: 'initial', runType: 'initial', roundNumber: 0 }), [])
  const round1 = makeInput(makeRun({ id: 'r1', roundNumber: 1 }), [])
  const round2 = makeInput(makeRun({ id: 'r2', roundNumber: 2 }), [])
  const round3 = makeInput(makeRun({ id: 'r3', roundNumber: 3 }), [])

  it('returns the initial run as previous of monitoring round 1', () => {
    expect(findPreviousCompletedRun([round1], 'r1', initial)?.run.id).toBe('initial')
  })

  it('returns the previous monitoring round', () => {
    expect(findPreviousCompletedRun([round1, round2, round3], 'r3', initial)?.run.id).toBe('r2')
  })

  it('skips failed runs in between', () => {
    const failedRound2 = makeInput(makeRun({ id: 'r2', roundNumber: 2, status: 'failed' }), [])
    expect(findPreviousCompletedRun([round1, failedRound2, round3], 'r3', initial)?.run.id).toBe('r1')
  })

  it('returns null when there is no previous completed run', () => {
    expect(findPreviousCompletedRun([round1], 'r1', null)).toBeNull()
    expect(findPreviousCompletedRun([], 'initial', initial)).toBeNull()
  })

  it('returns null for an unknown run id', () => {
    expect(findPreviousCompletedRun([round1], 'nope', initial)).toBeNull()
  })
})
