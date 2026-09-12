import { parse } from 'node-html-parser'
import {
  SafeAuditHttpClient,
  TechnicalAuditHttpError,
  type PublicAddress,
  type SafeRequestTransport,
} from './technical-audit-http.ts'

/** A source URL returned by the provider's web-search annotations. */
export type ContentAuditSourceCandidate = {
  url: string
  name?: string | null
  origin?: string | null
  versionAt?: string | null
  quote?: string | null
  snippet?: string | null
  authorityReason?: string | null
}

/**
 * The body returned by the safe source reader.  `text` is complete extracted
 * HTML text (within the explicit transport limits); this adapter never slices
 * it to fit a model prompt.
 */
export type ContentAuditFetchedSource = {
  requestedUrl: string
  finalUrl: string
  name: string
  contentType: string
  text: string
  title: string | null
  elapsedMs: number
}

export type ContentAuditSourceReadOptions = {
  /** Testable network seams. The default transport is the SSRF-safe client. */
  transport?: SafeRequestTransport
  resolveHost?: (hostname: string) => Promise<PublicAddress[]>
  maxRequests?: number
  timeoutMs?: number
  totalTimeoutMs?: number
  maxDecompressedBytes?: number
  maxWireBytes?: number
  maxRedirects?: number
  maxTextChars?: number
}

export class ContentAuditSourceError extends Error {
  readonly code: string
  readonly url: string
  readonly httpStatus?: number

  constructor(code: string, message: string, url: string, httpStatus?: number) {
    super(message)
    this.name = 'ContentAuditSourceError'
    this.code = code
    this.url = redactUrl(url)
    this.httpStatus = httpStatus
  }
}

const DEFAULT_MAX_TEXT_CHARS = 500_000
const ATTACHMENT_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|bz2|csv|json|xml|rss|atom|jpe?g|png|gif|webp|svg|ico|bmp|mp[34]|mov|avi|wav|ogg|webm|exe|dmg|apk)(?:$|[?#])/i

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return String(value).split(/[?#]/, 1)[0] ?? ''
  }
}

function evidenceUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return String(value).split('#', 1)[0] ?? ''
  }
}

function parsePublicHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ContentAuditSourceError('invalid_url', '外部来源地址不是有效URL', value)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ContentAuditSourceError('invalid_url', '外部来源只支持HTTP或HTTPS', value)
  }
  if (url.username || url.password || !url.hostname) {
    throw new ContentAuditSourceError('invalid_url', '外部来源地址格式不受支持', value)
  }
  // Reject names which should never be treated as public even when a test or
  // custom resolver accidentally returns an address for them. The safe HTTP
  // client additionally validates every resolved address.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'local') {
    throw new ContentAuditSourceError('private_address', '外部来源地址不是公网地址', value)
  }
  url.hash = ''
  return url
}

export function isContentAuditAttachmentUrl(value: string): boolean {
  try {
    return ATTACHMENT_EXTENSIONS.test(new URL(value).pathname)
  } catch {
    return ATTACHMENT_EXTENSIONS.test(value)
  }
}

function contentType(headers: Record<string, string>): string {
  return (headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function declaredCharset(headers: Record<string, string>, html: Buffer): string | null {
  const header = headers['content-type'] ?? ''
  const fromHeader = header.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
  if (fromHeader) return fromHeader
  // A small bounded scan is enough to find the declaration without decoding a
  // potentially hostile full body as UTF-8 first. HTML meta declarations are
  // ASCII-compatible even when the actual document is GBK/GB18030.
  const prefix = html.subarray(0, Math.min(html.byteLength, 16_384)).toString('latin1')
  const fromMeta = prefix.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>]+)/i)?.[1]
    ?? prefix.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)/i)?.[1]
  return fromMeta || null
}

