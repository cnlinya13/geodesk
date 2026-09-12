import { QUESTION_TOTAL } from './business-rules'

export type InitialDiagnosisCompletionRun = {
  status: string | null | undefined
}

export type InitialDiagnosisCompletion = {
  run: InitialDiagnosisCompletionRun | null | undefined
  answers: ReadonlyArray<{ status: string | null | undefined }>
  reportPdfReady: boolean
}

export type InitialDiagnosisCompletionProject = {
  initialDiagnosisStatus: string | null | undefined
  initialDiagnosis: InitialDiagnosisCompletion | null | undefined
}

/**
 * The workflow gate is tied to the current initial run, not to a project
 * timestamp that can outlive a retry or a reset.  The run is structurally
 * bound to the answers and report metadata by the API/database detail shape.
 */
export function isInitialDiagnosisComplete(project: InitialDiagnosisCompletionProject): boolean {
  const diagnosis = project.initialDiagnosis
  const answers = diagnosis?.answers
  return project.initialDiagnosisStatus === 'completed'
    && diagnosis?.run?.status === 'completed'
    && diagnosis.reportPdfReady === true
    && Array.isArray(answers)
    && answers.length === QUESTION_TOTAL
    && answers.every((answer) => answer.status === 'success')
}
