import { describe, expect, it } from 'vitest'
import { deliveryMetadataIsNewer, isCompleteMonitoringRun, latestSuccessfulMonitoringRun, monitoringDeliveryReportKey } from './App'
import type { MonitoringRun } from './types'

function completeRun(id: string, roundNumber: number, completedAt = '2026-09-07T01:00:00.000Z'): MonitoringRun {
  return {
    id,
    runType: 'monitoring',
    status: 'completed',
    requestedModel: 'fixture',
    roundNumber,
    publishedArticleCount: 0,
    startedAt: '2026-09-07T00:00:00.000Z',
    completedAt,
    summaryAnalysis: null,
    summaryModel: 'fixture',
    summaryError: null,
    recommendationRate: 0.5,
    officialCitationRate: 0.5,
    answers: Array.from({ length: 20 }, (_, index) => ({
      position: index + 1,
      question: `问题${index + 1}`,
      status: 'success' as const,
      answerText: '回答',
      citationUrls: [],
      responseModel: 'fixture',
      recommended: true,
      officialCitation: true,
      error: null,
      startedAt: '2026-09-07T00:00:00.000Z',
      completedAt,
    })),
  }
}

describe('monitoring delivery report source and metadata guards', () => {
  it('only treats a completed twenty-success-answer run as report-ready', () => {
    const run = completeRun('run-1', 1)
    expect(isCompleteMonitoringRun(run)).toBe(true)
    expect(isCompleteMonitoringRun({ ...run, status: 'analyzing' })).toBe(false)
    expect(isCompleteMonitoringRun({ ...run, answers: run.answers.slice(0, 19) })).toBe(false)
    expect(isCompleteMonitoringRun({ ...run, answers: [{ ...run.answers[0], position: 21 }, ...run.answers.slice(1)] })).toBe(false)
  })

  it('chooses the latest successful round independent of history ordering', () => {
    const first = completeRun('run-1', 1)
    const second = completeRun('run-2', 2)
    expect(latestSuccessfulMonitoringRun([second, first])?.id).toBe('run-2')
    expect(monitoringDeliveryReportKey('project-1', second)).toBe('project-1:run-2:2026-09-07T01:00:00.000Z')
  })

  it('rejects a stale older report metadata response after a newer upload', () => {
    const runs = [completeRun('run-2', 2), completeRun('run-1', 1)]
    const current = { reportPdfReady: true, reportPdfGeneratedAt: '2026-09-07T02:00:00.000Z', sourceRunId: 'run-2' }
    const stale = { reportPdfReady: true, reportPdfGeneratedAt: '2026-09-07T03:00:00.000Z', sourceRunId: 'run-1' }
    expect(deliveryMetadataIsNewer(current, stale, runs)).toBe(false)
    expect(deliveryMetadataIsNewer(current, { ...current, reportPdfGeneratedAt: '2026-09-07T03:00:00.000Z' }, runs)).toBe(true)
    expect(deliveryMetadataIsNewer(null, stale, runs)).toBe(true)
  })
})
