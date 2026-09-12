import { describe, expect, it } from 'vitest'
import {
  ContentAuditSourceError,
  fetchContentAuditSource,
} from './content-audit-source.ts'

const publicAddress = async () => [{ address: '93.184.216.34', family: 4 as const }]

function transportFor(body: string | Buffer, status = 200, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }) {
  return async () => ({ status, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(body) })
}

describe('content audit public source reader', () => {
  it('reads HTML, strips executable nodes, and preserves a direct query in evidence URLs', async () => {
    const source = await fetchContentAuditSource('https://source.test/rule?id=2026#fragment', {
      resolveHost: publicAddress,
      transport: transportFor('<html><head><title>政策原文</title></head><body><script>alert(1)</script><h1>办理条件</h1><p>申请人须满足条件。</p></body></html>'),
    })

    expect(source.requestedUrl).toBe('https://source.test/rule?id=2026')
    expect(source.finalUrl).toBe('https://source.test/rule?id=2026')
    expect(source.title).toBe('政策原文')
    expect(source.text).toContain('办理条件')
    expect(source.text).toContain('申请人须满足条件')
    expect(source.text).not.toContain('alert(1)')
  })

  it('rejects non-success responses, empty pages, and login pages as unresolved evidence', async () => {
    await expect(fetchContentAuditSource('https://source.test/missing', {
      resolveHost: publicAddress,
      transport: transportFor('<h1>不存在</h1>', 404),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_http_error', httpStatus: 404 })

    await expect(fetchContentAuditSource('https://source.test/empty', {
      resolveHost: publicAddress,
      transport: transportFor('<html><body> </body></html>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_empty' })

    await expect(fetchContentAuditSource('https://source.test/account', {
      resolveHost: publicAddress,
      transport: transportFor('<html><head><title>登录</title></head><body>用户名 密码 登录</body></html>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_login_page' })
  })

  it('does not mistake public registration or tax-operation content and header login links for a login wall', async () => {
    const source = await fetchContentAuditSource('https://source.test/company-registration', {
      resolveHost: publicAddress,
      transport: transportFor(`
        <html>
          <head><title>公司注册办理指南</title></head>
          <body>
            <header><a href="/login">登录</a></header>
            <article>
              <h1>公司注册与办税操作</h1>
              <p>办理企业登记后，可登录电子税务局提交申报。操作时请准备用户名、密码和统一社会信用代码。</p>
            </article>
            <aside aria-label="登录入口">
              <form><input name="username"><input type="password" name="password"><button>登录</button></form>
            </aside>
          </body>
        </html>`),
    })

    expect(source.title).toBe('公司注册办理指南')
    expect(source.text).toContain('办税操作')
  })

  it('allows ordinary article/main instructions that say login then submit or view progress', async () => {
    const article = await fetchContentAuditSource('https://source.test/tax-submit', {
      resolveHost: publicAddress,
      transport: transportFor('<html><body><article><h1>申报办理</h1><p>登录电子税务局后提交申报，按页面提示完成资料确认。</p></article></body></html>'),
    })
    const main = await fetchContentAuditSource('https://source.test/tax-progress', {
      resolveHost: publicAddress,
      transport: transportFor('<html><body><main><h1>进度查询</h1><p>登录后查看申报进度和历史办理记录，公开用户可直接阅读本说明。</p></main></body></html>'),
    })

    expect(article.text).toContain('登录电子税务局后提交申报')
    expect(main.text).toContain('登录后查看申报进度')
  })

  it('does not treat a long semantic login-wall shell as public article content', async () => {
    await expect(fetchContentAuditSource('https://source.test/account', {
      resolveHost: publicAddress,
      transport: transportFor('<html><head><title>登录</title></head><body><main>请登录后查看全文，输入用户名和密码继续访问本站内容。</main></body></html>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_login_page' })
  })

  it('rejects an actual credential form, an explicit login wall, and a login redirect', async () => {
    await expect(fetchContentAuditSource('https://source.test/public-guide', {
      resolveHost: publicAddress,
      transport: transportFor(`
        <html><head><title>登录</title></head><body>
          <form action="/session"><label>用户名</label><input name="username">
            <label>密码</label><input type="password" name="password"><button>登录</button>
          </form>
        </body></html>`),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_login_page' })

    await expect(fetchContentAuditSource('https://source.test/restricted-guide', {
      resolveHost: publicAddress,
      transport: transportFor('<html><body><p>请登录后查看此内容</p></body></html>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_login_page' })

    await expect(fetchContentAuditSource('https://source.test/guide', {
      resolveHost: publicAddress,
      transport: async (url) => url.pathname === '/guide'
        ? { status: 302, headers: { location: '/login' }, body: Buffer.from('') }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><body>登录</body></html>') },
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_login_page' })
  })

  it('preserves the HTTP status on authentication and other HTTP responses', async () => {
    await expect(fetchContentAuditSource('https://source.test/private', {
      resolveHost: publicAddress,
      transport: transportFor('<p>需要认证</p>', 401),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_http_error', httpStatus: 401 })

    const legacy = new ContentAuditSourceError('legacy', '旧调用', 'https://source.test/page')
    expect(legacy.httpStatus).toBeUndefined()
    const forbidden = new ContentAuditSourceError('source_http_error', '禁止访问', 'https://source.test/page', 403)
    expect(forbidden.httpStatus).toBe(403)
  })

  it('does not fetch attachments and rejects private or credentialed URLs', async () => {
    let calls = 0
    await expect(fetchContentAuditSource('https://source.test/rule.pdf', {
      resolveHost: publicAddress,
      transport: async () => { calls += 1; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>no</p>') } },
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'source_not_html' })
    expect(calls).toBe(0)

    await expect(fetchContentAuditSource('http://127.0.0.1/admin', {
      transport: transportFor('<p>blocked</p>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'private_address' })
    await expect(fetchContentAuditSource('https://user:password@source.test/rule', {
      resolveHost: publicAddress,
      transport: transportFor('<p>blocked</p>'),
    })).rejects.toMatchObject<Partial<ContentAuditSourceError>>({ code: 'invalid_url' })
  })

  it('decodes a declared GB18030 source instead of assuming UTF-8', async () => {
    // "服务" is B7 FE CE F1 in GB18030/GBK.
    const body = Buffer.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x67, 0x62, 0x31, 0x38, 0x30, 0x33, 0x30, 0x22, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0xb7, 0xfe, 0xce, 0xf1, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e])
    const source = await fetchContentAuditSource('https://source.test/gbk', {
      resolveHost: publicAddress,
      transport: transportFor(body, 200, { 'content-type': 'text/html' }),
    })
    expect(source.text).toContain('服务')
  })
})
