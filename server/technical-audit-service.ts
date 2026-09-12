import { clearTechnicalAuditSnapshot, getInitialDiagnosis, getProject, getTechnicalAuditSnapshot, saveTechnicalAuditSnapshot, withTechnicalAuditLock } from './db.ts'
import { runTechnicalAudit, type TechnicalAuditRunOptions } from './technical-audit.ts'
import { isInitialDiagnosisComplete } from '../src/initial-diagnosis-completion.ts'
import { TECHNICAL_AUDIT_RULE_VERSION, type TechnicalAuditExecutionError, type TechnicalAuditItem, type TechnicalAuditSnapshot } from '../src/technical-audit.ts'

export class TechnicalAuditServiceError extends Error {
  executionErrors?: TechnicalAuditExecutionError[]

  constructor(message: string, executionErrors?: TechnicalAuditExecutionError[]) {
    super(message)
    this.name = 'TechnicalAuditServiceError'
    this.executionErrors = executionErrors
  }
}

export async function readTechnicalAudit(projectId: string): Promise<TechnicalAuditSnapshot | null> {
  return getTechnicalAuditSnapshot(projectId)
}

export async function executeTechnicalAudit(projectId: string, options: TechnicalAuditRunOptions = {}): Promise<TechnicalAuditSnapshot | null> {
  return withTechnicalAuditLock(projectId, async (client) => {
    const project = await getProject(projectId, client)
    if (!project) return null
    const initialDiagnosis = await getInitialDiagnosis(projectId, client)
    if (!isInitialDiagnosisComplete({ initialDiagnosisStatus: project.initialDiagnosisStatus, initialDiagnosis })) {
      throw new TechnicalAuditServiceError('diagnosis_incomplete')
    }
    if (!project.websiteUrl) throw new TechnicalAuditServiceError('website_required')

    const diagnosisRunId = initialDiagnosis.run!.id
    // A run supersedes the one current snapshot immediately.  The runner then
    // writes each completed item through onItemPersist, so a process/network
    // interruption leaves completed items readable and the rest absent
    // (rendered as unchecked), rather than resurrecting stale conclusions.
    const cleared = await clearTechnicalAuditSnapshot(projectId, project.websiteUrl, diagnosisRunId, client)
    if (!cleared) throw new TechnicalAuditServiceError('website_changed')

    const persistedItems: TechnicalAuditItem[] = []
    const partialScope = {
      pages: [project.websiteUrl],
      sampled_pages: [],
      skipped_pages: [],
      candidates: [],
      requests: 0,
      request_limit: 0,
      page_limit: 1,
      response_limit_bytes: 0,
      time_limit_ms: 0,
      limits: ['run_in_progress'],
    }
    const partialCheckedAt = new Date().toISOString()
    const persistItem = async (entry: TechnicalAuditItem): Promise<void> => {
      persistedItems.push(entry)
      const partial: TechnicalAuditSnapshot = {
        checked_at: partialCheckedAt,
        website_url: project.websiteUrl as string,
        scope: partialScope,
        items: persistedItems.slice(),
        rule_version: TECHNICAL_AUDIT_RULE_VERSION,
      }
      const saved = await saveTechnicalAuditSnapshot(projectId, project.websiteUrl as string, partial, diagnosisRunId, client)
      if (!saved) throw new TechnicalAuditServiceError('website_changed')
    }
    const runnerOptions: TechnicalAuditRunOptions = {
      ...options,
      onItemPersist: persistItem,
    }
    const snapshot = await runTechnicalAudit({ websiteUrl: project.websiteUrl }, runnerOptions)
    const saved = await saveTechnicalAuditSnapshot(projectId, project.websiteUrl, snapshot, diagnosisRunId, client)
    if (!saved) throw new TechnicalAuditServiceError('website_changed')
    return snapshot
  })
}
