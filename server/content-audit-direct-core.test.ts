import { describe, expect, it } from 'vitest'
import { runContentAudit, type ContentAuditRunOptions } from './content-audit-core.ts'
import type {
  ContentAuditWebsiteReader,
  DirectWebsiteCoverage,
  DirectWebsitePage,
} from './content-audit-direct-reader.ts'

// Keep the reader deterministic and in-memory: these tests exercise the
// model/tool protocol and evidence gate without contacting a real website.
function makeReader(pages: Record<string, DirectWebsitePage>, links: Record<string, string[]> = {}): ContentAuditWebsiteReader {
  const rootUrl = 'https://example.test/'
  const discovered = new Set<string>([rootUrl])
  const baselineUrls = new Set<string>([rootUrl, ...Object.keys(pages)])
  const read = new Set<string>()
  const failed: Array<{ url: string; reason: string }> = []
  let baselineReady = false
  return {
    rootUrl,
    async prepareBaseline() {
      for (const url of baselineUrls) discovered.add(url)
      baselineReady = true
    },
    async readPage(url) {
      const page = pages[url]
      discovered.add(url)
      if (!page) {
        failed.push({ url, reason: '页面不存在' })
        throw new Error('页面不存在')
      }
      read.add(url)
      for (const link of links[url] ?? page.links) discovered.add(link)
      return { ...page, links: [...page.links] }
    },
    coverage(): DirectWebsiteCoverage {
      const pendingUrls = [...baselineUrls].filter((url) => !read.has(url) && !failed.some((item) => item.url === url))
      return {
        rootUrl,
        discoveredUrls: [...discovered],
        readUrls: [...read],
        failedUrls: failed,
        failedPageUrls: failed,
        pendingUrls,
        baselineReady,
        baselineCount: baselineUrls.size,
        baselineSource: 'sitemap',
        requestCount: read.size,
        toolReadCount: read.size,
        limitReached: false,
      }
    },
    getPage(url) {
      return read.has(url) ? pages[url] : undefined
    },
    close() {
      // The production reader releases temporary page text here. Tests keep
      // their fixtures immutable and need no cleanup.
    },
  }
}

function page(url: string, title: string, text: string, links: string[] = []): DirectWebsitePage {
  return { readId: `read-${url}`, url, title, text, links }
}

