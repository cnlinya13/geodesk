import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TECHNICAL_AUDIT_CURRENT_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS,
  TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS,
  TECHNICAL_AUDIT_RULE_VERSION,
  TECHNICAL_AUDIT_V6_ITEM_IDS,
  TECHNICAL_AUDIT_V5_ITEM_IDS,
  type TechnicalAuditItem,
  type TechnicalAuditScope,
  type TechnicalAuditSnapshot,
} from '../src/technical-audit.ts'
import { contentAuditFailureSummary, type ContentAuditRecord } from '../src/content-audit.ts'
import type { ContentAuditProgressSnapshot } from './db.ts'
import type { GeneratedQuestion } from './question-generator.ts'

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
      return {
        query: this.query.bind(this),
        release: () => undefined,
      }
    }

    async end(): Promise<void> {
      return undefined
    }
  }

  return { state, Pool: FakePool }
})

vi.mock('pg', () => ({ Pool: pgMock.Pool }))

const db = await import('./db.ts')

const baseRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '1',
  company_name: '示例公司',
  website_url: 'https://a.example',
  optimization_target: '服务',
  supplemental_info: null,
  questions_generated_at: null,
  questions_locked_at: null,
  diagnosis_started_at: null,
  initial_diagnosis_completed_at: null,
  initial_diagnosis_status: 'not_started',
  initial_recommendation_rate: null,
  initial_official_citation_rate: null,
  initial_diagnosis_at: null,
  website_locked_at: null,
  website_crawl_status: 'completed',
  website_crawl_started_at: '2026-09-06T05:00:00.000Z',
  website_crawl_completed_at: '2026-09-06T05:00:01.000Z',
  website_crawl_error: null,
  website_crawl_source: 'links',
  website_crawl_incomplete: false,
  website_pages_discovered: 1,
  website_pages_succeeded: 1,
  website_pages_failed: 0,
  questions_generation_status: 'completed',
  questions_generation_started_at: null,
  questions_generation_completed_at: null,
  questions_generation_error: null,
  created_at: '2026-09-06T05:00:00.000Z',
  updated_at: '2026-09-06T05:00:01.000Z',
  ...overrides,
})

function result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount }
}

function resetMock(): void {
  pgMock.state.queries.length = 0
  pgMock.state.responder = null
}

function projectDetailResponse(
  sql: string,
  project: Record<string, unknown>,
  articleRows: Array<Record<string, unknown>> = [],
): QueryResult | null {
  if (sql.includes('from geo_projects p')) return result([project])
  if (sql.includes('from geo_project_questions')) return result()
  if (sql.includes('run_type = \'initial\'')) return result()
  if (sql.includes('run_type = \'monitoring\'')) return result()
  if (sql.includes('from geo_article_batches b')) return result(articleRows)
  return null
}

function categorizedQuestionRows(overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `question-${index + 1}`,
    position: index + 1,
    question: `问题${index + 1}`,
    generated_at: '2026-09-06T05:00:00.123Z',
    category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision',
    is_locked: false,
    ...overrides,
  }))
}

afterEach(async () => {
  resetMock()
  await db.closeDatabasePool()
})

describe('database task invalidation', () => {
  it('does not write an old crawl token after A→B→A replacement', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select website_url, website_crawl_status')) {
        // The URL is A again, but this is the newer A crawl token.
        return result([{ website_url: 'https://a.example', website_crawl_status: 'crawling', crawl_token: 'new-a-token' }])
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const saved = await db.saveWebsiteCrawl('1', 'https://a.example', 'old-a-token', {
      startUrl: 'https://a.example', source: 'links', status: 'completed', incomplete: false,
      error: null, discoveredCount: 1, successCount: 1, failedCount: 0, pages: [],
    })

    expect(saved).toBe(false)
    expect(pgMock.state.queries.map((query) => query.sql).some((sql) => sql.includes('delete from geo_project_website_pages'))).toBe(false)
    expect(pgMock.state.queries.map((query) => query.sql).some((sql) => sql.includes('insert into geo_project_website_pages'))).toBe(false)
  })

  it('does not replace questions when an older generation token returns', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([baseRow()])
      if (sql.includes('select questions_generation_status')) {
        return result([{ questions_generation_status: 'generating', questions_locked_at: null, generation_token: 'new-token' }])
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const questions: GeneratedQuestion[] = Array.from({ length: 20 }, (_, index) => ({
      question: `问题${index + 1}`,
      category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision',
    }))
    const saved = await db.saveQuestions('1', questions, 'old-token')

    expect(saved).toBe(false)
    expect(pgMock.state.queries.map((query) => query.sql).some((sql) => sql.includes('delete from geo_project_questions'))).toBe(false)
    expect(pgMock.state.queries.map((query) => query.sql).some((sql) => sql.includes('insert into geo_project_questions'))).toBe(false)
  })
})

