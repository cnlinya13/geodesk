import type { PoolClient } from 'pg'
import { computeOfficialCitation } from './diagnosis-core.ts'
import { databasePool } from './db.ts'
import {
  renderDiagnosisReport,
  type DiagnosisReportAnswer,
  type DiagnosisReportRenderInput,
  type DiagnosisReportRendererDependencies,
} from './diagnosis-report-renderer.ts'
import {
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from '../src/business-rules.ts'
import type { DiagnosisReportLocale } from './diagnosis-report-locale.ts'

export const DIAGNOSIS_REPORT_REFRESH_STATUSES = ['not_started', 'running', 'ready', 'failed'] as const
export type DiagnosisReportRefreshStatus = typeof DIAGNOSIS_REPORT_REFRESH_STATUSES[number]

export type DiagnosisReportRefreshMetadata = {
  status: DiagnosisReportRefreshStatus
  startedAt: string | null
  error: string | null
  reportPdfReady: boolean
  reportPdfGeneratedAt: string | null
  sourceRunId: string | null
}

export type DiagnosisReportPdf = {
  pdf: Buffer
  companyName: string
  completedAt: string | null
  sourceRunId: string
}

export type DiagnosisReportRender = (
  input: DiagnosisReportRenderInput,
) => Promise<Buffer>

export type DiagnosisReportServiceOptions = {
  /** Injected only in isolated tests; production uses the Node jsPDF renderer. */
  render?: DiagnosisReportRender
  renderer?: DiagnosisReportRendererDependencies
  /** Captured from the accepting browser request; does not affect cache keys. */
  locale?: DiagnosisReportLocale
}

export class DiagnosisReportServiceError extends Error {}

type QueryExecutor = Pick<PoolClient, 'query'>

type ProjectRow = {
  id: unknown
  company_name: unknown
  website_url: unknown
  optimization_target: unknown
}

type RunRow = {
  id: unknown
  status: unknown
  run_type: unknown
  completed_at: unknown
  recommendation_rate: unknown
  report_pdf: unknown
  /** Status queries use a boolean presence flag instead of loading the binary. */
  report_pdf_present?: unknown
  report_pdf_generated_at: unknown
  report_refresh_status: unknown
  report_refresh_started_at: unknown
  report_refresh_error: unknown
}

type AnswerRow = {
  position: unknown
  question: unknown
  status: unknown
  answer_text: unknown
  citation_urls: unknown
  recommended: unknown
}

type ReportSnapshot = {
  projectId: string
  runId: string
  companyName: string
  websiteUrl: string | null
  optimizationTarget: string | null
  diagnosisDate: string | null
  recommendationRate: number | null
  answers: SnapshotAnswer[]
}

type SnapshotAnswer = DiagnosisReportAnswer & {
  citationUrls: string[]
}

type Claim = {
  shouldRun: boolean
  snapshot: ReportSnapshot | null
  metadata: DiagnosisReportRefreshMetadata
}

const inFlight = new Map<string, Promise<DiagnosisReportRefreshMetadata>>()

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text || null
}

function requiredText(value: unknown, error: string): string {
  const text = nullableText(value)
  if (!text) throw new DiagnosisReportServiceError(error)
  return text
}

function nullableRate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const rate = Number(value)
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null
}

function statusFromValue(value: unknown): DiagnosisReportRefreshStatus {
  return DIAGNOSIS_REPORT_REFRESH_STATUSES.includes(value as DiagnosisReportRefreshStatus)
    ? value as DiagnosisReportRefreshStatus
    : 'not_started'
}

function isoOrNull(value: unknown): string | null {
  return nullableIso(value)
}

function parseCitationUrls(value: unknown): string[] {
  let candidate = value
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) } catch { throw new DiagnosisReportServiceError('report_pdf_citations_invalid') }
  }
  if (!Array.isArray(candidate) || candidate.some((url) => typeof url !== 'string')) {
    throw new DiagnosisReportServiceError('report_pdf_citations_invalid')
  }
  return candidate.map((url) => url.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
}

function answerPositionsComplete(rows: AnswerRow[]): boolean {
  if (rows.length !== QUESTION_TOTAL) return false
  const positions = rows.map((row) => Number(row.position))
  return new Set(positions).size === QUESTION_TOTAL
    && positions.every((position, index) => Number.isInteger(position) && position === index + QUESTION_POSITION_MIN)
    && rows.every((row) => row.status === 'success')
}

