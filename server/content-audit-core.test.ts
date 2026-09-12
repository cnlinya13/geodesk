import { describe, expect, it } from 'vitest'
import { normalizeContentAuditClaim, runContentAudit, type ContentAuditRunOptions } from './content-audit-core.ts'
import { contentAuditRecordFromValue } from './db.ts'
import { DirectWebsiteReader, DirectWebsiteReaderError } from './content-audit-direct-reader.ts'
import type {
  ContentAuditWebsiteReader,
  DirectWebsiteCoverage,
  DirectWebsitePage,
} from './content-audit-direct-reader.ts'

/**
 * The content audit reads through the model function-call boundary. These
 * fixtures intentionally keep the reader in memory: no test should need a
 * project page cache, a real website, or a provider credential.
 */
function page(url: string, title: string, text: string, links: string[] = []): DirectWebsitePage {
  return { readId: `read-${url}`, url, title, text, links }
}

function makeReader(pages: Record<string, DirectWebsitePage>): ContentAuditWebsiteReader {
  const rootUrl = 'https://example.test/'
  const discovered = new Set<string>([rootUrl])
  const baselineUrls = new Set<string>([rootUrl, ...Object.keys(pages)])
  const read = new Set<string>()
  const failed: Array<{ url: string; reason: string }> = []
  const stored = new Map<string, DirectWebsitePage>()
  let baselineReady = false
  return {
    rootUrl,
    async prepareBaseline() {
      for (const url of baselineUrls) discovered.add(url)
      baselineReady = true
    },
    async readPage(url) {
      discovered.add(url)
      const current = pages[url]
      if (!current) {
        failed.push({ url, reason: '页面不存在' })
        throw new Error('页面不存在')
      }
      read.add(url)
      stored.set(url, current)
      for (const link of current.links) discovered.add(link)
      return { ...current, links: [...current.links] }
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
        requestCount: read.size + failed.length,
        toolReadCount: read.size + failed.length,
        limitReached: false,
      }
    },
    getPage(url) {
      return stored.get(url)
    },
    close() {
      stored.clear()
    },
  }
}