describe('project mutation invalidation boundaries', () => {
  it('atomically resets only the unconfirmed question outline and keeps history', async () => {
    const oldRow = baseRow({
      project_has_questions: true,
      updated_at: new Date('2026-09-06T05:00:01.234Z'),
      website_crawl_status: 'completed',
      questions_generated_at: '2026-09-06T05:01:00.000Z',
      questions_locked_at: null,
      diagnosis_started_at: '2026-09-06T05:02:00.000Z',
      initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z',
      initial_diagnosis_status: 'completed',
      website_locked_at: null,
      technical_audit: { items: ['old'] },
      content_audit: { status: 'completed' },
    })
    const newRow = {
      ...oldRow,
      company_name: '新公司',
      website_url: 'https://b.example',
      optimization_target: '新对象',
      supplemental_info: '新补充',
      questions_generated_at: null,
      questions_generation_status: 'not_started',
      questions_generation_started_at: null,
      questions_generation_completed_at: null,
      questions_generation_error: null,
      created_at: oldRow.created_at,
      updated_at: '2026-09-06T05:00:02.000Z',
    }
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      if (sql.startsWith('update geo_projects') && sql.includes('set company_name')) return result([newRow])
      if (sql.includes('delete from geo_project_questions')) return result()
      if (sql.includes('select') && sql.includes('where id = $1')) return result([newRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const mutation = await db.updateProjectWithWebsiteChange('1', {
      companyName: '新公司',
      websiteUrl: 'https://b.example',
      optimizationTarget: '新对象',
      supplementalInfo: '新补充',
      resetConfirmed: true,
      expectedUpdatedAt: '2026-09-06T05:00:01.234Z',
    })
    const sql = pgMock.state.queries.map((query) => query.sql)

    expect(mutation.websiteChanged).toBe(true)
    expect(mutation.resetPerformed).toBe(true)
    expect(mutation.project?.id).toBe(oldRow.id)
    expect(mutation.project?.updatedAt).toBe('2026-09-06T05:00:02.000Z')
    expect(mutation.project?.websiteUrl).toBe('https://b.example')
    expect(sql.findIndex((item) => item === 'BEGIN')).toBe(0)
    expect(sql.some((item) => item.includes('technical_audit = null'))).toBe(false)
    expect(sql.some((item) => item.includes('content_audit = null'))).toBe(false)
    expect(sql.some((item) => item.includes('delete from geo_article_batches'))).toBe(false)
    expect(sql.some((item) => item.includes('delete from geo_diagnosis_runs'))).toBe(false)
    expect(sql.some((item) => item.includes('delete from geo_project_questions'))).toBe(true)
    expect(sql.some((item) => item.includes('delete from geo_project_website_pages'))).toBe(false)
    expect(sql.findIndex((item) => item.includes('set company_name'))).toBeLessThan(sql.findIndex((item) => item.includes('delete from geo_project_questions')))
    expect(sql.at(-1)).toBe('COMMIT')
  })

  it('keeps all data and updated_at intact for an unchanged retry without confirmation', async () => {
    const oldRow = baseRow({ website_crawl_status: 'completed' })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const mutation = await db.updateProjectWithWebsiteChange('1', {
      companyName: oldRow.company_name,
      websiteUrl: oldRow.website_url,
      optimizationTarget: oldRow.optimization_target,
      supplementalInfo: oldRow.supplemental_info,
    })
    const sql = pgMock.state.queries.map((query) => query.sql)

    expect(mutation.websiteChanged).toBe(false)
    expect(mutation.resetPerformed).toBe(false)
    expect(mutation.project?.websiteUrl).toBe('https://a.example')
    expect(sql.some((item) => item.startsWith('update geo_projects'))).toBe(false)
    expect(sql.some((item) => item.startsWith('delete from'))).toBe(false)
  })

  it('updates a new project with no persisted questions without reset confirmation or deletion', async () => {
    const oldRow = baseRow({
      project_has_questions: false,
      website_url: null,
      optimization_target: null,
      supplemental_info: null,
    })
    const newRow = {
      ...oldRow,
      company_name: '新公司',
      optimization_target: '新对象',
      supplemental_info: '新补充',
      updated_at: '2026-09-06T05:00:02.000Z',
    }
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      if (sql.startsWith('update geo_projects') && sql.includes('set company_name')) return result([newRow])
      if (sql.includes('select') && sql.includes('where id = $1')) return result([newRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const mutation = await db.updateProjectWithWebsiteChange('1', {
      companyName: '新公司',
      optimizationTarget: '新对象',
      supplementalInfo: '新补充',
      expectedUpdatedAt: oldRow.updated_at,
    })
    const sql = pgMock.state.queries.map((query) => query.sql)

    expect(mutation.resetPerformed).toBe(false)
    expect(mutation.project?.companyName).toBe('新公司')
    expect(sql.some((item) => item.includes('delete from geo_project_questions'))).toBe(false)
  })

  it('allows an applicable website edit without reset confirmation when no questions exist', async () => {
    const oldRow = baseRow({
      project_has_questions: false,
      website_url: 'https://a.example',
      optimization_target: null,
      supplemental_info: null,
    })
    const newRow = {
      ...oldRow,
      website_url: 'https://b.example',
      updated_at: '2026-09-06T05:00:02.000Z',
    }
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      if (sql.startsWith('update geo_projects') && sql.includes('set company_name')) return result([newRow])
      if (sql.includes('select') && sql.includes('where id = $1')) return result([newRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const mutation = await db.updateProjectWithWebsiteChange('1', {
      websiteUrl: 'https://b.example',
      expectedUpdatedAt: oldRow.updated_at,
    })
    const sql = pgMock.state.queries.map((query) => query.sql)

    expect(mutation.websiteChanged).toBe(true)
    expect(mutation.resetPerformed).toBe(false)
    expect(mutation.project?.websiteUrl).toBe('https://b.example')
    expect(sql.some((item) => item.includes('delete from geo_project_questions'))).toBe(false)
  })
})

describe('initial report refresh failure marker', () => {
  it('persists only the non-AI refresh failure and leaves report bytes untouched', async () => {
    pgMock.state.responder = (sql) => {
      if (sql.startsWith('update geo_diagnosis_runs')) return result([{ id: 'run-1' }])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const saved = await db.markInitialDiagnosisReportRefreshFailed('1', '固定失败信息')

    expect(saved).toBe(true)
    const query = pgMock.state.queries[0]
    expect(query?.sql).toContain("report_refresh_status = 'failed'")
    expect(query?.sql).toContain('report_refresh_error = $2')
    expect(query?.sql).toContain("run_type = 'initial'")
    expect(query?.sql).not.toContain('report_pdf')
    expect(query?.values).toEqual(['1', '固定失败信息'])
  })

  it('reports an unpersisted marker when the current initial run is absent', async () => {
    pgMock.state.responder = (sql) => {
      if (sql.startsWith('update geo_diagnosis_runs')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.markInitialDiagnosisReportRefreshFailed('1', '固定失败信息')).resolves.toBe(false)
  })
})

describe('project reset confirmation and rollback guards', () => {
  it('rejects a changed profile before any update or delete without confirmation', async () => {
    const oldRow = baseRow({ project_has_questions: true })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.updateProjectWithWebsiteChange('1', {
      supplementalInfo: '未确认的新资料',
      expectedUpdatedAt: oldRow.updated_at,
    })).rejects.toThrow('project_reset_confirmation_required')
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql.some((item) => item.startsWith('update geo_projects'))).toBe(false)
    expect(sql.some((item) => item.startsWith('delete from'))).toBe(false)
  })

  it('rejects an old edit timestamp before any destructive statement', async () => {
    const oldRow = baseRow({ project_has_questions: true })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.updateProjectWithWebsiteChange('1', {
      supplementalInfo: '过期的新资料',
      resetConfirmed: true,
      expectedUpdatedAt: '2026-09-06T04:00:00.000Z',
    })).rejects.toThrow('project_changed')
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql.some((item) => item.startsWith('update geo_projects'))).toBe(false)
    expect(sql.some((item) => item.startsWith('delete from'))).toBe(false)
  })

  it('rolls back the profile update and deletes when a later reset step fails', async () => {
    const oldRow = baseRow({ project_has_questions: true })
    const newRow = baseRow({ company_name: '新公司', supplemental_info: '新补充' })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([oldRow])
      if (sql.startsWith('update geo_projects') && sql.includes('set company_name')) return result([newRow])
      if (sql.includes('delete from geo_project_questions')) throw new Error('reset_delete_failed')
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.updateProjectWithWebsiteChange('1', {
      supplementalInfo: '新补充',
      resetConfirmed: true,
      expectedUpdatedAt: oldRow.updated_at,
    })).rejects.toThrow('reset_delete_failed')
    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql).toContain('ROLLBACK')
    expect(sql).not.toContain('COMMIT')
  })
})

describe('question lock and deletion controls', () => {
  it('locks one categorized question with an explicit flag and project CAS timestamp', async () => {
    const oldRow = baseRow()
    const questions = categorizedQuestionRows()
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      if (sql.includes('where project_id = $1 and id = $2') && sql.includes('for update')) return result([questions[0]])
      if (sql.includes('from geo_project_questions') && sql.includes('order by position') && sql.includes('for update')) return result(questions)
      if (sql.includes('set is_locked = $3')) return result()
      if (sql.includes('set updated_at = greatest')) return result()
      return projectDetailResponse(sql, oldRow) ?? result()
    }

    const detail = await db.setQuestionLocked('1', 'question-1', true, String(oldRow.updated_at))
    const lockQuery = pgMock.state.queries.find((query) => query.sql.includes('set is_locked = $3'))

    expect(detail?.id).toBe('1')
    expect(lockQuery?.values).toEqual(['1', 'question-1', true])
    expect(pgMock.state.queries.some((query) => query.sql.includes('updated_at = greatest'))).toBe(true)
    expect(pgMock.state.queries.some((query) => query.sql === 'COMMIT')).toBe(true)
  })

  it('deletes a locked question without deleting another project question', async () => {
    const oldRow = baseRow()
    const questions = categorizedQuestionRows()
    questions[0].is_locked = true
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      if (sql.includes('where project_id = $1 and id = $2') && sql.includes('for update')) return result([questions[0]])
      if (sql.includes('from geo_project_questions') && sql.includes('order by position') && sql.includes('for update')) return result(questions)
      if (sql.startsWith('delete from geo_project_questions where project_id = $1 and id = $2')) return result([], 1)
      if (sql.includes('set updated_at = greatest')) return result()
      return projectDetailResponse(sql, oldRow) ?? result()
    }

    const detail = await db.deleteQuestion('1', 'question-1', String(oldRow.updated_at))
    const deleteQuery = pgMock.state.queries.find((query) => query.sql.startsWith('delete from geo_project_questions where project_id = $1 and id = $2'))

    expect(detail?.id).toBe('1')
    expect(deleteQuery?.values).toEqual(['1', 'question-1'])
    expect(pgMock.state.queries.some((query) => query.sql.includes('delete from geo_project_questions where project_id = $1 and id = $2'))).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['stale', '2026-09-06T04:00:00.000Z'],
  ])('rejects a %s expectedUpdatedAt before touching a question', async (_label, expectedUpdatedAt) => {
    const oldRow = baseRow()
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.setQuestionLocked('1', 'question-1', true, expectedUpdatedAt as string)).rejects.toThrow('project_changed')
    expect(pgMock.state.queries.some((query) => query.sql.includes('from geo_project_questions'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_project_questions'))).toBe(false)
  })

  it.each([
    ['global lock', { questions_locked_at: '2026-09-06T05:02:00.000Z' }, 'questions_locked'],
    ['generation', { questions_generation_status: 'generating' }, 'questions_generation_in_progress'],
  ])('rejects single-question mutation during %s', async (_label, overrides, reason) => {
    const oldRow = baseRow(overrides)
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.setQuestionLocked('1', 'question-1', true, String(oldRow.updated_at))).rejects.toThrow(reason)
    expect(pgMock.state.queries.some((query) => query.sql.includes('from geo_project_questions'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_project_questions'))).toBe(false)
  })

  it('returns null for a cross-project question without issuing a delete', async () => {
    const oldRow = baseRow()
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      if (sql.includes('where project_id = $1 and id = $2') && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.deleteQuestion('1', 'question-owned-by-2', String(oldRow.updated_at))).resolves.toBeNull()
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('delete from geo_project_questions'))).toBe(false)
  })

  it('directly confirms twenty categorized questions and marks every row locked', async () => {
    const oldRow = baseRow()
    const questions = categorizedQuestionRows()
    let confirmed = false
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      if (sql.includes('from geo_project_questions')) {
        return result(questions.map((question) => ({ ...question, is_locked: confirmed })))
      }
      if (sql.includes('set is_locked = true')) {
        confirmed = true
        return result()
      }
      if (sql.includes('set questions_locked_at = now()')) return result()
      if (sql.includes('from geo_projects p')) {
        return result([confirmed ? { ...oldRow, questions_locked_at: '2026-09-06T05:00:02.000Z' } : oldRow])
      }
      return result()
    }

    const detail = await db.confirmQuestions('1', String(oldRow.updated_at))
    const lockQuery = pgMock.state.queries.find((query) => query.sql.includes('set is_locked = true'))

    expect(detail?.questions).toHaveLength(20)
    expect(detail?.questions.every((question) => question.isLocked)).toBe(true)
    expect(detail?.questionsLockedAt).toBe('2026-09-06T05:00:02.000Z')
    expect(lockQuery?.values).toEqual(['1'])
    expect(pgMock.state.queries.some((query) => query.sql.includes('set questions_locked_at = now()'))).toBe(true)
  })

  it('does not start AI generation when all twenty questions are already locked', async () => {
    const oldRow = baseRow()
    const questions = categorizedQuestionRows({ is_locked: true })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([oldRow])
      if (sql.includes('from geo_project_questions')) return result(questions)
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.beginQuestionGeneration('1', String(oldRow.updated_at))).rejects.toThrow('all_questions_locked')
    expect(pgMock.state.queries.some((query) => query.sql.includes('set questions_generation_status = \'generating\''))).toBe(false)
  })
})

