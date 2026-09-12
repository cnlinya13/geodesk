import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryResponder = (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryResult>

const mocks = vi.hoisted(() => {
  const state: {
    responder: QueryResponder | null
    queries: Array<{ sql: string; values?: unknown[] }>
  } = { responder: null, queries: [] }
  class FakePool {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
      state.queries.push({ sql, values })
      return (await state.responder?.(sql, values)) ?? { rows: [], rowCount: 0 }
    }

    async connect(): Promise<{ query: QueryFunction; release: () => void }> {
      return { query: this.query.bind(this), release: () => undefined }
    }
  }
  const pool = new FakePool()
  return { state, databasePool: vi.fn(() => pool) }
})

vi.mock('./db.ts', () => ({ databasePool: mocks.databasePool }))

const {
  clearDiagnosisReportRefreshInflight,
  getDiagnosisReportPdf,
  getDiagnosisReportRefresh,
  runDiagnosisReportRefresh,
  startDiagnosisReportRefresh,
  waitForDiagnosisReportRefresh,
} = await import('./diagnosis-report-service.ts')

function result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount }
}

const project = {
  id: '1',
  company_name: '示例公司',
  website_url: 'https://a.example',
  optimization_target: '企业服务',
}

function answerRows(): Array<Record<string, unknown>> {
  return Array.from({ length: 20 }, (_, index) => ({
    position: index + 1,
    question: `客户选择服务商时应关注什么${index + 1}？`,
    status: 'success',
    answer_text: `回答${index + 1}`,
    citation_urls: index === 0 ? ['https://a.example/source'] : ['https://other.example/source'],
    recommended: index % 2 === 0,
  }))
}

let run: Record<string, unknown>
let answers: Array<Record<string, unknown>>
let renderCalls: Array<Record<string, unknown>>

function resetState(overrides: Record<string, unknown> = {}): void {
  run = {
    id: 'run-1',
    status: 'completed',
    run_type: 'initial',
    completed_at: '2026-09-08T10:00:00.000Z',
    recommendation_rate: 0.5,
    report_pdf: null,
    report_pdf_generated_at: null,
    report_refresh_status: 'not_started',
    report_refresh_started_at: null,
    report_refresh_error: null,
    ...overrides,
  }
  answers = answerRows()
  renderCalls = []
  mocks.state.queries.length = 0
}