function metadataFromRun(run: RunRow | null, forceStatus?: DiagnosisReportRefreshStatus): DiagnosisReportRefreshMetadata {
  if (!run) {
    return {
      status: forceStatus ?? 'not_started',
      startedAt: null,
      error: null,
      reportPdfReady: false,
      reportPdfGeneratedAt: null,
      sourceRunId: null,
    }
  }
  const sourceRunId = run.id === null || run.id === undefined ? null : String(run.id)
  const hasPdf = run.report_pdf_present === undefined
    ? run.report_pdf !== null && run.report_pdf !== undefined
    : run.report_pdf_present === true || run.report_pdf_present === 't' || run.report_pdf_present === 1 || run.report_pdf_present === '1'
  const rawStatus = statusFromValue(run.report_refresh_status)
  // Migration 017 backfills old completed browser reports.  This fallback is
  // also useful while an old detail reader is racing the migration; it never
  // treats a running or failed refresh as downloadable.
  const status = rawStatus === 'not_started' && hasPdf && run.status === 'completed' ? 'ready' : rawStatus
  return {
    status,
    startedAt: isoOrNull(run.report_refresh_started_at),
    error: nullableText(run.report_refresh_error),
    reportPdfReady: status === 'ready' && hasPdf && run.status === 'completed',
    reportPdfGeneratedAt: status === 'ready' && hasPdf ? isoOrNull(run.report_pdf_generated_at) : null,
    sourceRunId,
  }
}

function expectedSourceAnswer(answer: SnapshotAnswer): string {
  return JSON.stringify({
    position: answer.position,
    question: answer.question,
    citationUrls: answer.citationUrls,
    recommended: answer.recommended,
  })
}

function sourceAnswerFromRow(row: AnswerRow, websiteUrl: string | null): SnapshotAnswer {
  const position = Number(row.position)
  const question = requiredText(row.question, 'report_pdf_question_invalid')
  if (row.status !== 'success' || !nullableText(row.answer_text)) {
    throw new DiagnosisReportServiceError('report_pdf_answers_incomplete')
  }
  if (typeof row.recommended !== 'boolean') {
    throw new DiagnosisReportServiceError('report_pdf_recommendations_incomplete')
  }
  const citationUrls = parseCitationUrls(row.citation_urls)
  return {
    position,
    question,
    citationUrls,
    recommended: row.recommended,
    officialCitation: computeOfficialCitation(websiteUrl, citationUrls),
  }
}

function deriveOfficialCitationRate(answers: readonly SnapshotAnswer[], websiteUrl: string | null): number | null {
  if (!websiteUrl) return null
  const count = answers.filter((answer) => answer.officialCitation === true).length
  return Number((count / QUESTION_TOTAL).toFixed(4))
}

function buildRenderInput(
  snapshot: ReportSnapshot,
  answers: readonly SnapshotAnswer[],
  officialCitationRate: number | null,
  locale?: DiagnosisReportLocale,
): DiagnosisReportRenderInput {
  return {
    companyName: snapshot.companyName,
    diagnosisDate: snapshot.diagnosisDate,
    websiteUrl: snapshot.websiteUrl,
    optimizationTarget: snapshot.optimizationTarget,
    recommendationRate: snapshot.recommendationRate,
    officialCitationRate,
    answers: answers.map(({ position, question, recommended, officialCitation }) => ({
      position,
      question,
      recommended,
      officialCitation,
    })),
    ...(locale ? { locale } : {}),
  }
}

function safeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const redacted = raw
    .replace(/Bearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[-_ ]?key|access[-_ ]?token|token|secret|password|cookie)\s*[:=]\s*[^\s,;}]+/gi, 'credential=[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (redacted || '诊断报告刷新失败').slice(0, 500)
}

function sameWebsite(left: string | null, right: string | null): boolean {
  return left === right
}

async function queryRunAndAnswers(
  client: QueryExecutor,
  projectId: string,
  lock: boolean,
): Promise<{ project: ProjectRow; run: RunRow | null; answers: AnswerRow[] }> {
  const projectResult = await client.query<ProjectRow>(
    `select id, company_name, website_url, optimization_target
     from geo_projects
     where id = $1${lock ? ' for update' : ''}`,
    [projectId],
  )
  const project = projectResult.rows[0]
  if (!project) throw new DiagnosisReportServiceError('project_not_found')
  const runResult = await client.query<RunRow>(
    `select id, status, run_type, completed_at, recommendation_rate,
            report_pdf is not null as report_pdf_present, report_pdf_generated_at,
            report_refresh_status, report_refresh_started_at, report_refresh_error
     from geo_diagnosis_runs
     where project_id = $1 and run_type = 'initial'
     ${lock ? 'for update' : ''}`,
    [projectId],
  )
  const run = runResult.rows[0] ?? null
  if (!run) return { project, run: null, answers: [] }
  const answerResult = await client.query<AnswerRow>(
    `select position, question, status, answer_text, citation_urls, recommended
     from geo_diagnosis_answers
     where run_id = $1
     order by position`,
    [run.id],
  )
  return { project, run, answers: answerResult.rows }
}