describe('late diagnosis write guards', () => {
  it('does not mark a new project analyzing when the old run is gone', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select id from geo_projects') && sql.includes('for update')) return result([{ id: '1' }])
      if (sql.includes('from geo_diagnosis_runs') && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.markDiagnosisRunAnalyzing('old-run', '1')).resolves.toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_projects'))).toBe(false)
  })

  it('does not write summary metrics when the old run is gone', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select id from geo_projects') && sql.includes('for update')) return result([{ id: '1' }])
      if (sql.includes('from geo_diagnosis_runs') && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.saveDiagnosisSummary('old-run', '1', [], {
      analysis: {}, model: 'model', recommendationRate: 0.5, officialCitationRate: null,
    })).resolves.toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_projects'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_diagnosis_answers'))).toBe(false)
  })

  it('does not write a late failure to project state when the old run is gone', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select id from geo_projects') && sql.includes('for update')) return result([{ id: '1' }])
      if (sql.includes('from geo_diagnosis_runs') && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.markDiagnosisRunFailed('old-run', '1', '迟到失败')).resolves.toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('update geo_projects'))).toBe(false)
  })
})

describe('technical audit diagnosis-start guard', () => {
  it('requires the captured diagnosis marker in the conditional snapshot write', async () => {
    const snapshot = {
      checked_at: '2026-09-06T05:01:00.000Z',
      website_url: 'https://a.example',
      scope: {},
      items: [],
    } as unknown as TechnicalAuditSnapshot
    pgMock.state.responder = (sql, values) => {
      if (!sql.startsWith('update geo_projects')) throw new Error(`unexpected SQL: ${sql}`)
      expect(values).toEqual([JSON.stringify(snapshot), '1', 'https://a.example', '2026-09-06T05:02:00.123Z'])
      return result([], 0)
    }

    await expect(db.saveTechnicalAuditSnapshot(
      '1',
      'https://a.example',
      snapshot,
      '2026-09-06T05:02:00.123Z',
    )).resolves.toBe(false)
  })
})

