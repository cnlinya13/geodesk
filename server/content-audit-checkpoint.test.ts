import { describe, expect, it } from 'vitest'
import {
  contentAuditRecordFromValue,
  type ContentAuditProgressSnapshot,
} from './db.ts'
import { runContentAudit, type ContentAuditRunOptions } from './content-audit-core.ts'
import type {
  ContentAuditCheckpoint,
  ContentAuditRecord,
} from '../src/content-audit.ts'
import type {
  ContentAuditWebsiteReader,
  DirectWebsiteCoverage,
  DirectWebsitePage,
} from './content-audit-direct-reader.ts'

function providerResponse(payload: unknown): Response {
  return new Response(JSON.stringify({
    output_text: typeof payload === 'string' ? payload : undefined,
    output: typeof payload === 'string' ? [] : payload,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function page(url: string, title: string, text: string): DirectWebsitePage {
  return { readId: `read-${url}`, url, title, text, links: [] }
}

function reader(root: string, rootPage: DirectWebsitePage): ContentAuditWebsiteReader {
  let read = false
  let baselineReady = false
  return {
    rootUrl: root,
    async prepareBaseline() {
      baselineReady = true
    },
    async readPage(url) {
      if (url !== root) throw new Error('页面不存在')
      read = true
      return rootPage
    },
    coverage(): DirectWebsiteCoverage {
      return {
        rootUrl: root,
        discoveredUrls: [root],
        readUrls: read ? [root] : [],
        failedUrls: [],
        failedPageUrls: [],
        pendingUrls: baselineReady && !read ? [root] : [],
        baselineReady,
        baselineCount: 1,
        baselineSource: 'sitemap',
        requestCount: read ? 1 : 0,
        toolReadCount: read ? 1 : 0,
        limitReached: false,
      }
    },
    getPage(url) {
      return read && url === root ? rootPage : undefined
    },
    close() {},
  }
}

function checkpoint(): ContentAuditCheckpoint {
  return {
    version: 1,
    completedPages: 1,
    totalClaims: 0,
    processedClaims: 0,
    pageClaims: [{ pageIndex: 0, claims: [] }],
    excludedPages: [],
    internalConflicts: [],
  }
}

function failedRecord(overrides: Partial<ContentAuditRecord> = {}): ContentAuditRecord {
  return {
    status: 'failed',
    startedAt: '2026-09-09T00:00:00.000Z',
    completedAt: '2026-09-09T00:01:00.000Z',
    progress: { stage: 'checking', totalPages: 1, processedPages: 1, totalClaims: 0, processedClaims: 0 },
    result: null,
    error: '内容检查失败，请重试。',
    executionErrors: [],
    usage: { modelCalls: 1, searchCalls: 0, sourceFetches: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, elapsedMs: 1 },
    ...overrides,
  }
}

describe('content audit checkpoint compatibility', () => {
  it('round-trips a nullable checkpoint but keeps it out of API JSON', () => {
    const parsed = contentAuditRecordFromValue(JSON.parse(JSON.stringify(failedRecord({ checkpoint: checkpoint() }))))

    expect(parsed).not.toBeNull()
    expect(parsed?.checkpoint).toMatchObject({ version: 1, completedPages: 1 })
    expect(Object.prototype.propertyIsEnumerable.call(parsed, 'checkpoint')).toBe(false)
    expect(Object.keys(parsed ?? {})).not.toContain('checkpoint')
    expect(JSON.stringify(parsed)).not.toContain('checkpoint')
  })

  it('requires a null current result for checking/failed records and ignores read-only history fields', () => {
    const previousResult = { checkedAt: '2026-09-08T00:01:00.000Z', scope: 'website_internal' as const, items: [] }
    const current = contentAuditRecordFromValue({
      ...failedRecord({ result: null }),
      previousResult,
      previousCompletedAt: '2026-09-08T00:01:00.000Z',
    })

    expect(current).not.toBeNull()
    expect(current?.result).toBeNull()
    expect(current).not.toHaveProperty('previousResult')
    expect(current).not.toHaveProperty('previousCompletedAt')
    expect(contentAuditRecordFromValue({
      ...failedRecord(),
      result: previousResult,
    })).toBeNull()
    expect(contentAuditRecordFromValue({
      ...failedRecord(),
      status: 'checking',
      completedAt: null,
      result: previousResult,
    })).toBeNull()
  })

  it('ignores legacy resume/checkpoint input and starts a fresh direct-reader run', async () => {
    const root = 'https://example.test/'
    const websiteReader = reader(root, page(root, '首页', '官网正文'))
    let calls = 0
    const options: ContentAuditRunOptions = {
      apiKey: 'test-key',
      modelId: 'test-model',
      endpoint: 'https://content-audit-fixture.example.test/api/v3/responses',
      websiteReader,
      fetch: async () => {
        calls += 1
        return calls === 1
          ? providerResponse([{
              type: 'function_call',
              call_id: 'call-root',
              name: 'read_website_page',
              arguments: JSON.stringify({ url: root }),
            }])
          : providerResponse(JSON.stringify({
              issues: [],
              reviews: [],
            }))
      },
      resume: { checkpoint: checkpoint(), result: failedRecord().result, usage: failedRecord().usage } as ContentAuditProgressSnapshot,
    }

    const result = await runContentAudit({ websiteUrl: root }, options)
    expect(calls).toBe(2)
    expect(result.executionErrors).toEqual([])
    expect(result.result.items).toEqual([])
    expect(result.result.coverage?.complete).toBe(true)
  })
})
