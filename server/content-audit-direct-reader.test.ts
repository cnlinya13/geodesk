import { describe, expect, it } from 'vitest'
import {
  DirectWebsiteReader,
  DirectWebsiteReaderError,
  directWebsiteReaderToolDefinition,
  directWebsiteToolOutput,
  directWebsiteToolError,
  type DirectWebsiteReaderOptions,
} from './content-audit-direct-reader.ts'
import type { PublicAddress, SafeRequestTransport } from './technical-audit-http.ts'

const publicAddress: PublicAddress = { address: '93.184.216.34', family: 4 }

function reader(transport: SafeRequestTransport, options: Partial<DirectWebsiteReaderOptions> = {}): DirectWebsiteReader {
  return new DirectWebsiteReader('https://example.test/root?view=a', {
    resolveHost: async () => [publicAddress],
    transport,
    ...options,
  })
}

function response(status: number, body: string | Buffer, contentType = 'text/html'): Awaited<ReturnType<SafeRequestTransport>> {
  return { status, headers: { 'content-type': contentType }, body: Buffer.isBuffer(body) ? body : Buffer.from(body) }
}

describe('direct website reader', () => {
  it('describes only fixed Sitemap-table HTML reads for the production tool', () => {
    const definition = directWebsiteReaderToolDefinition() as {
      description: string
      parameters: { properties: { url: { description: string } } }
    }
    expect(definition.description).toBe('程序已完成Sitemap固定表；仅读取程序列出的固定表内一页公开HTML页面，不扩充固定清单、不读取Sitemap XML、附件、登录页或表外地址。必须使用模型选择的固定表URL；返回实际最终URL、标题、正文、受限链接及临时读取标识。')
    expect(definition.parameters.properties.url.description).toBe('程序Sitemap固定表中的公开HTML页面绝对HTTP(S)地址；不要填写表外链接、Sitemap XML、附件或登录地址。')
  })

  it('keeps ordinary query strings distinct while redacting credentials in errors', async () => {
    const requested: string[] = []
    const read = reader(async (url) => {
      requested.push(url.toString())
      if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
      return response(200, `<html><head><title>${url.search}</title></head><body>正文${url.search}</body></html>`)
    })

    const first = await read.readPage('https://example.test/root?view=a')
    const second = await read.readPage('https://example.test/root?view=b')
    expect(first.url).toBe('https://example.test/root?view=a')
    expect(second.url).toBe('https://example.test/root?view=b')
    expect(first.text).not.toBe(second.text)
    expect(requested).toContain('https://example.test/root?view=a')
    expect(requested).toContain('https://example.test/root?view=b')

    await expect(read.readPage('https://user:password@example.test/root?view=a')).rejects.toMatchObject({ code: 'invalid_url' })
    try {
      await read.readPage('https://user:password@example.test/root?token=secret')
    } catch (error) {
      expect(error).toBeInstanceOf(DirectWebsiteReaderError)
      expect((error as DirectWebsiteReaderError).url).not.toContain('password')
      expect((error as DirectWebsiteReaderError).url).not.toContain('secret')
    }
    expect(directWebsiteToolError(new Error('bad'), 'https://example.test/root?token=secret')).toMatchObject({ url: 'https://example.test/root?token=%5BREDACTED%5D' })
  })

  it('marks a link cap as a failed incomplete read instead of silently truncating discovery', async () => {
    const anchors = Array.from({ length: 2_001 }, (_, index) => `<a href="/root/page-${index}">p</a>`).join('')
    const read = reader(async (url) => url.pathname === '/root/robots.txt'
      ? response(404, '', 'text/plain')
      : response(200, `<html><body>${anchors}</body></html>`))

    await expect(read.readPage('https://example.test/root?view=a')).rejects.toMatchObject({ code: 'link_limit' })
    expect(read.coverage().limitReached).toBe(true)
    expect(read.coverage().failedUrls.at(-1)?.code).toBe('link_limit')
    expect(read.coverage().readUrls).toEqual([])
  })

  it('reads only same-root sitemap XML for page discovery and rejects external entities', async () => {
    const requested: string[] = []
    const read = reader(async (url) => {
      requested.push(url.toString())
      if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
      if (url.pathname === '/root/sitemap.xml') return response(200, '<?xml version="1.0"?><urlset><url><loc>https://example.test/root/page?view=b</loc></url></urlset>', 'application/xml')
      return response(200, '<html><head><title>页面</title></head><body>连续原句</body></html>')
    })

    const sitemap = await read.readPage('https://example.test/root/sitemap.xml')
    expect(sitemap.isSitemap).toBe(true)
    expect(sitemap.links).toEqual(['https://example.test/root/page?view=b'])
    await read.readPage('https://example.test/root/page?view=b')
    expect(requested).toContain('https://example.test/root/sitemap.xml')
    expect(read.coverage().readUrls).toEqual(['https://example.test/root/page?view=b'])
    expect(read.getPage('https://example.test/root/sitemap.xml')?.isSitemap).toBe(true)

    const blocked = reader(async (url) => url.pathname === '/root/robots.txt'
      ? response(404, '', 'text/plain')
      : response(200, '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset><url><loc>https://example.test/root/page</loc></url></urlset>', 'application/xml'))
    await expect(blocked.readPage('https://example.test/root/sitemap.xml')).rejects.toMatchObject({ code: 'sitemap_entity_blocked' })
  })

  it('exposes same-root robots sitemap declarations as navigation without fetching them early', async () => {
    const requested: string[] = []
    const sitemap = 'https://example.test/root/declared-sitemap.xml'
    const read = reader(async (url) => {
      requested.push(url.toString())
      if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`, 'text/plain')
      if (url.pathname === '/root/declared-sitemap.xml') return response(200, '<?xml version="1.0"?><urlset><url><loc>https://example.test/root/page</loc></url></urlset>', 'application/xml')
      return response(200, '<html><body>根页面正文</body></html>')
    })

    const rootPage = await read.readPage('https://example.test/root?view=a')
    expect(rootPage.links).toContain(sitemap)
    expect(requested).not.toContain(sitemap)
    expect(read.coverage().discoveredUrls).not.toContain(sitemap)

    await read.readPage(sitemap)
    expect(requested).toContain(sitemap)
    expect(read.coverage().readUrls).toEqual(['https://example.test/root?view=a'])
  })

  it('does not mistake ordinary public sitemap paths for external entity declarations', async () => {
    const read = reader(async (url) => {
      if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
      if (url.pathname === '/root/sitemap.xml') {
        return response(200, '<?xml version="1.0"?><urlset><url><loc>https://example.test/root/public/foo</loc></url></urlset>', 'application/xml')
      }
      return response(200, '<html><body>公开页面正文</body></html>')
    })

    const sitemap = await read.readPage('https://example.test/root/sitemap.xml')
    expect(sitemap.links).toEqual(['https://example.test/root/public/foo'])
  })

  it('records same-root attachments and login links as unread gaps without fetching them', async () => {
    const requested: string[] = []
    const read = reader(async (url) => {
      requested.push(url.toString())
      if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
      return response(200, '<html><body>公开正文<a href="/root/manual.pdf">手册</a><a href="/root/account">登录</a></body></html>')
    })

    const page = await read.readPage('https://example.test/root?view=a')
    expect(page.links).toEqual([])
    expect(page.unreadLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.test/root/manual.pdf', sourceUrl: 'https://example.test/root?view=a' }),
      expect.objectContaining({ url: 'https://example.test/root/account', sourceUrl: 'https://example.test/root?view=a' }),
    ]))
    expect(requested).not.toContain('https://example.test/root/manual.pdf')
    expect(requested).not.toContain('https://example.test/root/account')
    expect(read.coverage().unreadUrls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://example.test/root/manual.pdf' }),
      expect.objectContaining({ url: 'https://example.test/root/account' }),
    ]))
    expect(directWebsiteToolOutput(page)).toMatchObject({ unread_links: expect.any(Array) })
  })

  it('rejects HTTP 200 login and browser-challenge pages as unreadable anonymous content', async () => {
    const login = reader(async (url) => url.pathname === '/root/robots.txt'
      ? response(404, '', 'text/plain')
      : response(200, '<html><body><form class="login-wall"><input type="password"><p>登录后查看全文</p></form></body></html>'))
    await expect(login.readPage('https://example.test/root?view=login')).rejects.toMatchObject({ code: 'login_blocked' })

    const challenge = reader(async (url) => url.pathname === '/root/robots.txt'
      ? response(404, '', 'text/plain')
      : response(200, '<html><body><div class="cf-chl">Just a moment... Checking your browser</div></body></html>'))
    await expect(challenge.readPage('https://example.test/root?view=challenge')).rejects.toMatchObject({ code: 'challenge_blocked' })
  })

  it('refuses malformed UTF-8 instead of validating evidence against replacement characters', async () => {
    const read = reader(async (url) => url.pathname === '/root/robots.txt'
      ? response(404, '', 'text/plain')
      : response(200, Buffer.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e])))
    await expect(read.readPage('https://example.test/root?view=a')).rejects.toMatchObject({ code: 'invalid_encoding' })
  })

  it('retains the final query after a same-origin redirect while checking every hop', async () => {
    const requested: string[] = []
    const read = reader(async (url) => {
      requested.push(url.toString())
      if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
      if (url.pathname === '/root' && url.search === '?view=a') return { ...response(302, ''), headers: { location: '/root/final?view=b' } }
      return response(200, '<html><head><title>最终页面</title></head><body>最终原句</body></html>')
    })
    const page = await read.readPage('https://example.test/root?view=a')
    expect(page.url).toBe('https://example.test/root/final?view=b')
    expect(requested).toContain('https://example.test/root/final?view=b')
  })

  it('builds a deduplicated fixed page baseline from an index and child sitemaps without counting XML', async () => {
    const root = 'https://example.test/root'
    const index = `${root}/manifest-root`
    const childOne = `${root}/maps/one`
    const childTwo = `${root}/maps/two`
    const pages = Array.from({ length: 28 }, (_, index) => `${root}/page-${index + 1}`)
    const requested: string[] = []
    const xml = (kind: 'sitemapindex' | 'urlset', urls: string[]): string => kind === 'sitemapindex'
      ? `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`
      : `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nAllow: /\nSitemap: ${index}\n`, 'text/plain')
        if (url.toString() === index) return response(200, xml('sitemapindex', [childOne, childTwo, childOne]), 'application/xml')
        if (url.toString() === childOne) return response(200, xml('urlset', pages.slice(0, 14)), 'application/xml')
        if (url.toString() === childTwo) return response(200, xml('urlset', [...pages.slice(14), pages[0]]), 'application/xml')
        return response(200, '<html><body>正文</body></html>')
      },
    })

    await read.prepareBaseline()
    expect(requested).toEqual([`${root}/robots.txt`, index, childOne, childTwo])
    expect(read.coverage()).toMatchObject({ baselineReady: true, baselineCount: 29, baselineSource: 'sitemap', requestCount: 4, toolReadCount: 0 })
    expect(read.coverage().discoveredUrls).toHaveLength(29)
    expect(read.coverage().discoveredUrls).not.toContain(index)
    expect(read.coverage().discoveredUrls).not.toContain(childOne)
    expect(read.coverage().readUrls).toEqual([])

    await read.readPage(root)
    for (const url of pages.slice(0, 7)) await read.readPage(url)
    expect(read.coverage().discoveredUrls).toHaveLength(29)
    expect(read.coverage().readUrls).toHaveLength(8)
    expect(read.coverage().pendingUrls).toHaveLength(21)

    const requestsBeforeOutsideRead = [...requested]
    await expect(read.readPage(`${root}/newly-linked-page`)).rejects.toMatchObject({ code: 'scope_blocked' })
    expect(requested).toEqual(requestsBeforeOutsideRead)
    expect(read.coverage().discoveredUrls).toHaveLength(29)
    expect(read.coverage().readUrls).toHaveLength(8)
  })

  it('reads more than forty content resources when manifest overhead is included', async () => {
    const root = 'https://example.test/root'
    const index = `${root}/manifest-root`
    const childOne = `${root}/maps/one`
    const childTwo = `${root}/maps/two`
    const pages = Array.from({ length: 45 }, (_, index) => `${root}/page-${index + 1}`)
    const requested: string[] = []
    const xml = (kind: 'sitemapindex' | 'urlset', urls: string[]): string => kind === 'sitemapindex'
      ? `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`
      : `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nSitemap: ${index}\n`, 'text/plain')
        if (url.toString() === index) return response(200, xml('sitemapindex', [childOne, childTwo]), 'application/xml')
        if (url.toString() === childOne) return response(200, xml('urlset', pages.slice(0, 22)), 'application/xml')
        if (url.toString() === childTwo) return response(200, xml('urlset', pages.slice(22)), 'application/xml')
        return response(200, '<html><head><title>页面</title></head><body>正文</body></html>')
      },
    })

    await read.prepareBaseline()
    for (const url of [root, ...pages]) await read.readPage(url)

    expect(requested.length).toBeGreaterThan(40)
    expect(read.coverage()).toMatchObject({
      baselineReady: true,
      baselineCount: 46,
      requestCount: 50,
      toolReadCount: 46,
      limitReached: false,
    })
    expect(read.coverage().pendingUrls).toEqual([])
  })

  it('keeps failed pages in the denominator and never retries a failed URL', async () => {
    const root = 'https://example.test/root'
    const sitemap = `${root}/sitemap.xml`
    const failedPage = `${root}/missing`
    let pageRequests = 0
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nSitemap: ${sitemap}\n`, 'text/plain')
        if (url.toString() === sitemap) return response(200, `<urlset><url><loc>${root}</loc></url><url><loc>${root}/good</loc></url><url><loc>${failedPage}</loc></url></urlset>`, 'application/xml')
        pageRequests += 1
        if (url.toString() === failedPage) return response(503, 'temporarily unavailable')
        return response(200, '<html><body>正文</body></html>')
      },
    })
    await read.prepareBaseline()
    await read.readPage(root)
    await read.readPage(`${root}/good`)
    await expect(read.readPage(failedPage)).rejects.toMatchObject({ code: 'http_error' })
    const afterFailure = read.coverage()
    expect(afterFailure.discoveredUrls).toHaveLength(3)
    expect(afterFailure.readUrls).toHaveLength(2)
    expect(afterFailure.failedPageUrls).toEqual([expect.objectContaining({ url: failedPage })])
    expect(afterFailure.pendingUrls).toEqual([])
    await expect(read.readPage(failedPage)).rejects.toMatchObject({ code: 'http_error' })
    expect(pageRequests).toBe(3)
  })

  it('fails explicitly when robots and conventional sitemap are both absent', async () => {
    const root = 'https://example.test/root'
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt' || url.pathname === '/root/sitemap.xml') return response(404, '', 'text/plain')
        if (url.toString() === root) return response(200, '<html><body>首页</body></html>')
        return response(200, '<html><body>正文</body></html>')
      },
    })
    await expect(read.prepareBaseline()).rejects.toMatchObject({ code: 'sitemap_missing' })
    expect(read.coverage()).toMatchObject({ baselineReady: false, baselineCount: 0 })
    expect(read.coverage().baselineSource).toBeUndefined()
    expect(read.coverage().discoveredUrls).toEqual([root])
    expect(read.coverage().readUrls).toEqual([])
    expect(requested).toEqual([`${root}/robots.txt`, `${root}/sitemap.xml`])
    expect(read.coverage().failedUrls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${root}/sitemap.xml`, code: 'sitemap_missing' }),
    ]))
  })

  it('keeps sitemap attachment and login rows in the fixed denominator as explicit no-network failures', async () => {
    const root = 'https://example.test/root'
    const sitemap = `${root}/sitemap.xml`
    const attachment = `${root}/manual.pdf`
    const login = `${root}/account`
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
        if (url.toString() === sitemap) return response(200, `<urlset><url><loc>${root}</loc></url><url><loc>${root}/good</loc></url><url><loc>${attachment}</loc></url><url><loc>${login}</loc></url></urlset>`, 'application/xml')
        return response(200, '<html><body>正文</body></html>')
      },
    })

    await read.prepareBaseline()
    expect(read.coverage()).toMatchObject({ baselineReady: true, baselineCount: 4, baselineSource: 'sitemap' })
    expect(read.coverage().discoveredUrls).toEqual([root, `${root}/good`, attachment, login])
    expect(read.coverage().failedPageUrls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: attachment, code: 'attachment_blocked' }),
      expect.objectContaining({ url: login, code: 'login_blocked' }),
    ]))
    expect(read.coverage().unreadUrls).toEqual([])
    expect(requested).toEqual([`${root}/robots.txt`, sitemap])

    await expect(read.readPage(attachment)).rejects.toMatchObject({ code: 'attachment_blocked' })
    await expect(read.readPage(login)).rejects.toMatchObject({ code: 'login_blocked' })
    expect(requested).toEqual([`${root}/robots.txt`, sitemap])
    expect(read.coverage().toolReadCount).toBe(0)
  })

  it('ignores post-baseline HTML links, linked XML and blocked resources outside the fixed table', async () => {
    const root = 'https://example.test/root'
    const sitemap = `${root}/sitemap.xml`
    const fixedPage = `${root}/fixed`
    const outsidePage = `${root}/new-from-html`
    const outsideSitemap = `${root}/linked-bad-sitemap.xml`
    const outsideAttachment = `${root}/manual.pdf`
    const outsideLogin = `${root}/account`
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
        if (url.toString() === sitemap) return response(200, `<urlset><url><loc>${root}</loc></url><url><loc>${fixedPage}</loc></url></urlset>`, 'application/xml')
        if (url.toString() === root) return response(200, `<html><body>根页面<a href="${fixedPage}">固定页</a><a href="${outsidePage}">新页面</a><a href="${outsideSitemap}">坏站点地图</a><a href="${outsideAttachment}">附件</a><a href="${outsideLogin}">登录</a></body></html>`)
        return response(200, '<html><body>固定正文</body></html>')
      },
    })

    await read.prepareBaseline()
    const page = await read.readPage(root)
    expect(page.links).toEqual([fixedPage])
    expect(read.coverage().discoveredUrls).toEqual([root, fixedPage])
    expect(read.coverage().failedUrls).toEqual([])
    expect(read.coverage().unreadUrls).toEqual([])
    expect(requested).toEqual([`${root}/robots.txt`, sitemap, root])

    await expect(read.readPage(outsidePage)).rejects.toMatchObject({ code: 'scope_blocked' })
    await expect(read.readPage(outsideSitemap)).rejects.toMatchObject({ code: 'scope_blocked' })
    expect(requested).toEqual([`${root}/robots.txt`, sitemap, root])
  })

  it('keeps redirects as fixed-row reads while exposing the final URL as a getPage alias', async () => {
    const root = 'https://example.test/root'
    const sitemap = `${root}/sitemap.xml`
    const redirect = `${root}/redirect`
    const final = `${root}/final`
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
        if (url.toString() === sitemap) return response(200, `<urlset><url><loc>${root}</loc></url><url><loc>${redirect}</loc></url><url><loc>${final}</loc></url></urlset>`, 'application/xml')
        if (url.toString() === redirect) return { ...response(302, ''), headers: { location: '/root/final' } }
        return response(200, '<html><head><title>最终标题</title></head><body>最终正文</body></html>')
      },
    })

    await read.prepareBaseline()
    const page = await read.readPage(redirect)
    expect(page.url).toBe(final)
    expect(page.title).toBe('最终标题')
    expect(page.text).toContain('最终正文')
    expect(read.coverage().discoveredUrls).toEqual([root, redirect, final])
    expect(read.coverage().readUrls).toEqual([redirect, final])
    expect(read.getPage(redirect)?.url).toBe(final)
    expect(read.getPage(final)?.url).toBe(final)

    const requestsAfterFirstRead = [...requested]
    await read.readPage(final)
    expect(requested).toEqual(requestsAfterFirstRead)
    expect(read.coverage().readUrls).toEqual([redirect, final])
  })

  it('does not add an in-scope redirect final alias outside the fixed table', async () => {
    const root = 'https://example.test/root'
    const sitemap = `${root}/sitemap.xml`
    const redirect = `${root}/redirect`
    const final = `${root}/final-not-listed`
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(404, '', 'text/plain')
        if (url.toString() === sitemap) return response(200, `<urlset><url><loc>${root}</loc></url><url><loc>${redirect}</loc></url></urlset>`, 'application/xml')
        if (url.toString() === redirect) return { ...response(302, ''), headers: { location: '/root/final-not-listed' } }
        return response(200, '<html><head><title>别名页面</title></head><body>别名正文</body></html>')
      },
    })

    await read.prepareBaseline()
    const page = await read.readPage(redirect)
    expect(page.url).toBe(final)
    expect(read.coverage().discoveredUrls).toEqual([root, redirect])
    expect(read.coverage().readUrls).toEqual([redirect])
    expect(read.getPage(final)?.text).toContain('别名正文')
    const requestsAfterFirstRead = [...requested]
    await expect(read.readPage(final)).rejects.toMatchObject({ code: 'scope_blocked' })
    expect(requested).toEqual(requestsAfterFirstRead)
  })

  it('does not turn a malformed declared child sitemap into a successful links baseline', async () => {
    const root = 'https://example.test/root'
    const index = `${root}/index-manifest`
    const child = `${root}/child-without-an-xml-name`
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nSitemap: ${index}\n`, 'text/plain')
        if (url.toString() === index) return response(200, `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`, 'application/xml')
        if (url.toString() === child) return response(200, '<urlset><url><loc>https://example.test/root/missing', 'application/xml')
        return response(200, '<html><body>正文</body></html>')
      },
    })
    await expect(read.prepareBaseline()).rejects.toMatchObject({ code: 'sitemap_invalid' })
    expect(read.coverage().baselineReady).toBe(false)
    expect(read.coverage().baselineSource).toBeUndefined()
    expect(read.coverage().failedUrls).toEqual(expect.arrayContaining([expect.objectContaining({ url: child, code: 'sitemap_invalid' })]))
    expect(read.coverage().discoveredUrls).toEqual([root])
  })

  it('fails the baseline when an index declares a blocked login child instead of recording it as an unread page', async () => {
    const root = 'https://example.test/root'
    const index = `${root}/index-manifest`
    const blockedChild = `${root}/account`
    const requested: string[] = []
    const read = new DirectWebsiteReader(root, {
      resolveHost: async () => [publicAddress],
      transport: async (url) => {
        requested.push(url.toString())
        if (url.pathname === '/root/robots.txt') return response(200, `User-agent: *\nSitemap: ${index}\n`, 'text/plain')
        if (url.toString() === index) return response(200, `<sitemapindex><sitemap><loc>${blockedChild}</loc></sitemap></sitemapindex>`, 'application/xml')
        return response(200, '<html><body>不应读取</body></html>')
      },
    })

    await expect(read.prepareBaseline()).rejects.toMatchObject({ code: 'sitemap_scope_blocked' })
    expect(read.coverage().baselineReady).toBe(false)
    expect(read.coverage().unreadUrls).toEqual([])
    expect(read.coverage().failedUrls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: index, code: 'sitemap_scope_blocked' }),
    ]))
    expect(requested).toEqual([`${root}/robots.txt`, index])
  })
})