describe('diagnosis run timestamp mapping', () => {
  it('preserves milliseconds when node-postgres returns a Date for started_at', async () => {
    const startedAt = new Date('2026-09-09T16:56:22.477Z')
    pgMock.state.responder = (sql) => {
      if (sql.includes('from geo_diagnosis_runs')) return result([{
        id: 'initial-run-1', run_type: 'initial', status: 'completed', requested_model: 'model', round_number: 0,
        published_article_count: null, started_at: startedAt, completed_at: new Date('2026-09-09T16:57:22.477Z'),
        summary_analysis: null, summary_model: 'model', summary_error: null, recommendation_rate: 1, official_citation_rate: 1,
        report_refresh_status: 'ready', report_pdf_ready: true, report_pdf_generated_at: new Date('2026-09-09T16:58:22.477Z'),
      }])
      if (sql.includes('from geo_diagnosis_answers')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const diagnosis = await db.getInitialDiagnosis('1')
    expect(diagnosis.run?.startedAt).toBe('2026-09-09T16:56:22.477Z')
    expect(diagnosis.run?.completedAt).toBe('2026-09-09T16:57:22.477Z')
  })
})

describe('initial diagnosis start timestamp synchronization', () => {
  it('uses the original run start on a retry and clears stale project completion markers', async () => {
    const project = baseRow({
      questions_locked_at: '2026-09-09T16:55:00.000Z',
      diagnosis_started_at: '2026-09-09T16:55:30.000Z',
      initial_diagnosis_status: 'completed',
      initial_diagnosis_completed_at: '2026-09-09T16:56:00.000Z',
      initial_diagnosis_at: '2026-09-09T16:56:00.000Z',
    })
    const startedAt = new Date('2026-09-09T16:56:22.477Z')
    const failedRun = {
      id: 'initial-run-retry', run_type: 'initial', status: 'failed', requested_model: 'model', round_number: 0,
      published_article_count: null, started_at: startedAt, completed_at: null,
      summary_analysis: null, summary_model: 'model', summary_error: '旧失败', recommendation_rate: null, official_citation_rate: null,
    }
    const runningRun = { ...failedRun, status: 'running', summary_error: null }
    let projectUpdateSql = ''
    let projectUpdateValues: unknown[] | undefined
    pgMock.state.responder = (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_projects') && sql.includes('for update')) return result([project])
      if (sql.includes('from geo_project_questions')) return result(Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `问题${index + 1}` })))
      if (sql.startsWith('update geo_diagnosis_runs')) return result([runningRun])
      if (sql.startsWith('update geo_projects')) {
        projectUpdateSql = sql
        projectUpdateValues = values
        return result()
      }
      if (sql.includes("from geo_diagnosis_runs") && sql.includes("run_type = 'initial'") && sql.includes('for update')) return result([failedRun])
      if (sql.includes('insert into geo_diagnosis_answers')) return result()
      if (sql.includes('from geo_diagnosis_answers')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const preparation = await db.createOrResumeDiagnosis('1', 'initial')
    expect(preparation?.run.startedAt).toBe('2026-09-09T16:56:22.477Z')
    expect(projectUpdateSql).toContain('diagnosis_started_at = (')
    expect(projectUpdateSql).toContain('initial_diagnosis_completed_at = null')
    expect(projectUpdateSql).toContain('initial_diagnosis_at = null')
    expect(projectUpdateValues).toEqual(['1', 'initial-run-retry'])
  })
})

describe('article batch persistence quantities', () => {
  function articles(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      title: `文章${count}-${index + 1}`,
      questionPositions: [(index % 20) + 1],
      contentHtml: '<p>正文</p>',
    }))
  }

  function configureSuccessfulSave(count: number): void {
    const project = baseRow({ initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z', initial_diagnosis_status: 'completed' })
    const batchRows = Array.from({ length: count }, (_, index) => ({
      batch_id: 'batch-1',
      project_id: '1',
      requested_model: 'model',
      response_model: 'response-model',
      batch_generated_at: '2026-09-06T05:04:00.000Z',
      id: `article-${index + 1}`,
      article_batch_id: 'batch-1',
      article_project_id: '1',
      title: `文章${count}-${index + 1}`,
      question_position: (index % 20) + 1,
      question_positions: [(index % 20) + 1],
      content_html: '<p>正文</p>',
      generated_at: '2026-09-06T05:04:00.000Z',
      publish_status: 'pending',
      confirmed_at: null,
    }))
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([project])
      if (sql.includes('from geo_diagnosis_runs')) return result([{
        id: 'run-1', run_type: 'initial', status: 'completed', requested_model: 'model', round_number: 0,
        published_article_count: null, started_at: '2026-09-06T05:02:00.000Z', completed_at: '2026-09-06T05:03:00.000Z',
        summary_analysis: null, summary_model: 'model', summary_error: null, recommendation_rate: 1, official_citation_rate: 1,
        report_refresh_status: 'ready', report_pdf_ready: true, report_pdf_generated_at: '2026-09-06T05:03:01.000Z',
      }])
      if (sql.includes('from geo_diagnosis_answers')) return result(Array.from({ length: 20 }, (_, index) => ({
        position: index + 1, question: `问题${index + 1}`, status: 'success', answer_text: '回答', citation_urls: [],
        response_model: 'model', recommended: true, official_citation: true, error: null, started_at: null, completed_at: null,
      })))
      if (sql.includes('insert into geo_article_batches')) return result([{ id: 'batch-1', project_id: '1', requested_model: 'model', response_model: 'response-model', generated_at: '2026-09-06T05:04:00.000Z' }])
      if (sql.includes('insert into geo_project_articles')) return result()
      if (sql.startsWith('update geo_projects')) return result()
      if (sql.includes('from geo_article_batches b')) return result(batchRows)
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }

  it('saves one, five, and more than twenty articles without a count cap', async () => {
    for (const count of [1, 5, 21]) {
      resetMock()
      configureSuccessfulSave(count)
      const saved = await db.saveArticleBatch('1', 'model', 'response-model', articles(count), {
        websiteUrl: 'https://a.example',
        websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
      })
      expect(saved.articles).toHaveLength(count)
      expect(pgMock.state.queries.filter((query) => query.sql.includes('insert into geo_project_articles'))).toHaveLength(count)
    }
  })

  it('rejects an empty batch before opening a database transaction', async () => {
    resetMock()
    await expect(db.saveArticleBatch('1', 'model', null, [], {
      websiteUrl: 'https://a.example',
      websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    })).rejects.toThrow('articles_count_invalid')
    expect(pgMock.state.queries).toHaveLength(0)
  })

  it('rolls back a dynamic batch when any article insert fails', async () => {
    const project = baseRow({ initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z', initial_diagnosis_status: 'completed' })
    let articleInserts = 0
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('for update')) return result([project])
      if (sql.includes('from geo_diagnosis_runs')) return result([{
        id: 'run-1', run_type: 'initial', status: 'completed', requested_model: 'model', round_number: 0,
        published_article_count: null, started_at: '2026-09-06T05:02:00.000Z', completed_at: '2026-09-06T05:03:00.000Z',
        summary_analysis: null, summary_model: 'model', summary_error: null, recommendation_rate: 1, official_citation_rate: 1,
        report_refresh_status: 'ready', report_pdf_ready: true, report_pdf_generated_at: '2026-09-06T05:03:01.000Z',
      }])
      if (sql.includes('from geo_diagnosis_answers')) return result(Array.from({ length: 20 }, (_, index) => ({
        position: index + 1, question: `问题${index + 1}`, status: 'success', answer_text: '回答', citation_urls: [],
        response_model: 'model', recommended: true, official_citation: true, error: null, started_at: null, completed_at: null,
      })))
      if (sql.includes('insert into geo_article_batches')) return result([{ id: 'batch-1', project_id: '1', requested_model: 'model', response_model: null, generated_at: '2026-09-06T05:04:00.000Z' }])
      if (sql.includes('insert into geo_project_articles')) {
        articleInserts += 1
        if (articleInserts === 3) throw new Error('article_insert_failed')
        return result()
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.saveArticleBatch('1', 'model', null, articles(5), {
      websiteUrl: 'https://a.example',
      websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    })).rejects.toThrow('article_insert_failed')
    expect(articleInserts).toBe(3)
    expect(pgMock.state.queries.map((query) => query.sql)).toContain('ROLLBACK')
    expect(pgMock.state.queries.map((query) => query.sql)).not.toContain('COMMIT')
  })
})

describe('title-first article writing state transitions', () => {
  const articleRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'article-1',
    project_id: '1',
    batch_id: 'batch-1',
    title: '待写作标题',
    question_position: 1,
    question_positions: [1],
    content_html: null,
    generated_at: '2026-09-06T05:04:00.000Z',
    updated_at: '2026-09-06T05:04:00.000Z',
    writing_status: 'writing',
    writing_error: null,
    writing_attempt_token: 'current-token',
    writing_started_at: '2026-09-06T05:04:00.000Z',
    writing_lease_expires_at: '2999-09-06T05:10:00.000Z',
      optimization_type: '补充 FAQ', optimization_direction: '补充 FAQ',
    publish_status: 'pending',
    confirmed_at: null,
    website_url: 'https://a.example',
    website_crawl_started_at: '2026-09-06T05:00:00.000Z',
    website_crawl_status: 'completed',
    website_pages_succeeded: 1,
    initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z',
    ...overrides,
  })

  it('rejects an active claim and reclaims an expired lease', async () => {
    const active = articleRow()
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_project_articles a') && sql.includes('for update')) return result([active])
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.claimArticleWriting('article-1')).rejects.toThrow('article_writing_in_progress')

    resetMock()
    const expired = articleRow({ writing_lease_expires_at: '2000-01-01T00:00:00.000Z' })
    pgMock.state.responder = (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_project_articles a') && sql.includes('for update')) return result([expired])
      if (sql.includes('update geo_project_articles') && sql.includes("writing_status = 'writing'")) {
        return result([{ ...expired, writing_attempt_token: String(values?.[1]), writing_lease_expires_at: null }])
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const claim = await db.claimArticleWriting('article-1')
    expect(claim?.attemptToken).not.toBe('current-token')
    expect(claim?.article.writingStatus).toBe('writing')
    expect(pgMock.state.queries.some((query) => query.sql.includes('writing_lease_expires_at = null'))).toBe(true)
  })

  it('rejects stale completion and only fails the matching active attempt', async () => {
    const current = articleRow()
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes("where a.id = $1 and a.writing_status = 'writing'") && sql.includes('for update')) return result([current])
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.completeArticleWriting('article-1', 'stale-token', '<p>迟到</p>', {
      websiteUrl: 'https://a.example', websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    })).rejects.toThrow('article_write_stale')

    resetMock()
    pgMock.state.responder = (sql) => {
      if (sql.includes('update geo_project_articles') && sql.includes('writing_attempt_token = $2')) return result([], 0)
      throw new Error(`unexpected SQL: ${sql}`)
    }
    expect(await db.failArticleWriting('article-1', 'old-token', '迟到失败')).toBe(false)
    expect(pgMock.state.queries[0]?.values?.slice(0, 2)).toEqual(['article-1', 'old-token'])
    expect(pgMock.state.queries[0]?.sql).toContain("writing_status = 'writing'")
  })

  it('blocks publishing until the selected article is ready with a body', async () => {
    const pending = articleRow({ writing_status: 'pending', writing_attempt_token: null, writing_lease_expires_at: null })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('from geo_project_articles where id = $1 for update')) return result([pending])
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.confirmArticlePublished('article-1')).rejects.toThrow('article_not_ready')
    expect(pgMock.state.queries.some((query) => query.sql.includes("set publish_status = 'published'"))).toBe(false)
  })
})

