import { describe, expect, it } from 'vitest'
import { parseStrictXml, runTechnicalAudit } from './technical-audit.ts'
import { TechnicalAuditHttpError } from './technical-audit-http.ts'
import { TECHNICAL_AUDIT_CURRENT_ITEM_IDS, TECHNICAL_AUDIT_ITEM_COUNT, TECHNICAL_AUDIT_RULE_VERSION } from '../src/technical-audit.ts'

const home = 'https://audit.example/'
const page = '<!doctype html><html><head><title>示例</title><meta name="description" content="测试"><link rel="canonical" href="https://audit.example/"></head><body><main><h1>示例网站</h1><p>这是公开网站正文资料，用于验证技术规则能否根据实际证据判断状态。</p></main></body></html>'

type Fixture = { status: number; body: string | Uint8Array; type?: string; headers?: Record<string, string>; error?: string }

function runFixture(files: Record<string, Fixture>, options: { websiteUrl?: string; dnsFailure?: boolean; pages?: Array<{ url: string; status: 'success' | 'failed'; title: string; bodyText: string; error: string | null }> } = {}) {
  const websiteUrl = options.websiteUrl ?? home
  const requests: string[] = []
  const result = runTechnicalAudit({ websiteUrl, pages: options.pages }, {
    resolveHost: async () => {
      if (options.dnsFailure) throw new TechnicalAuditHttpError('dns_failed', 'DNS解析失败', websiteUrl)
      return [{ address: '93.184.216.34', family: 4 }]
    },
    transport: async (url) => {
      requests.push(url.pathname)
      const file = files[url.pathname] ?? { status: 404, body: '', type: 'text/plain' }
      if (file.error) throw new TechnicalAuditHttpError(file.error, `fixture ${file.error}`, url.toString())
      return { status: file.status, headers: { 'content-type': file.type ?? (url.pathname === '/' ? 'text/html' : 'text/plain'), ...(file.headers ?? {}) }, body: Buffer.from(file.body) }
    },
  }).then((audit) => ({ audit, requests }))
  return result
}