function snapshotFromRows(project: ProjectRow, run: RunRow, answers: AnswerRow[]): ReportSnapshot {
  if (run.run_type !== 'initial' || run.status !== 'completed' || !answerPositionsComplete(answers)) {
    throw new DiagnosisReportServiceError('report_pdf_diagnosis_incomplete')
  }
  const websiteUrl = nullableText(project.website_url)
  const normalizedAnswers = answers.map((answer) => sourceAnswerFromRow(answer, websiteUrl))
  const recommendationRate = nullableRate(run.recommendation_rate)
  if (recommendationRate === null) throw new DiagnosisReportServiceError('report_pdf_recommendations_incomplete')
  return {
    projectId: String(project.id),
    runId: String(run.id),
    companyName: requiredText(project.company_name, 'report_pdf_company_required'),
    websiteUrl,
    optimizationTarget: nullableText(project.optimization_target),
    diagnosisDate: nullableIso(run.completed_at),
    recommendationRate,
    answers: normalizedAnswers,
  }
}

async function claimDiagnosisReportRefresh(projectId: string): Promise<Claim> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const { project, run, answers } = await queryRunAndAnswers(client, projectId, true)
    if (!run) {
      await client.query('COMMIT')
      return { shouldRun: false, snapshot: null, metadata: metadataFromRun(null) }
    }

    const current = metadataFromRun(run)
    if (current.reportPdfReady) {
      await client.query('COMMIT')
      return { shouldRun: false, snapshot: null, metadata: current }
    }
    if (current.status === 'running') {
      await client.query('COMMIT')
      return { shouldRun: false, snapshot: null, metadata: current }
    }

    let snapshot: ReportSnapshot
    try {
      snapshot = snapshotFromRows(project, run, answers)
    } catch (error) {
      // No complete initial run means there is nothing reportable. Keep that
      // case neutral; completed runs with malformed source data are retryable
      // failures. Neither branch creates a placeholder PDF.
      if (error instanceof DiagnosisReportServiceError && error.message === 'report_pdf_diagnosis_incomplete') {
        const neutral = await client.query<RunRow>(
          `update geo_diagnosis_runs
           set report_refresh_status = 'not_started',
               report_refresh_started_at = null,
               report_refresh_error = null
           where id = $1 and project_id = $2 and run_type = 'initial'
           returning id, status, run_type, completed_at, recommendation_rate,
                     report_pdf is not null as report_pdf_present, report_pdf_generated_at,
                     report_refresh_status, report_refresh_started_at, report_refresh_error`,
          [run.id, projectId],
        )
        await client.query('COMMIT')
        return {
          shouldRun: false,
          snapshot: null,
          metadata: neutral.rows[0]
            ? metadataFromRun(neutral.rows[0])
            : { ...current, status: 'not_started', startedAt: null, reportPdfReady: false, error: null, reportPdfGeneratedAt: null },
        }
      }
      const failure = safeFailureMessage(error)
      const failed = await client.query<RunRow>(
        `update geo_diagnosis_runs
         set report_refresh_status = 'failed', report_refresh_error = $3
         where id = $1 and project_id = $2 and run_type = 'initial'
         returning id, status, run_type, completed_at, recommendation_rate,
                   report_pdf is not null as report_pdf_present, report_pdf_generated_at,
                   report_refresh_status, report_refresh_started_at, report_refresh_error`,
        [run.id, projectId, failure],
      )
      await client.query('COMMIT')
      return {
        shouldRun: false,
        snapshot: null,
        metadata: failed.rows[0]
          ? metadataFromRun(failed.rows[0])
          : { ...current, status: 'failed', error: failure, reportPdfReady: false },
      }
    }

    const updated = await client.query<RunRow>(
      `update geo_diagnosis_runs
       set report_refresh_status = 'running',
           report_refresh_started_at = clock_timestamp(),
           report_refresh_error = null
       where id = $1 and project_id = $2 and run_type = 'initial'
         and status = 'completed'
         and report_refresh_status <> 'running'
       returning id, status, run_type, completed_at, recommendation_rate,
                 report_pdf is not null as report_pdf_present, report_pdf_generated_at,
                 report_refresh_status, report_refresh_started_at, report_refresh_error`,
      [run.id, projectId],
    )
    if (!updated.rows[0]) {
      await client.query('COMMIT')
      return { shouldRun: false, snapshot: null, metadata: current }
    }
    await client.query('COMMIT')
    return { shouldRun: true, snapshot, metadata: metadataFromRun(updated.rows[0]) }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep original failure */ }
    throw error
  } finally {
    client.release()
  }
}