describe('article plan persistence and deletion boundaries', () => {
  const completedAudit = {
    status: 'completed',
    startedAt: '2026-09-06T05:03:30.000Z',
    completedAt: '2026-09-06T05:03:31.000Z',
    progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 0, processedClaims: 0 },
    result: { checkedAt: '2026-09-06T05:03:31.000Z', scope: 'website_internal', items: [] },
    error: null,
    executionErrors: [],
    usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
  }

  it('deletes exactly one article and only cleans an empty batch', async () => {
    const project = baseRow({ initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z' })
    const detailArticleRows: Record<string, unknown>[] = []
    pgMock.state.responder = (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
      if (sql.includes('select id, project_id, batch_id') && sql.includes('for update')) {
        return result([{ id: 'article-1', project_id: '1', batch_id: 'batch-1' }])
      }
      if (sql.startsWith('delete from geo_project_articles')) return result([{ id: 'article-1' }])
      if (sql.includes('delete from geo_article_batches')) return result()
      if (sql.startsWith('update geo_projects set updated_at')) return result()
      const detail = projectDetailResponse(sql, project, detailArticleRows)
      if (detail) return detail
      throw new Error(`unexpected SQL: ${sql} ${JSON.stringify(values)}`)
    }

    const deleted = await db.deleteArticle('article-1')

    expect(deleted).not.toBeNull()
    expect(deleted?.deletedArticleId).toBe('article-1')
    expect(pgMock.state.queries.filter((query) => query.sql.startsWith('delete from geo_project_articles'))).toHaveLength(1)
    expect(pgMock.state.queries.find((query) => query.sql.startsWith('delete from geo_project_articles'))?.values).toEqual(['article-1'])
    const batchCleanup = pgMock.state.queries.find((query) => query.sql.includes('delete from geo_article_batches'))
    expect(batchCleanup?.sql).toContain('not exists')
    expect(batchCleanup?.values).toEqual(['batch-1'])
    expect(pgMock.state.queries.some((query) => query.sql.includes('website_locked_at'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.includes('geo_project_questions') && query.sql.startsWith('delete'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.includes('geo_diagnosis') && query.sql.startsWith('delete'))).toBe(false)
  })

  it('rolls back without deleting when the requested article does not exist', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('select id, project_id, batch_id') && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.deleteArticle('missing-article')).resolves.toBeNull()
    expect(pgMock.state.queries.map((query) => query.sql)).toEqual(['BEGIN', expect.stringContaining('select id, project_id, batch_id'), 'ROLLBACK'])
    expect(pgMock.state.queries.some((query) => query.sql.startsWith('delete from'))).toBe(false)
  })

  it('does not insert a late body after the article row was deleted', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes("where a.id = $1 and a.writing_status = 'writing'") && sql.includes('for update')) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.completeArticleWriting('article-1', 'late-token', '<p>迟到正文</p>', {
      websiteUrl: 'https://a.example', websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    })).rejects.toThrow('article_write_stale')
    expect(pgMock.state.queries.some((query) => query.sql.includes('insert into geo_project_articles'))).toBe(false)
  })

  it('rejects title saving when the current content-audit round changed before insert', async () => {
    const project = baseRow({
      initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z',
      content_audit: { ...completedAudit, startedAt: '2026-09-06T05:04:00.000Z' },
    })
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (sql.includes('select') && sql.includes('content_audit') && sql.includes('for update')) return result([project])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.saveArticleTitles('1', 'model', null, [{
      title: '新标题', questionPositions: [1], optimizationType: '新增文章', targetPageUrl: null,
    }], {
      websiteUrl: 'https://a.example', websiteCrawlStartedAt: '2026-09-06T05:00:00.000Z',
    }, 'run-1', undefined, '2026-09-06T05:03:30.000Z')).rejects.toThrow('content_audit_required')
    expect(pgMock.state.queries.some((query) => query.sql.includes('insert into geo_article_batches'))).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql.includes('insert into geo_project_articles'))).toBe(false)
  })

  it('reads empty question positions and persisted target metadata without inventing a diagnosis position', async () => {
    const project = baseRow({ initial_diagnosis_completed_at: '2026-09-06T05:03:00.000Z' })
    const articleRows = [{
      batch_id: 'batch-1', project_id: '1', requested_model: 'model', response_model: 'response-model',
      batch_generated_at: '2026-09-06T05:04:00.000Z', id: 'article-1', article_batch_id: 'batch-1', article_project_id: '1',
      title: '内容检查任务', question_position: null, question_positions: [], content_html: null,
      generated_at: '2026-09-06T05:04:00.000Z', updated_at: '2026-09-06T05:04:00.000Z', writing_status: 'pending', writing_error: null,
      optimization_type: '更新已有文章', optimization_direction: '补充 FAQ', target_page_url: 'https://a.example/services', target_page_title: '服务页',
      publish_status: 'pending', confirmed_at: null,
    }]
    pgMock.state.responder = (sql) => {
      const detail = projectDetailResponse(sql, project, articleRows)
      if (detail) return detail
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const loaded = await db.getProjectDetail('1')
    const article = loaded?.articleBatches[0]?.articles[0]
    expect(article?.questionPositions).toEqual([])
    expect(article?.targetPageUrl).toBe('https://a.example/services')
    expect(article?.targetPageTitle).toBe('服务页')
    expect(article?.optimizationDirection).toBe('补充 FAQ')
  })
})

