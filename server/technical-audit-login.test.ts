import { describe, expect, it } from 'vitest'
import { analyzeAnonymousPage } from './technical-audit-login.ts'

const requestedUrl = 'https://example.test/article'
const analyze = (html: string, finalUrl: string | null = requestedUrl) => analyzeAnonymousPage({ html, requestedUrl, finalUrl })

describe('anonymous login evidence', () => {
  it('does not treat explanatory login or captcha text as a content gate', () => {
    expect(analyze('<main><h1>电子税务局操作说明</h1><p>办理业务时，请登录电子税务局后查看申报结果。以下为具体步骤。</p><p>首先准备企业资料，按办税流程填写并核对申报内容。</p></main>')).toMatchObject({ readable: true, blocked: false, challenge: false })
    expect(analyze('<main><h1>验证码使用说明</h1><p>填写验证码后可以提交申请。如果没有收到验证码，请检查电话号码。</p></main>')).toMatchObject({ readable: true, blocked: false, challenge: false })
  })

  it('does not treat an ordinary login form or hidden gate as blocking public prose', () => {
    expect(analyze('<main><h1>服务说明</h1><p>我们提供企业登记与财税咨询服务，以下内容可以直接阅读。</p><form><input type="password"><button>登录</button></form></main>')).toMatchObject({ readable: true, blocked: false })
    expect(analyze('<main><p>公开正文，不需要登录即可阅读。</p><div hidden>请登录后查看全文</div></main>')).toMatchObject({ readable: true, blocked: false })
  })

  it('requires a clear gate structure for a full or partial login restriction', () => {
    expect(analyze('<main><h1>请登录后查看全文</h1><form><input name="username"><input type="password"><button>登录</button></form></main>')).toMatchObject({ readable: false, blocked: true })
    expect(analyze('<main><article><h1>研究报告</h1><p>这是报告的公开预览内容。</p></article><section class="login-required"><p>请登录后查看全文</p><form><input type="password"><button>登录</button></form></section></main>')).toMatchObject({ readable: true, blocked: true })
    expect(analyze('<main><p>网站若出现“登录后查看全文”，说明内容受到保护。本文介绍此类设置。</p></main>')).toMatchObject({ readable: true, blocked: false })
  })

  it('does not let a login URL override readable public content, but blocks a login replacement', () => {
    expect(analyze('<main><h1>公开文章</h1><p>这是匿名用户可以直接阅读的完整正文。</p><a href="/login">登录</a></main>', 'https://example.test/login')).toMatchObject({ readable: true, blocked: false, redirected_to_login: true })
    expect(analyze('<main><h1>登录</h1><form><input type="password"><button>登录</button></form></main>', 'https://example.test/login')).toMatchObject({ readable: false, blocked: true, redirected_to_login: true })
  })

  it('treats challenge replacement and empty/error pages as insufficient evidence', () => {
    expect(analyze('<main><div id="challenge">Verify you are human</div></main>')).toMatchObject({ readable: false, blocked: false, challenge: true })
    expect(analyze('<main><div id="challenge">请完成验证码</div></main>')).toMatchObject({ readable: false, blocked: false, challenge: true })
    expect(analyze('<main><div id="app"></div></main>')).toMatchObject({ readable: false, blocked: false, challenge: false })
    expect(analyze('<html><body><h1>404 Not Found</h1><p>Please try again.</p></body></html>')).toMatchObject({ readable: false, blocked: false })
    expect(analyze('<html><body><h1>404</h1></body></html>')).toMatchObject({ readable: false, blocked: false })
  })
})
