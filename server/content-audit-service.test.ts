import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentAuditRecord, ContentAuditResult, ContentAuditUsage } from '../src/content-audit.ts'
import type { ContentAuditClaim } from './db.ts'

const mocks = vi.hoisted(() => ({
  claimContentAudit: vi.fn(),
  contentAuditResultEligible: vi.fn(),
  failContentAudit: vi.fn(),
  finishContentAudit: vi.fn(),
  getContentAuditRecord: vi.fn(),
  saveContentAuditProgress: vi.fn(),
  runContentAudit: vi.fn(),
}))

vi.mock('./db.ts', () => ({
  claimContentAudit: mocks.claimContentAudit,
  contentAuditResultEligible: mocks.contentAuditResultEligible,
  failContentAudit: mocks.failContentAudit,
  finishContentAudit: mocks.finishContentAudit,
  getContentAuditRecord: mocks.getContentAuditRecord,
  saveContentAuditProgress: mocks.saveContentAuditProgress,
}))
vi.mock('./content-audit-core.ts', () => ({ runContentAudit: mocks.runContentAudit }))

const { ContentAuditServiceError, executeContentAudit, requireContentAudit, startContentAudit } = await import('./content-audit-service.ts')

const usage: ContentAuditUsage = {
  modelCalls: 2,
  searchCalls: 0,
  sourceFetches: 1,
  inputTokens: 10,
  outputTokens: 8,
  totalTokens: 18,
  elapsedMs: 20,
}

const result: ContentAuditResult = {
  checkedAt: '2026-09-07T00:01:00.000Z',
  scope: 'website_internal',
  items: [],
  coverage: { discoveredCount: 1, readCount: 1, failedCount: 0, toolCalls: 1, requestCount: 1, complete: true },
}

const progress = {
  stage: 'checking' as const,
  totalPages: 1,
  processedPages: 1,
  totalClaims: 0,
  processedClaims: 0,
}

const record: ContentAuditRecord = {
  status: 'checking',
  startedAt: '2026-09-07T00:00:00.000Z',
  completedAt: null,
  progress: { stage: 'checking', totalPages: 0, processedPages: 0, totalClaims: 0, processedClaims: 0 },
  result: null,
  error: null,
  executionErrors: [],
  usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
}

const claim = {
  project: { id: '1', websiteUrl: 'https://example.test/' },
  record,
  previous: null,
} as unknown as ContentAuditClaim

beforeEach(() => {
  vi.clearAllMocks()
  mocks.claimContentAudit.mockResolvedValue(claim)
  mocks.saveContentAuditProgress.mockResolvedValue(true)
  mocks.finishContentAudit.mockResolvedValue(true)
  mocks.failContentAudit.mockResolvedValue(true)
  mocks.getContentAuditRecord.mockResolvedValue(record)
})