describe('technical audit snapshot compatibility parser', () => {
  const scope = (): TechnicalAuditScope => ({
    pages: ['https://a.example/'],
    sampled_pages: ['https://a.example/'],
    skipped_pages: [],
    candidates: ['https://a.example/robots.txt'],
    requests: 2,
    request_limit: 40,
    page_limit: 10,
    response_limit_bytes: 2 * 1024 * 1024,
    time_limit_ms: 45_000,
    limits: [],
  })

  const item = (itemId: string, index: number, source = 'fixture'): TechnicalAuditItem => ({
    item_id: itemId,
    status: 'pass',
    message_code: 'pass',
    facts: { source, index },
    evidence: { source, index },
  })

  const snapshot = (ids: readonly string[], overrides: Partial<TechnicalAuditSnapshot> = {}): TechnicalAuditSnapshot => ({
    checked_at: '2026-09-06T08:00:00.000Z',
    website_url: 'https://a.example/',
    scope: scope(),
    items: ids.map((id, index) => item(id, index, overrides.rule_version === 2 ? 'current' : 'historical')),
    ...overrides,
  })

  it('accepts current and known legacy versions without changing the original value', () => {
    const current = snapshot(TECHNICAL_AUDIT_CURRENT_ITEM_IDS, { rule_version: TECHNICAL_AUDIT_RULE_VERSION })
    const parsed = db.technicalAuditSnapshotFromValue(current)
    expect(parsed).toBe(current)
    expect(parsed?.items).toEqual(current.items)
    expect(parsed?.rule_version).toBe(TECHNICAL_AUDIT_RULE_VERSION)

    for (const ruleVersion of [1, 2, 3]) {
      const legacyVersion = snapshot(TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS, { rule_version: ruleVersion })
      expect(db.technicalAuditSnapshotFromValue(legacyVersion)).toBe(legacyVersion)
    }
  })

  it('accepts complete and partial v5 snapshots only from the explicit historical 34-item set', () => {
    const historical = snapshot([...TECHNICAL_AUDIT_V5_ITEM_IDS], { rule_version: 5 })
    expect(historical.items).toHaveLength(34)
    expect(db.technicalAuditSnapshotFromValue(historical)).toBe(historical)

    const partial = snapshot([...TECHNICAL_AUDIT_V5_ITEM_IDS.slice(0, -1)], { rule_version: 5 })
    expect(partial.items).toHaveLength(33)
    expect(db.technicalAuditSnapshotFromValue(partial)).toBe(partial)

    const wrongVersion = snapshot([...TECHNICAL_AUDIT_V5_ITEM_IDS], { rule_version: 4 })
    expect(db.technicalAuditSnapshotFromValue(wrongVersion)).toBeNull()
  })

  it('accepts complete and partial v6 snapshots only from the explicit historical 31-item set', () => {
    const historical = snapshot([...TECHNICAL_AUDIT_V6_ITEM_IDS], { rule_version: 6 })
    expect(historical.items).toHaveLength(31)
    expect(db.technicalAuditSnapshotFromValue(historical)).toBe(historical)

    const partial = snapshot([...TECHNICAL_AUDIT_V6_ITEM_IDS.slice(0, -1)], { rule_version: 6 })
    expect(partial.items).toHaveLength(30)
    expect(db.technicalAuditSnapshotFromValue(partial)).toBe(partial)

    const historicalOptionalLlms = {
      ...historical,
      items: historical.items.map((entry) => entry.item_id === 'discovery.llms_txt' ? { ...entry, status: 'not_applicable' as const } : entry),
    }
    expect(db.technicalAuditSnapshotFromValue(historicalOptionalLlms)).toBe(historicalOptionalLlms)
  })

  it('keeps partial v4 and omitted-version 38-item snapshots readable', () => {
    const partialV4 = snapshot(TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS.slice(0, -1), { rule_version: 4 })
    expect(db.technicalAuditSnapshotFromValue(partialV4)).toBe(partialV4)

    const omittedVersion = snapshot(TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS.slice(0, -1))
    expect(db.technicalAuditSnapshotFromValue(omittedVersion)).toBe(omittedVersion)
  })

  it('accepts known 43/44-item historical snapshots for old versions, including a missing rule version', () => {
    const oldIds = [...TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS, ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS]
    const old = snapshot(oldIds)
    const parsedOld = db.technicalAuditSnapshotFromValue(old)
    expect(parsedOld).toBe(old)
    expect(parsedOld?.items.at(-1)?.item_id).toBe(TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS.at(-1))

    const oldWithExtra = snapshot([...oldIds, ...TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS])
    const parsedOldWithExtra = db.technicalAuditSnapshotFromValue(oldWithExtra)
    expect(parsedOldWithExtra).toBe(oldWithExtra)
    expect(parsedOldWithExtra?.items.at(-1)?.item_id).toBe('site.request_failure')

    for (const ruleVersion of [1, 2, 3]) {
      const oldVersion = snapshot(oldIds, { rule_version: ruleVersion })
      expect(db.technicalAuditSnapshotFromValue(oldVersion)).toBe(oldVersion)
      const oldVersionWithExtra = snapshot([...oldIds, ...TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS], { rule_version: ruleVersion })
      expect(db.technicalAuditSnapshotFromValue(oldVersionWithExtra)).toBe(oldVersionWithExtra)
    }
  })

  it('retains a current snapshot with missing item records for frontend incomplete-state display', () => {
    const partial = snapshot(TECHNICAL_AUDIT_CURRENT_ITEM_IDS.slice(0, -1), { rule_version: TECHNICAL_AUDIT_RULE_VERSION })
    expect(db.technicalAuditSnapshotFromValue(partial)).toBe(partial)
  })

  it('rejects duplicate, unknown, malformed, and unsupported-version snapshots', () => {
    const current = snapshot(TECHNICAL_AUDIT_CURRENT_ITEM_IDS, { rule_version: TECHNICAL_AUDIT_RULE_VERSION })

    const duplicate = { ...current, items: [...current.items.slice(0, -1), current.items[0]] }
    expect(db.technicalAuditSnapshotFromValue(duplicate)).toBeNull()

    const unknown = { ...current, items: [...current.items.slice(0, -1), item('site.unknown', 99)] }
    expect(db.technicalAuditSnapshotFromValue(unknown)).toBeNull()

    const extraItemField = { ...current, items: current.items.map((entry, index) => index === 0 ? { ...entry, unexpected: true } : entry) }
    expect(db.technicalAuditSnapshotFromValue(extraItemField)).toBeNull()

    const invalidItemField = { ...current, items: current.items.map((entry, index) => index === 0 ? { ...entry, facts: [] } : entry) }
    expect(db.technicalAuditSnapshotFromValue(invalidItemField)).toBeNull()

    expect(db.technicalAuditSnapshotFromValue({ ...current, rule_version: 99 })).toBeNull()
    const currentLlmsNotApplicable = {
      ...current,
      items: current.items.map((entry) => entry.item_id === 'discovery.llms_txt' ? { ...entry, status: 'not_applicable' as const } : entry),
    }
    expect(db.technicalAuditSnapshotFromValue(currentLlmsNotApplicable)).toBeNull()
    expect(db.technicalAuditSnapshotFromValue({ ...current, items: [...TECHNICAL_AUDIT_CURRENT_ITEM_IDS, 'site.timeout'].map((id, index) => item(id, index)), rule_version: 2 })).toBeNull()
    const oldIds = [...TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS, ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS]
    expect(db.technicalAuditSnapshotFromValue(snapshot(oldIds, { rule_version: TECHNICAL_AUDIT_RULE_VERSION }))).toBeNull()
    expect(db.technicalAuditSnapshotFromValue({ ...current, extra: true })).toBeNull()
    expect(db.technicalAuditSnapshotFromValue({ ...current, items: [] })).toBeNull()
  })

  it('does not accept an incomplete mixture of historical and current ids', () => {
    const mixed = snapshot([...TECHNICAL_AUDIT_CURRENT_ITEM_IDS, ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS.slice(0, -1)])
    expect(db.technicalAuditSnapshotFromValue(mixed)).toBeNull()
  })

  it('keeps the existing website-url guard when reading current or legacy snapshots', async () => {
    const old = snapshot([...TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS, ...TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS])
    pgMock.state.responder = (sql) => {
      if (sql.includes('select website_url, technical_audit')) return result([{ website_url: 'https://a.example/', technical_audit: old }])
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.getTechnicalAuditSnapshot('1')).resolves.toBe(old)

    resetMock()
    pgMock.state.responder = (sql) => {
      if (sql.includes('select website_url, technical_audit')) return result([{ website_url: 'https://other.example/', technical_audit: old }])
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.getTechnicalAuditSnapshot('1')).resolves.toBeNull()
  })
})

describe('content audit failure summaries', () => {
  it('maps known failure stages without presenting model calls as retries or legacy source wording', () => {
    expect(contentAuditFailureSummary([{ stage: 'extracting', message: '引用定位失败', attempts: 2 }])).toBe('官网内容检查在页面解析阶段失败：引用定位失败。')
    expect(contentAuditFailureSummary([{ stage: 'assessment', message: '站内表述无法对照', attempts: 1 }])).toBe('官网内容检查在站内对照阶段失败：站内表述无法对照。')
    for (const stage of ['progress', 'snapshot', 'persistence'] as const) {
      expect(contentAuditFailureSummary([{ stage, message: '结果保存失败' }])).toBe('官网内容检查在结果保存阶段失败：结果保存失败。')
    }
    for (const stage of ['config', 'input'] as const) {
      expect(contentAuditFailureSummary([{ stage, message: '检查准备失败' }])).toBe('官网内容检查在准备检查阶段失败：检查准备失败。')
    }
    expect(contentAuditFailureSummary([{ stage: 'completeness', message: '未知执行失败', attempts: 3 }])).toBe('官网内容检查在执行阶段失败：未知执行失败。')
    const summary = contentAuditFailureSummary([{ stage: 'extracting', message: 'Bearer error-secret apiKey=api-secret "api_key":"json-api-secret", \'token\': \'json-token-secret\' https://source.example/path?token=url-secret#fragment' }])
    expect(summary).toContain('官网内容检查在页面解析阶段失败：')
    expect(summary).not.toContain('error-secret')
    expect(summary).not.toContain('api-secret')
    expect(summary).not.toContain('json-api-secret')
    expect(summary).not.toContain('json-token-secret')
    expect(summary).not.toContain('url-secret')
    expect(summary).not.toContain('?token=')
    expect(summary).not.toContain('取证')
    expect(summary).not.toContain('内容事实核查')
  })

  it('uses a concise default for an empty or unusable error list', () => {
    expect(contentAuditFailureSummary([])).toBe('官网内容检查失败，请重试。')
    expect(contentAuditFailureSummary(null as unknown as readonly never[])).toBe('官网内容检查失败，请重试。')
    expect(contentAuditFailureSummary([{ stage: 'input', message: '长错误'.repeat(500) }])).toHaveLength(240 + '官网内容检查在准备检查阶段失败：'.length + 1)
  })
})

