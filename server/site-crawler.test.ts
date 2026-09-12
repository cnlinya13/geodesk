import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { crawlWebsite, DEFAULT_MAX_PAGES } from './site-crawler.ts'

let fixture: Server | undefined

async function startFixture(handler: (path: string) => { status?: number; type?: string; body: string }): Promise<string> {
  fixture = createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? '/'
    const result = handler(path)
    response.writeHead(result.status ?? 200, { 'content-type': result.type ?? 'text/html; charset=utf-8' })
    response.end(result.body)
  })
  await new Promise<void>((resolve) => fixture?.listen(0, '127.0.0.1', () => resolve()))
  const address = fixture.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not start')
  return `http://127.0.0.1:${address.port}`
}

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; requests: string[]; inits: RequestInit[] } {
  const requests: string[] = []
  const inits: RequestInit[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    requests.push(url.toString())
    inits.push(init ?? {})
    return handler(url, init)
  }) as typeof fetch
  return { fetch: fetcher, requests, inits }
}

function html(body: string, title = ''): Response {
  return new Response(`<html><head>${title ? `<title>${title}</title>` : ''}</head><body>${body}</body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function missing(type = 'text/plain'): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': type } })
}

afterEach(async () => {
  if (!fixture) return
  await new Promise<void>((resolve, reject) => fixture?.close((error) => error ? reject(error) : resolve()))
  fixture = undefined
})

describe('crawlWebsite', () => {
  it('falls back to same-host links when sitemap is unavailable and skips duplicates and attachments', async () => {
    const requests: string[] = []
    const base = await startFixture((path) => {
      requests.push(path)
      if (path === '/robots.txt' || path === '/sitemap.xml') return { status: 404, type: 'text/plain', body: 'not found' }
      if (path === '/') return {
        body: '<html><head><title>首页</title></head><body><a href="/about?utm=1#team">关于</a><a href="/about?other=2">关于重复</a><a href="/guide">指南</a><a href="/extra">更多</a><a href="/download.pdf">PDF</a><a href="https://sub.example.com/private">子域</a></body></html>',
      }
      if (path === '/about') return { body: '<html><title>关于</title><body>关于我们</body></html>' }
      if (path === '/guide') return { body: '<html><title>指南</title><body>使用指南</body></html>' }
      if (path === '/extra') return { body: '<html><title>更多</title><body>更多内容</body></html>' }
      return { status: 404, body: 'missing' }
    })

    const result = await crawlWebsite(`${base}/`, { maxPages: 3 })

    expect(result.source).toBe('links')
    expect(result.discoveredCount).toBe(4)
    expect(result.successCount).toBe(3)
    expect(result.failedCount).toBe(0)
    expect(result.incomplete).toBe(true)
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/`, `${base}/about`, `${base}/guide`])
    expect(requests.filter((path) => path === '/about')).toHaveLength(1)
    expect(requests).not.toContain('/download.pdf')
  })

  it('recursively reads a sitemap index and normalizes sitemap URLs', async () => {
    const base = await startFixture((path) => {
      if (path === '/robots.txt') return { type: 'text/plain', body: `Sitemap: ${base}/root-sitemap.xml` }
      if (path === '/root-sitemap.xml') return { type: 'application/xml', body: `<sitemapindex><sitemap><loc>${base}/child.xml</loc></sitemap></sitemapindex>` }
      if (path === '/child.xml') return { type: 'application/xml', body: `<urlset><url><loc>${base}/one?x=1#part</loc></url><url><loc>${base}/two</loc></url></urlset>` }
      if (path === '/') return { body: '<html><title>首页</title><body>首页</body></html>' }
      if (path === '/one') return { body: '<html><title>一</title><body>一</body></html>' }
      if (path === '/two') return { body: '<html><title>二</title><body>二</body></html>' }
      return { status: 404, body: 'missing' }
    })

    const result = await crawlWebsite(base)

    expect(result.source).toBe('sitemap')
    expect(result.successCount).toBe(3)
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/`, `${base}/one`, `${base}/two`])
  })

  it('follows /about to /about/ and stores the actual final URL', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/about">关于</a>', '首页')
      if (url.pathname === '/about') return new Response('', { status: 301, headers: { location: `${base}/about/` } })
      if (url.pathname === '/about/') return html('<p>关于我们</p>', '关于')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.status).toBe('completed')
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/`, `${base}/about/`])
    expect(requests).toContain(`${base}/about`)
    expect(requests).toContain(`${base}/about/`)
    expect(requests.filter((url) => url === `${base}/about`)).toHaveLength(1)
    expect(requests.filter((url) => url === `${base}/about/`)).toHaveLength(1)
  })

  it('preserves a trailing slash on the direct start URL', async () => {
    const base = 'https://example.com'
    const { fetch } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/about/') return html('<p>关于我们</p>', '关于')
      return missing()
    })

    const result = await crawlWebsite(`${base}/about/`, { fetch })

    expect(result.startUrl).toBe(`${base}/about/`)
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/about/`])
  })

  it('deduplicates /about and /about/ while retaining one saved page', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/about">关于</a><a href="/about/">关于重复</a>', '首页')
      if (url.pathname === '/about' || url.pathname === '/about/') return html('<p>关于我们</p>', '关于')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(2)
    expect(result.pages.filter((page) => page.url === `${base}/about` || page.url === `${base}/about/`)).toHaveLength(1)
    expect(requests.filter((url) => url === `${base}/about` || url === `${base}/about/`)).toHaveLength(1)
  })

  it('resolves relative links from a final /section/ URL', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/section/">分区</a>', '首页')
      if (url.pathname === '/section/') return html('<a href="child">子页</a>', '分区')
      if (url.pathname === '/section/child') return html('<p>子页正文</p>', '子页')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.pages.map((page) => page.url)).toContain(`${base}/section/child`)
    expect(requests).toContain(`${base}/section/child`)
    expect(requests).not.toContain(`${base}/child`)
  })

  it('uses homepage links even when a sitemap exists and prioritizes core pages', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt') return new Response(`Sitemap: ${base}/sitemap.xml`, { headers: { 'content-type': 'text/plain' } })
      if (url.pathname === '/sitemap.xml') return new Response(`<urlset><url><loc>${base}/news</loc></url><url><loc>${base}/services</loc></url></urlset>`, { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/') return html('<a href="/contact">联系</a><a href="/about">关于</a><a href="/cases">案例</a>', '首页')
      if (url.pathname === '/about') return html('<p>关于我们</p>', '关于')
      if (url.pathname === '/services') return html('<p>服务</p>', '服务')
      if (url.pathname === '/contact') return html('<p>联系方式</p>', '联系')
      if (url.pathname === '/cases') return html('<p>案例</p>', '案例')
      if (url.pathname === '/news') return html('<p>新闻</p>', '新闻')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch, maxPages: 5 })

    expect(result.source).toBe('sitemap')
    expect(result.pages.map((page) => new URL(page.url).pathname)).toEqual(['/', '/about', '/services', '/contact', '/cases'])
    expect(requests).toContain(`${base}/about`)
    expect(result.successCount).toBe(5)
    expect(result.incomplete).toBe(true)
  })

  it('continues past failed URLs until 200 valid pages, then stops at the success cap', async () => {
    const base = 'https://example.com'
    const sitemapPages = Array.from({ length: DEFAULT_MAX_PAGES + 5 }, (_, index) => `${base}/page-${String(index + 1).padStart(3, '0')}`)
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
        if (url.pathname === '/sitemap.xml') return new Response(`<urlset>${sitemapPages.map((page) => `<url><loc>${page}</loc></url>`).join('')}</urlset>`, { headers: { 'content-type': 'application/xml' } })
        return missing()
      }
      if (url.pathname === '/') return html('<p>首页</p>', '首页')
      if (url.pathname === '/page-001') return missing()
      return html(`<p>${url.pathname}</p>`, url.pathname)
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(DEFAULT_MAX_PAGES)
    expect(result.failedCount).toBe(1)
    expect(result.pages).toHaveLength(DEFAULT_MAX_PAGES + 1)
    expect(result.incomplete).toBe(true)
    expect(requests).not.toContain(`${base}/page-201`)
  })

  it('rejects empty HTML and JavaScript-only shells as failed pages', async () => {
    const base = 'https://example.com'
    const { fetch } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<p>Loading...</p><script>document.querySelector("#root")</script>', '壳页面')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.status).toBe('failed')
    expect(result.successCount).toBe(0)
    expect(result.failedCount).toBe(1)
    expect(result.pages[0]?.error).toContain('正文')
    expect(result.incomplete).toBe(true)
  })

  it('keeps attachment links in body text without fetching the attachment', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<p>资料</p><a href="/manual.pdf">产品手册</a><a href="/about">关于</a>', '首页')
      if (url.pathname === '/about') return html('<p>关于我们</p>', '关于')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch, maxPages: 2 })

    expect(result.successCount).toBe(2)
    expect(result.pages[0]?.bodyText).toContain(`[附件未读取] (${base}/manual.pdf)`)
    expect(requests).not.toContain(`${base}/manual.pdf`)
  })

  it('follows a root-to-www redirect but blocks an external redirect before following it', async () => {
    const base = 'https://example.com'
    const www = 'https://www.example.com'
    const normal = mockFetch((url) => {
      if (url.toString() === `${base}/robots.txt` || url.toString() === `${base}/sitemap.xml`) return missing()
      if (url.toString() === `${base}/`) return new Response('', { status: 302, headers: { location: `${www}/` } })
      if (url.toString() === `${www}/`) return html('<p>官网正文</p>', '首页')
      return missing()
    })
    const normalResult = await crawlWebsite(base, { fetch: normal.fetch })
    expect(normalResult.successCount).toBe(1)
    expect(normal.requests).toContain(`${www}/`)
    expect(normal.inits.every((init) => init.redirect === 'manual')).toBe(true)

    const external = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return new Response('', { status: 302, headers: { location: 'https://evil.example/' } })
      throw new Error('external URL was followed')
    })
    const externalResult = await crawlWebsite(base, { fetch: external.fetch })
    expect(externalResult.status).toBe('failed')
    expect(externalResult.failedCount).toBe(1)
    expect(external.requests).not.toContain('https://evil.example/')
  })

  it('does not expand to www from a link without an actual root/www redirect', async () => {
    const base = 'https://example.com'
    const www = 'https://www.example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.toString() === `${base}/`) return html(`<p>首页</p><a href="${www}/about">www关于</a>`, '首页')
      if (url.toString() === `${www}/about`) return html('<p>不应读取</p>', 'www')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(1)
    expect(requests).not.toContain(`${www}/about`)
  })

  it('deduplicates pages by their final URL after an internal redirect', async () => {
    const base = 'https://example.com'
    const { fetch } = mockFetch((url) => {
      if (url.pathname === '/robots.txt') return missing()
      if (url.pathname === '/sitemap.xml') return new Response(`<urlset><url><loc>${base}/old</loc></url><url><loc>${base}/new</loc></url></urlset>`, { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/') return html('<p>首页</p>', '首页')
      if (url.pathname === '/old') return new Response('', { status: 301, headers: { location: `${base}/new` } })
      if (url.pathname === '/new') return html('<p>新地址正文</p>', '新地址')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(2)
    expect(result.pages.map((page) => page.url)).toEqual([`${base}/`, `${base}/new`])
    expect(new Set(result.pages.map((page) => page.url)).size).toBe(result.pages.length)
  })

  it('does not follow page redirects to login routes or attachments', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/service">服务</a>', '首页')
      if (url.pathname === '/service') return new Response('', { status: 302, headers: { location: `${base}/login` } })
      if (url.pathname === '/login') throw new Error('login redirect target was fetched')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(requests).toContain(`${base}/service`)
    expect(requests).not.toContain(`${base}/login`)
  })

  it('keeps trailing-slash attachments blocked in links and redirects', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/manual.pdf/">手册</a><a href="/download">下载</a>', '首页')
      if (url.pathname === '/download') return new Response('', { status: 302, headers: { location: `${base}/manual.pdf/` } })
      if (url.pathname === '/manual.pdf/') throw new Error('attachment redirect target was fetched')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(result.pages[0]?.bodyText).toContain(`[附件未读取] (${base}/manual.pdf/)`)
    expect(requests).toContain(`${base}/download`)
    expect(requests).not.toContain(`${base}/manual.pdf/`)
  })

  it('keeps an /a to /a/ to /a redirect cycle as a failed page', async () => {
    const base = 'https://example.com'
    const { fetch, requests } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<a href="/a">循环</a>', '首页')
      if (url.pathname === '/a') return new Response('', { status: 301, headers: { location: `${base}/a/` } })
      if (url.pathname === '/a/') return new Response('', { status: 301, headers: { location: `${base}/a` } })
      return missing()
    })

    const result = await crawlWebsite(base, { fetch })

    expect(result.successCount).toBe(1)
    expect(result.failedCount).toBe(1)
    expect(result.pages[1]?.error).toBe('官网跳转次数过多')
    expect(requests).toEqual([`${base}/robots.txt`, `${base}/sitemap.xml`, `${base}/`, `${base}/a`, `${base}/a/`])
  })

  it('preserves block structure and explicitly marks body truncation', async () => {
    const base = 'https://example.com'
    const { fetch } = mockFetch((url) => {
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return missing()
      if (url.pathname === '/') return html('<h1>标题</h1><p>第一段内容</p><ul><li>项目一</li><li>项目二</li></ul><table><tr><th>列一</th><th>列二</th></tr><tr><td>值一</td><td>值二</td></tr></table>', '结构')
      return missing()
    })

    const result = await crawlWebsite(base, { fetch, maxBodyChars: 200 })
    const body = result.pages[0]?.bodyText ?? ''

    expect(body).toContain('标题')
    expect(body).toContain('项目一')
    expect(body).toContain('列一')
    expect(result.incomplete).toBe(false)

    const truncated = await crawlWebsite(base, { fetch, maxBodyChars: 24 })
    expect(truncated.pages[0]?.bodyText).toContain('[正文因长度限制未完整保存]')
    expect(truncated.incomplete).toBe(true)
    expect(truncated.error).toContain('不完整')
  })
})
