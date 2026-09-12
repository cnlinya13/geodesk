import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TECHNICAL_AUDIT_ITEM_COUNT } from '../src/technical-audit.ts'

const mocks = vi.hoisted(() => ({
  clearTechnicalAuditSnapshot: vi.fn(),
  getInitialDiagnosis: vi.fn(),
  getProject: vi.fn(),
  getTechnicalAuditSnapshot: vi.fn(),
  saveTechnicalAuditSnapshot: vi.fn(),
  withTechnicalAuditLock: vi.fn(),
  runTechnicalAudit: vi.fn(),
}))

vi.mock('./db.ts', () => ({
  clearTechnicalAuditSnapshot: mocks.clearTechnicalAuditSnapshot,
  getInitialDiagnosis: mocks.getInitialDiagnosis,
  getProject: mocks.getProject,
  getTechnicalAuditSnapshot: mocks.getTechnicalAuditSnapshot,
  saveTechnicalAuditSnapshot: mocks.saveTechnicalAuditSnapshot,
  withTechnicalAuditLock: mocks.withTechnicalAuditLock,
}))
vi.mock('./technical-audit.ts', () => ({ runTechnicalAudit: mocks.runTechnicalAudit }))

const { executeTechnicalAudit, readTechnicalAudit, TechnicalAuditServiceError } = await import('./technical-audit-service.ts')

const project = {
  id: '7',
  websiteUrl: 'https://audit.example/',
  initialDiagnosisStatus: 'completed',
}
const initialDiagnosis = {
  run: { id: 'initial-run-7', status: 'completed' },
  answers: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, status: 'success' })),
  reportPdfReady: true,
}
const snapshot = { checked_at: '2026-09-06T10:01:00.000Z', website_url: project.websiteUrl, scope: {}, items: [] }
const auditItem = (item_id: string) => ({ item_id, status: 'pass', message_code: 'pass', facts: {}, evidence: {} })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.withTechnicalAuditLock.mockImplementation(async (_id: string, operation: (client: object) => Promise<unknown>) => operation({}))
  mocks.getProject.mockResolvedValue(project)
  mocks.getInitialDiagnosis.mockResolvedValue(initialDiagnosis)
  mocks.clearTechnicalAuditSnapshot.mockResolvedValue(true)
  mocks.saveTechnicalAuditSnapshot.mockResolvedValue(true)
  mocks.runTechnicalAudit.mockResolvedValue(snapshot)
})