async function markRefreshFailed(projectId: string, runId: string, message: string): Promise<boolean> {
  const result = await databasePool().query(
    `update geo_diagnosis_runs
     set report_refresh_status = 'failed', report_refresh_error = $3
     where id = $1 and project_id = $2 and run_type = 'initial'
       and report_refresh_status = 'running'`,
    [runId, projectId, safeFailureMessage(message)],
  )
  // A reset/delete may have removed this run, or a newer state may have won
  // the race.  The caller must re-read persisted state rather than claiming
  // that the failure was saved when no row was updated.
  return result.rowCount === 1
}

function assertSameAnswers(currentRows: AnswerRow[], expected: readonly SnapshotAnswer[], websiteUrl: string | null): void {
  if (!answerPositionsComplete(currentRows)) throw new DiagnosisReportServiceError('report_pdf_diagnosis_stale')
  const current = currentRows.map((row) => sourceAnswerFromRow(row, websiteUrl))
  if (current.length !== expected.length || current.some((answer, index) => expectedSourceAnswer(answer) !== expectedSourceAnswer(expected[index]!))) {
    throw new DiagnosisReportServiceError('report_pdf_diagnosis_stale')
  }
}

async function persistReport(
  snapshot: ReportSnapshot,
  derivedAnswers: readonly SnapshotAnswer[],
  officialCitationRate: number | null,
  pdf: Buffer,
): Promise<DiagnosisReportRefreshMetadata> {
  if (pdf.length < 5 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DiagnosisReportServiceError('report_pdf_output_invalid')
  }
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const projectResult = await client.query<{ website_url: unknown }>(
      'select website_url from geo_projects where id = $1 for update',
      [snapshot.projectId],
    )
    if (!projectResult.rows[0] || !sameWebsite(nullableText(projectResult.rows[0].website_url), snapshot.websiteUrl)) {
      throw new DiagnosisReportServiceError('report_pdf_diagnosis_stale')
    }

    const runResult = await client.query<RunRow>(
      `select id, status, run_type, completed_at, recommendation_rate,
              report_pdf is not null as report_pdf_present, report_pdf_generated_at,
              report_refresh_status, report_refresh_started_at, report_refresh_error
       from geo_diagnosis_runs
       where id = $1 and project_id = $2 and run_type = 'initial'
       for update`,
      [snapshot.runId, snapshot.projectId],
    )
    const run = runResult.rows[0]
    if (!run || run.status !== 'completed' || statusFromValue(run.report_refresh_status) !== 'running') {
      throw new DiagnosisReportServiceError('report_pdf_diagnosis_stale')
    }

    const answerResult = await client.query<AnswerRow>(
      `select position, question, status, answer_text, citation_urls, recommended
       from geo_diagnosis_answers
       where run_id = $1
       order by position`,
      [snapshot.runId],
    )
    assertSameAnswers(answerResult.rows, snapshot.answers, snapshot.websiteUrl)

    for (const answer of derivedAnswers) {
      await client.query(
        `update geo_diagnosis_answers
         set official_citation = $3, updated_at = now()
         where run_id = $1 and position = $2 and status = 'success'`,
        [snapshot.runId, answer.position, answer.officialCitation],
      )
    }

    const saved = await client.query<RunRow>(
      `update geo_diagnosis_runs
       set official_citation_rate = $3,
           report_pdf = $4,
           report_pdf_generated_at = clock_timestamp(),
           report_refresh_status = 'ready',
           report_refresh_error = null
       where id = $1 and project_id = $2 and run_type = 'initial'
         and status = 'completed' and report_refresh_status = 'running'
       returning id, status, run_type, completed_at, recommendation_rate,
                 report_pdf is not null as report_pdf_present, report_pdf_generated_at,
                 report_refresh_status, report_refresh_started_at, report_refresh_error`,
      [snapshot.runId, snapshot.projectId, officialCitationRate, pdf],
    )
    if (!saved.rows[0]) throw new DiagnosisReportServiceError('report_pdf_diagnosis_stale')
    await client.query(
      `update geo_projects
       set initial_official_citation_rate = $2, updated_at = now()
       where id = $1`,
      [snapshot.projectId, officialCitationRate],
    )
    await client.query('COMMIT')
    return metadataFromRun(saved.rows[0])
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* keep original failure */ }
    throw error
  } finally {
    client.release()
  }
}

