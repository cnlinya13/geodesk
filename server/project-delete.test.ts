import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryResponder = (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>

const pgMock = vi.hoisted(() => {
  const state: {
    responder: QueryResponder | null
    queries: Array<{ sql: string; values?: unknown[] }>
    releases: number
  } = { responder: null, queries: [], releases: 0 }

  class FakePool {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
      state.queries.push({ sql, values })
      return (await state.responder?.(sql, values)) ?? { rows: [], rowCount: 0 }
    }

    async connect(): Promise<{ query: (sql: string, values?: unknown[]) => Promise<QueryResult>; release: () => void }> {
      return {
        query: this.query.bind(this),
        release: () => { state.releases += 1 },
      }
    }

    async end(): Promise<void> {
      return undefined
    }
  }

  return { state, Pool: FakePool, abortAiTaskControllersById: vi.fn() }
})

vi.mock('pg', () => ({ Pool: pgMock.Pool }))
vi.mock('./ai-task-runtime.ts', () => ({ abortAiTaskControllersById: pgMock.abortAiTaskControllersById }))

const db = await import('./db.ts')

function result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount }
}

function resetMock(): void {
  pgMock.state.responder = null
  pgMock.state.queries.length = 0
  pgMock.state.releases = 0
  pgMock.abortAiTaskControllersById.mockReset()
}

function projectQuery(sql: string): boolean {
  return sql.includes('from geo_projects') && sql.includes('for update')
}

function taskQuery(sql: string): boolean {
  return sql === 'select id from geo_ai_tasks where project_id = $1 for update'
}

afterEach(async () => {
  resetMock()
  await db.closeDatabasePool()
})

describe('project deletion transaction', () => {
  beforeEach(() => {
    resetMock()
  })

  for (const fixture of [
    { label: 'an unconfirmed project', questions_locked_at: null, has_published_article: false },
    { label: 'a confirmed project', questions_locked_at: '2026-09-09T00:00:00.000Z', has_published_article: false },
    { label: 'a project with a published article', questions_locked_at: null, has_published_article: true },
    { label: 'a confirmed project with a published article', questions_locked_at: '2026-09-09T00:00:00.000Z', has_published_article: true },
  ]) {
    it(`deletes ${fixture.label} and keeps cascade/abort ordering`, async () => {
      const taskRows = [{ id: 'task-1' }, { id: 'task-2' }]
      pgMock.state.responder = (sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result()
        if (projectQuery(sql)) return result([{ id: 'project-1', ...fixture }])
        if (taskQuery(sql)) return result(taskRows)
        if (sql === 'delete from geo_projects where id = $1') return result([], 1)
        throw new Error(`unexpected SQL: ${sql}`)
      }

      await expect(db.deleteProject('project-1')).resolves.toBe(true)

      const sql = pgMock.state.queries.map((query) => query.sql)
      expect(sql[0]).toBe('BEGIN')
      expect(sql[1]).toContain('select id')
      expect(sql[1]).toContain('from geo_projects')
      expect(sql[1]).toContain('for update')
      expect(sql[1]).not.toContain('questions_locked_at')
      expect(sql[1]).not.toContain('publish_status')
      expect(sql).toContain('select id from geo_ai_tasks where project_id = $1 for update')
      expect(sql).toContain('delete from geo_projects where id = $1')
      expect(sql.at(-1)).toBe('COMMIT')
      expect(sql.filter((item) => item.startsWith('delete from '))).toEqual(['delete from geo_projects where id = $1'])
      expect(pgMock.abortAiTaskControllersById).toHaveBeenCalledOnce()
      expect(pgMock.abortAiTaskControllersById).toHaveBeenCalledWith('project-1', ['task-1', 'task-2'])
      expect(pgMock.state.releases).toBe(1)
    })
  }

  it('returns false and rolls back without deleting or aborting when the project is absent', async () => {
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (projectQuery(sql)) return result()
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.deleteProject('missing-project')).resolves.toBe(false)

    expect(pgMock.state.queries.map((query) => query.sql)).toEqual([
      'BEGIN',
      expect.stringContaining('select id'),
      'ROLLBACK',
    ])
    expect(pgMock.state.queries.some((query) => query.sql === 'COMMIT')).toBe(false)
    expect(pgMock.state.queries.some((query) => query.sql === 'delete from geo_projects where id = $1')).toBe(false)
    expect(pgMock.abortAiTaskControllersById).not.toHaveBeenCalled()
    expect(pgMock.state.releases).toBe(1)
  })

  it('rolls back and does not abort task controllers when the transaction fails', async () => {
    const failure = new Error('delete_failed')
    pgMock.state.responder = (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result()
      if (projectQuery(sql)) return result([{ id: 'project-1', questions_locked_at: 'locked', has_published_article: true }])
      if (taskQuery(sql)) return result([{ id: 'task-1' }])
      if (sql === 'delete from geo_projects where id = $1') throw failure
      throw new Error(`unexpected SQL: ${sql}`)
    }

    await expect(db.deleteProject('project-1')).rejects.toThrow('delete_failed')

    const sql = pgMock.state.queries.map((query) => query.sql)
    expect(sql).toContain('ROLLBACK')
    expect(sql).not.toContain('COMMIT')
    expect(pgMock.abortAiTaskControllersById).not.toHaveBeenCalled()
    expect(pgMock.state.releases).toBe(1)
  })
})

describe('project deletion wiring', () => {
  it('does not retain confirmation or published-content lock checks in the database layer', async () => {
    const source = await readFile(new URL('./db.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export async function deleteProject')
    const end = source.indexOf('export type ProjectMutation', start)
    const deletion = source.slice(start, end)

    expect(deletion).not.toContain('project_locked')
    expect(deletion).not.toContain("publish_status = 'published'")
    expect(deletion).toContain("'select id from geo_ai_tasks where project_id = $1 for update'")
    expect(deletion).toContain("'delete from geo_projects where id = $1'")
    expect(deletion).toContain('abortAiTaskControllersById(id, taskIds)')
  })

  it('keeps expected delete endpoint success, not-found, and transient failure handling', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    expect(source).toContain("request.method === 'DELETE' && projectId")
    expect(source).toContain("sendJson(response, 200, { ok: true })")
    expect(source).toContain("sendError(response, 404, 'project_not_found', '项目不存在')")
    expect(source).toContain("sendError(response, 503, 'project_delete_failed', '项目删除失败，请稍后重试')")
    expect(source).not.toContain("sendError(response, 409, 'project_locked'")
  })
})
