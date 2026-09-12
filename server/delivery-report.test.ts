import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryResponder = (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryResult>

const pgMock = vi.hoisted(() => {
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

    async end(): Promise<void> {
      return undefined
    }
  }

  return { state, Pool: FakePool }
})

vi.mock('pg', () => ({ Pool: pgMock.Pool }))

const db = await import('./db.ts')
const indexSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

function result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount }
}

function successfulAnswers() {
  return Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' }))
}

function configureSuccessfulSave(overrides: {
  sourceRunId?: string
  sourceRunType?: string
  sourceStatus?: string
  sourceHasReport?: boolean
  latestRunId?: string
  answerRows?: Array<Record<string, unknown>>
  onSave?: (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>
} = {}): void {
  const sourceRunId = overrides.sourceRunId ?? '14'
  pgMock.state.responder = (sql, values) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
    if (sql.includes('select id from geo_projects where id = $1 for update')) return result([{ id: '13' }])
    if (sql.includes('where id = $1 and project_id = $2') && sql.includes('report_pdf is not null')) {
      return result([{
        id: sourceRunId,
        project_id: '13',
        run_type: overrides.sourceRunType ?? 'monitoring',
        status: overrides.sourceStatus ?? 'completed',
        round_number: 2,
        report_pdf_ready: overrides.sourceHasReport ?? false,
        report_pdf_generated_at: '2026-09-07T01:00:00.000Z',
      }])
    }
    if (sql.includes('from geo_diagnosis_answers')) return result(overrides.answerRows ?? successfulAnswers())
    if (sql.includes('order by round_number desc') && sql.includes('for update')) {
      return result([{ id: overrides.latestRunId ?? sourceRunId, round_number: 2 }])
    }
    if (sql.includes('set report_pdf = $2')) {
      if (overrides.onSave) return overrides.onSave(sql, values)
      return result([{ report_pdf_generated_at: '2026-09-07T02:00:00.000Z' }])
    }
    if (sql.includes('set report_pdf = null')) return result()
    throw new Error(`unexpected SQL: ${sql}`)
  }
}

afterEach(async () => {
  pgMock.state.responder = null
  pgMock.state.queries.length = 0
  await db.closeDatabasePool()
})

describe('monitoring delivery report persistence', () => {
  it('locks the project and atomically replaces only monitoring reports', async () => {
    configureSuccessfulSave()

    const saved = await db.saveMonitoringDeliveryReportPdf('13', '14', Buffer.from('%PDF-new'))

    expect(saved).toEqual({ reportPdfReady: true, reportPdfGeneratedAt: '2026-09-07T02:00:00.000Z', sourceRunId: '14' })
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql[0]).toBe('BEGIN')
    expect(sql.some((query) => query.includes('select id from geo_projects where id = $1 for update'))).toBe(true)
    expect(sql.some((query) => query.includes("run_type = 'monitoring'") && query.includes('set report_pdf = null'))).toBe(true)
    expect(sql).not.toContain('set report_pdf = null where project_id = $1 and run_type = \'initial\'')
    expect(sql.at(-1)).toBe('COMMIT')
  })

  it('rejects a completed source from an older monitoring round without replacing the current report', async () => {
    configureSuccessfulSave({ latestRunId: '15' })

    await expect(db.saveMonitoringDeliveryReportPdf('13', '14', Buffer.from('%PDF-old'))).rejects.toThrow('delivery_report_stale')
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql.some((query) => query.includes('set report_pdf = $2'))).toBe(false)
    expect(sql.at(-1)).toBe('ROLLBACK')
  })

  it('rejects incomplete or non-1..20 answer sets before writing bytes', async () => {
    configureSuccessfulSave({ answerRows: Array.from({ length: 20 }, (_, index) => ({ position: index === 19 ? 19 : index + 1, status: 'success' })) })

    await expect(db.saveMonitoringDeliveryReportPdf('13', '14', Buffer.from('%PDF-incomplete'))).rejects.toThrow('delivery_report_run_incomplete')
    expect(pgMock.state.queries.some((query) => query.sql.includes('set report_pdf = $2'))).toBe(false)
  })

  it('returns the existing metadata without rewriting the same source run', async () => {
    configureSuccessfulSave({ sourceHasReport: true })

    await expect(db.saveMonitoringDeliveryReportPdf('13', '14', Buffer.from('%PDF-retry'))).resolves.toEqual({
      reportPdfReady: true,
      reportPdfGeneratedAt: '2026-09-07T01:00:00.000Z',
      sourceRunId: '14',
    })
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql.some((query) => query.includes('set report_pdf = $2'))).toBe(false)
    expect(sql.some((query) => query.includes('set report_pdf = null'))).toBe(false)
  })

  it('rolls back a failed replacement so the previous report is retained', async () => {
    configureSuccessfulSave({ onSave: () => { throw new Error('disk_or_database_failure') } })

    await expect(db.saveMonitoringDeliveryReportPdf('13', '14', Buffer.from('%PDF-fails'))).rejects.toThrow('disk_or_database_failure')
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql.some((query) => query.includes('set report_pdf = null'))).toBe(false)
    expect(sql.at(-1)).toBe('ROLLBACK')
  })

  it('reads the project-level current report and never returns initial-report rows', async () => {
    pgMock.state.responder = (sql) => {
      if (sql.includes('from geo_diagnosis_runs as run') && sql.includes('join geo_projects as project')) {
        return result([{ pdf: Buffer.from('%PDF-current'), company_name: '示例公司', completed_at: '2026-09-07T02:00:00.000Z', source_run_id: '15' }])
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const report = await db.getMonitoringDeliveryReportPdf('13')

    expect(report?.pdf.toString()).toBe('%PDF-current')
    expect(report?.sourceRunId).toBe('15')
    expect(pgMock.state.queries[0]?.sql).toContain("run.run_type = 'monitoring'")
    expect(pgMock.state.queries[0]?.sql).not.toContain("run.run_type = 'initial'")
  })

  it('uses the Asia/Shanghai calendar date for a UTC-crossing delivery filename', () => {
    expect(indexSource).toContain("timeZone: 'Asia/Shanghai'")
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date('2026-09-06T16:30:00.000Z'))
    expect(date).toBe('2026-09-07')
  })
})