async function executeClaim(claim: Claim, options: DiagnosisReportServiceOptions): Promise<DiagnosisReportRefreshMetadata> {
  if (!claim.snapshot) return claim.metadata
  const snapshot = claim.snapshot
  try {
    const derivedAnswers = snapshot.answers.map((answer) => ({ ...answer }))
    const officialCitationRate = deriveOfficialCitationRate(derivedAnswers, snapshot.websiteUrl)
    const renderInput = buildRenderInput(snapshot, derivedAnswers, officialCitationRate, options.locale)
    const pdf = await (options.render
      ? options.render(renderInput)
      : renderDiagnosisReport(renderInput, options.renderer))
    return await persistReport(snapshot, derivedAnswers, officialCitationRate, pdf)
  } catch (error) {
    const message = safeFailureMessage(error)
    try {
      await markRefreshFailed(snapshot.projectId, snapshot.runId, message)
    } catch {
      // Do not fabricate a failed status if the failure marker itself could
      // not be persisted.  Callers may retry after the database recovers.
      throw new DiagnosisReportServiceError('report_pdf_failure_state_not_persisted')
    }
    const current = await getDiagnosisReportRefresh(snapshot.projectId)
    return current
  }
}

/**
 * Claim and execute one refresh synchronously.  This is useful to a backend
 * startup hook and to isolated tests; the HTTP-facing path should use
 * startDiagnosisReportRefresh(), which returns after acceptance.
 */
export async function runDiagnosisReportRefresh(
  projectId: string,
  options: DiagnosisReportServiceOptions = {},
): Promise<DiagnosisReportRefreshMetadata> {
  const claim = await claimDiagnosisReportRefresh(projectId)
  return executeClaim(claim, options)
}

/**
 * Accept a report refresh and let it finish independently of the browser.
 * The process-local map prevents same-process duplicate work; the persisted
 * running status prevents a second request from claiming the same operation.
 */
export async function startDiagnosisReportRefresh(
  projectId: string,
  options: DiagnosisReportServiceOptions = {},
): Promise<DiagnosisReportRefreshMetadata> {
  const existing = inFlight.get(projectId)
  if (existing) return getDiagnosisReportRefresh(projectId)

  const claim = await claimDiagnosisReportRefresh(projectId)
  if (!claim.shouldRun) return claim.metadata

  const execution = executeClaim(claim, options)
  inFlight.set(projectId, execution)
  void execution.then(() => undefined).catch(() => undefined).finally(() => {
    if (inFlight.get(projectId) === execution) inFlight.delete(projectId)
  })
  return claim.metadata
}

/** Wait only for this process-local execution, primarily for deterministic tests. */
export async function waitForDiagnosisReportRefresh(projectId: string): Promise<DiagnosisReportRefreshMetadata> {
  await inFlight.get(projectId)
  return getDiagnosisReportRefresh(projectId)
}

export async function getDiagnosisReportRefresh(projectId: string): Promise<DiagnosisReportRefreshMetadata> {
  const result = await databasePool().query<RunRow>(
    `select id, status, run_type, completed_at, recommendation_rate,
            report_pdf is not null as report_pdf_present, report_pdf_generated_at,
            report_refresh_status, report_refresh_started_at, report_refresh_error
     from geo_diagnosis_runs
     where project_id = $1 and run_type = 'initial'`,
    [projectId],
  )
  return metadataFromRun(result.rows[0] ?? null)
}

/** Read only the currently ready initial report; failed/running binaries are guarded. */
export async function getDiagnosisReportPdf(projectId: string): Promise<DiagnosisReportPdf | null> {
  const result = await databasePool().query<{
    pdf: unknown
    company_name: unknown
    completed_at: unknown
    source_run_id: unknown
  }>(
    `select run.report_pdf as pdf,
            project.company_name,
            run.completed_at,
            run.id as source_run_id
     from geo_diagnosis_runs as run
     join geo_projects as project on project.id = run.project_id
     where project.id = $1
       and run.run_type = 'initial'
       and run.status = 'completed'
       and run.report_refresh_status = 'ready'
       and run.report_pdf is not null`,
    [projectId],
  )
  const row = result.rows[0]
  if (!row) return null
  const raw = row.pdf
  const pdf = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw ?? ''), 'base64')
  if (pdf.length < 5 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') return null
  return {
    pdf,
    companyName: requiredText(row.company_name, 'report_pdf_company_required'),
    completedAt: nullableIso(row.completed_at),
    sourceRunId: String(row.source_run_id),
  }
}

/** Exposed for test teardown; it does not change persisted state. */
export function clearDiagnosisReportRefreshInflight(): void {
  inFlight.clear()
}