describe('technical audit service boundaries', () => {
  it('returns null before network work when the project does not exist', async () => {
    mocks.getProject.mockResolvedValue(null)
    await expect(executeTechnicalAudit('999')).resolves.toBeNull()
    expect(mocks.clearTechnicalAuditSnapshot).not.toHaveBeenCalled()
    expect(mocks.runTechnicalAudit).not.toHaveBeenCalled()
  })

  it('enforces the completed diagnosis prerequisite', async () => {
    mocks.getProject.mockResolvedValue({ ...project, initialDiagnosisStatus: 'running' })
    await expect(executeTechnicalAudit('7')).rejects.toMatchObject({ message: 'diagnosis_incomplete' })
    expect(mocks.clearTechnicalAuditSnapshot).not.toHaveBeenCalled()
  })

  it('clears the old snapshot before the root-only run and uses the lock client for conditional writes', async () => {
    const client = { query: vi.fn() }
    mocks.withTechnicalAuditLock.mockImplementation(async (_id: string, operation: (received: object) => Promise<unknown>) => operation(client))
    await expect(executeTechnicalAudit('7')).resolves.toEqual(snapshot)
    expect(mocks.getProject).toHaveBeenCalledWith('7', client)
    expect(mocks.clearTechnicalAuditSnapshot).toHaveBeenCalledWith('7', project.websiteUrl, initialDiagnosis.run.id, client)
    expect(mocks.runTechnicalAudit).toHaveBeenCalledWith(
      { websiteUrl: project.websiteUrl },
      expect.objectContaining({ onItemPersist: expect.any(Function) }),
    )
    expect(mocks.clearTechnicalAuditSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mocks.runTechnicalAudit.mock.invocationCallOrder[0])
    expect(mocks.saveTechnicalAuditSnapshot).toHaveBeenCalledWith('7', project.websiteUrl, snapshot, initialDiagnosis.run.id, client)
  })

  it('persists each finalized item before forwarding the observer and saves the final snapshot last', async () => {
    const client = { query: vi.fn() }
    const first = auditItem('site.dns')
    const second = auditItem('site.https')
    const events: string[] = []
    const onItem = vi.fn(async (item: { item_id: string }) => { events.push(`observer:${item.item_id}`) })
    mocks.withTechnicalAuditLock.mockImplementation(async (_id: string, operation: (received: object) => Promise<unknown>) => operation(client))
    mocks.clearTechnicalAuditSnapshot.mockImplementation(async () => { events.push('clear'); return true })
    mocks.saveTechnicalAuditSnapshot.mockImplementation(async (_id: string, _url: string, saved: { items: unknown[] }) => {
      events.push(`save:${saved.items.length}`)
      expect(saved).not.toHaveProperty('execution_errors')
      return true
    })
    mocks.runTechnicalAudit.mockImplementationOnce(async (input: unknown, options: { onItem?: (item: typeof first, count: number, total: number) => Promise<void> | void; onItemPersist?: (item: typeof first, count: number, total: number) => Promise<void> | void }) => {
      expect(input).toEqual({ websiteUrl: project.websiteUrl })
      expect(options.onItem).toBe(onItem)
      await options.onItemPersist?.(first, 1, TECHNICAL_AUDIT_ITEM_COUNT)
      await options.onItem?.(first, 1, TECHNICAL_AUDIT_ITEM_COUNT)
      await options.onItemPersist?.(second, 2, TECHNICAL_AUDIT_ITEM_COUNT)
      await options.onItem?.(second, 2, TECHNICAL_AUDIT_ITEM_COUNT)
      return snapshot
    })

    await expect(executeTechnicalAudit('7', { onItem })).resolves.toEqual(snapshot)
    expect(events).toEqual(['clear', 'save:1', 'observer:site.dns', 'save:2', 'observer:site.https', 'save:0'])
    expect(mocks.saveTechnicalAuditSnapshot).toHaveBeenCalledTimes(3)
    expect(mocks.saveTechnicalAuditSnapshot.mock.calls[0]?.[2].items).toEqual([first])
    expect(mocks.saveTechnicalAuditSnapshot.mock.calls[1]?.[2].items).toEqual([first, second])
    expect(mocks.saveTechnicalAuditSnapshot.mock.calls[2]?.[2]).toEqual(snapshot)
  })

  it('maps a conditional URL mismatch to a retryable website_changed error', async () => {
    mocks.saveTechnicalAuditSnapshot.mockResolvedValue(false)
    await expect(executeTechnicalAudit('7')).rejects.toBeInstanceOf(TechnicalAuditServiceError)
    expect(mocks.clearTechnicalAuditSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.saveTechnicalAuditSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.runTechnicalAudit).toHaveBeenCalledTimes(1)
  })

  it('propagates a per-item persistence failure and does not announce that item', async () => {
    const first = auditItem('site.dns')
    const onItem = vi.fn()
    mocks.clearTechnicalAuditSnapshot.mockResolvedValue(true)
    mocks.saveTechnicalAuditSnapshot.mockResolvedValue(false)
    mocks.runTechnicalAudit.mockImplementation(async (_input: unknown, options: { onItemPersist?: (item: typeof first, count: number, total: number) => Promise<void> | void }) => {
      await options.onItemPersist?.(first, 1, TECHNICAL_AUDIT_ITEM_COUNT)
      throw new Error('runner_continued_after_persist_failure')
    })
    await expect(executeTechnicalAudit('7', { onItem })).rejects.toMatchObject({ message: 'website_changed' })
    expect(onItem).not.toHaveBeenCalled()
    expect(mocks.saveTechnicalAuditSnapshot).toHaveBeenCalledTimes(1)
  })

  it('keeps completed item snapshots when the runner is interrupted', async () => {
    const first = auditItem('site.dns')
    const second = auditItem('site.https')
    mocks.runTechnicalAudit.mockImplementation(async (_input: unknown, options: { onItemPersist?: (item: typeof first, count: number, total: number) => Promise<void> | void; onItem?: (item: typeof first, count: number, total: number) => Promise<void> | void }) => {
      await options.onItemPersist?.(first, 1, TECHNICAL_AUDIT_ITEM_COUNT)
      await options.onItem?.(first, 1, TECHNICAL_AUDIT_ITEM_COUNT)
      void second
      throw new Error('runner_interrupted')
    })
    await expect(executeTechnicalAudit('7')).rejects.toMatchObject({ message: 'runner_interrupted' })
    expect(mocks.clearTechnicalAuditSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.saveTechnicalAuditSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.saveTechnicalAuditSnapshot.mock.calls[0]?.[2].items).toEqual([first])
    expect(mocks.saveTechnicalAuditSnapshot.mock.calls[0]?.[2].items).not.toContain(second)
  })

  it('reads the dedicated snapshot endpoint without changing project detail shape', async () => {
    mocks.getTechnicalAuditSnapshot.mockResolvedValue(snapshot)
    await expect(readTechnicalAudit('7')).resolves.toEqual(snapshot)
    expect(mocks.getTechnicalAuditSnapshot).toHaveBeenCalledWith('7')
  })
})
