import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
}))

vi.mock('./ai-task-db.ts', () => ({
  getAiTask: vi.fn(),
  getRunningAiTask: vi.fn(),
  listAiTasks: vi.fn(),
  clearIncompleteAiTasksOnStartup: vi.fn(),
}))

vi.mock('./db.ts', () => ({
  checkDatabase: vi.fn(),
  closeDatabasePool: vi.fn(),
  confirmQuestions: vi.fn(),
  createProject: vi.fn(),
  deleteProject: mocks.deleteProject,
  getProject: vi.fn(),
  getProjectDetail: vi.fn(),
  getInitialDiagnosisReportPdf: vi.fn(),
  getMonitoringDeliveryReportPdf: vi.fn(),
  isUniqueViolation: vi.fn(),
  listProjects: vi.fn(),
  markInitialDiagnosisReportRefreshFailed: vi.fn(),
  confirmArticlePublished: vi.fn(),
  deleteQuestion: vi.fn(),
  deleteArticle: vi.fn(),
  getArticleProjectId: vi.fn(),
  saveInitialDiagnosisReportPdf: vi.fn(),
  saveMonitoringDeliveryReportPdf: vi.fn(),
  setQuestionLocked: vi.fn(),
  updateProjectWithWebsiteChange: vi.fn(),
  updateProjectWebsiteWithChange: vi.fn(),
}))

// v0.2.2 登录态守卫：测试用固定登录用户，会话 Cookie 由 issueSessionToken 签发
vi.mock('./auth-db.ts', () => ({
  createUser: vi.fn(),
  findUserByUsername: vi.fn(),
  findUserRowById: vi.fn(async () => ({
    id: '1',
    username: 'tester',
    displayName: 'Tester',
    role: 'user',
    isActive: true,
    createdAt: '',
    updatedAt: '',
    passwordHash: 'x',
    tokenVersion: 0,
  })),
  publicUserFromRow: vi.fn((row: Record<string, unknown>) => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.displayName),
    role: row.role,
    isActive: row.isActive,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  })),
}))

describe('project deletion API route', () => {
  let handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>

  let sessionCookie = ''

  beforeAll(async () => {
    process.env.GEODESK_SESSION_SECRET = 'test-secret'
    const { issueSessionToken } = await import('./auth.ts')
    sessionCookie = `geodesk_session=${await issueSessionToken({ userId: '1', tokenVersion: 0 })}`
    ;({ handleRequest } = await import('./index.ts'))
  })

  beforeEach(() => {
    mocks.deleteProject.mockReset()
  })

  function request(pathname: string): IncomingMessage {
    const request = Readable.from([]) as Readable & IncomingMessage
    Object.assign(request, {
      method: 'DELETE',
      url: pathname,
      headers: { host: '127.0.0.1:8787', cookie: sessionCookie },
    })
    return request
  }

  function response(): { value: ServerResponse; statusCode: number; body: string } {
    const state = { statusCode: 0, body: '' }
    const raw = {
      destroyed: false,
      headersSent: false,
      writeHead(statusCode: number): void {
        state.statusCode = statusCode
        raw.headersSent = true
      },
      end(body?: string | Uint8Array): void {
        state.body = body === undefined ? '' : Buffer.from(body).toString('utf8')
      },
    }
    const value = raw as unknown as ServerResponse
    return {
      value,
      get statusCode() { return state.statusCode },
      get body() { return state.body },
    }
  }

  it('returns success when the database deletes a project regardless of workflow history', async () => {
    mocks.deleteProject.mockResolvedValue(true)
    const output = response()

    await handleRequest(request('/api/projects/42'), output.value)

    expect(output.statusCode).toBe(200)
    expect(JSON.parse(output.body)).toEqual({ ok: true })
    expect(mocks.deleteProject).toHaveBeenCalledWith('42')
  })

  it('returns 404 when the database reports that the project does not exist', async () => {
    mocks.deleteProject.mockResolvedValue(false)
    const output = response()

    await handleRequest(request('/api/projects/404'), output.value)

    expect(output.statusCode).toBe(404)
    expect(JSON.parse(output.body)).toEqual({ ok: false, error: 'project_not_found', message: '项目不存在' })
  })

  it('maps any deletion transaction failure to the transient 503 response', async () => {
    mocks.deleteProject.mockRejectedValue(new Error('database_connection_failed'))
    const output = response()

    await handleRequest(request('/api/projects/42'), output.value)

    expect(output.statusCode).toBe(503)
    expect(JSON.parse(output.body)).toEqual({ ok: false, error: 'project_delete_failed', message: '项目删除失败，请稍后重试' })
  })

  it('does not expose the removed project-lock response mapping', async () => {
    mocks.deleteProject.mockRejectedValue(new Error('project_locked'))
    const output = response()

    await handleRequest(request('/api/projects/42'), output.value)

    expect(output.statusCode).toBe(503)
    expect(JSON.parse(output.body)).toMatchObject({ error: 'project_delete_failed' })
  })
})