function decodeHtmlBody(body: Buffer, headers: Record<string, string>): string {
  const charset = declaredCharset(headers, body)?.trim().toLowerCase() || 'utf-8'
  try {
    // Node's WHATWG TextDecoder includes gbk/gb18030 on supported runtimes;
    // unlike Buffer#toString('utf8'), this preserves declared Chinese pages.
    return new TextDecoder(charset, { fatal: false }).decode(body)
  } catch {
    throw new ContentAuditSourceError('unsupported_charset', '外部来源字符编码不受支持', '')
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function isLoginWallText(value: string): boolean {
  return /(?:请|需|需要|必须|先)?\s*(?:登录|登入|sign\s*in|log\s*in|login)\s*(?:后|之后|才能|方可|才可)\s*(?:(?:查看|浏览)(?:全文|此内容|该内容|本文|详情|页面|更多)|访问(?:本站|此页面|该内容|全文)|继续(?:访问|阅读|浏览)|下载(?:附件|文件|内容))|(?:未登录|仅限登录)/iu.test(value)
}

/** Remove executable/non-content nodes before exposing source text to a model. */
function htmlToText(html: string): { text: string; title: string | null; hasLoginForm: boolean; hasPublicContent: boolean } {
  let document
  try {
    document = parse(html)
  } catch {
    throw new ContentAuditSourceError('html_parse_failed', '外部来源HTML无法解析', '')
  }
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg', 'canvas']) {
    for (const node of document.querySelectorAll(selector)) node.remove()
  }
  const titleText = document.querySelector('title')?.textContent
  const title = titleText ? normalizeText(titleText).slice(0, 500) || null : null
  const body = document.querySelector('body')
  const text = normalizeText(body?.textContent ?? document.textContent)
  const loginMarker = /(?:登录|登入|sign\s*in|log\s*in|login)/iu.test(text)
  const passwordField = document.querySelectorAll('input[type="password"], input[name*="password" i], input[id*="password" i]').length > 0
  const identityField = document.querySelectorAll('input[name*="user" i], input[id*="user" i], input[name*="account" i], input[id*="account" i], input[type="email"]').length > 0
  // A public article can contain a hidden/sidebar login form. Remove forms
  // only for this signal and retain the article text; an actual login page
  // normally has no substantial non-form body to expose.
  const forms = document.querySelectorAll('form')
  for (const form of forms) form.remove()
  const nonFormText = normalizeText(body?.textContent ?? document.textContent)
  const semanticContent = document.querySelectorAll('main, article, [role="main"], [itemprop="articleBody"], .article, .post, .entry-content, .content')
    .some((node) => {
      const blocks = node.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')
      const texts = blocks.length > 0 ? blocks.map((block) => normalizeText(block.textContent)) : [normalizeText(node.textContent)]
      return texts.some((value) => value.length >= 20 && !isLoginWallText(value))
    })
  const hasPublicContent = semanticContent || (nonFormText.length >= 240 && !isLoginWallText(nonFormText))
  // Do not reject merely because the full page contains a password input: a
  // public article often renders a sidebar/header login widget.  Credential
  // controls only count when the page has no substantial public article body.
  const hasLoginForm = passwordField && (loginMarker || identityField) && !hasPublicContent
  return { text, title, hasLoginForm, hasPublicContent }
}

function isLoginPath(value: string): boolean {
  try {
    const parts = new URL(value).pathname.toLowerCase().split('/').filter(Boolean)
    // Do not block ordinary /register, /account, /admin or article paths that
    // merely discuss authentication.  Only explicit login endpoints are
    // treated as a redirect/login-wall signal here.
    const blocked = new Set(['login', 'signin', 'sign-in', 'log-in', 'wp-login.php', 'sso'])
    return parts.some((part) => blocked.has(part) || part.startsWith('wp-login'))
  } catch {
    return false
  }
}

function looksLikeLoginPage(url: string, title: string | null, text: string, hasLoginForm: boolean, hasPublicContent: boolean): boolean {
  if (isLoginPath(url)) return true
  if (hasLoginForm) return true
  // A login wall can omit a form entirely (for example, a JS shell or an
  // access-denied page).  Require an explicit access gate phrase and no
  // independent public body; operational copy such as “登录后提交申报” is
  // not a wall when it appears in an article/main body.
  if (!hasPublicContent && isLoginWallText(text)) return true
  // Some JavaScript login shells expose only a title and credential labels,
  // without a form in the server-rendered HTML. Treat an exact auth title as
  // a login page only when no public body is present; ordinary guide titles
  // such as “公司注册办理指南” remain unaffected.
  return !hasPublicContent
    && Boolean(title && /^(?:登录|登入|sign\s*in|log\s*in|login)$/iu.test(title.trim()))
}

function sourceName(candidate: ContentAuditSourceCandidate, finalUrl: string, title: string | null): string {
  const supplied = candidate.name?.trim()
  if (supplied) return supplied.slice(0, 500)
  if (title) return title
  try { return new URL(finalUrl).hostname } catch { return '外部来源' }
}

/**
 * Fetch one public HTML source with per-origin safe transport. A new client is
 * deliberately created for each candidate: its origin and redirect policy
 * cannot be widened by a model-returned URL.
 */
export async function fetchContentAuditSource(
  candidate: ContentAuditSourceCandidate | string,
  options: ContentAuditSourceReadOptions = {},
): Promise<ContentAuditFetchedSource> {
  const rawUrl = typeof candidate === 'string' ? candidate : candidate.url
  const candidateValue: ContentAuditSourceCandidate = typeof candidate === 'string' ? { url: candidate } : candidate
  const requested = parsePublicHttpUrl(rawUrl)
  if (isContentAuditAttachmentUrl(requested.toString())) {
    throw new ContentAuditSourceError('source_not_html', '外部来源不是可读取的HTML页面', requested.toString())
  }

  const deadlineAt = Date.now() + Math.max(1, Math.floor(options.totalTimeoutMs ?? 15_000))
  let client: SafeAuditHttpClient
  try {
    client = new SafeAuditHttpClient({
      origin: requested.origin,
      deadlineAt,
      maxRequests: Math.max(1, Math.floor(options.maxRequests ?? 3)),
      timeoutMs: Math.max(1, Math.floor(options.timeoutMs ?? 5_000)),
      maxDecompressedBytes: Math.max(0, Math.floor(options.maxDecompressedBytes ?? 2 * 1024 * 1024)),
      maxWireBytes: Math.max(0, Math.floor(options.maxWireBytes ?? 8 * 1024 * 1024)),
      maxRedirects: Math.max(0, Math.floor(options.maxRedirects ?? 5)),
      resolveHost: options.resolveHost,
      transport: options.transport,
    })
  } catch (error) {
    if (error instanceof ContentAuditSourceError) throw error
    if (error instanceof TechnicalAuditHttpError) {
      throw new ContentAuditSourceError(error.code, error.message, requested.toString(), error.responseStatus)
    }
    throw new ContentAuditSourceError('client_init_failed', '外部来源请求范围初始化失败', requested.toString())
  }

  const startedAt = Date.now()
  let response
  try {
    response = await client.get(requested, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1')
  } catch (error) {
    if (error instanceof TechnicalAuditHttpError) {
      throw new ContentAuditSourceError(error.code, error.message, error.url, error.responseStatus)
    }
    throw new ContentAuditSourceError('source_fetch_failed', '外部来源读取失败', requested.toString())
  }

  if (response.status < 200 || response.status >= 300) {
    throw new ContentAuditSourceError('source_http_error', `外部来源返回HTTP ${response.status}`, response.url, response.status)
  }

  const type = contentType(response.headers)
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) {
    throw new ContentAuditSourceError('source_not_html', '外部来源不是可读取的HTML页面', response.url)
  }

  const html = decodeHtmlBody(response.body, response.headers)
  let parsed: { text: string; title: string | null; hasLoginForm: boolean; hasPublicContent: boolean }
  try {
    parsed = htmlToText(html)
  } catch (error) {
    if (error instanceof ContentAuditSourceError) {
      throw new ContentAuditSourceError(error.code, error.message, response.url)
    }
    throw new ContentAuditSourceError('html_parse_failed', '外部来源HTML无法解析', response.url)
  }
  const maxTextChars = Math.max(1, Math.floor(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS))
  if (parsed.text.length > maxTextChars) {
    throw new ContentAuditSourceError('source_text_too_large', '外部来源正文超过大小限制', response.url)
  }
  if (!parsed.text) {
    throw new ContentAuditSourceError('source_empty', '外部来源没有可读取正文', response.url)
  }
  if (looksLikeLoginPage(response.url, parsed.title, parsed.text, parsed.hasLoginForm, parsed.hasPublicContent)) {
    throw new ContentAuditSourceError('source_login_page', '外部来源需要登录或返回登录页面', response.url)
  }

  // SafeAuditHttpClient intentionally redacts query strings in its diagnostic
  // URL. For a direct (non-redirected) request, retain the actual requested
  // query so evidence links still point to the fetched government/resource
  // page. Redirected URLs remain the client-provided redacted final URL.
  const finalUrl = response.redirects.length === 0 ? requested.toString() : response.url

  return {
    requestedUrl: evidenceUrl(requested.toString()),
    finalUrl: evidenceUrl(finalUrl),
    name: sourceName(candidateValue, finalUrl, parsed.title),
    contentType: type || 'text/html',
    text: parsed.text,
    title: parsed.title,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  }
}

/** Explicit alias for callers that want to emphasize that this is public HTML. */
export const fetchPublicContentAuditSource = fetchContentAuditSource