function configureDatabase(): void {
  mocks.state.responder = async (sql, values) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
    if (sql.includes('select id, company_name, website_url, optimization_target')) return result([project])
    if (sql.includes('select website_url from geo_projects')) return result([{ website_url: project.website_url }])
    if (sql.includes('from geo_diagnosis_answers')) return result(answers)
    if (sql.includes('set report_refresh_status = \'not_started\'')) {
      run = { ...run, report_refresh_status: 'not_started', report_refresh_started_at: null, report_refresh_error: null }
      return result()
    }
    if (sql.includes('set report_refresh_status = \'running\'')) {
      run = { ...run, report_refresh_status: 'running', report_refresh_started_at: '2026-09-08T10:01:00.000Z', report_refresh_error: null }
      return result([run])
    }
    if (sql.includes('set report_refresh_status = \'failed\'')) {
      run = { ...run, report_refresh_status: 'failed', report_refresh_error: String(values?.[2] ?? '') }
      return result([], 1)
    }
    if (sql.includes('set official_citation =')) return result([], 1)
    if (sql.includes('set official_citation_rate =')) {
      run = {
        ...run,
        report_pdf: values?.[3] ?? Buffer.from('%PDF-test'),
        official_citation_rate: values?.[2] ?? null,
        report_pdf_generated_at: '2026-09-08T10:02:00.000Z',
        report_refresh_status: 'ready',
        report_refresh_error: null,
      }
      return result([run])
    }
    if (sql.includes('set initial_official_citation_rate =')) return result([], 1)
    if (sql.includes('select id, status, run_type, completed_at, recommendation_rate')) return result([run])
    if (sql.includes('from geo_diagnosis_runs as run') && sql.includes('run.report_refresh_status = \'ready\'')) {
      return run.report_refresh_status === 'ready' && run.report_pdf
        ? result([{ pdf: run.report_pdf, company_name: project.company_name, completed_at: run.completed_at, source_run_id: run.id }])
        : result()
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}

beforeEach(() => {
  clearDiagnosisReportRefreshInflight()
  resetState()
  configureDatabase()
})

afterEach(() => {
  clearDiagnosisReportRefreshInflight()
  mocks.state.responder = null
  mocks.state.queries.length = 0
})

function renderFake(value = '%PDF-first'): (input: Record<string, unknown>) => Promise<Buffer> {
  return async (input) => {
    renderCalls.push(input)
    return Buffer.from(value)
  }
}

describe('diagnosis report refresh service', () => {
  it('prepares the first current PDF without AI and saves derived citation values atomically', async () => {
    const metadata = await runDiagnosisReportRefresh('1', { render: renderFake() })

    expect(metadata).toMatchObject({
      status: 'ready',
      reportPdfReady: true,
      reportPdfGeneratedAt: '2026-09-08T10:02:00.000Z',
      sourceRunId: 'run-1',
    })
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]).toMatchObject({
      companyName: '示例公司',
      websiteUrl: 'https://a.example',
      recommendationRate: 0.5,
      officialCitationRate: 0.05,
    })
    const queries = mocks.state.queries.map((item) => item.sql)
    expect(queries.some((sql) => sql.includes('set official_citation ='))).toBe(true)
    expect(queries.some((sql) => sql.includes('set official_citation_rate =') && sql.includes("report_pdf = $4"))).toBe(true)
    expect(queries.some((sql) => sql.includes('set recommended ='))).toBe(false)
    expect(queries.some((sql) => sql.includes('summary_analysis'))).toBe(false)
    expect(queries.some((sql) => sql.includes('set diagnosis_started_at'))).toBe(false)
  })

  it('passes the accepted English locale to the renderer without changing the source snapshot', async () => {
    const metadata = await runDiagnosisReportRefresh('1', { locale: 'en', render: renderFake() })

    expect(metadata.status).toBe('ready')
    expect(renderCalls[0]?.locale).toBe('en')
    expect(renderCalls[0]?.companyName).toBe('示例公司')
    expect((renderCalls[0]?.answers as Array<{ question: string }>)[0]?.question).toContain('客户选择服务商')
  })

  it('re-derives only official citation values after a website fill and replaces the one current PDF', async () => {
    await runDiagnosisReportRefresh('1', { render: renderFake('%PDF-before') })
    const before = renderCalls[0]
    project.website_url = 'https://other.example'
    run = { ...run, report_pdf: null, report_pdf_generated_at: null, report_refresh_status: 'not_started' }
    await runDiagnosisReportRefresh('1', { render: renderFake('%PDF-after') })

    expect(renderCalls).toHaveLength(2)
    expect(before?.officialCitationRate).toBe(0.05)
    expect(renderCalls[1]?.officialCitationRate).toBe(0.95)
    expect((renderCalls[1]?.answers as Array<{ officialCitation: boolean }>)[0]?.officialCitation).toBe(false)
    expect(run.report_pdf).toEqual(Buffer.from('%PDF-after'))
    const sql = mocks.state.queries.map((item) => item.sql)
    expect(sql.filter((item) => item.includes('set official_citation =')).length).toBe(40)
    expect(sql.some((item) => item.includes('set recommended ='))).toBe(false)
    expect(sql.some((item) => item.includes('set completed_at ='))).toBe(false)
  })

  it('returns not-started without rendering a fake PDF when the initial run is incomplete', async () => {
    run = { ...run, status: 'failed' }
    answers = answers.map((answer, index) => index === 0 ? { ...answer, status: 'failed', answer_text: null, recommended: null } : answer)

    const metadata = await runDiagnosisReportRefresh('1', { render: renderFake() })

    expect(metadata).toMatchObject({ status: 'not_started', reportPdfReady: false, sourceRunId: 'run-1' })
    expect(renderCalls).toHaveLength(0)
    expect(run.report_pdf).toBeNull()
    expect(mocks.state.queries.some((item) => item.sql.includes('report_pdf = $4'))).toBe(false)
  })

  it('marks completed runs with invalid source data failed in one transaction', async () => {
    answers = answers.map((answer, index) => index === 0 ? { ...answer, citation_urls: '{invalid-json' } : answer)

    const metadata = await runDiagnosisReportRefresh('1', { render: renderFake() })

    expect(metadata).toMatchObject({ status: 'failed', reportPdfReady: false })
    expect(run.status).toBe('completed')
    expect(run.report_refresh_status).toBe('failed')
    expect(String(run.report_refresh_error)).toContain('report_pdf_citations_invalid')
    expect(renderCalls).toHaveLength(0)
    const statusWrites = mocks.state.queries.filter((item) =>
      item.sql.includes('set report_refresh_status =') && item.sql.includes('geo_diagnosis_runs'),
    )
    expect(statusWrites).toHaveLength(1)
    expect(statusWrites[0]?.sql).toContain("set report_refresh_status = 'failed'")
  })

  it('continues after the caller returns and prevents a duplicate same-project start', async () => {
    let release!: (value: Buffer) => void
    const render = async (input: Record<string, unknown>): Promise<Buffer> => {
      renderCalls.push(input)
      return new Promise((resolve) => { release = resolve })
    }
    const accepted = await startDiagnosisReportRefresh('1', { render })
    expect(accepted.status).toBe('running')
    const duplicate = await startDiagnosisReportRefresh('1', { render: renderFake('%PDF-duplicate') })
    expect(duplicate.status).toBe('running')
    expect(renderCalls).toHaveLength(1)
    release(Buffer.from('%PDF-background'))
    await waitForDiagnosisReportRefresh('1')
    expect(run.report_refresh_status).toBe('ready')
    expect(run.report_pdf).toEqual(Buffer.from('%PDF-background'))
  })

  it('marks render failures retryable without changing the completed diagnosis status', async () => {
    const failed = await runDiagnosisReportRefresh('1', {
      render: async () => { throw new Error('report_pdf_font_unavailable') },
    })

    expect(failed).toMatchObject({ status: 'failed', reportPdfReady: false })
    expect(run.status).toBe('completed')
    expect(run.report_refresh_status).toBe('failed')
    expect(String(run.report_refresh_error)).toContain('report_pdf_font_unavailable')

    const retried = await runDiagnosisReportRefresh('1', { render: renderFake('%PDF-retry') })
    expect(retried.status).toBe('ready')
    expect(run.report_pdf).toEqual(Buffer.from('%PDF-retry'))
  })

  it('guards download until the current report is ready', async () => {
    expect(await getDiagnosisReportPdf('1')).toBeNull()
    await runDiagnosisReportRefresh('1', { render: renderFake('%PDF-ready') })
    const report = await getDiagnosisReportPdf('1')
    expect(report?.pdf).toEqual(Buffer.from('%PDF-ready'))
    expect(report?.sourceRunId).toBe('run-1')
    run = { ...run, report_refresh_status: 'failed' }
    expect(await getDiagnosisReportPdf('1')).toBeNull()
  })

  it('does not invalidate a ready PDF when the requested locale changes', async () => {
    await runDiagnosisReportRefresh('1', { locale: 'zh-CN', render: renderFake('%PDF-zh') })
    const accepted = await startDiagnosisReportRefresh('1', { locale: 'en', render: renderFake('%PDF-en') })

    expect(accepted).toMatchObject({ status: 'ready', reportPdfReady: true })
    expect(renderCalls).toHaveLength(1)
    expect(run.report_pdf).toEqual(Buffer.from('%PDF-zh'))
  })

  it('exposes persisted status for page re-entry without reading PDF bytes', async () => {
    run = { ...run, report_refresh_status: 'failed', report_refresh_error: 'PDF生成失败' }
    const metadata = await getDiagnosisReportRefresh('1')
    expect(metadata).toMatchObject({ status: 'failed', reportPdfReady: false, error: 'PDF生成失败' })
    const query = mocks.state.queries.at(-1)
    expect(query?.sql).not.toContain('select report_pdf')
  })
})