describe('content audit background service', () => {
  it('claims once, passes only the website root to the direct runner, and persists a complete result', async () => {
    mocks.runContentAudit.mockImplementationOnce(async (input: unknown, options: { onProgress?: (value: typeof progress) => Promise<void> }) => {
      expect(input).toEqual({ websiteUrl: 'https://example.test/', previousResult: null })
      await options.onProgress?.(progress)
      return { result, executionErrors: [], usage }
    })

    const returned = await executeContentAudit('1', { apiKey: 'test-key', modelId: 'test-model', taskId: 'task-1' })

    expect(returned).toBe(record)
    expect(mocks.claimContentAudit).toHaveBeenCalledWith('1', 'task-1')
    expect(mocks.runContentAudit).toHaveBeenCalledTimes(1)
    expect(mocks.saveContentAuditProgress).toHaveBeenCalledWith('1', record.startedAt, progress)
    expect(mocks.finishContentAudit).toHaveBeenCalledWith('1', record.startedAt, result, [], usage, progress)
    expect(mocks.failContentAudit).not.toHaveBeenCalled()
  })

  it('does not expose an execution-error result as completed and does not pass partial rows to persistence', async () => {
    const errors = [{ stage: 'tool', message: '官网读取失败', pageUrl: 'https://example.test/page' }]
    mocks.runContentAudit.mockResolvedValue({ result, executionErrors: errors, usage })

    await expect(executeContentAudit('1', { apiKey: 'test-key', modelId: 'test-model' })).resolves.toBe(record)
    expect(mocks.failContentAudit).toHaveBeenCalledWith(
      '1', record.startedAt, '官网读取失败', errors, usage, record.progress, null,
    )
    expect(mocks.finishContentAudit).not.toHaveBeenCalled()
  })

  it('fails a thrown runner without persisting a partial result or restarting it', async () => {
    mocks.runContentAudit.mockRejectedValueOnce(new Error('runner_failed'))

    await expect(executeContentAudit('1', { apiKey: 'test-key', modelId: 'test-model' })).resolves.toBe(record)
    expect(mocks.runContentAudit).toHaveBeenCalledTimes(1)
    expect(mocks.failContentAudit).toHaveBeenCalledWith(
      '1', record.startedAt, expect.objectContaining({ message: 'runner_failed' }), [], record.usage, record.progress, null,
    )
    expect(mocks.finishContentAudit).not.toHaveBeenCalled()
  })

  it('returns the claimed checking record immediately for a background run', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<{ result: ContentAuditResult; executionErrors: []; usage: ContentAuditUsage }>((resolve) => { release = () => resolve({ result, executionErrors: [], usage }) })
    mocks.runContentAudit.mockReturnValueOnce(pending)

    await expect(startContentAudit('1', { apiKey: 'test-key', modelId: 'test-model', taskId: 'task-2' })).resolves.toBe(record)
    expect(mocks.claimContentAudit).toHaveBeenCalledWith('1', 'task-2')
    expect(mocks.finishContentAudit).not.toHaveBeenCalled()

    release?.()
    await vi.waitFor(() => expect(mocks.finishContentAudit).toHaveBeenCalled())
  })

  it('does not launch a runner when the database rejects a concurrent claim', async () => {
    mocks.claimContentAudit.mockRejectedValueOnce(new Error('content_audit_in_progress'))

    await expect(startContentAudit('1')).rejects.toThrow('content_audit_in_progress')
    expect(mocks.runContentAudit).not.toHaveBeenCalled()
  })

  it('forwards model timing to the injected hook while default logs contain only allowlisted fields', async () => {
    const injected = vi.fn()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      mocks.runContentAudit.mockImplementationOnce(async (_input: unknown, options: {
        onModelTiming?: (event: {
          event: 'request_start'
          correlationId: string
          elapsedMs: number
          timeoutMs: number
          phase: 'extracting'
          inputChars: number
          modelCall: number
        }) => void
      }) => {
        options.onModelTiming?.({
          event: 'request_start', correlationId: 'corr-secret', elapsedMs: 12, timeoutMs: 0,
          phase: 'extracting', inputChars: 321, modelCall: 1,
        })
        return { result, executionErrors: [], usage }
      })

      await executeContentAudit('1', { apiKey: 'test-key', modelId: 'test-model', onModelTiming: injected })
      expect(injected).toHaveBeenCalledWith(expect.objectContaining({ phase: 'extracting', inputChars: 321, modelCall: 1 }))
      const logText = info.mock.calls.flat().map((value) => String(value)).join('\n')
      expect(logText).toContain('[content-audit-timing] phase=extracting inputChars=321 modelCall=1 event=request_start')
      expect(logText).not.toContain('corr-secret')
      expect(logText).not.toContain('test-key')
    } finally {
      info.mockRestore()
    }
  })
})

describe('content audit generation gate', () => {
  it('rejects generation without a completed eligible result', async () => {
    mocks.getContentAuditRecord.mockResolvedValue(null)
    mocks.contentAuditResultEligible.mockReturnValue(false)
    await expect(requireContentAudit('1')).rejects.toMatchObject({ constructor: ContentAuditServiceError, message: 'content_audit_required' })
  })

  it('returns the persisted result when the database marks it eligible', async () => {
    mocks.contentAuditResultEligible.mockReturnValue(true)
    mocks.getContentAuditRecord.mockResolvedValue({ ...record, status: 'completed', result })

    await expect(requireContentAudit('1')).resolves.toBe(result)
  })
})