describe('technical audit deterministic evidence rules', () => {
  it('emits each finalized item once in the same order as the final snapshot', async () => {
    const events: Array<{ item: unknown; completedCount: number; total: number }> = []
    const audit = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        const fixture: Fixture = url.pathname === '/'
          ? { status: 200, body: page, type: 'text/html' }
          : { status: 404, body: '', type: 'text/plain' }
        return { status: fixture.status, headers: { 'content-type': fixture.type ?? 'text/plain' }, body: Buffer.from(fixture.body) }
      },
      onItem: (item, completedCount, total) => { events.push({ item, completedCount, total }) },
    })

    expect(audit.items).toHaveLength(TECHNICAL_AUDIT_ITEM_COUNT)
    expect(events).toHaveLength(TECHNICAL_AUDIT_ITEM_COUNT)
    expect(events.map((event) => event.item)).toEqual(audit.items)
    expect(events.map((event) => event.completedCount)).toEqual(Array.from({ length: TECHNICAL_AUDIT_ITEM_COUNT }, (_, index) => index + 1))
    expect(events.every((event) => event.total === TECHNICAL_AUDIT_ITEM_COUNT)).toBe(true)
  })

  it('persists each item before notifying an observer and ignores observer failures', async () => {
    const events: string[] = []
    const audit = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        const fixture: Fixture = url.pathname === '/'
          ? { status: 200, body: page, type: 'text/html' }
          : { status: 404, body: '', type: 'text/plain' }
        return { status: fixture.status, headers: { 'content-type': fixture.type ?? 'text/plain' }, body: Buffer.from(fixture.body) }
      },
      onItemPersist: async (item) => { events.push(`persist:${item.item_id}`) },
      onItem: async (item) => {
        events.push(`observer:${item.item_id}`)
        throw new Error('observer_disconnected')
      },
    })

    expect(audit.items).toHaveLength(TECHNICAL_AUDIT_ITEM_COUNT)
    expect(events).toHaveLength(TECHNICAL_AUDIT_ITEM_COUNT * 2)
    for (let index = 0; index < audit.items.length; index += 1) {
      const itemId = audit.items[index]?.item_id
      expect(events[index * 2]).toBe(`persist:${itemId}`)
      expect(events[index * 2 + 1]).toBe(`observer:${itemId}`)
    }
  })

  it('delivers early items while sitemap and llms evidence requests are pending', async () => {
    const body = page.replace('</main>', '<a href="/new-page">新页面</a></main>')
    let releaseSitemap!: () => void
    let releaseLlms!: () => void
    let sitemapRequested!: () => void
    let llmsRequested!: () => void
    const sitemapGate = new Promise<void>((resolve) => { releaseSitemap = resolve })
    const llmsGate = new Promise<void>((resolve) => { releaseLlms = resolve })
    const sitemapStarted = new Promise<void>((resolve) => { sitemapRequested = resolve })
    const llmsStarted = new Promise<void>((resolve) => { llmsRequested = resolve })
    const events: string[] = []
    const requests: string[] = []
    let settled = false
    const auditPromise = runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        requests.push(url.pathname)
        if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) }
        if (url.pathname === '/sitemap.xml') {
          sitemapRequested()
          await sitemapGate
          return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        }
        if (url.pathname === '/llms.txt') {
          llmsRequested()
          await llmsGate
          return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        }
        return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
      },
      onItem: (item) => { events.push(item.item_id) },
    })
    void auditPromise.then(() => { settled = true })

    await sitemapStarted
    expect(events).toHaveLength(14)
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseSitemap()
    await llmsStarted
    expect(events).toHaveLength(18)
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseLlms()
    const audit = await auditPromise
    const expected = (await runFixture({ '/': { status: 200, body, type: 'text/html' } })).audit
    expect(requests).toEqual(['/robots.txt', '/', '/sitemap.xml', '/llms.txt'])
    expect(audit.items).toHaveLength(TECHNICAL_AUDIT_ITEM_COUNT)
    expect(audit.items).toEqual(expected.items)
    expect(audit.scope).toEqual(expected.scope)
  })

  it('does not wait for the final structured-data check before delivering earlier items', async () => {
    let release!: () => void
    let metadataDelivered!: () => void
    const metadata = new Promise<void>((resolve) => { metadataDelivered = resolve })
    const events: string[] = []
    const auditPromise = runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        const fixture: Fixture = url.pathname === '/'
          ? { status: 200, body: page, type: 'text/html' }
          : { status: 404, body: '', type: 'text/plain' }
        return { status: fixture.status, headers: { 'content-type': fixture.type ?? 'text/plain' }, body: Buffer.from(fixture.body) }
      },
      onItem: async (item) => {
        events.push(item.item_id)
        if (item.item_id === 'content.metadata') {
          metadataDelivered()
          await new Promise<void>((resolve) => { release = resolve })
        }
      },
    })

    await metadata
    expect(events).toHaveLength(23)
    expect(events.at(-1)).toBe('content.metadata')
    let settled = false
    void auditPromise.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    const audit = await auditPromise
    expect(audit.items).toHaveLength(24)
    expect(events).toEqual(audit.items.map((item) => item.item_id))
  })
  it('returns exactly the current 24-item contract without removed or unsupported ids', async () => {
    const { audit } = await runFixture({ '/': { status: 200, body: page, type: 'text/html' } })
    expect(audit.rule_version).toBe(TECHNICAL_AUDIT_RULE_VERSION)
    expect(audit.items).toHaveLength(24)
    expect(audit.items.map((item) => item.item_id)).toEqual(TECHNICAL_AUDIT_CURRENT_ITEM_IDS)
    expect(audit.items.some((item) => item.item_id.startsWith('sync.'))).toBe(false)
    expect(audit.items.some((item) => [
      'index.cms_search_visibility', 'canonical.duplicate', 'canonical.migration_redirect',
      'links.orphan', 'sitemap.platform_submission', 'content.click_load', 'content.scroll_load',
    ].includes(item.item_id))).toBe(false)
  })

  it('returns the unaffected 23 items and does not turn a DNS failure into a structured-data conclusion', async () => {
    const { audit, requests } = await runFixture({}, { dnsFailure: true })
    expect(audit.items).toHaveLength(23)
    expect(audit).not.toHaveProperty('execution_errors')
    expect(audit.items.some((item) => item.item_id === 'site.request_failure')).toBe(false)
    expect(audit.items.find((item) => item.item_id === 'site.dns')?.status).toBe('review')
    expect(audit.items.find((item) => item.item_id === 'site.redirect')?.status).toBe('review')
    expect(audit.items.find((item) => item.item_id === 'content.html_body')?.status).toBe('review')
    expect(requests).toEqual([])
  })

  it('honours the detector robots group before requesting saved pages', async () => {
    const { audit, requests } = await runFixture({ '/robots.txt': { status: 200, body: 'User-agent: GEODesk\nDisallow: /' } })
    expect(requests).toEqual(['/robots.txt'])
    expect(audit.items.find((item) => item.item_id === 'content.html_body')?.status).toBe('review')
    expect(audit.scope.limits).toContain('page_check_incomplete')
    expect(audit.scope.limits).not.toContain('page_sample_limited')
  })

  it('uses a path entry as the temporary read root without falling back to origin-root resources', async () => {
    const scopedHome = 'https://audit.example/about'
    const scopedPage = page.replace('href="https://audit.example/"', `href="${scopedHome}"`)
    const { audit, requests } = await runFixture({
      '/about': { status: 200, body: scopedPage, type: 'text/html' },
      '/about/robots.txt': { status: 404, body: '' },
      '/about/sitemap.xml': { status: 404, body: '' },
      '/about/llms.txt': { status: 200, body: '# About' },
      '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
      '/sitemap.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/</loc></url></urlset>', type: 'application/xml' },
      '/llms.txt': { status: 200, body: '# Origin root' },
    }, {
      websiteUrl: scopedHome,
      pages: [{ url: 'https://audit.example/cached', status: 'success', title: '缓存页', bodyText: '旧正文', error: null }],
    })

    expect(requests).toEqual(['/about/robots.txt', '/about', '/about/sitemap.xml', '/about/llms.txt'])
    expect(audit.scope.pages).toEqual([scopedHome])
    expect(audit.scope.candidates).toEqual([
      'https://audit.example/about/robots.txt',
      'https://audit.example/about/sitemap.xml',
      'https://audit.example/about/llms.txt',
    ])
    expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'pass', message_code: 'llms_present' })
  })

  it('keeps independent page evidence findings without target-specific crawler items', async () => {
    const noindex = page.replace('</head>', '<meta name="robots" content="noindex"></head>')
    const noindexAudit = (await runFixture({ '/': { status: 200, body: noindex, type: 'text/html' } })).audit
    expect(noindexAudit.items.some((item) => item.item_id === 'crawl.target_crawler_policy')).toBe(false)
    expect(noindexAudit.items.some((item) => item.item_id === 'crawl.gptbot_policy')).toBe(false)
    expect(noindexAudit.items.find((item) => item.item_id === 'index.noindex')?.status).toBe('review')

    const emptyBodyAudit = (await runFixture({ '/': { status: 200, body: '<!doctype html><html><head><title>空正文</title><meta name="description" content="测试"></head><body></body></html>', type: 'text/html' } })).audit
    expect(emptyBodyAudit.items.find((item) => item.item_id === 'content.html_body')?.status).toBe('fix')

    const invalidJsonLdAudit = (await runFixture({ '/': { status: 200, body: page.replace('</head>', '<script type="application/ld+json">{invalid</script></head>'), type: 'text/html' } })).audit
    expect(invalidJsonLdAudit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'fix', message_code: 'structured_data_invalid' })
  })

  it('does not use saved page captures as canonical or link target evidence', async () => {
    const body = page
      .replace('href="https://audit.example/"', 'href="https://audit.example/missing"')
      .replace('</main>', '<a href="/missing">失效链接</a></main>')
    const { audit, requests } = await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
      '/sitemap.xml': { status: 200, body: '<?xml version="1.0"?><urlset><url><loc>https://audit.example/</loc></url></urlset>', type: 'application/xml' },
      '/llms.txt': { status: 404, body: '' },
      '/missing': { status: 404, body: '' },
    }, { pages: [{ url: 'https://audit.example/missing', status: 'success', title: '失效页', bodyText: '', error: null }] })
    const byId = new Map(audit.items.map((item) => [item.item_id, item]))
    expect(byId.get('canonical.target')?.status).toBe('pass')
    expect(byId.get('links.broken')).toMatchObject({ status: 'review', facts: { checked: 0, unverified: 1 } })
    expect(requests).not.toContain('/missing')
    expect(audit.scope.pages).toEqual([home])
  })

  it('treats missing llms.txt as a required fix and ignores links in a valid file', async () => {
    const missing = await runFixture({ '/': { status: 200, body: page }, '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' }, '/sitemap.xml': { status: 404, body: '' }, '/llms.txt': { status: 404, body: '' } })
    expect(missing.audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'fix', message_code: 'llms_missing' })

    const broken = await runFixture({ '/': { status: 200, body: page }, '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' }, '/sitemap.xml': { status: 404, body: '' }, '/llms.txt': { status: 200, body: '# Site\n\n- [失效](/missing)' } })
    expect(broken.audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'pass', message_code: 'llms_present' })
    expect(broken.requests).not.toContain('/missing')
  })

  it('treats an explicitly declared missing, empty, or untitled root llms.txt as a fix', async () => {
    const declaredRoot = (body: string) => body.replace('</head>', '<link rel="describedby" href="/llms.txt"></head>')
    for (const [index, llms] of [
      { status: 404, body: '' },
      { status: 200, body: '' },
      { status: 200, body: 'Plain text without a Markdown H1' },
    ].entries()) {
      const { audit } = await runFixture({
        '/': { status: 200, body: declaredRoot(page), type: 'text/html' },
        '/llms.txt': { status: llms.status, body: llms.body },
      })
      expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt')?.status, `llms case ${index}`).toBe('fix')
    }
  })

  it('does not inspect links inside an otherwise valid llms.txt', async () => {
    const body = page.replace('</head>', '<link rel="describedby" href="/llms.txt"></head>')
    const llms = [
      '[外链1](https://outside.example/1)',
      '[外链2](https://outside.example/2)',
      '[外链3](https://outside.example/3)',
      '[外链4](https://outside.example/4)',
      '[外链5](https://outside.example/5)',
      '[失效内链](/llms-broken)',
    ].join('\n')
    const { audit, requests } = await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/llms.txt': { status: 200, body: `# Site\n${llms}` },
      '/llms-broken': { status: 404, body: '' },
    })
    expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'pass', message_code: 'llms_present' })
    expect(requests).not.toContain('/llms-broken')
  })

  it('keeps a valid candidate passing when another declared llms.txt candidate is unavailable', async () => {
    const body = page.replace('</head>', '<link rel="describedby" href="/docs/llms.txt"></head>')
    const { audit } = await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/llms.txt': { status: 200, body: '# Site' },
      '/docs/llms.txt': { status: 403, body: '' },
    })
    expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'pass', message_code: 'llms_present' })

    const emptyCandidate = await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/llms.txt': { status: 200, body: '# Site' },
      '/docs/llms.txt': { status: 200, body: '' },
    })
    expect(emptyCandidate.audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'pass', message_code: 'llms_present' })
  })

  it('ignores an HTTP Link describedby declaration and checks only the root llms.txt', async () => {
    const { audit, requests } = await runFixture({
      '/': {
        status: 200,
        body: page,
        type: 'text/html',
        headers: { link: '<https://audit.example/docs/llms.txt>; rel="describedby"' },
      },
      '/llms.txt': { status: 404, body: '' },
      '/docs/llms.txt': { status: 200, body: '# Site' },
    })
    expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt')).toMatchObject({ status: 'fix', message_code: 'llms_missing' })
    expect(requests).not.toContain('/docs/llms.txt')
  })

  it('applies the required llms.txt two-state matrix without making link checks blocking', async () => {
    const cases: Array<{
      name: string
      files: Record<string, Fixture>
      status: 'pass' | 'fix'
      messageCode: string
    }> = [
      {
        name: 'valid content with broken and external links',
        files: { '/llms.txt': { status: 200, body: '# Site\n- [broken](/gone)\n- [external](https://outside.example/)' } },
        status: 'pass',
        messageCode: 'llms_present',
      },
      {
        name: '404 missing',
        files: { '/llms.txt': { status: 404, body: '' } },
        status: 'fix',
        messageCode: 'llms_missing',
      },
      {
        name: '410 missing',
        files: { '/llms.txt': { status: 410, body: '' } },
        status: 'fix',
        messageCode: 'llms_missing',
      },
      {
        name: 'html fallback',
        files: { '/llms.txt': { status: 200, type: 'text/html', body: '<html><body><h1>Fallback</h1></body></html>' } },
        status: 'fix',
        messageCode: 'llms_invalid',
      },
      {
        name: 'empty',
        files: { '/llms.txt': { status: 200, body: '' } },
        status: 'fix',
        messageCode: 'llms_invalid',
      },
      {
        name: 'missing h1',
        files: { '/llms.txt': { status: 200, body: 'Plain text without a Markdown heading' } },
        status: 'fix',
        messageCode: 'llms_invalid',
      },
      {
        name: 'invalid utf8',
        files: { '/llms.txt': { status: 200, body: new Uint8Array([0xff, 0xfe]) } },
        status: 'fix',
        messageCode: 'llms_invalid',
      },
      {
        name: 'timeout',
        files: { '/llms.txt': { status: 0, body: '', error: 'timeout' } },
        status: 'fix',
        messageCode: 'llms_unavailable',
      },
      {
        name: 'robots blocked',
        files: { '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /llms.txt' } },
        status: 'fix',
        messageCode: 'llms_unavailable',
      },
      {
        name: 'declared alternatives do not replace the root file',
        files: {
          '/': { status: 200, body: page.replace('</head>', '<link rel="describedby" href="/docs/llms.txt"><link rel="describedby" href="/alt/llms.txt"></head>'), type: 'text/html' },
          '/llms.txt': { status: 404, body: '' },
          '/docs/llms.txt': { status: 200, body: '# Valid' },
          '/alt/llms.txt': { status: 410, body: '' },
        },
        status: 'fix',
        messageCode: 'llms_missing',
      },
    ]

    for (const testCase of cases) {
      const { audit, requests } = await runFixture({
        '/': { status: 200, body: page, type: 'text/html' },
        ...testCase.files,
      })
      expect(audit.items.find((item) => item.item_id === 'discovery.llms_txt'), testCase.name).toMatchObject({
        status: testCase.status,
        message_code: testCase.messageCode,
      })
      if (testCase.name === 'valid content with broken and external links') expect(requests).not.toContain('/gone')
      if (testCase.name === 'declared alternatives do not replace the root file') {
        expect(requests).not.toContain('/docs/llms.txt')
        expect(requests).not.toContain('/alt/llms.txt')
      }
    }
  })

  it('keeps homepage findings independent from saved inner-page failures', async () => {
    const canonical = page.replace('href="https://audit.example/"', 'href="https://audit.example/restricted"')
    const { audit } = await runFixture({
      '/': { status: 200, body: canonical, type: 'text/html' },
      '/restricted': { status: 403, body: '' },
      '/broken-page': { status: 500, body: '' },
    }, {
      pages: [{ url: 'https://audit.example/broken-page', status: 'success', title: '', bodyText: '', error: null }],
    })
    const byId = new Map(audit.items.map((item) => [item.item_id, item]))
    expect(byId.get('canonical.target')?.status).toBe('pass')
    expect(byId.get('site.http_status')).toMatchObject({ status: 'pass', message_code: 'pass', facts: { status: 200 } })
    expect(byId.get('index.noindex')?.status).toBe('pass')
    expect(byId.get('crawl.captcha')).toBeUndefined()
    expect(byId.get('links.broken')?.status).toBe('not_applicable')
    expect(byId.get('content.structured_data')?.status).toBe('fix')
  })

  it('keeps a deterministic structured-data fix from the configured root page', async () => {
    const { audit } = await runFixture({
      '/': { status: 200, body: page, type: 'text/html' },
      '/inner': { status: 503, body: '', type: 'text/html' },
    }, { pages: [{ url: `${home}inner`, status: 'success', title: '内页', bodyText: '正文', error: null }] })
    expect(audit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({
      status: 'fix',
      message_code: 'structured_data_missing',
      facts: { pages: 1, incomplete_pages: 0 },
    })
    expect(audit).not.toHaveProperty('execution_errors')
  })

  it('does not let a saved page failure hide a readable root structured-data result', async () => {
    const valid = page.replace('</head>', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"示例"}</script></head>')
    const { audit } = await runFixture({
      '/': { status: 200, body: valid, type: 'text/html' },
      '/inner': { status: 503, body: '', type: 'text/html' },
    }, { pages: [{ url: `${home}inner`, status: 'success', title: '内页', bodyText: '正文', error: null }] })
    expect(audit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'pass', facts: { pages: 1, pages_with_markers: 1 } })
    expect(audit).not.toHaveProperty('execution_errors')
  })

  it('does not treat an absent or explicitly unrestricted X-Robots-Tag as a finding', async () => {
    const absent = (await runFixture({ '/': { status: 200, body: page, type: 'text/html' } })).audit
    expect(absent.items.find((item) => item.item_id === 'index.x_robots_tag')).toMatchObject({ status: 'pass', facts: { restricted: false } })

    const unrestricted = (await runFixture({
      '/': { status: 200, body: page, type: 'text/html', headers: { 'x-robots-tag': 'index, follow' } },
    })).audit
    expect(unrestricted.items.find((item) => item.item_id === 'index.x_robots_tag')).toMatchObject({ status: 'pass', facts: { restricted: false } })

    const restricted = (await runFixture({
      '/': { status: 200, body: page, type: 'text/html', headers: { 'x-robots-tag': 'noindex' } },
    })).audit
    expect(restricted.items.find((item) => item.item_id === 'index.x_robots_tag')).toMatchObject({ status: 'review', facts: { restricted: true } })
  })

  it('does not turn valid fragments or menu controls into navigation fixes', async () => {
    const body = page.replace('</main>', [
      '<nav><a href="#menu">正文</a><a href="#missing">未知片段</a><a href="javascript:openMenu()" role="button" aria-controls="menu">菜单</a></nav>',
      '<div id="menu"></div>',
      '</main>',
    ].join(''))
    const { audit } = await runFixture({ '/': { status: 200, body, type: 'text/html' } })
    expect(audit.items.find((item) => item.item_id === 'links.navigation')).toMatchObject({ status: 'review', message_code: 'review' })
    expect(audit.items.find((item) => item.item_id === 'links.navigation')?.status).not.toBe('fix')

    const known = body.replace('href="#missing"', 'href="#menu"')
    const knownAudit = (await runFixture({ '/': { status: 200, body: known, type: 'text/html' } })).audit
    expect(knownAudit.items.find((item) => item.item_id === 'links.navigation')).toMatchObject({ status: 'pass' })
  })

  it('keeps links without targets not-applicable and blocked selected links under review', async () => {
    const noLinks = (await runFixture({ '/': { status: 200, body: page, type: 'text/html' } })).audit
    expect(noLinks.items.find((item) => item.item_id === 'links.broken')).toMatchObject({ status: 'not_applicable', message_code: 'not_applicable' })

    const body = page.replace('</main>', '<a href="/blocked">受限链接</a></main>')
    const blocked = (await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /blocked' },
    }, { pages: [{ url: 'https://audit.example/blocked', status: 'success', title: '受限页', bodyText: '', error: null }] })).audit
    expect(blocked.items.find((item) => item.item_id === 'links.broken')).toMatchObject({ status: 'review', facts: { checked: 0, unverified: 1 } })
  })

  it('checks only the configured root and ignores saved inner pages', async () => {
    const savedPages = Array.from({ length: 28 }, (_, index) => ({
      url: `${home}target-${index + 1}`,
      status: 'success' as const,
      title: `页面${index + 1}`,
      bodyText: '历史正文',
      error: null,
    }))
    const requests: string[] = []
    const audit = await runTechnicalAudit({ websiteUrl: home, pages: savedPages }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        requests.push(url.pathname)
        if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page) }
        if (url.pathname === '/target-1') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        if (url.pathname === '/target-2') return { status: 302, headers: { 'content-type': 'text/plain', location: '/target-2' }, body: Buffer.from('') }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page) }
      },
    })
    expect(requests).not.toContain('/target-1')
    expect(requests).not.toContain('/target-2')
    expect([...new Set(requests.filter((path) => path.startsWith('/target-')))]).toHaveLength(0)
    expect(audit.scope.pages).toEqual([home])
    expect(audit.scope.page_limit).toBe(1)
    expect(audit.scope.sampled_pages).toEqual([home])
    expect(audit.scope.skipped_pages).toEqual([])
    expect(audit.scope.limits).not.toContain('page_check_incomplete')
    expect(audit.scope.limits).not.toContain('page_sample_limited')
    expect(audit.scope.request_limit).toBeGreaterThan(40)
    expect(audit.items.find((item) => item.item_id === 'site.http_status')).toMatchObject({ status: 'pass', message_code: 'pass', facts: { status: 200 } })
    expect(audit.items.find((item) => item.item_id === 'site.redirect')).toMatchObject({ status: 'pass', message_code: 'pass' })
  })

  it('does not discover or recheck pages from the saved crawler list', async () => {
    const urls = [home, ...Array.from({ length: 199 }, (_, index) => `${home}p${index + 1}`)]
    const pages = [
      ...urls.map((url) => ({ url, status: 'success' as const, title: '页面', bodyText: '正文', error: null })),
      { url: `${home}old-failed`, status: 'failed' as const, title: '', bodyText: '', error: 'prior failure' },
      { url: 'https://outside.example/', status: 'success' as const, title: '外站', bodyText: '正文', error: null },
      { url: home, status: 'success' as const, title: '重复首页', bodyText: '正文', error: null },
    ]
    const requests: string[] = []
    const audit = await runTechnicalAudit({ websiteUrl: home, pages }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        requests.push(url.pathname)
        if (url.pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /') }
        if (url.pathname === '/sitemap.xml') return { status: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from(`<urlset>${urls.map((value) => `<url><loc>${value}</loc></url>`).join('')}<url><loc>${home}new-discovered</loc></url></urlset>`) }
        if (url.pathname === '/llms.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('# Site\n[新页面](/new-discovered)') }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page) }
      },
    })
    expect(audit.scope.pages).toEqual([home])
    expect(audit.scope.pages).not.toContain(`${home}old-failed`)
    expect(audit.scope.pages).not.toContain('https://outside.example/')
    expect(audit.scope.sampled_pages).toEqual([home])
    expect(audit.scope.skipped_pages).toHaveLength(0)
    expect([...new Set(requests.filter((path) => path.startsWith('/p')))]).toHaveLength(0)
    expect(requests).not.toContain('/new-discovered')
    expect(audit.scope.request_limit).toBeGreaterThan(40)
  })

  it('does not infer a late saved-page issue or expand the request plan', async () => {
    const pages = Array.from({ length: 28 }, (_, index) => ({
      url: index === 0 ? home : `${home}p${index}`,
      status: 'success' as const,
      title: `页面${index}`,
      bodyText: '正文',
      error: null,
    }))
    const run = (maxRequests?: number) => runTechnicalAudit({ websiteUrl: home, pages }, {
      ...(maxRequests === undefined ? {} : { maxRequests }),
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' || url.pathname === '/llms.txt') {
          return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        }
        const lateBody = url.pathname === '/p27'
          ? page.replace('</head>', '<script type="application/ld+json">{bad</script></head>')
          : page
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(lateBody) }
      },
    })

    const complete = await run()
    expect(complete.scope.pages).toEqual([home])
    expect(complete.scope.sampled_pages).toEqual([home])
    expect(complete.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'fix', message_code: 'structured_data_missing' })

    const capped = await run(5)
    expect(capped.scope.pages).toEqual([home])
    expect(capped.scope.sampled_pages).toEqual([home])
    expect(capped.scope.page_limit).toBe(1)
    expect(capped.scope.request_limit).toBe(5)
    expect(capped.scope.skipped_pages).toEqual([])
    expect(capped.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'fix', message_code: 'structured_data_missing' })
  })

  it('handles a sitemap index and checks a sampled URL that returns 404', async () => {
    const { audit } = await runFixture({
      '/sitemap.xml': { status: 200, body: '<sitemapindex><sitemap><loc>https://audit.example/child.xml</loc></sitemap></sitemapindex>', type: 'application/xml' },
      '/child.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/gone</loc></url></urlset>', type: 'application/xml' },
      '/gone': { status: 404, body: '' },
    }, { pages: [{ url: 'https://audit.example/gone', status: 'success', title: '失效页', bodyText: '', error: null }] })
    expect(audit.items.find((item) => item.item_id === 'sitemap.invalid_urls')).toMatchObject({ status: 'pass', facts: { dead: 0, sample_incomplete: true } })
  })

  it('marks a successfully read malformed sitemap XML as a fix', async () => {
    const { audit } = await runFixture({
      '/sitemap.xml': { status: 200, body: '<urlset><url></url></urlset>', type: 'application/xml' },
    })
    expect(audit.items.find((item) => item.item_id === 'sitemap.generation')).toMatchObject({ status: 'fix', message_code: 'sitemap_invalid' })
  })

  it('prioritizes a malformed sitemap candidate over a valid candidate', async () => {
    const { audit } = await runFixture({
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nSitemap: https://audit.example/good.xml\nSitemap: https://audit.example/bad.xml' },
      '/good.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/</loc></url></urlset>', type: 'application/xml' },
      '/bad.xml': { status: 200, body: '<urlset><url></url></urlset>', type: 'application/xml' },
    })
    expect(audit.items.find((item) => item.item_id === 'sitemap.generation')).toMatchObject({ status: 'fix', message_code: 'sitemap_invalid' })
  })

  it('keeps a valid sitemap plus an unavailable candidate in review', async () => {
    const { audit } = await runFixture({
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nSitemap: https://audit.example/good.xml\nSitemap: https://audit.example/down.xml' },
      '/good.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/</loc></url></urlset>', type: 'application/xml' },
      '/down.xml': { status: 503, body: '' },
    })
    expect(audit.items.find((item) => item.item_id === 'sitemap.generation')).toMatchObject({ status: 'review' })
  })

  it('does not discover declared llms candidates beyond the root companion file', async () => {
    const body = page.replace('</head>', [
      '<link rel="describedby" href="/a/llms.txt">',
      '<link rel="describedby" href="/b/llms.txt">',
      '<link rel="describedby" href="/c/llms.txt">',
      '<link rel="describedby" href="/d/llms.txt">',
      '</head>',
    ].join(''))
    const { audit, requests } = await runFixture({
      '/': { status: 200, body, type: 'text/html' },
      '/llms.txt': { status: 404, body: '' },
      '/a/llms.txt': { status: 200, body: '# A' },
      '/b/llms.txt': { status: 200, body: '# B' },
      '/c/llms.txt': { status: 200, body: '# C' },
      '/d/llms.txt': { status: 200, body: '# D' },
    })
    const llmsItem = audit.items.find((item) => item.item_id === 'discovery.llms_txt')
    expect(llmsItem).toMatchObject({ status: 'fix', message_code: 'llms_missing', facts: { files_checked: 1, candidate_budget_exhausted: false } })
    expect(requests).not.toContain('/a/llms.txt')
    expect(requests).not.toContain('/b/llms.txt')
    expect(requests).not.toContain('/c/llms.txt')
    expect(requests).not.toContain('/d/llms.txt')
  })

  it('does not emit the seven removed unsupported checks', async () => {
    const { audit } = await runFixture({ '/': { status: 200, body: page, type: 'text/html' } })
    const ids = [
      'index.cms_search_visibility', 'canonical.duplicate', 'canonical.migration_redirect',
      'links.orphan', 'sitemap.platform_submission', 'content.click_load', 'content.scroll_load',
    ]
    for (const id of ids) {
      expect(audit.items.find((item) => item.item_id === id), id).toBeUndefined()
    }
  })

  it('keeps root JSON-LD graph wrappers valid without reading saved pages', async () => {
    const shared = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@id': 'https://audit.example/#org', '@type': 'Organization', name: '示例公司' }] })
    const article = page.replace('</head>', `<script type="application/ld+json">${shared}</script></head>`)
    const { audit, requests } = await runFixture({
      '/': { status: 200, body: article, type: 'text/html' },
      '/article': { status: 200, body: article, type: 'text/html' },
    }, { pages: [{ url: 'https://audit.example/article', status: 'success', title: '文章', bodyText: '正文', error: null }] })
    expect(audit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'pass', facts: { pages: 1, pages_with_markers: 1 } })
    expect(requests).not.toContain('/article')
    expect(audit.items.some((item) => item.item_id.startsWith('structured.'))).toBe(false)

    const nullLd = page.replace('</head>', '<script type="application/ld+json">null</script></head>')
    const nullAudit = (await runFixture({ '/': { status: 200, body: nullLd, type: 'text/html' } })).audit
    expect(nullAudit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'fix', message_code: 'structured_data_missing' })
  })

  it('reviews only a same-page JSON-LD key-field conflict', async () => {
    const conflicting = JSON.stringify({ '@graph': [
      { '@id': 'https://audit.example/#org', '@type': 'Organization', name: '甲公司' },
      { '@id': 'https://audit.example/#org', '@type': 'Organization', name: '乙公司' },
    ] })
    const body = page.replace('</head>', `<script type="application/ld+json">${conflicting}</script></head>`)
    const { audit } = await runFixture({ '/': { status: 200, body, type: 'text/html' } })
    expect(audit.items.find((item) => item.item_id === 'content.structured_data')).toMatchObject({ status: 'pass' })
    expect(audit.items.some((item) => item.item_id === 'structured.duplicate_conflict')).toBe(false)
  })

  it('reviews sitemap generation and URL checks when one sitemap candidate fails', async () => {
    const { audit } = await runFixture({
      '/': { status: 200, body: page, type: 'text/html' },
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\nSitemap: https://audit.example/good.xml\nSitemap: https://audit.example/down.xml' },
      '/good.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/</loc></url></urlset>', type: 'application/xml' },
      '/down.xml': { status: 503, body: '' },
    })
    expect(audit.items.find((item) => item.item_id === 'sitemap.generation')?.status).toBe('review')
    expect(audit.items.find((item) => item.item_id === 'sitemap.coverage')?.status).toBe('review')
    expect(audit.items.find((item) => item.item_id === 'sitemap.invalid_urls')?.status).toBe('review')
  })

  it('does not use a saved failed page capture when checking sitemap URLs', async () => {
    const { audit, requests } = await runFixture({
      '/': { status: 200, body: page, type: 'text/html' },
      '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
      '/sitemap.xml': { status: 200, body: '<urlset><url><loc>https://audit.example/failed</loc></url></urlset>', type: 'application/xml' },
      '/failed': { status: 503, body: '' },
    }, { pages: [{ url: 'https://audit.example/failed', status: 'success', title: '失败页', bodyText: '', error: null }] })
    expect(audit.items.find((item) => item.item_id === 'sitemap.invalid_urls')).toMatchObject({ status: 'pass', facts: { blocked: 0, sample_incomplete: true } })
    expect(requests).not.toContain('/failed')
  })

  it('does not fetch pages when robots is HTML, unavailable, or redirects to a blocking policy', async () => {
    const htmlRobots = await runFixture({ '/robots.txt': { status: 200, body: '<!doctype html><html><body>fallback</body></html>', type: 'text/html' } })
    expect(htmlRobots.requests).toEqual(['/robots.txt'])
    expect(htmlRobots.audit.items.find((item) => item.item_id === 'crawl.robots_txt')).toMatchObject({ status: 'review', message_code: 'robots_unreadable' })

    const unavailableRobots = await runFixture({ '/robots.txt': { status: 503, body: '' } })
    expect(unavailableRobots.requests).toEqual(['/robots.txt'])
    expect(unavailableRobots.audit.items.find((item) => item.item_id === 'crawl.robots_txt')).toMatchObject({ status: 'review', message_code: 'robots_unreadable' })

    const redirectedRobots = await runFixture({
      '/robots.txt': { status: 302, body: '', headers: { location: '/robots-policy.txt' } },
      '/robots-policy.txt': { status: 200, body: 'User-agent: GEODesk\nDisallow: /' },
    })
    expect(redirectedRobots.requests).toEqual(['/robots.txt'])
    expect(redirectedRobots.audit.items.find((item) => item.item_id === 'content.html_body')?.status).toBe('review')
  })

  it('passes the actual query to the robots authorizer and blocks a disallowed redirect target', async () => {
    const requests: string[] = []
    const audit = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        requests.push(url.pathname + url.search)
        if (url.pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: GEODesk\nDisallow: /search?token=secret\nAllow: /') }
        if (url.pathname === '/' && !url.search) return { status: 302, headers: { 'content-type': 'text/plain', location: '/search?token=secret' }, body: Buffer.from('') }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page) }
      },
    })
    expect(requests).toContain('/robots.txt')
    expect(requests).toContain('/')
    expect(requests).not.toContain('/search?token=secret')
    expect(audit.items.find((item) => item.item_id === 'site.redirect')?.status).toBe('review')
  })

  it('separates DNS evidence from an explicit TLS failure', async () => {
    const audit = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        throw new TechnicalAuditHttpError('tls_failed', 'HTTPS证书校验失败', url.toString(), { phase: 'tls', tlsEstablished: false })
      },
    })
    expect(audit.items.find((item) => item.item_id === 'site.dns')).toMatchObject({ status: 'pass', facts: { resolved: true } })
    expect(audit.items.find((item) => item.item_id === 'site.https')).toMatchObject({ status: 'review', message_code: 'tls_failed', facts: { tls_failed: true } })
  })

  it('does not infer a TLS finding from a reset or an incomplete handshake deadline', async () => {
    const reset = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => { throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) },
    })
    expect(reset.items.find((item) => item.item_id === 'site.https')).toMatchObject({ status: 'review', message_code: 'network_unavailable', facts: { tls_failed: false } })

    const deadline = await runTechnicalAudit({ websiteUrl: home }, {
      timeoutMs: 5,
      totalTimeoutMs: 100,
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => new Promise(() => undefined),
    })
    expect(deadline.items.find((item) => item.item_id === 'site.https')).toMatchObject({ status: 'review', message_code: 'network_unavailable', facts: { tls_failed: false } })
  })

  it('records a private DNS answer as resolved without allowing the request', async () => {
    let transportCalls = 0
    const audit = await runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '192.168.1.10', family: 4 }],
      transport: async () => {
        transportCalls += 1
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page) }
      },
    })
    expect(audit.items.find((item) => item.item_id === 'site.dns')).toMatchObject({ status: 'pass', facts: { resolved: true } })
    expect(transportCalls).toBe(0)
  })

  it('assigns a final 404 to HTTP status rather than the redirect item', async () => {
    const { audit } = await runFixture({
      '/': { status: 302, body: '', type: 'text/plain', headers: { location: '/gone' } },
      '/gone': { status: 404, body: '', type: 'text/plain' },
    })
    expect(audit.items.find((item) => item.item_id === 'site.http_status')).toMatchObject({ status: 'fix', message_code: 'http_error', facts: { status: 404 } })
    expect(audit.items.find((item) => item.item_id === 'site.http_status')?.facts).not.toHaveProperty('page_failures')
    expect(audit.items.find((item) => item.item_id === 'site.redirect')).toMatchObject({ status: 'pass', message_code: 'pass' })
  })

  it('keeps redirect loops and invalid targets as fixes, while a blocked cross-origin target is review', async () => {
    const runRedirect = (locationFor: (path: string) => string) => runTechnicalAudit({ websiteUrl: home }, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async (url) => {
        if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }
        return { status: 302, headers: { 'content-type': 'text/plain', location: locationFor(url.pathname) }, body: Buffer.from('') }
      },
    })

    const loop = await runRedirect(() => '/loop')
    expect(loop.items.find((item) => item.item_id === 'site.redirect')).toMatchObject({ status: 'fix', message_code: 'redirect_loop' })

    const invalid = await runRedirect(() => 'http://[invalid')
    expect(invalid.items.find((item) => item.item_id === 'site.redirect')).toMatchObject({ status: 'fix', message_code: 'redirect_invalid' })

    const cross = await runRedirect(() => 'https://outside.example/end')
    expect(cross.items.find((item) => item.item_id === 'site.redirect')).toMatchObject({ status: 'review', message_code: 'redirect_blocked' })
  })
})

describe('strict sitemap XML parser', () => {
  it('rejects external entities, malformed nesting, invalid code points and deep documents', () => {
    expect(parseStrictXml('<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>')).toBeNull()
    expect(parseStrictXml('<urlset><url></urlset>')).toBeNull()
    expect(parseStrictXml('<urlset>&#99999999999;</urlset>')).toBeNull()
    expect(parseStrictXml(`<urlset>${'<a>'.repeat(65)}${'</a>'.repeat(65)}</urlset>`)).toBeNull()
  })
})