function providerResponse(payload: unknown, usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 }): Response {
  return new Response(JSON.stringify({
    output_text: typeof payload === 'string' ? payload : undefined,
    output: typeof payload === 'string' ? [] : payload,
    usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function runOptions(
  fakeFetch: ContentAuditRunOptions['fetch'],
  websiteReader: ContentAuditWebsiteReader,
  extras: Partial<ContentAuditRunOptions> = {},
): ContentAuditRunOptions {
  return {
    apiKey: 'test-key',
    modelId: 'test-model',
    fetch: fakeFetch,
    endpoint: 'https://content-audit-test-endpoint.example.test/api/v3/responses',
    websiteReader,
    ...extras,
  }
}

function readCall(url: string, callId = 'call-root'): Record<string, unknown> {
  return {
    type: 'function_call',
    call_id: callId,
    name: 'read_website_page',
    arguments: JSON.stringify({ url }),
  }
}

describe('direct website content audit core', () => {
  it('does not use legacy page snapshots and requires a real website tool call', async () => {
    const root = 'https://example.test/'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({
      websiteUrl: root,
      pages: [page('https://example.test/cached', '缓存页', '不应发送给模型')],
    }, runOptions(async () => {
      calls += 1
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(calls).toBe(2)
    expect(result.usage.sourceFetches).toBe(0)
    expect(result.result.items).toEqual([])
    expect(result.executionErrors[0]).toMatchObject({ stage: 'tool' })
  })

  it('reads the root through the function tool and accepts a clean complete result', async () => {
    const root = 'https://example.test/'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const requestBodies: Record<string, unknown>[] = []
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({
            // A stale/incorrect model coverage declaration is ignored; the
            // final coverage is derived from the fixed Sitemap table.
            coverage: { complete: false, discoveredUrls: [], readUrls: [], unreadUrls: [root] },
            issues: [],
            reviews: [],
          }))
    }, reader))

    expect(result.executionErrors).toEqual([])
    expect(result.result).toMatchObject({ scope: 'website_internal', items: [], coverage: { complete: true, discoveredCount: 1, readCount: 1, toolCalls: 1 } })
    expect(result.usage).toMatchObject({ modelCalls: 2, sourceFetches: 1, inputTokens: 4, outputTokens: 6 })
    expect(requestBodies[0]?.store).toBe(false)
    expect(requestBodies[1]?.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output' })]))
    const schema = ((requestBodies[0]?.text as Record<string, unknown> | undefined)?.format as Record<string, unknown> | undefined)?.schema as Record<string, unknown> | undefined
    expect((schema?.properties as Record<string, unknown> | undefined)).not.toHaveProperty('coverage')
    expect(schema?.required).toEqual(['issues', 'reviews'])
  })

  it('allows more than 128 effective page reads when every tool call changes coverage', async () => {
    const root = 'https://example.test/'
    const urls = Array.from({ length: 130 }, (_, index) => index === 0 ? root : `https://example.test/page-${index}`)
    const pages = Object.fromEntries(urls.map((url, index) => [url, page(url, `页面${index}`, `正文${index}`)]))
    const reader = makeReader(pages)
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      const url = urls[calls - 1]
      return url
        ? providerResponse([readCall(url, `call-${calls}`)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(result.executionErrors).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 130, readCount: 130, failedCount: 0, toolCalls: 130 })
    expect(result.usage).toMatchObject({ modelCalls: 131, sourceFetches: 130 })
  })

  it('stops after two cached duplicate tool rounds when no page remains pending', async () => {
    const root = 'https://example.test/'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls <= 3
        ? providerResponse([readCall(root, `call-${calls}`)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(calls).toBe(3)
    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'tool' })
    expect(result.executionErrors[0]?.message).toContain('有效')
  })

  it('does not count repeated out-of-scope tool arguments as coverage progress', async () => {
    const root = 'https://example.test/'
    const outside = 'https://example.test/outside'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root, 'call-root')])
        : providerResponse([readCall(outside, `call-outside-${calls}`)])
    }, reader))

    expect(calls).toBe(3)
    expect(result.result.coverage).toMatchObject({ complete: false, discoveredCount: 1, readCount: 1, failedCount: 0 })
    expect(result.executionErrors[0]).toMatchObject({ stage: 'tool' })
    expect(result.executionErrors[0]?.message).toContain('有效')
  })

  it('bounds alternating cached tool calls and unfinished final responses', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文'), [other]: page(other, '其他', '其他正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      if (calls === 1 || calls === 2 || calls === 4) return providerResponse([readCall(root, `call-${calls}`)])
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(calls).toBe(4)
    expect(result.result.coverage).toMatchObject({ complete: false, discoveredCount: 2, readCount: 1, failedCount: 0 })
    expect(result.executionErrors[0]).toMatchObject({ stage: 'pending' })
    expect(result.executionErrors[0]?.message).toContain('待读页面')
  })

  it('continues when one tool batch repeats a cached page and reads a new page', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文'), [other]: page(other, '其他', '其他正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      if (calls === 1) return providerResponse([readCall(root, 'call-root')])
      if (calls === 2) return providerResponse([readCall(root, 'call-root-cached'), readCall(other, 'call-other')])
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(calls).toBe(3)
    expect(result.executionErrors).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 2, readCount: 2, failedCount: 0 })
    expect(result.usage).toMatchObject({ modelCalls: 3, sourceFetches: 3 })
  })

  it('continues a baseline run when the first response is final without a tool call', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const pages = { [root]: page(root, '首页', '官网正文'), [other]: page(other, '其他', '其他正文') }
    const discovered = new Set<string>([root])
    const read = new Set<string>()
    const failed: Array<{ url: string; reason: string }> = []
    const stored = new Map<string, DirectWebsitePage>()
    let baselineReady = false
    const websiteReader: ContentAuditWebsiteReader = {
      rootUrl: root,
      async prepareBaseline() {
        discovered.add(other)
        baselineReady = true
      },
      async readPage(url) {
        discovered.add(url)
        const current = pages[url as keyof typeof pages]
        if (!current) {
          failed.push({ url, reason: '页面不存在' })
          throw new Error('页面不存在')
        }
        read.add(url)
        stored.set(url, current)
        return { ...current, links: [...current.links] }
      },
      coverage() {
        const pendingUrls = [...discovered].filter((url) => !read.has(url) && !failed.some((item) => item.url === url))
        return {
          rootUrl: root,
          discoveredUrls: [...discovered],
          readUrls: [...read],
          failedUrls: failed,
          pendingUrls,
          failedPageUrls: failed,
          baselineReady,
          baselineCount: 2,
          baselineSource: 'sitemap' as const,
          requestCount: read.size + failed.length,
          toolReadCount: read.size + failed.length,
          limitReached: false,
        }
      },
      getPage(url) { return stored.get(url) },
      close() { stored.clear() },
    }
    let calls = 0
    const requestBodies: Record<string, unknown>[] = []
    const progress: Array<{ totalPages: number; processedPages: number; failedPages?: number; pendingPages?: number; baselineReady?: boolean }> = []
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      calls += 1
      if (calls === 1) return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
      if (calls === 2) return providerResponse([readCall(root, 'call-root')])
      if (calls === 3) return providerResponse([readCall(other, 'call-other')])
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader, {
      onProgress: (value) => { progress.push(value) },
    }))

    expect(result.executionErrors).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 2, readCount: 2, failedCount: 0, toolCalls: 2 })
    expect(result.usage).toMatchObject({ modelCalls: 4, sourceFetches: 2 })
    expect(JSON.stringify(requestBodies[1]?.input)).toContain(other)
    expect(progress.some((value) => value.baselineReady === true && value.totalPages === 2 && value.pendingPages === 2)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ totalPages: 2, processedPages: 2, failedPages: 0, pendingPages: 0, baselineReady: true })
  })

  it('preserves the reader instance when preparing a real baseline', async () => {
    const root = 'https://example.test/'
    const requested: string[] = []
    const reader = new DirectWebsiteReader(root, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        requested.push(url.pathname)
        if (url.pathname === '/robots.txt') {
          return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        }
        if (url.pathname === '/sitemap.xml') {
          return {
            status: 200,
            headers: { 'content-type': 'application/xml' },
            body: Buffer.from(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${root}</loc></url></urlset>`),
          }
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html><head><title>首页</title></head><body>官网正文</body></html>'),
        }
      },
    })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(result.executionErrors).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 1, readCount: 1, failedCount: 0, toolCalls: 1 })
    expect(requested).toEqual(expect.arrayContaining(['/robots.txt', '/sitemap.xml', '/']))
  })

  it('fails before model access when Sitemap is unavailable instead of falling back to links', async () => {
    const root = 'https://example.test/'
    const base = makeReader({ [root]: page(root, '首页', '官网正文') })
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async prepareBaseline() {
        await base.prepareBaseline?.()
      },
      coverage() {
        return { ...base.coverage(), baselineSource: 'links' as const }
      },
    }
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader))

    expect(calls).toBe(0)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'baseline' })
    expect(result.executionErrors[0]?.message).toContain('未发现可用Sitemap')
  })

  it('keeps the first safe Sitemap error reason and URL when baseline preparation fails', async () => {
    const root = 'https://example.test/'
    const base = makeReader({ [root]: page(root, '首页', '官网正文') })
    const sitemap = 'https://example.test/sitemap.xml'
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async prepareBaseline() {
        throw new DirectWebsiteReaderError('sitemap_invalid', 'Sitemap XML无效', sitemap)
      },
    }
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => providerResponse(JSON.stringify({ issues: [], reviews: [] })), websiteReader))

    expect(result.executionErrors[0]).toMatchObject({ stage: 'baseline', pageUrl: sitemap })
    expect(result.executionErrors[0]?.message).toContain('Sitemap XML无效')
  })

  it('fails after bounded final responses without reading pending pages', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const base = makeReader({ [root]: page(root, '首页', '官网正文'), [other]: page(other, '其他', '其他正文') })
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async prepareBaseline() {},
      coverage() {
        return {
          ...base.coverage(),
          discoveredUrls: [root, other],
          readUrls: [],
          failedUrls: [],
          pendingUrls: [root, other],
          failedPageUrls: [],
          baselineReady: true,
          baselineCount: 2,
          baselineSource: 'sitemap' as const,
        }
      },
    }
    let calls = 0
    const prematureFinal = JSON.stringify({ issues: [], reviews: [] })
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1 ? providerResponse([readCall(root)]) : providerResponse(prematureFinal)
    }, websiteReader))

    expect(calls).toBe(3)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'pending' })
    expect(result.executionErrors[0]?.message).toContain('待读页面')
  })

  it('round-trips a successful direct result with all three issue types through the durable record parser', async () => {
    const root = 'https://example.test/'
    const comparison = 'https://example.test/service'
    const riskQuote = 'We guarantee delivery in one day.'
    const incompleteQuote = 'Pricing details pending.'
    const conflictQuote = 'Standard plan includes 100 seats.'
    const comparisonQuote = 'Standard plan includes 50 seats.'
    const reader = makeReader({
      [root]: page(root, '首页', [riskQuote, incompleteQuote, conflictQuote].join('\n'), [comparison]),
      [comparison]: page(comparison, '服务页', comparisonQuote),
    })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      if (calls === 1) return providerResponse([readCall(root)])
      if (calls === 2) return providerResponse([readCall(comparison, 'call-comparison')])
      return providerResponse(JSON.stringify({
        issues: [
          {
            type: 'risk', dimension: 'expression_risk', reason: '无条件承诺交付时限。', suggestion: '补充适用条件和例外情况。',
            primary: { url: root, title: '首页', quote: riskQuote, section: '', sectionQuote: '', location: '' },
            comparison: null,
          },
          {
            type: 'incomplete', dimension: 'key_completeness', reason: '缺少价格周期说明。', suggestion: '补充计费周期和适用范围。',
            primary: { url: root, title: '首页', quote: incompleteQuote, section: '', sectionQuote: '', location: '' },
            comparison: null,
          },
          {
            type: 'conflict', dimension: 'data_consistency', reason: '两个页面的席位数量不一致。', suggestion: '统一并注明套餐条件。',
            primary: { url: root, title: '首页', quote: conflictQuote, section: '', sectionQuote: '', location: '' },
            comparison: { url: comparison, title: '服务页', quote: comparisonQuote, section: '', sectionQuote: '', location: '' },
          },
        ],
        reviews: [],
      }))
    }, reader))

    expect(result.executionErrors).toEqual([])
    expect(result.result.items).toHaveLength(3)
    expect(result.result.items.map((item) => item.issues?.[0]?.type)).toEqual(['risk', 'incomplete', 'conflict'])
    expect(result.result.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'risk'))).toBe(true)

    const parsed = contentAuditRecordFromValue({
      status: 'completed',
      startedAt: '2026-09-09T00:00:00.000Z',
      completedAt: result.result.checkedAt ?? '2026-09-09T00:01:00.000Z',
      progress: { stage: 'checking', totalPages: 2, processedPages: 2, totalClaims: 3, processedClaims: 3 },
      result: result.result,
      error: null,
      executionErrors: result.executionErrors,
      usage: result.usage,
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.result?.scope).toBe('website_internal')
    expect(parsed?.result?.items).toHaveLength(3)
    expect(parsed?.result?.items.map((item) => item.issues?.[0]?.type)).toEqual(['risk', 'incomplete', 'conflict'])
    expect(parsed?.result?.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'risk'))).toBe(true)
    expect(parsed?.result?.items[2]?.evidence.comparisons).toHaveLength(1)
  })

  it('requires contiguous evidence from the actual temporary page', async () => {
    const root = 'https://example.test/'
    const reader = makeReader({ [root]: page(root, '首页', '官网真实原句') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      if (calls === 1) return providerResponse([readCall(root)])
      return providerResponse(JSON.stringify({
        issues: [{
          type: 'risk', dimension: 'expression_risk', reason: '风险', suggestion: '修改',
          primary: { url: root, title: '首页', quote: '模型虚构原句', section: '', sectionQuote: '', location: '', start: 0, end: 6 },
          comparison: null,
        }],
        reviews: [],
      }))
    }, reader))

    expect(result.result.items).toEqual([])
    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'evidence' })
  })

  it('does not complete when the reader has a discovered but unread page', async () => {
    const root = 'https://example.test/'
    const other = 'https://example.test/other'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文', [other]), [other]: page(other, '其他', '其他正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'pending' })
  })

  it('keeps links discovered outside the fixed Sitemap table out of coverage counts and gaps', async () => {
    const root = 'https://example.test/'
    const linked = 'https://example.test/linked-outside-sitemap'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文', [linked]) })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, reader))

    expect(result.executionErrors).toEqual([])
    expect(result.result.coverage).toMatchObject({ complete: true, discoveredCount: 1, readCount: 1, failedCount: 0 })
  })

  it('does not claim complete when sitemap expansion fails outside the page denominator', async () => {
    const root = 'https://example.test/'
    const sitemap = 'https://example.test/child-sitemap.xml'
    const base = makeReader({ [root]: page(root, '首页', '官网正文') })
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async prepareBaseline() {
        throw new Error('子站点地图读取失败')
      },
      coverage() {
        return {
          ...base.coverage(),
          discoveredUrls: [root],
          readUrls: [root],
          failedUrls: [{ url: sitemap, reason: '子站点地图读取失败', code: 'sitemap_invalid' }],
          failedPageUrls: [],
          pendingUrls: [],
        }
      },
    }
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader))

    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'baseline' })
  })

  it('counts explicit unread links as failed coverage when they are not pending work', async () => {
    const root = 'https://example.test/'
    const attachment = 'https://example.test/files/guide.pdf'
    const base = makeReader({ [root]: page(root, '首页', '官网正文') })
    const stored = new Map<string, DirectWebsitePage>()
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async prepareBaseline() {
        await base.prepareBaseline?.()
      },
      async readPage(url) {
        const value = await base.readPage(url)
        stored.set(url, value)
        return value
      },
      coverage() {
        return {
          ...base.coverage(),
          discoveredUrls: [root, attachment],
          readUrls: [root],
          unreadUrls: [{ url: attachment, sourceUrl: root, reason: '附件不读取' }],
          pendingUrls: [],
          failedPageUrls: [],
          baselineReady: true,
          baselineCount: 2,
          baselineSource: 'sitemap',
        }
      },
      getPage(url) { return stored.get(url) ?? base.getPage(url) },
    }
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1
        ? providerResponse([readCall(root)])
        : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader))

    expect(result.executionErrors[0]).toMatchObject({ stage: 'page' })
    expect(result.executionErrors[0]?.message).toContain('附件不读取')
    expect(result.result.coverage).toMatchObject({ complete: false, discoveredCount: 2, readCount: 1, failedCount: 1 })
    expect((result.result.coverage?.discoveredCount ?? 0)).toBe((result.result.coverage?.readCount ?? 0) + (result.result.coverage?.failedCount ?? 0))
  })

  it('fails with a resource stage when the reader reaches its request limit', async () => {
    const root = 'https://example.test/'
    const base = makeReader({ [root]: page(root, '首页', '官网正文') })
    let limitReached = false
    const websiteReader: ContentAuditWebsiteReader = {
      ...base,
      async readPage(url) {
        const value = await base.readPage(url)
        limitReached = true
        return value
      },
      coverage() {
        return { ...base.coverage(), limitReached }
      },
    }
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return calls === 1 ? providerResponse([readCall(root)]) : providerResponse(JSON.stringify({ issues: [], reviews: [] }))
    }, websiteReader))

    expect(result.executionErrors[0]).toMatchObject({ stage: 'resource' })
    expect(result.result.coverage?.complete).toBe(false)
  })

  it('does not retry a provider failure even when a legacy retry count is supplied', async () => {
    const root = 'https://example.test/'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      return new Response('provider failed', { status: 500 })
    }, reader, { maxRetries: 5 }))

    expect(calls).toBe(1)
    expect(result.usage.modelCalls).toBe(1)
    expect(result.executionErrors[0]).toMatchObject({ stage: 'model' })
    expect(result.executionErrors[0]).not.toHaveProperty('attempts')
  })

  it('returns no formal result rows when a tool read fails', async () => {
    const root = 'https://example.test/'
    const missing = 'https://example.test/missing'
    const reader = makeReader({ [root]: page(root, '首页', '官网正文') })
    let calls = 0
    const result = await runContentAudit({ websiteUrl: root }, runOptions(async () => {
      calls += 1
      if (calls === 1) return providerResponse([readCall(missing, 'call-missing')])
      return providerResponse(JSON.stringify({
        issues: [], reviews: [],
      }))
    }, reader))

    expect(result.result.items).toEqual([])
    expect(result.result.coverage?.complete).toBe(false)
    expect(result.executionErrors.length).toBeGreaterThan(0)
  })

  it('keeps stable claim normalization limited to presentation differences', () => {
    expect(normalizeContentAuditClaim('  服务价格：1000 元！！ ')).toBe('服务价格:1000 元')
    expect(normalizeContentAuditClaim('同一句')).not.toBe(normalizeContentAuditClaim('另一句'))
  })
})
