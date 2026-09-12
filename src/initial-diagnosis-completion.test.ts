import { describe, expect, it } from 'vitest'
import { isInitialDiagnosisComplete } from './initial-diagnosis-completion'

function diagnosis(overrides: Record<string, unknown> = {}) {
  return {
    run: { status: 'completed' },
    answers: Array.from({ length: 20 }, () => ({ status: 'success' })),
    reportPdfReady: true,
    ...overrides,
  }
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    initialDiagnosisStatus: 'completed',
    initialDiagnosis: diagnosis(),
    ...overrides,
  }
}

describe('initial diagnosis completion gate', () => {
  it('requires the completed project, current run, twenty successful answers, and a ready PDF', () => {
    expect(isInitialDiagnosisComplete(project())).toBe(true)
    expect(isInitialDiagnosisComplete(project({ initialDiagnosisStatus: 'running' }))).toBe(false)
    expect(isInitialDiagnosisComplete(project({ initialDiagnosis: diagnosis({ run: { status: 'running' } }) }))).toBe(false)
    expect(isInitialDiagnosisComplete(project({ initialDiagnosis: diagnosis({ reportPdfReady: false }) }))).toBe(false)
    expect(isInitialDiagnosisComplete(project({ initialDiagnosis: diagnosis({ answers: Array.from({ length: 19 }, () => ({ status: 'success' })) }) }))).toBe(false)
    expect(isInitialDiagnosisComplete(project({ initialDiagnosis: diagnosis({ answers: Array.from({ length: 20 }, (_, index) => ({ status: index === 19 ? 'failed' : 'success' })) }) }))).toBe(false)
  })

  it('does not rely on completion timestamps', () => {
    expect(isInitialDiagnosisComplete(project({ initialDiagnosisCompletedAt: null, diagnosisStartedAt: null }))).toBe(true)
  })

  it('rejects a missing diagnosis snapshot', () => {
    expect(isInitialDiagnosisComplete(project({ initialDiagnosis: null }))).toBe(false)
  })
})