function providerResponse(payload: unknown, usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 }): Response {
  return new Response(JSON.stringify({ output_text: typeof payload === 'string' ? payload : undefined, output: typeof payload === 'string' ? [] : payload, usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function runOptions(fakeFetch: ContentAuditRunOptions['fetch'], websiteReader: ContentAuditWebsiteReader, extras: Partial<ContentAuditRunOptions> = {}): ContentAuditRunOptions {
  return {
    apiKey: 'test-key',
    modelId: 'test-model',
    fetch: fakeFetch,
    endpoint: 'https://content-audit-direct-test-endpoint.example.test/api/v3/responses',
    websiteReader,
    ...extras,
  }
}

describe('direct website content audit core', () => {
  it('requires a real function call, sends the temporary full transcript, and accepts a clean complete result', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '官网正文') })
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const fakeFetch: ContentAuditRunOptions['fetch'] = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      calls += 1
      if (calls === 1) {
        return providerResponse([{
          type: 'function_call',
          call_id: 'call-root',
          name: 'read_website_page',
          arguments: JSON.stringify({ url: root }),
        }])
      }
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }
    const result = await runContentAudit({ websiteUrl: root }, runOptions(fakeFetch, websiteReader))
    expect(result.executionErrors).toEqual([])
    expect(result.result.items).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 1, readCount: 1, toolCalls: 1 })
    expect(result.usage.modelCalls).toBe(2)
    expect(result.usage.sourceFetches).toBe(1)
    expect(bodies[0]?.store).toBe(false)
    expect(bodies[0]?.input).toBeTypeOf('string')
    expect(bodies[0]?.tools).toEqual([expect.objectContaining({ name: 'read_website_page' })])
    expect(bodies[1]?.store).toBe(false)
    expect(Array.isArray(bodies[1]?.input)).toBe(true)
    expect(JSON.stringify(bodies[1]?.input)).toContain('function_call_output')
  })

  it('fails without a tool call and never treats a URL-only model answer as an audit', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader))
    expect(calls).toBe(2)
    expect(result.result.items).toEqual([])
    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'tool' })
  })

  it('rejects a quote that is not a contiguous substring of the tool-returned page', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '官网真实原句') })
    let calls = 0
    const fakeFetch: ContentAuditRunOptions['fetch'] = async () => {
      calls += 1
      if (calls === 1) return providerResponse([{ type: 'function_call', call_id: 'call-root', name: 'read_website_page', arguments: JSON.stringify({ url: root }) }])
      return providerResponse(JSON.stringify({
        issues: [{
          type: 'risk', dimension: 'expression_risk', reason: '风险', suggestion: '修改',
          primary: { url: root, title: '首页', quote: '模型虚构原句', section: '', sectionQuote: '', location: '', start: 0, end: 6 },
          comparison: null,
        }],
        reviews: [],
      }))
    }
    const result = await runContentAudit({ websiteUrl: root }, runOptions(fakeFetch, websiteReader))
    expect(result.result.items).toEqual([])
    expect(result.executionErrors[0]).toMatchObject({ stage: 'evidence' })
  })

  it('fails coverage when the actual page exposes an unread page that the model omits', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const websiteReader = makeReader({ [root]: page(root, '首页', '官网正文', [other]), [other]: page(other, '其他', '其他正文') })
    let calls = 0
    const fakeFetch: ContentAuditRunOptions['fetch'] = async () => {
      calls += 1
      if (calls === 1) return providerResponse([{ type: 'function_call', call_id: 'call-root', name: 'read_website_page', arguments: JSON.stringify({ url: root }) }])
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }
    const result = await runContentAudit({ websiteUrl: root }, runOptions(fakeFetch, websiteReader))
    expect(result.executionErrors[0]).toMatchObject({ stage: 'pending' })
    expect(result.result.coverage?.complete).toBe(false)
  })

  it('does not retry a failed model call', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return new Response('provider failed', { status: 500 })
    }, websiteReader, { maxRetries: 5 }))
    expect(calls).toBe(1)
    expect(result.usage.modelCalls).toBe(1)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'model' })
  })

  it('reconciles a persisted review with the current page position and keeps the old locations', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '当前连续原句') })
    const previous = {
      scope: 'website_internal' as const,
      checkedAt: '2026-09-08T00:00:00.000Z',
      items: [{
        id: 'old-issue-id',
        statement: '当前连续原句',
        explanation: '上一轮判断',
        page: '首页',
        issues: [{ type: 'risk' as const, reason: '上一轮风险', suggestion: '上一轮建议' }],
        evidence: {
          statement: '当前连续原句',
          page: '首页',
          pageUrl: root,
          checkedAt: '2026-09-08T00:00:00.000Z',
          pageExcerpt: { location: '正文第1行第1字附近', context: '当前连续原句' },
          judgment: '上一轮判断',
          suggestion: '上一轮建议',
        },
        locations: [
          { page: '首页', pageUrl: root, statement: '当前连续原句', location: '正文第1行第1字附近', context: '当前连续原句' },
          { page: '旧服务页', pageUrl: 'https://example.test/old', statement: '当前连续原句', location: '正文第2行第1字附近', context: '旧服务页中的同一原句' },
        ],
      }],
    }
    let calls = 0
    const fakeFetch: ContentAuditRunOptions['fetch'] = async () => {
      calls += 1
      if (calls === 1) return providerResponse([{ type: 'function_call', call_id: 'call-root', name: 'read_website_page', arguments: JSON.stringify({ url: root }) }])
      return providerResponse(JSON.stringify({
        issues: [{
          type: 'risk', dimension: 'expression_risk', reason: '本轮更新后的风险', suggestion: '本轮更新后的建议',
          primary: { url: root, title: '首页', quote: '当前连续原句', section: '', sectionQuote: '', location: '', start: 0, end: 6 },
          comparison: null,
        }],
        reviews: [{
          issueId: 'old-issue-id', status: 'persists', reason: '旧问题仍存在', suggestion: '继续修订',
          evidence: { url: root, title: '首页', quote: '当前连续原句', section: '', sectionQuote: '', location: '', start: 0, end: 6 },
          comparison: null,
        }],
      }))
    }

    const result = await runContentAudit({ websiteUrl: root, previousResult: previous }, runOptions(fakeFetch, websiteReader))
    expect(result.executionErrors).toEqual([])
    expect(result.result.items).toHaveLength(1)
    expect(result.result.items[0]?.id).toBe('old-issue-id')
    expect(result.result.items[0]?.review).toMatchObject({ issueId: 'old-issue-id', status: 'persists' })
    expect(result.result.items[0]?.issues?.[0]?.reason).toBe('本轮更新后的风险')
    expect(result.result.items[0]?.locations?.map((location) => location.pageUrl)).toEqual([
      root,
      'https://example.test/old',
    ])
  })

  it('does not attach a review to a different issue type at the same page position', async () => {
    const root = 'https://example.test/'
    const websiteReader = makeReader({ [root]: page(root, '首页', '相同原句') })
    const previous = {
      scope: 'website_internal' as const,
      checkedAt: '2026-09-08T00:00:00.000Z',
      items: [{
        id: 'old-risk-id',
        statement: '相同原句',
        explanation: '上一轮表述风险',
        page: '首页',
        issues: [{ type: 'risk' as const, reason: '上一轮风险', suggestion: '上一轮建议' }],
        evidence: {
          statement: '相同原句',
          page: '首页',
          pageUrl: root,
          checkedAt: '2026-09-08T00:00:00.000Z',
          pageExcerpt: { location: '正文第1行第1字附近', context: '相同原句' },
          judgment: '上一轮表述风险',
          suggestion: '上一轮建议',
        },
      }],
    }
    let calls = 0
    const fakeFetch: ContentAuditRunOptions['fetch'] = async () => {
      calls += 1
      if (calls === 1) return providerResponse([{ type: 'function_call', call_id: 'call-root', name: 'read_website_page', arguments: JSON.stringify({ url: root }) }])
      return providerResponse(JSON.stringify({
        issues: [{
          type: 'incomplete', dimension: 'key_completeness', reason: '本轮发现信息缺项。', suggestion: '补充必要条件。',
          primary: { url: root, title: '首页', quote: '相同原句', section: '', sectionQuote: '', location: '' },
          comparison: null,
        }],
        reviews: [{
          issueId: 'old-risk-id', status: 'persists', reason: '旧问题仍存在。', suggestion: '继续修订。',
          evidence: { url: root, title: '首页', quote: '相同原句', section: '', sectionQuote: '', location: '' },
          comparison: null,
        }],
      }))
    }

    const result = await runContentAudit({ websiteUrl: root, previousResult: previous }, runOptions(fakeFetch, websiteReader))
    expect(result.executionErrors).toEqual([])
    expect(result.result.items).toHaveLength(2)
    expect(result.result.items.map((item) => item.issues?.[0]?.type)).toEqual(['incomplete', 'risk'])
    expect(result.result.items[0]?.id).not.toBe('old-risk-id')
    expect(result.result.items[1]).toMatchObject({
      id: 'old-risk-id',
      review: { issueId: 'old-risk-id', status: 'persists' },
    })
  })
})