describe('content audit record validation and generation gate', () => {
  const legacyItem = {
    id: 'claim-1',
    statement: '服务覆盖制造业客户。',
    explanation: '服务范围',
    page: '服务页',
    conclusion: 'supported' as const,
    evidence: {
      statement: '服务覆盖制造业客户。',
      page: '服务页',
      pageUrl: 'https://example.test/services',
      checkedAt: '2026-09-07T00:00:00.000Z',
      pageExcerpt: { location: '第1段', context: '服务覆盖制造业客户。' },
      sources: [{ name: '来源', origin: 'https://source.test', sourceText: '服务覆盖制造业客户。', url: 'https://source.test/rule', relation: 'supports' as const, authorityReason: '原始页面' }],
      judgment: '直接支持',
      suggestion: '保留条件',
    },
    locations: [{ page: '服务页', pageUrl: 'https://example.test/services', statement: '服务覆盖制造业客户。', location: '第1段', context: '服务覆盖制造业客户。' }],
    subject: '示例公司',
    timeScope: '当前',
    conditions: '制造业客户',
  }

  const item = {
    id: 'claim-1',
    statement: '服务覆盖制造业客户。',
    explanation: '服务范围',
    page: '服务页',
    issues: [{ type: 'risk' as const, reason: '缺少适用条件。', suggestion: '补充适用条件并收窄表述。' }],
    evidence: {
      statement: '服务覆盖制造业客户。',
      page: '服务页',
      pageUrl: 'https://example.test/services',
      checkedAt: '2026-09-07T00:00:00.000Z',
      pageExcerpt: { location: '第1段', context: '服务覆盖制造业客户。' },
      judgment: '存在表述风险',
      suggestion: '补充适用条件并收窄表述。',
    },
    locations: [{ page: '服务页', pageUrl: 'https://example.test/services', statement: '服务覆盖制造业客户。', location: '第1段', context: '服务覆盖制造业客户。' }],
    subject: '示例公司',
    timeScope: '当前',
    conditions: '制造业客户',
  }

  const record = (overrides: Partial<ContentAuditRecord> = {}): ContentAuditRecord => ({
    status: 'completed',
    startedAt: '2026-09-07T00:00:00.000Z',
    completedAt: '2026-09-07T00:01:00.000Z',
    progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 1, processedClaims: 1 },
    result: { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal', items: [item], excludedPages: [] },
    error: null,
    executionErrors: [],
    usage: { modelCalls: 1, searchCalls: 0, sourceFetches: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, elapsedMs: 1 },
    ...overrides,
  })

  const partialUsage = {
    modelCalls: 2,
    searchCalls: 0,
    sourceFetches: 0,
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    elapsedMs: 42,
  }

  const partialSnapshot = (count: number) => ({
    result: {
      checkedAt: `2026-09-07T00:01:0${count}.000Z`,
      scope: 'website_internal' as const,
      items: Array.from({ length: count }, (_, index) => ({
        ...item,
        id: `claim-${index + 1}`,
        statement: `服务覆盖制造业客户${index + 1}。`,
        evidence: { ...item.evidence, statement: `服务覆盖制造业客户${index + 1}。` },
      })),
      excludedPages: [],
    },
    executionErrors: [],
    usage: { ...partialUsage, modelCalls: count },
  })

  it('rejects malformed evidence instead of exposing it to the UI', () => {
    const malformed = record({ result: { checkedAt: '2026-09-07T00:01:00.000Z', items: [{ ...item, evidence: null as never }] } })
    expect(db.contentAuditRecordFromValue(malformed)).toBeNull()
  })

  it('accepts internal issue rows, sanitizes issue/location fields, and keeps legacy external rows readable but ineligible', () => {
    const internalIssues = [
      { type: 'risk' as const, reason: 'Bearer risk-secret 当前承诺缺少适用条件。', suggestion: '请收窄为可由缓存官网直接表达的服务范围。' },
      { type: 'incomplete' as const, reason: '缺少必要的计费周期说明。', suggestion: '补充计费周期；无法表达时不要补造细节。' },
    ]
    const internal = {
      ...item,
      section: 'Bearer section-secret 服务方案',
      issues: internalIssues,
      evidence: {
        ...item.evidence,
        comparisons: [{
          page: '另一服务页',
          pageUrl: 'https://example.test/other?token=page-secret#context',
          statement: '另一处缓存页面的原句 Bearer comparison-secret。',
          location: '正文第2段',
          context: '另一处缓存页面的原句。',
        }],
      },
    }
    const parsed = db.contentAuditRecordFromValue(record({
      progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 2, processedClaims: 2 },
      result: { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal', items: [internal], excludedPages: [] },
    }))
    expect(parsed).not.toBeNull()
    expect(parsed?.result?.scope).toBe('website_internal')
    expect(parsed?.result?.items[0]).toMatchObject({ section: 'Bearer [REDACTED] 服务方案' })
    expect(parsed?.result?.items[0]?.issues).toEqual([
      { type: 'risk', reason: 'Bearer [REDACTED] 当前承诺缺少适用条件。', suggestion: '请收窄为可由缓存官网直接表达的服务范围。' },
      { type: 'incomplete', reason: '缺少必要的计费周期说明。', suggestion: '补充计费周期；无法表达时不要补造细节。' },
    ])
    expect(parsed?.result?.items[0]?.evidence.comparisons).toEqual([{
      page: '另一服务页',
      pageUrl: 'https://example.test/other',
      statement: '另一处缓存页面的原句 Bearer [REDACTED]',
      location: '正文第2段',
      context: '另一处缓存页面的原句。',
    }])
    expect(db.contentAuditResultEligible(parsed)).toBe(true)

    const legacy = db.contentAuditRecordFromValue(record({
      result: { checkedAt: '2026-09-07T00:01:00.000Z', items: [legacyItem], excludedPages: [] },
    }))
    expect(legacy).not.toBeNull()
    expect(legacy?.result?.scope).toBeUndefined()
    expect(legacy?.result?.items[0]?.conclusion).toBe('supported')
    expect(db.contentAuditResultEligible(legacy)).toBe(false)

    const cleanReviewed = record({
      progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 2, processedClaims: 2 },
      result: { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal', items: [], excludedPages: [] },
    })
    expect(db.contentAuditResultEligible(cleanReviewed)).toBe(true)
    expect(db.contentAuditResultEligible(record({
      progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 1, processedClaims: 1 },
      result: { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal', items: [item, item], excludedPages: [] },
    }))).toBe(false)

    const noIssue = { ...item, issues: [] }
    expect(db.contentAuditRecordFromValue(record({
      result: { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal', items: [noIssue], excludedPages: [] },
    }))).toBeNull()

    expect(db.contentAuditRecordFromValue(record({
      result: {
        checkedAt: '2026-09-07T00:01:00.000Z',
        scope: 'website_internal',
        items: [{ ...item, conclusion: 'supported' as const }],
        excludedPages: [],
      },
    }))).toBeNull()
    expect(db.contentAuditRecordFromValue(record({
      result: {
        checkedAt: '2026-09-07T00:01:00.000Z',
        scope: 'website_internal',
        items: [{ ...item, evidence: { ...item.evidence, sources: [] } }],
        excludedPages: [],
      },
    }))).toBeNull()
  })

  it('requires terminal success and complete counters before generation', () => {
    expect(db.contentAuditResultEligible(record())).toBe(true)
    expect(db.contentAuditResultEligible(record({ result: { checkedAt: '2026-09-07T00:01:00.000Z', items: [] } }))).toBe(false)
    expect(db.contentAuditResultEligible(record({ completedAt: null }))).toBe(false)
    expect(db.contentAuditResultEligible(record({ error: 'failed' }))).toBe(false)
    expect(db.contentAuditResultEligible(record({ progress: { stage: 'checking', totalPages: 1, processedPages: 0, totalClaims: 1, processedClaims: 1 } }))).toBe(false)
    expect(db.contentAuditResultEligible(record({ progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 2, processedClaims: 1 } }))).toBe(false)
    expect(db.contentAuditResultEligible(record({ status: 'checking', completedAt: null, progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 1, processedClaims: 1 } }))).toBe(false)
  })

  it('round-trips optional page coverage counters without accepting an imbalanced partition', () => {
    const progress = {
      stage: 'checking' as const,
      totalPages: 29,
      processedPages: 8,
      failedPages: 2,
      pendingPages: 19,
      baselineReady: true,
      baselineSource: 'sitemap' as const,
      totalClaims: 1,
      processedClaims: 0,
    }
    const parsed = db.contentAuditRecordFromValue(record({ progress }))
    expect(parsed?.progress).toMatchObject(progress)
    expect(db.contentAuditResultEligible(parsed)).toBe(false)
    expect(db.contentAuditRecordFromValue(record({ progress: { ...progress, pendingPages: 18 } }))).toBeNull()
  })

  it('atomically stores a validated partial snapshot without closing the checking run', async () => {
    pgMock.state.responder = (sql, values) => {
      if (sql.includes('content_audit || jsonb_build_object')) return result([], 1)
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const progress = { stage: 'checking' as const, totalPages: 2, processedPages: 1, totalClaims: 2, processedClaims: 1 }
    const snapshot = partialSnapshot(1)
    const saved = await db.saveContentAuditProgress('1', 'run-token', progress, snapshot)

    expect(saved).toBe(true)
    const query = pgMock.state.queries[0]
    expect(query.sql).toContain("content_audit->>'status' = 'checking'")
    expect(query.sql).toContain("content_audit->>'startedAt' = $2")
    expect(query.sql).toContain("'progress', $3::jsonb")
    expect(query.sql).toContain("'result', $4::jsonb")
    expect(query.sql).toContain("'executionErrors', $5::jsonb")
    expect(query.sql).toContain("'usage', $6::jsonb")
    expect(query.sql).not.toContain("'status',")
    expect(query.sql).not.toContain("'completedAt'")
    expect(JSON.parse(String(query.values?.[4]))).toEqual([])
    expect(JSON.parse(String(query.values?.[5]))).toEqual(snapshot.usage)
  })

  it('redacts partial execution errors and rejects stale run tokens', async () => {
    pgMock.state.responder = (sql) => {
      if (sql.includes('content_audit || jsonb_build_object')) return result([], 1)
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const progress = { stage: 'checking' as const, totalPages: 1, processedPages: 1, totalClaims: 1, processedClaims: 1 }
    const snapshot = {
      ...partialSnapshot(1),
      executionErrors: [{
        stage: 'source',
        message: 'Bearer secret-token apiKey=another-secret',
        pageUrl: 'https://example.test/page?token=secret#section',
        itemId: 'sha256:internal-fact-hash',
        statement: '原句\u0000：支持制造业客户。 Bearer statement-secret apiKey=statement-secret',
        sourceUrl: 'https://source.example/rule?token=source-secret#section',
        attempts: 2,
        resolution: 'Bearer resolution-secret：第二次仍失败，未采用该来源。',
      }],
    }
    await db.saveContentAuditProgress('1', 'run-token', progress, snapshot)
    const savedErrors = JSON.parse(String(pgMock.state.queries[0]?.values?.[4])) as Array<Record<string, unknown>>
    expect(savedErrors[0]?.message).not.toContain('secret-token')
    expect(savedErrors[0]?.message).not.toContain('another-secret')
    expect(savedErrors[0]?.pageUrl).toBe('https://example.test/page')
    expect(savedErrors[0]?.itemId).toBe('sha256:internal-fact-hash')
    expect(savedErrors[0]?.statement).toBe('原句 ：支持制造业客户。 Bearer [REDACTED] apiKey=[REDACTED]')
    expect(savedErrors[0]?.sourceUrl).toBe('https://source.example/rule')
    expect(savedErrors[0]?.attempts).toBe(2)
    expect(savedErrors[0]?.resolution).not.toContain('resolution-secret')

    resetMock()
    pgMock.state.responder = (sql) => {
      if (sql.includes('content_audit || jsonb_build_object')) return result([], 0)
      throw new Error(`unexpected SQL: ${sql}`)
    }
    await expect(db.saveContentAuditProgress('1', 'wrong-token', progress, partialSnapshot(1))).resolves.toBe(false)
    expect(pgMock.state.queries[0]?.sql).toContain("content_audit->>'startedAt' = $2")
  })

  it('sanitizes optional execution context when reading rich records and keeps legacy errors explicit', async () => {
    const longStatement = '有效原句'.repeat(900)
    const richStoredError = {
      stage: 'source_fetch',
      message: 'Bearer read-secret apiKey=read-api-secret',
      pageUrl: 'https://example.test/services?token=page-secret#section',
      itemId: 'sha256:internal-fact-hash',
      statement: '官网原句\u0000：支持制造业客户。 Bearer statement-secret apiKey=statement-secret',
      sourceUrl: 'https://source.example/rule?token=source-secret#section',
      attempts: 2,
      resolution: 'Bearer resolution-secret：第二次仍失败。',
      internalOnly: 'do not expose',
    } as unknown as ContentAuditRecord['executionErrors'][number]
    const longStoredError = {
      stage: 'source_fetch',
      message: '长原句记录',
      itemId: 'sha256:long-fact-hash',
      statement: longStatement,
      sourceUrl: 'https://source.example/long-rule',
      attempts: 1,
      resolution: '已停止',
    } as unknown as ContentAuditRecord['executionErrors'][number]
    const stored = record({
      status: 'failed',
      // A failed current run never carries a partial result.  Any previous
      // successful snapshot is kept in the separate history field.
      result: null,
      error: '内容事实核查未完成',
      executionErrors: [
        richStoredError,
        longStoredError,
        { stage: 'extracting', message: '旧记录未提供来源上下文' },
      ],
    })
    pgMock.state.responder = (sql) => {
      if (sql.includes('select content_audit from geo_projects')) return result([{ content_audit: stored }])
      throw new Error(`unexpected SQL: ${sql}`)
    }

    const loaded = await db.getContentAuditRecord('1')
    expect(loaded?.executionErrors[0]).toEqual({
      stage: 'source_fetch',
      message: 'Bearer [REDACTED] apiKey=[REDACTED]',
      pageUrl: 'https://example.test/services',
      itemId: 'sha256:internal-fact-hash',
      statement: '官网原句 ：支持制造业客户。 Bearer [REDACTED] apiKey=[REDACTED]',
      sourceUrl: 'https://source.example/rule',
      attempts: 2,
      resolution: 'Bearer [REDACTED]',
    })
    expect(loaded?.executionErrors[1]?.statement).toBe(longStatement)
    expect(loaded?.executionErrors[1]?.statement).toHaveLength(3_600)
    expect(loaded?.executionErrors[2]).toEqual({ stage: 'extracting', message: '旧记录未提供来源上下文' })
    expect(JSON.stringify(loaded)).not.toContain('internalOnly')
    expect(JSON.stringify(loaded)).not.toContain('read-secret')
    expect(JSON.stringify(loaded)).not.toContain('source-secret')
  })

  it('rejects malformed partial snapshots before any database update', async () => {
    const malformed = { ...partialSnapshot(1), result: { items: [{ ...item, evidence: null }] } } as unknown as ContentAuditProgressSnapshot
    await expect(db.saveContentAuditProgress('1', 'run-token', {
      stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 1, processedClaims: 1,
    }, malformed)).rejects.toThrow('content_audit_snapshot_invalid')
    expect(pgMock.state.queries).toHaveLength(0)
  })

  it('persists an incomplete runner result as failed, never as completed', async () => {
    let persisted: ContentAuditRecord | null = null
    pgMock.state.responder = (sql, values) => {
      if (sql.includes('update geo_projects') && sql.includes('content_audit = $3')) {
        persisted = JSON.parse(String(values?.[2])) as ContentAuditRecord
        return result([], 0)
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const current = record()
    await db.finishContentAudit('1', current.startedAt, current.result, [], current.usage, {
      stage: 'checking', totalPages: 1, processedPages: 0, totalClaims: 1, processedClaims: 1,
    })
    expect(persisted).not.toBeNull()
    const saved = persisted as unknown as ContentAuditRecord
    expect(saved.status).toBe('failed')
    expect(saved.executionErrors[0]?.stage).toBe('completeness')
    expect(saved.error).toBe(contentAuditFailureSummary(saved.executionErrors))
  })

  it('persists a completed clean review when all candidates were checked but no finding rows were produced', async () => {
    let persisted: ContentAuditRecord | null = null
    pgMock.state.responder = (sql, values) => {
      if (sql.includes('update geo_projects') && sql.includes('content_audit = $3')) {
        persisted = JSON.parse(String(values?.[2])) as ContentAuditRecord
        return result([], 1)
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const cleanResult = { checkedAt: '2026-09-07T00:01:00.000Z', scope: 'website_internal' as const, items: [], excludedPages: [] }
    const progress = { stage: 'checking' as const, totalPages: 1, processedPages: 1, totalClaims: 3, processedClaims: 3 }
    await expect(db.finishContentAudit('1', 'run-token', cleanResult, [], record().usage, progress)).resolves.toBe(true)

    expect(persisted).not.toBeNull()
    const saved = persisted as unknown as ContentAuditRecord
    expect(saved.status).toBe('completed')
    expect(saved.executionErrors).toEqual([])
    expect(db.contentAuditResultEligible(saved)).toBe(true)
  })

  it('clears partial rows and keeps real usage on failure, but never makes them eligible', async () => {
    let persisted: ContentAuditRecord | null = null
    pgMock.state.responder = (sql, values) => {
      if (sql.includes('update geo_projects') && sql.includes('content_audit = $3')) {
        persisted = JSON.parse(String(values?.[2])) as ContentAuditRecord
        return result([], 1)
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
    const snapshot = partialSnapshot(1)
    const progress = { stage: 'checking' as const, totalPages: 1, processedPages: 1, totalClaims: 2, processedClaims: 1 }
    await expect(db.failContentAudit('1', 'run-token', new Error('later task failed'), [], snapshot.usage, progress, snapshot.result)).resolves.toBe(true)

    expect(persisted).not.toBeNull()
    const saved = persisted as unknown as ContentAuditRecord
    expect(saved.status).toBe('failed')
    expect(saved.completedAt).not.toBeNull()
    expect(saved.result).toBeNull()
    expect(saved.usage).toEqual(snapshot.usage)
    expect(db.contentAuditResultEligible(saved)).toBe(false)
  })
})
