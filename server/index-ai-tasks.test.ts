import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishAiTaskEvent } from './ai-task-events.ts'

const mocks = vi.hoisted(() => ({
  getAiTask: vi.fn(),
  getRunningAiTask: vi.fn(),
  getProjectDetail: vi.fn(),
}))

vi.mock('./ai-task-db.ts', () => ({
  getAiTask: mocks.getAiTask,
  getRunningAiTask: mocks.getRunningAiTask,
  listAiTasks: vi.fn(),
  clearIncompleteAiTasksOnStartup: vi.fn(),
}))

vi.mock('./db.ts', () => ({
  checkDatabase: vi.fn(),
  closeDatabasePool: vi.fn(),
  confirmQuestions: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  getProjectDetail: mocks.getProjectDetail,
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

describe('AI task duplicate acceptance', () => {
  let handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>

  beforeAll(async () => {
    ({ handleRequest } = await import('./index.ts'))
  })

  beforeEach(() => {
    mocks.getAiTask.mockReset()
    mocks.getRunningAiTask.mockReset()
    mocks.getProjectDetail.mockReset()
  })

  function request(pathname: string): IncomingMessage {
    const request = Readable.from([]) as Readable & IncomingMessage
    Object.assign(request, {
      method: 'POST',
      url: pathname,
      headers: { host: '127.0.0.1:8787' },
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

  function streamingResponse(): EventEmitter & ServerResponse & { body: string; writableEnded: boolean } {
    const output = new EventEmitter() as EventEmitter & ServerResponse & { body: string; writableEnded: boolean }
    Object.assign(output as unknown as Record<string, unknown>, {
      destroyed: false,
      headersSent: false,
      body: '',
      writableEnded: false,
      writeHead: (statusCode: number) => {
        output.statusCode = statusCode
        Object.assign(output as unknown as Record<string, unknown>, { headersSent: true })
        return output
      },
      write: (chunk: string | Uint8Array) => {
        output.body += Buffer.from(chunk).toString('utf8')
        return true
      },
      end: (body?: string | Uint8Array) => {
        if (body !== undefined) output.body += Buffer.from(body).toString('utf8')
        output.writableEnded = true
        return output
      },
    })
    return output
  }

  it('returns the existing diagnosis report task before run preflight', async () => {
    const task = {
      id: 'report-task-1',
      projectId: '1',
      kind: 'diagnosis_report',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-09T00:00:00.000Z',
      completedAt: null,
      result: null,
    }
    mocks.getRunningAiTask.mockResolvedValue(task)
    const output = response()

    await handleRequest(request('/api/projects/1/diagnosis/generate-report'), output.value)

    expect(output.value).toMatchObject({ headersSent: true })
    expect(output.statusCode).toBe(202)
    expect(JSON.parse(output.body)).toEqual({ ok: true, task })
    expect(mocks.getProjectDetail).not.toHaveBeenCalled()
  })

  it('returns the existing question task before checking a stale form timestamp', async () => {
    const task = {
      id: 'question-task-1',
      projectId: '1',
      kind: 'questions',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-09T00:00:00.000Z',
      completedAt: null,
      result: null,
    }
    mocks.getRunningAiTask.mockResolvedValue(task)
    const output = response()
    const bodyRequest = Readable.from([JSON.stringify({ expectedUpdatedAt: 'stale' })]) as Readable & IncomingMessage
    Object.assign(bodyRequest, {
      method: 'POST',
      url: '/api/projects/1/questions/generate',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
    })

    await handleRequest(bodyRequest, output.value)

    expect(output.statusCode).toBe(202)
    expect(JSON.parse(output.body)).toEqual({ ok: true, task })
  })

  it('keeps a questions stream alive after the request body closes', async () => {
    const task = {
      id: 'question-task-stream-1',
      projectId: '1',
      kind: 'questions',
      targetId: null,
      status: 'running',
      error: null,
      startedAt: '2026-09-09T00:00:00.000Z',
      completedAt: null,
      result: null,
    }
    mocks.getAiTask.mockResolvedValue(task)
    mocks.getProjectDetail.mockResolvedValue({ id: '1' })
    const requestValue = request('/api/projects/1/ai-tasks/question-task-stream-1')
    requestValue.headers = { host: '127.0.0.1:8787', accept: 'application/x-ndjson' }
    requestValue.method = 'GET'
    const output = streamingResponse()

    await handleRequest(requestValue, output)
    await publishAiTaskEvent({
      taskId: task.id,
      type: 'progress',
      progress: {
        completedCount: 1,
        total: 1,
        questions: [{ question: '如何选择实施方式？', category: 'selection' }],
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(output.body).toContain('如何选择实施方式？')
    expect(output.writableEnded).toBe(false)
    output.emit('close')
  })

  it('terminates a completed questions stream when its saved project cannot be read', async () => {
    const task = {
      id: 'question-task-stream-2',
      projectId: '1',
      kind: 'questions',
      targetId: null,
      status: 'completed',
      error: null,
      startedAt: '2026-09-09T00:00:00.000Z',
      completedAt: '2026-09-09T00:00:01.000Z',
      result: {},
    }
    mocks.getAiTask.mockResolvedValue(task)
    mocks.getProjectDetail.mockResolvedValueOnce({ id: '1' }).mockRejectedValueOnce(new Error('database unavailable'))
    const requestValue = request('/api/projects/1/ai-tasks/question-task-stream-2')
    requestValue.headers = { host: '127.0.0.1:8787', accept: 'application/x-ndjson' }
    requestValue.method = 'GET'
    const output = streamingResponse()

    await handleRequest(requestValue, output)

    expect(output.writableEnded).toBe(true)
    expect(output.body).toContain('问题生成结果暂时无法读取')
  })
})
