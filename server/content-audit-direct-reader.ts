import { randomUUID } from 'node:crypto'
import { NodeType, parse, type HTMLElement } from 'node-html-parser'
import {
  SafeAuditHttpClient,
  TechnicalAuditHttpError,
  type PublicAddress,
  type SafeRequestTransport,
} from './technical-audit-http.ts'
import { evaluateRobots, isRobotsText, parseRobots, type RobotsGroup } from './technical-audit-robots.ts'
import { analyzeAnonymousPage } from './technical-audit-login.ts'

/**
 * The content audit deliberately has a different website input boundary from
 * the old project crawler.  It does not receive a page list.  The caller may
 * explicitly prepare a sitemap/link baseline, but page bodies are otherwise
 * fetched only through the model's `read_website_page` function.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_WIRE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_TOOL_TEXT_CHARS = 500_000
const MAX_PAGE_TITLE_CHARS = 8_000
const MAX_PAGE_LINKS = 2_000

// Query strings are part of a public page's identity. Reject only
// unambiguously credential-shaped parameters; ordinary selectors and
// tracking parameters must remain in the request/evidence URL.
const CREDENTIAL_QUERY_KEY = /^(?:api[-_]?key|access[-_]?token|auth(?:entication)?|credential|cookie|jwt|password|secret|session(?:[-_]?id)?|signature|sig|token)$/iu
const UNREAD_RESOURCE_REASON = '附件或受保护资源不读取，仅记录链接和未读取缺口'

export type DirectWebsiteReaderOptions = {
  /** Test/controlled transport hook; production uses SafeAuditHttpClient. */
  transport?: SafeRequestTransport
  resolveHost?: (hostname: string) => Promise<PublicAddress[]>
  requestTimeoutMs?: number
  maxRequests?: number
  maxRedirects?: number
  maxWireBytes?: number
  maxDecompressedBytes?: number
  maxToolTextChars?: number
  /** Optional caller-owned cancellation signal for the current task. */
  signal?: AbortSignal
}

export type DirectWebsitePage = {
  /** A temporary identifier for this read; it is never persisted. */
  readId: string
  url: string
  title: string
  /** Parsed DOM text returned to the model. This is the exact text used for quote validation. */
  text: string
  /** In-scope links exposed by this actual read. */
  links: readonly string[]
  /** Same-root resources discovered from this page but deliberately not read. */
  unreadLinks?: readonly DirectWebsiteUnreadLink[]
  /** Sitemap reads are navigation evidence, not quote-bearing content pages. */
  isSitemap?: boolean
}

export type DirectWebsiteUnreadLink = {
  url: string
  sourceUrl: string
  reason: string
}

export type DirectWebsiteReadFailure = {
  url: string
  reason: string
  code?: string
}

export type DirectWebsiteCoverage = {
  rootUrl: string
  discoveredUrls: readonly string[]
  readUrls: readonly string[]
  failedUrls: readonly DirectWebsiteReadFailure[]
  /** Same-root links excluded from reading (for example attachments/login). */
  unreadUrls?: readonly DirectWebsiteUnreadLink[]
  requestCount: number
  toolReadCount: number
  limitReached: boolean
  /** True after the initial sitemap/link baseline has finished building. */
  baselineReady?: boolean
  /** Number of target content pages in the initial baseline. */
  baselineCount?: number
  baselineSource?: 'sitemap' | 'links'
  /** Target pages discovered but not read successfully or explicitly unreadable. */
  pendingUrls?: readonly string[]
  /** Failures that belong to target content pages, excluding sitemap XML. */
  failedPageUrls?: readonly DirectWebsiteReadFailure[]
}

export class DirectWebsiteReaderError extends Error {
  readonly code: string
  readonly url?: string

  constructor(code: string, message: string, url?: string) {
    super(message)
    this.name = 'DirectWebsiteReaderError'
    this.code = code
    // Error/logging URLs are a separate, redacted representation. Successful
    // page URLs retain non-sensitive query strings elsewhere for identity.
    this.url = safeErrorUrl(url)
  }
}

export type ContentAuditWebsiteReader = {
  readonly rootUrl: string
  /** Optional for compatibility with controlled readers from older tests. */
  prepareBaseline?: () => Promise<void>
  readPage(url: string): Promise<DirectWebsitePage>
  coverage(): DirectWebsiteCoverage
  getPage(url: string): DirectWebsitePage | undefined
  close(): void
}

type SafeUrl = {
  url: URL
  display: string
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof DirectWebsiteReaderError || error instanceof TechnicalAuditHttpError) return error.message
  if (error instanceof Error && error.message && !/(?:Bearer\s+|api[-_ ]?key|access[-_ ]?token|password|secret)/i.test(error.message)) return error.message
  return fallback
}

function safeErrorUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    url.hash = ''
    return url.toString()
  } catch {
    // Never copy invalid model input into a diagnostic verbatim.
    return value.split(/[?#]/u, 1)[0] || undefined
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof DirectWebsiteReaderError) return error.code
  if (error instanceof TechnicalAuditHttpError) return error.code
  const value = error as { code?: unknown } | null
  return typeof value?.code === 'string' && value.code.trim() ? value.code.trim() : undefined
}

function normalizePathname(pathname: string): string {
  const value = pathname || '/'
  if (value === '/') return '/'
  return `/${value.replace(/^\/+|\/+$/g, '')}/`
}

function parseSafeUrl(value: unknown, base?: URL): SafeUrl {
  if (typeof value !== 'string' || !value.trim()) throw new DirectWebsiteReaderError('invalid_url', '网站读取工具需要有效的HTTP或HTTPS地址')
  let url: URL
  try {
    url = base ? new URL(value.trim(), base) : new URL(value.trim())
  } catch {
    throw new DirectWebsiteReaderError('invalid_url', '网站读取工具需要有效的HTTP或HTTPS地址', safeErrorUrl(String(value)))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DirectWebsiteReaderError('invalid_url', '网站读取工具只允许HTTP或HTTPS地址', safeErrorUrl(url.toString()))
  }
  if (url.username || url.password || !url.hostname) {
    throw new DirectWebsiteReaderError('invalid_url', '网站读取地址不能包含凭据', safeErrorUrl(url.toString()))
  }
  url.hash = ''
  for (const [key, queryValue] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEY.test(key) && queryValue.trim()) {
      throw new DirectWebsiteReaderError('credential_url', '网站读取地址不能包含凭据参数', safeErrorUrl(url.toString()))
    }
  }
  return { url, display: url.toString() }
}

function safeRootUrl(value: string): SafeUrl {
  const parsed = parseSafeUrl(value)
  if (isLoginPath(parsed.url.pathname)) throw new DirectWebsiteReaderError('login_blocked', '官网根入口不能是登录或管理地址', safeErrorUrl(parsed.display))
  if (isAttachmentPath(parsed.url.pathname)) throw new DirectWebsiteReaderError('attachment_blocked', '官网根入口不能是附件地址', safeErrorUrl(parsed.display))
  return parsed
}

function isLoginPath(pathname: string): boolean {
  const blocked = new Set(['login', 'signin', 'sign-in', 'logout', 'register', 'signup', 'sign-up', 'account', 'auth', 'admin', 'wp-admin', 'wp-login.php'])
  return pathname.toLowerCase().split('/').filter(Boolean).some((part) => blocked.has(part) || part.startsWith('wp-login'))
}

function isAttachmentPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/u, '')
  if (isSitemapPath(normalized)) return false
  return /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|bz2|csv|json|xml|rss|atom|jpe?g|png|gif|webp|svg|ico|bmp|mp[34]|mov|avi|wav|ogg|webm|exe|dmg|apk)$/iu.test(normalized)
}

function isSitemapPath(pathname: string): boolean {
  // Sitemap URLs are commonly named `sitemap.xml`, `sitemap-index.xml` or
  // `declared-sitemap.xml`; rely on the path's sitemap marker rather than one
  // exact filename.  The response content type still decides whether XML is
  // parsed as a navigation manifest.
  return /(?:^|\/)[^/]*sitemap[^/]*\.xml$/iu.test(pathname.replace(/\/+$/u, ''))
}

type ParsedPageContent = {
  title: string
  text: string
  links: string[]
  unreadLinks: DirectWebsiteUnreadLink[]
  linksLimitReached: boolean
  isSitemap: boolean
  sitemapKind?: 'index' | 'urlset'
}

function externalXmlEntity(value: string): boolean {
  // The parser does not fetch entities, but rejecting declarations up front
  // makes the no-external-entity policy explicit and parser-independent.
  return /<!DOCTYPE\b|<!ENTITY\b/iu.test(value)
}

function xmlLocalName(value: string): string {
  const separator = value.lastIndexOf(':')
  return value.slice(separator + 1).toLowerCase()
}

function invalidXml(message = '站点地图XML格式无效'): DirectWebsiteReaderError {
  return new DirectWebsiteReaderError('sitemap_invalid', message)
}

function validateXmlText(value: string): void {
  // node-html-parser is intentionally an HTML parser and accepts malformed
  // XML (including unclosed elements).  Validate the small XML grammar we
  // need before using its tree so malformed manifests cannot silently become
  // a partial page baseline.
  const stack: string[] = []
  let rootCount = 0
  let index = 0

  const validateEntities = (text: string): void => {
    for (let offset = 0; offset < text.length; offset += 1) {
      if (text[offset] !== '&') continue
      const end = text.indexOf(';', offset + 1)
      if (end < 0 || !/^(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+)$/iu.test(text.slice(offset + 1, end))) throw invalidXml('站点地图XML包含无效实体')
      offset = end
    }
  }

  while (index < value.length) {
    if (value[index] !== '<') {
      const end = value.indexOf('<', index)
      const text = value.slice(index, end < 0 ? value.length : end)
      validateEntities(text)
      if (stack.length === 0 && text.trim()) throw invalidXml('站点地图XML根元素外包含文本')
      index = end < 0 ? value.length : end
      continue
    }

    if (value.startsWith('<!--', index)) {
      const end = value.indexOf('-->', index + 4)
      if (end < 0) throw invalidXml('站点地图XML注释未闭合')
      index = end + 3
      continue
    }
    if (value.startsWith('<![CDATA[', index)) {
      const end = value.indexOf(']]>', index + 9)
      if (end < 0 || stack.length === 0) throw invalidXml('站点地图XMLCDATA段无效')
      index = end + 3
      continue
    }
    if (value.startsWith('<?', index)) {
      const end = value.indexOf('?>', index + 2)
      if (end < 0) throw invalidXml('站点地图XML处理指令未闭合')
      index = end + 2
      continue
    }
    if (value.startsWith('<!', index)) throw invalidXml('站点地图XML包含不支持的声明')

    let end = index + 1
    let quote: '"' | "'" | undefined
    for (; end < value.length; end += 1) {
      const character = value[end]
      if (quote) {
        if (character === quote) quote = undefined
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
    }
    if (end >= value.length || quote) throw invalidXml('站点地图XML标签未闭合')
    const token = value.slice(index + 1, end).trim()
    if (!token) throw invalidXml()
    if (token.startsWith('/')) {
      const name = token.slice(1).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || !stack.length || stack.at(-1) !== name) throw invalidXml('站点地图XML标签嵌套不匹配')
      stack.pop()
    } else {
      const selfClosing = /\/\s*$/u.test(token)
      const content = selfClosing ? token.replace(/\/\s*$/u, '').trim() : token
      const nameMatch = content.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u)
      if (!nameMatch) throw invalidXml('站点地图XML标签名无效')
      const attributes = nameMatch[2]
      const names = new Set<string>()
      let attrOffset = 0
      while (attrOffset < attributes.length) {
        while (/\s/u.test(attributes[attrOffset] ?? '')) attrOffset += 1
        if (attrOffset >= attributes.length) break
        const attrMatch = attributes.slice(attrOffset).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/u)
        if (!attrMatch) throw invalidXml('站点地图XML属性无效')
        if (names.has(attrMatch[1])) throw invalidXml('站点地图XML包含重复属性')
        names.add(attrMatch[1])
        validateEntities(attrMatch[3])
        attrOffset += attrMatch[0].length
      }
      if (stack.length === 0) rootCount += 1
      if (!selfClosing) stack.push(nameMatch[1])
    }
    index = end + 1
  }
  if (stack.length !== 0 || rootCount !== 1) throw invalidXml('站点地图XML根元素不完整')
}

function childElements(node: HTMLElement): HTMLElement[] {
  return node.childNodes.filter((child): child is HTMLElement => child.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[]
}

function locText(node: HTMLElement): string {
  const value = node.textContent.trim()
  return value.replace(/^<!\[CDATA\[/u, '').replace(/\]\]>$/u, '').trim()
}

function parseSitemapXml(value: string): { kind: 'index' | 'urlset'; links: string[] } {
  if (externalXmlEntity(value)) throw new DirectWebsiteReaderError('sitemap_entity_blocked', '站点地图包含不允许的外部实体声明')
  validateXmlText(value)
  let root: HTMLElement
  try {
    const document = parse(value)
    const roots = document.childNodes.filter((child): child is HTMLElement => child.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[]
    if (roots.length !== 1) throw invalidXml('站点地图XML必须有且只有一个根元素')
    root = roots[0]
  } catch (error) {
    if (error instanceof DirectWebsiteReaderError) throw error
    throw invalidXml()
  }
  const rootTag = xmlLocalName(root.rawTagName)
  if (rootTag !== 'sitemapindex' && rootTag !== 'urlset') throw invalidXml('站点地图根元素必须是sitemapindex或urlset')
  const kind: 'index' | 'urlset' = rootTag === 'sitemapindex' ? 'index' : 'urlset'
  const expectedEntry = rootTag === 'sitemapindex' ? 'sitemap' : 'url'
  const links: string[] = []
  for (const entry of childElements(root)) {
    if (xmlLocalName(entry.rawTagName) !== expectedEntry) throw invalidXml('站点地图包含不支持的条目元素')
    const locs = childElements(entry).filter((child) => xmlLocalName(child.rawTagName) === 'loc')
    if (locs.length !== 1) throw invalidXml('站点地图条目必须包含一个loc地址')
    const loc = locText(locs[0])
    if (!loc) throw new DirectWebsiteReaderError('sitemap_invalid', '站点地图包含空的loc地址')
    links.push(loc)
  }
  if (links.length === 0) throw new DirectWebsiteReaderError('sitemap_empty', '站点地图没有可读取的loc地址')
  if (links.length > MAX_PAGE_LINKS) throw new DirectWebsiteReaderError('sitemap_link_limit', '站点地图地址超过读取工具上限')
  return { kind, links: [...new Set(links)] }
}

function bodyTextFromHtml(html: string, sitemap = false): ParsedPageContent {
  if (sitemap) {
    const parsed = parseSitemapXml(html)
    return { title: '站点地图', text: parsed.links.join('\n'), links: parsed.links, unreadLinks: [], linksLimitReached: false, isSitemap: true, sitemapKind: parsed.kind }
  }
  const root = parse(html)
  const rawTitle = root.querySelector('title')?.textContent.replace(/\s+/gu, ' ').trim() ?? ''
  if (rawTitle.length > MAX_PAGE_TITLE_CHARS) throw new DirectWebsiteReaderError('title_too_large', '页面标题超过网站读取工具上限，未截断返回')
  const title = rawTitle
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg']) {
    for (const node of root.querySelectorAll(selector)) node.remove()
  }

  const body = root.querySelector('body')
  if (!body) root.querySelector('head')?.remove()
  const contentRoot = body ?? root
  const links: string[] = []
  const unreadLinks: DirectWebsiteUnreadLink[] = []
  let linksLimitReached = false
  for (const anchor of contentRoot.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')?.trim()
    if (!href) continue
    if (links.length >= MAX_PAGE_LINKS) {
      linksLimitReached = true
      break
    }
    links.push(href)
  }

  // `structuredText` is a DOM representation, not a site-wide cleaning
  // pipeline: it is created only for the page the model explicitly read and
  // the same representation is returned to the model and checked later.
  const text = contentRoot.structuredText
    .split(/\r?\n/gu)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n')
  if (!text && !title) throw new DirectWebsiteReaderError('empty_page', '页面没有可读取的正文或标题')
  if (/^(?:loading(?:[. ……]*)?|please enable javascript|enable javascript|javascript is required|请启用javascript|正在加载)[.!。！… ]*$/iu.test(text)) {
    throw new DirectWebsiteReaderError('javascript_shell', '页面仅返回JavaScript壳，未取得正文')
  }
  return { title, text, links, unreadLinks, linksLimitReached, isSitemap: false }
}

function decodeResponseBody(body: Buffer): string {
  try {
    // A replacement character would make a quote look continuous even though
    // the bytes cannot be decoded as the page's claimed UTF-8 text.
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new DirectWebsiteReaderError('invalid_encoding', '页面内容不是有效UTF-8，无法核验连续原文')
  }
}

function rootPathFor(url: URL): string {
  return normalizePathname(url.pathname)
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.origin.toLowerCase() === right.origin.toLowerCase()
}

function inRootPath(url: URL, rootPath: string): boolean {
  const pathname = url.pathname || '/'
  if (rootPath === '/') return true
  const rootWithoutTrailingSlash = rootPath.replace(/\/$/u, '')
  return pathname === rootWithoutTrailingSlash || pathname.startsWith(rootPath)
}

function isRobotsPath(url: URL, rootPath: string): boolean {
  const expected = rootPath === '/' ? '/robots.txt' : `${rootPath}robots.txt`
  return url.pathname === expected
}

function displayUrl(url: URL | string): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  return parsed.toString()
}

function validReaderNumber(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function optionalReaderNumber(value: number | undefined, minimum: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(minimum, Math.floor(value))
}

function requestErrorFor(error: unknown, url: string): DirectWebsiteReaderError {
  if (error instanceof DirectWebsiteReaderError) return error
  const code = errorCode(error) ?? 'read_failed'
  return new DirectWebsiteReaderError(code, safeMessage(error, '官网页面读取失败'), url)
}

/**
 * A per-read wrapper around SafeAuditHttpClient.  The shared client enforces
 * DNS pinning, public-address checks, TLS validation, response limits and
 * redirect checks.  We add the content-audit root-path and robots policy at
 * its `authorizeUrl` hook for every request hop.
 */
export class DirectWebsiteReader implements ContentAuditWebsiteReader {
  readonly rootUrl: string
  private readonly origin: string
  private readonly rootPath: string
  private readonly options: Required<Pick<DirectWebsiteReaderOptions, 'requestTimeoutMs' | 'maxRedirects' | 'maxWireBytes' | 'maxDecompressedBytes' | 'maxToolTextChars'>> & Pick<DirectWebsiteReaderOptions, 'maxRequests' | 'transport' | 'resolveHost' | 'signal'>
  private readonly discovered = new Set<string>()
  private readonly readPages = new Map<string, DirectWebsitePage>()
  private readonly successfulReadUrls = new Set<string>()
  private readonly failed = new Map<string, DirectWebsiteReadFailure>()
  private readonly failedPage = new Set<string>()
  private readonly unreadLinks = new Map<string, DirectWebsiteUnreadLink>()
  /** Same-root sitemap declarations and index children. */
  private readonly robotsSitemaps = new Set<string>()
  private readonly manifestUrls = new Set<string>()
  private readonly manifestAttempted = new Set<string>()
  private readonly missingManifestUrls = new Set<string>()
  /**
   * The immutable page table established by prepareBaseline.  Sitemap XML
   * addresses are deliberately not included; URLset entries that cannot be
   * read (attachments/login pages) are included and represented as failures.
   */
  private readonly fixedBaselineUrls = new Set<string>()
  private robotsReady = false
  private robotsGroups: RobotsGroup[] | null = null
  private robotsError: DirectWebsiteReadFailure | null = null
  private readonly robotsDeclarationFailures: DirectWebsiteReadFailure[] = []
  private baselineReadyValue = false
  private baselineCountValue = 0
  private baselineSourceValue: 'sitemap' | 'links' | undefined
  private baselinePromise: Promise<void> | undefined
  private requestCountValue = 0
  private toolReadCountValue = 0
  private limitReachedValue = false
  private closed = false

  constructor(rootUrl: string, options: DirectWebsiteReaderOptions = {}) {
    const parsed = safeRootUrl(rootUrl)
    const rootPath = rootPathFor(parsed.url)
    this.rootUrl = parsed.display
    this.origin = parsed.url.origin
    this.rootPath = rootPath
    this.options = {
      requestTimeoutMs: validReaderNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1),
      // There is intentionally no product-wide request budget.  Each
      // manifest/page read receives its own redirect-bounded HTTP budget below.
      // An explicit maxRequests remains available only for controlled callers
      // (primarily tests) that need a task-owned total limit.
      maxRequests: optionalReaderNumber(options.maxRequests, 1),
      maxRedirects: validReaderNumber(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0),
      maxWireBytes: validReaderNumber(options.maxWireBytes, DEFAULT_MAX_WIRE_BYTES, 1),
      maxDecompressedBytes: validReaderNumber(options.maxDecompressedBytes, DEFAULT_MAX_DECOMPRESSED_BYTES, 1),
      maxToolTextChars: validReaderNumber(options.maxToolTextChars, DEFAULT_MAX_TOOL_TEXT_CHARS, 1),
      transport: options.transport,
      resolveHost: options.resolveHost,
      signal: options.signal,
    }
    this.discovered.add(this.rootUrl)
    this.fixedBaselineUrls.add(this.rootUrl)
  }

  private ensureOpen(): void {
    if (this.closed) throw new DirectWebsiteReaderError('reader_closed', '官网读取任务已结束')
    if (this.options.signal?.aborted) throw new DirectWebsiteReaderError('aborted', '官网读取任务已取消')
  }

  private urlIsInScope(url: URL): boolean {
    return sameOrigin(url, new URL(this.origin))
      && inRootPath(url, this.rootPath)
      && !isLoginPath(url.pathname)
      && !isAttachmentPath(url.pathname)
  }

  /** Sitemap children may use a non-XML-looking path, so their role comes
   * from the parent sitemapindex rather than the filename.  Attachments are
   * allowed only in this manifest role; login/admin paths remain blocked. */
  private urlIsInManifestScope(url: URL): boolean {
    return sameOrigin(url, new URL(this.origin))
      && inRootPath(url, this.rootPath)
      && !isLoginPath(url.pathname)
  }

  private isManifestUrl(value: string | URL): boolean {
    const parsed = typeof value === 'string' ? new URL(value) : value
    return this.manifestUrls.has(displayUrl(parsed)) || isSitemapPath(parsed.pathname)
  }

  private isTargetPageUrl(value: string | URL): boolean {
    const parsed = typeof value === 'string' ? new URL(value) : value
    return this.urlIsInScope(parsed) && !this.isManifestUrl(parsed)
  }

  private safeRequestedUrl(value: string): SafeUrl {
    const parsed = parseSafeUrl(value)
    const fixed = this.baselineReadyValue && this.fixedBaselineUrls.has(parsed.display)
    if (this.baselineReadyValue && !fixed) {
      throw new DirectWebsiteReaderError('scope_blocked', '读取地址不在本轮Sitemap固定页面范围内', parsed.display)
    }
    // Fixed sitemap rows that are attachments or login/admin pages have an
    // explicit no-network failure recorded during baseline construction. Let
    // readPageInternal surface that failure instead of replacing it with a
    // generic scope error.
    if (fixed && (isAttachmentPath(parsed.url.pathname) || isLoginPath(parsed.url.pathname))) return parsed
    const allowed = this.isManifestUrl(parsed.url)
      ? this.urlIsInManifestScope(parsed.url)
      : this.urlIsInScope(parsed.url)
    if (!allowed) {
      throw new DirectWebsiteReaderError('scope_blocked', '读取地址超出官网根入口范围', parsed.display)
    }
    return parsed
  }

  private createHttpClient(authorizeUrl: (url: URL, context: { isRedirect: boolean; redirects: readonly string[] }) => boolean | void | Promise<boolean | void>): SafeAuditHttpClient {
    const perResourceRequests = this.options.maxRedirects + 1
    const remainingRequests = this.options.maxRequests === undefined
      ? perResourceRequests
      : Math.max(0, this.options.maxRequests - this.requestCountValue)
    return new SafeAuditHttpClient({
      origin: this.origin,
      // A content-audit task has no shared total model/website deadline. The
      // HTTP client's per-hop timeout and request budget remain active.
      deadlineAt: Date.now() + 24 * 60 * 60 * 1_000,
      maxRequests: Math.min(perResourceRequests, remainingRequests),
      timeoutMs: this.options.requestTimeoutMs,
      maxWireBytes: this.options.maxWireBytes,
      maxDecompressedBytes: this.options.maxDecompressedBytes,
      maxRedirects: this.options.maxRedirects,
      resolveHost: this.options.resolveHost,
      transport: this.options.transport,
      authorizeUrl,
    })
  }

  private async ensureRobots(): Promise<void> {
    if (this.robotsReady) return
    this.robotsReady = true
    const robotsUrl = new URL(this.rootPath === '/' ? '/robots.txt' : `${this.rootPath}robots.txt`, this.origin)
    let client: SafeAuditHttpClient | undefined
    try {
      client = this.createHttpClient((url) => isRobotsPath(url, this.rootPath))
      const response = await client.get(robotsUrl, 'text/plain,application/xml;q=0.9,*/*;q=0.1')
      if (response.status === 404 || response.status === 410) {
        this.robotsGroups = null
        return
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DirectWebsiteReaderError('robots_unreadable', 'robots范围文件读取失败', displayUrl(robotsUrl))
      }
      const text = decodeResponseBody(response.body)
      if (!isRobotsText(text)) throw new DirectWebsiteReaderError('robots_unreadable', 'robots范围文件格式不可读取', displayUrl(robotsUrl))
      this.robotsGroups = parseRobots(text)
      // A robots Sitemap directive is a manifest declaration.  Baseline
      // preparation fetches it safely, but ordinary page reads never fetch a
      // declaration as a side effect.  Do not infer its role from a filename:
      // a declared same-root address is a manifest even when it is not named
      // `sitemap*.xml`.
      for (const line of text.split(/\r\n|\n|\r/u)) {
        const match = line.match(/^\s*sitemap\s*:\s*(\S+)/iu)
        if (!match?.[1]) continue
        try {
          const candidate = parseSafeUrl(match[1], robotsUrl).url
          if (!this.urlIsInManifestScope(candidate)) {
            this.robotsDeclarationFailures.push({
              url: safeErrorUrl(candidate.toString()) ?? displayUrl(robotsUrl),
              reason: 'robots声明的站点地图超出官网根入口范围',
              code: 'sitemap_scope_blocked',
            })
            continue
          }
          const normalized = displayUrl(candidate)
          this.robotsSitemaps.add(normalized)
          this.manifestUrls.add(normalized)
        } catch {
          this.robotsDeclarationFailures.push({
            url: safeErrorUrl(match[1]) ?? displayUrl(robotsUrl),
            reason: 'robots声明的站点地图地址无效',
            code: 'sitemap_invalid',
          })
        }
      }
    } catch (error) {
      this.robotsError = {
        url: displayUrl(robotsUrl),
        reason: safeMessage(error, 'robots范围文件读取失败'),
        ...(errorCode(error) ? { code: errorCode(error) } : {}),
      }
      this.robotsGroups = null
    } finally {
      this.requestCountValue += client?.requestsUsed ?? 0
      if (errorCode(this.robotsError) === 'budget_exhausted' || errorCode(this.robotsError) === 'total_budget_exhausted') this.limitReachedValue = true
    }
  }

  private robotsAllowed(url: URL): boolean {
    if (this.robotsError) return false
    if (!this.robotsGroups || this.robotsGroups.length === 0) return true
    const evaluation = evaluateRobots(this.robotsGroups, 'geodesk', [`${url.pathname || '/'}${url.search}`])
    return evaluation === null || evaluation.results.every((entry) => entry.allowed)
  }

  private recordFailure(url: string, error: unknown, kind: 'page' | 'manifest' | 'other' = 'other'): DirectWebsiteReaderError {
    const failure = requestErrorFor(error, url)
    this.failed.set(url, { url, reason: failure.message, code: failure.code })
    if (kind === 'page') this.failedPage.add(url)
    if (failure.code === 'budget_exhausted' || failure.code === 'total_budget_exhausted') this.limitReachedValue = true
    return failure
  }

  private clonePage(page: DirectWebsitePage): DirectWebsitePage {
    return { ...page, links: [...page.links], ...(page.unreadLinks ? { unreadLinks: page.unreadLinks.map((entry) => ({ ...entry })) } : {}) }
  }

  private assertRequestBudget(url: string): void {
    if (this.options.maxRequests !== undefined && this.requestCountValue >= this.options.maxRequests) {
      this.limitReachedValue = true
      throw new DirectWebsiteReaderError('budget_exhausted', '已达到官网读取资源上限', url)
    }
  }

  private async requestBody(requested: SafeUrl, mode: 'page' | 'manifest'): Promise<{ status: number; body: Buffer; contentType: string; finalUrl: string }> {
    await this.ensureRobots()
    const url = requested.display
    if (this.robotsError) throw new DirectWebsiteReaderError('robots_unreadable', this.robotsError.reason, this.robotsError.url)
    if (this.robotsDeclarationFailures.length > 0) {
      const first = this.robotsDeclarationFailures[0]
      throw new DirectWebsiteReaderError(first.code ?? 'sitemap_invalid', first.reason, first.url)
    }
    if (!this.robotsAllowed(requested.url)) throw new DirectWebsiteReaderError('robots_blocked', '请求被robots范围策略阻止', url)
    this.assertRequestBudget(url)

    let client: SafeAuditHttpClient | undefined
    // SafeAuditHttpClient deliberately redacts query strings in diagnostics.
    // Capture every authorized hop separately so successful page identities
    // retain non-sensitive query strings such as `?a` versus `?b`.
    let lastRequestUrl = requested.url.toString()
    try {
      client = this.createHttpClient((candidate) => {
        lastRequestUrl = candidate.toString()
        const inScope = mode === 'manifest' ? this.urlIsInManifestScope(candidate) : this.urlIsInScope(candidate)
        return inScope && this.robotsAllowed(candidate)
      })
      const response = await client.get(requested.url)
      const contentType = (response.headers['content-type'] ?? '').toLowerCase()
      const finalResponseUrl = displayUrl(new URL(lastRequestUrl))
      const finalParsed = new URL(finalResponseUrl)
      const xmlResponse = /(?:application|text)\/(?:xml|sitemap\+xml)|application\/(?:rss\+xml|atom\+xml)/iu.test(contentType)
      if (response.status === 404 || response.status === 410) {
        if (mode === 'manifest') return { status: response.status, body: response.body, contentType, finalUrl: finalResponseUrl }
        throw new DirectWebsiteReaderError('http_error', `页面读取失败（HTTP ${response.status}）`, url)
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DirectWebsiteReaderError(mode === 'manifest' ? 'sitemap_http_error' : 'http_error', `${mode === 'manifest' ? '站点地图' : '页面'}读取失败（HTTP ${response.status}）`, url)
      }
      const inScope = mode === 'manifest' ? this.urlIsInManifestScope(finalParsed) : this.urlIsInScope(finalParsed)
      if (!inScope) throw new DirectWebsiteReaderError('scope_blocked', '页面跳转到了官网根入口之外', finalResponseUrl)
      if (mode === 'manifest') {
        if (contentType && !xmlResponse) throw new DirectWebsiteReaderError('not_xml', '响应不是站点地图XML', url)
      } else if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new DirectWebsiteReaderError('not_html', '响应不是HTML页面', url)
      }
      const body = decodeResponseBody(response.body)
      if (mode === 'page') {
        const anonymous = analyzeAnonymousPage({ html: body, requestedUrl: url, finalUrl: finalResponseUrl })
        if (!anonymous.readable) {
          const code = anonymous.challenge ? 'challenge_blocked' : anonymous.blocked ? 'login_blocked' : 'anonymous_unreadable'
          throw new DirectWebsiteReaderError(code, anonymous.challenge ? '页面需要人机验证，未取得匿名正文' : '页面未提供可读取的匿名正文', url)
        }
      }
      return { status: response.status, body: Buffer.from(body), contentType, finalUrl: finalResponseUrl }
    } finally {
      this.requestCountValue += client?.requestsUsed ?? 0
    }
  }

  private recordUnread(url: string, sourceUrl: string, reason: string, local: DirectWebsiteUnreadLink[]): void {
    const entry: DirectWebsiteUnreadLink = { url, sourceUrl, reason }
    local.push(entry)
    this.unreadLinks.set(url, entry)
  }

  private processHtmlLinks(parsed: ParsedPageContent, finalUrl: string): { links: string[]; unreadLinks: DirectWebsiteUnreadLink[]; manifestUrls: string[] } {
    const finalParsed = new URL(finalUrl)
    const unreadLinks: DirectWebsiteUnreadLink[] = []
    const links = new Set<string>()
    const linkedManifests = new Set<string>()
    for (const href of parsed.links) {
      try {
        const link = parseSafeUrl(href, finalParsed).url
        const normalized = displayUrl(link)
        const sameRoot = sameOrigin(link, new URL(this.origin)) && inRootPath(link, this.rootPath)

        // Once the sitemap baseline is frozen, links are evidence only.  Do
        // not let a page body expand the fixed denominator, expose a new
        // pending URL, or trigger a linked sitemap fetch.  In-table ordinary
        // pages remain visible to the model; fixed attachment/login rows are
        // already explicit failures from the sitemap pass and are not turned
        // into an unread-link gap here.
        if (this.baselineReadyValue) {
          if (!sameRoot || !this.fixedBaselineUrls.has(normalized)) continue
          if (isAttachmentPath(link.pathname) || isLoginPath(link.pathname) || this.isManifestUrl(link)) continue
          links.add(normalized)
          continue
        }

        if (sameRoot && isAttachmentPath(link.pathname)) {
          this.recordUnread(normalized, finalUrl, UNREAD_RESOURCE_REASON, unreadLinks)
          continue
        }
        if (sameRoot && isLoginPath(link.pathname)) {
          this.recordUnread(normalized, finalUrl, '登录或管理页面不读取，仅记录链接和未读取缺口', unreadLinks)
          continue
        }
        if (!this.urlIsInScope(link)) continue
        if (this.isManifestUrl(link)) {
          this.manifestUrls.add(normalized)
          links.add(normalized)
          if (!this.missingManifestUrls.has(normalized)) linkedManifests.add(normalized)
          continue
        }
        this.discovered.add(normalized)
        links.add(normalized)
      } catch {
        // Ordinary page links are untrusted navigation hints. Invalid,
        // cross-origin and out-of-root links are omitted rather than fetched.
      }
    }
    if (!this.baselineReadyValue) {
      for (const manifest of [...this.robotsSitemaps, ...this.manifestUrls]) links.add(manifest)
    }
    return { links: [...links], unreadLinks: [...new Map(unreadLinks.map((entry) => [entry.url, entry])).values()], manifestUrls: [...linkedManifests] }
  }

  private processManifestLocations(parsed: ParsedPageContent, sourceUrl: string): { unreadLinks: DirectWebsiteUnreadLink[]; childUrls: string[] } {
    const unreadLinks: DirectWebsiteUnreadLink[] = []
    const childUrls: string[] = []
    if (!parsed.sitemapKind) throw new DirectWebsiteReaderError('sitemap_invalid', '站点地图缺少有效类型', sourceUrl)
    for (const href of parsed.links) {
      let link: URL
      try {
        link = parseSafeUrl(href, new URL(sourceUrl)).url
      } catch {
        throw new DirectWebsiteReaderError('sitemap_invalid', '站点地图包含无效或不允许的地址', safeErrorUrl(href))
      }
      const normalized = displayUrl(link)
      const sameRoot = sameOrigin(link, new URL(this.origin)) && inRootPath(link, this.rootPath)
      if (!sameRoot) throw new DirectWebsiteReaderError('sitemap_scope_blocked', '站点地图包含根入口范围外地址', safeErrorUrl(normalized))
      if (isLoginPath(link.pathname)) {
        if (parsed.sitemapKind === 'urlset') {
          this.fixedBaselineUrls.add(normalized)
          this.discovered.add(normalized)
          this.recordFailure(
            normalized,
            new DirectWebsiteReaderError('login_blocked', '站点地图声明的登录或管理页面不可读取', normalized),
            'page',
          )
        } else {
          // An index entry is a child-sitemap declaration, not a page link.
          // A login/admin path therefore cannot be silently treated as an
          // unread page: it is a blocked child and must fail the baseline.
          throw new DirectWebsiteReaderError('sitemap_scope_blocked', '站点地图子图超出可读取范围', normalized)
        }
        continue
      }
      if (parsed.sitemapKind === 'index') {
        // The parent index gives this URL its manifest role, regardless of
        // whether its path ends in .xml or contains a sitemap marker.
        this.manifestUrls.add(normalized)
        childUrls.push(normalized)
        continue
      }
      if (isAttachmentPath(link.pathname)) {
        this.fixedBaselineUrls.add(normalized)
        this.discovered.add(normalized)
        this.recordFailure(
          normalized,
          new DirectWebsiteReaderError('attachment_blocked', '站点地图声明的附件或受保护资源不可读取', normalized),
          'page',
        )
        continue
      }
      // Sitemap XML itself is navigation evidence, never a content-page
      // denominator. A URLset entry with the conventional marker is kept as a
      // known manifest address but is not fetched recursively: only an index
      // parent grants a child-manifest role.
      if (isSitemapPath(link.pathname)) {
        this.manifestUrls.add(normalized)
        continue
      }
      this.fixedBaselineUrls.add(normalized)
      this.discovered.add(normalized)
    }
    return { unreadLinks: [...new Map(unreadLinks.map((entry) => [entry.url, entry])).values()], childUrls: [...new Set(childUrls)] }
  }

  private async fetchManifest(value: string, allowMissing = false): Promise<DirectWebsitePage | undefined> {
    const requested = parseSafeUrl(value)
    const url = requested.display
    if (!this.urlIsInManifestScope(requested.url)) throw new DirectWebsiteReaderError('sitemap_scope_blocked', '站点地图超出官网根入口范围', url)
    this.manifestUrls.add(url)
    if (this.missingManifestUrls.has(url)) {
      if (allowMissing) return undefined
      throw new DirectWebsiteReaderError('sitemap_missing', '站点地图不存在', url)
    }
    const existing = this.readPages.get(url)
    if (existing) return this.clonePage(existing)
    const priorFailure = this.failed.get(url)
    if (priorFailure) throw new DirectWebsiteReaderError(priorFailure.code ?? 'sitemap_failed', priorFailure.reason, url)
    if (this.manifestAttempted.has(url)) throw new DirectWebsiteReaderError('sitemap_cycle', '站点地图读取出现循环或重复', url)
    this.manifestAttempted.add(url)
    let stored = false
    try {
      const response = await this.requestBody(requested, 'manifest')
      if (response.status === 404 || response.status === 410) {
        this.manifestUrls.delete(url)
        this.missingManifestUrls.add(url)
        if (allowMissing) return undefined
        throw new DirectWebsiteReaderError('sitemap_missing', `站点地图不存在（HTTP ${response.status}）`, url)
      }
      const parsed = bodyTextFromHtml(response.body.toString('utf8'), true)
      if (!parsed.isSitemap || !parsed.sitemapKind) throw new DirectWebsiteReaderError('sitemap_invalid', '响应不是有效的站点地图', url)
      const finalUrl = response.finalUrl
      this.manifestUrls.add(finalUrl)
      const manifestData = this.processManifestLocations(parsed, finalUrl)
      const page: DirectWebsitePage = {
        readId: randomUUID(),
        url: finalUrl,
        title: parsed.title,
        text: parsed.text,
        links: [...parsed.links],
        ...(manifestData.unreadLinks.length > 0 ? { unreadLinks: manifestData.unreadLinks } : {}),
        isSitemap: true,
      }
      this.readPages.set(url, page)
      this.readPages.set(finalUrl, page)
      stored = true
      if (parsed.sitemapKind === 'index') {
        for (const childUrl of manifestData.childUrls) {
          if (this.manifestAttempted.has(childUrl)) continue
          await this.fetchManifest(childUrl)
        }
      }
      return this.clonePage(page)
    } catch (error) {
      if (!stored) throw this.recordFailure(url, error, 'manifest')
      throw error
    }
  }

  private async expandLinkedManifests(urls: readonly string[]): Promise<void> {
    for (const url of urls) {
      if (this.manifestAttempted.has(url) || this.missingManifestUrls.has(url)) continue
      try {
        await this.fetchManifest(url)
      } catch {
        // The page itself remains a successful read. Keep the manifest failure
        // in coverage so completeness cannot be claimed silently.
      }
    }
  }

  private async readPageInternal(value: string, fromTool: boolean): Promise<DirectWebsitePage> {
    this.ensureOpen()
    const requested = this.safeRequestedUrl(value)
    const url = requested.display
    // Resolve robots declarations before deciding whether a non-conventional
    // URL is a manifest. This keeps direct/manual reads compatible with a
    // declared child whose filename does not contain "sitemap".
    await this.ensureRobots()
    const manifest = this.isManifestUrl(requested.url)
    if (manifest) {
      if (this.missingManifestUrls.has(url)) throw new DirectWebsiteReaderError('sitemap_missing', '站点地图不存在', url)
      const existing = this.readPages.get(url)
      if (existing) return this.clonePage(existing)
      const priorFailure = this.failed.get(url)
      if (priorFailure) throw new DirectWebsiteReaderError(priorFailure.code ?? 'sitemap_failed', priorFailure.reason, url)
      if (fromTool) this.toolReadCountValue += 1
      try {
        const page = await this.fetchManifest(url)
        if (!page) throw new DirectWebsiteReaderError('sitemap_missing', '站点地图不存在', url)
        return page
      } catch (error) {
        if (error instanceof DirectWebsiteReaderError && this.failed.get(url)?.code === error.code) throw error
        throw this.recordFailure(url, error, 'manifest')
      }
    }

    this.discovered.add(url)
    const existing = this.readPages.get(url)
    if (existing) return this.clonePage(existing)
    const priorFailure = this.failed.get(url)
    if (priorFailure) throw new DirectWebsiteReaderError(priorFailure.code ?? 'read_failed', priorFailure.reason, url)
    if (fromTool) this.toolReadCountValue += 1
    try {
      const response = await this.requestBody(requested, 'page')
      const parsed = bodyTextFromHtml(response.body.toString('utf8'), false)
      if (parsed.linksLimitReached) {
        this.limitReachedValue = true
        throw new DirectWebsiteReaderError('link_limit', '页面链接超过网站读取工具上限，未静默截断')
      }
      if (parsed.text.length > this.options.maxToolTextChars) throw new DirectWebsiteReaderError('tool_output_too_large', '页面正文超过网站读取工具输出上限，未截断返回', url)
      const finalUrl = response.finalUrl
      const finalParsed = new URL(finalUrl)
      if (!this.isTargetPageUrl(finalParsed)) throw new DirectWebsiteReaderError('scope_blocked', '页面跳转到了官网根入口之外', finalUrl)
      // Before production establishes a sitemap baseline, preserve the
      // legacy link-discovery behavior.  Afterward the denominator is frozen:
      // a redirect target is only an alias, unless it is itself an original
      // row in the fixed table.
      if (!this.baselineReadyValue) this.discovered.add(finalUrl)
      const processed = this.processHtmlLinks(parsed, finalUrl)
      const page: DirectWebsitePage = {
        readId: randomUUID(),
        url: finalUrl,
        title: parsed.title,
        text: parsed.text,
        links: processed.links,
        ...(processed.unreadLinks.length > 0 ? { unreadLinks: processed.unreadLinks } : {}),
      }
      this.readPages.set(url, page)
      this.readPages.set(finalUrl, page)
      // A redirect alias refers to the same body; retain both URL identities
      // for getPage compatibility, while only storing one temporary page/
      // evidence object and never issuing a second HTTP request for the alias.
      this.successfulReadUrls.add(url)
      if (!this.baselineReadyValue || this.fixedBaselineUrls.has(finalUrl)) this.successfulReadUrls.add(finalUrl)
      this.failed.delete(url)
      this.failedPage.delete(url)
      if (this.baselineReadyValue && this.fixedBaselineUrls.has(finalUrl)) {
        this.failed.delete(finalUrl)
        this.failedPage.delete(finalUrl)
      }
      if (!this.baselineReadyValue) await this.expandLinkedManifests(processed.manifestUrls)
      return this.clonePage(page)
    } catch (error) {
      throw this.recordFailure(url, error, 'page')
    }
  }

  async prepareBaseline(): Promise<void> {
    this.ensureOpen()
    if (this.baselineReadyValue) return
    if (!this.baselinePromise) this.baselinePromise = this.buildBaseline()
    return this.baselinePromise
  }

  private async buildBaseline(): Promise<void> {
    try {
      await this.ensureRobots()
      if (this.robotsError) {
        const failure = this.recordFailure(this.robotsError.url ?? new URL(this.rootPath === '/' ? '/robots.txt' : `${this.rootPath}robots.txt`, this.origin).toString(), this.robotsError)
        throw failure
      }
      if (this.robotsDeclarationFailures.length > 0) {
        const first = this.robotsDeclarationFailures[0]
        for (const failure of this.robotsDeclarationFailures) this.failed.set(failure.url, { ...failure })
        throw new DirectWebsiteReaderError(first.code ?? 'sitemap_invalid', first.reason, first.url)
      }

      if (this.robotsSitemaps.size > 0) {
        for (const sitemapUrl of this.robotsSitemaps) await this.fetchManifest(sitemapUrl)
      } else {
        const fallbackUrl = displayUrl(new URL(this.rootPath === '/' ? '/sitemap.xml' : `${this.rootPath}sitemap.xml`, this.origin))
        // Production content audits have a sitemap-only boundary.  A missing
        // conventional sitemap is an explicit baseline failure, not permission
        // to infer a denominator from an HTML entrance page.
        await this.fetchManifest(fallbackUrl)
      }
      this.baselineCountValue = this.fixedBaselineUrls.size
      this.baselineSourceValue = 'sitemap'
      this.baselineReadyValue = true
    } catch (error) {
      if (error instanceof DirectWebsiteReaderError && (error.code === 'budget_exhausted' || error.code === 'total_budget_exhausted')) this.limitReachedValue = true
      throw error
    }
  }

  async readPage(value: string): Promise<DirectWebsitePage> {
    return this.readPageInternal(value, true)
  }
  getPage(url: string): DirectWebsitePage | undefined {
    try {
      const parsed = parseSafeUrl(url)
      const normalized = parsed.display
      const page = this.readPages.get(normalized)
      return page ? this.clonePage(page) : undefined
    } catch {
      return undefined
    }
  }

  coverage(): DirectWebsiteCoverage {
    const unread = new Set(this.unreadLinks.keys())
    const pendingUrls = [...this.discovered].filter((url) => !this.successfulReadUrls.has(url) && !this.failed.has(url) && !unread.has(url))
    const failedPageUrls = [...this.failedPage]
      .map((url) => this.failed.get(url))
      .filter((failure): failure is DirectWebsiteReadFailure => Boolean(failure))
      .map((failure) => ({ ...failure }))
    return {
      rootUrl: this.rootUrl,
      discoveredUrls: [...this.discovered],
      readUrls: [...this.successfulReadUrls],
      failedUrls: [...this.failed.values()].map((failure) => ({ ...failure })),
      unreadUrls: [...this.unreadLinks.values()].map((entry) => ({ ...entry })),
      requestCount: this.requestCountValue,
      toolReadCount: this.toolReadCountValue,
      limitReached: this.limitReachedValue,
      baselineReady: this.baselineReadyValue,
      baselineCount: this.baselineCountValue,
      ...(this.baselineSourceValue ? { baselineSource: this.baselineSourceValue } : {}),
      pendingUrls,
      failedPageUrls,
    }
  }

  close(): void {
    this.closed = true
    // Page text/raw response data is deliberately task-scoped.  The result
    // builder copies only the small evidence excerpts before this is called.
    this.readPages.clear()
    this.successfulReadUrls.clear()
    this.discovered.clear()
    this.failed.clear()
    this.failedPage.clear()
    this.unreadLinks.clear()
    this.robotsSitemaps.clear()
    this.manifestUrls.clear()
    this.manifestAttempted.clear()
    this.missingManifestUrls.clear()
    this.fixedBaselineUrls.clear()
    this.robotsGroups = null
    this.robotsError = null
    this.baselineReadyValue = false
    this.baselineCountValue = 0
    this.baselineSourceValue = undefined
  }
}

export function directWebsiteReaderToolDefinition(): Record<string, unknown> {
  return {
    type: 'function',
    name: 'read_website_page',
    description: '程序已完成Sitemap固定表；仅读取程序列出的固定表内一页公开HTML页面，不扩充固定清单、不读取Sitemap XML、附件、登录页或表外地址。必须使用模型选择的固定表URL；返回实际最终URL、标题、正文、受限链接及临时读取标识。',
    strict: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '程序Sitemap固定表中的公开HTML页面绝对HTTP(S)地址；不要填写表外链接、Sitemap XML、附件或登录地址。' } },
      required: ['url'],
      additionalProperties: false,
    },
  }
}

export function directWebsiteToolOutput(page: DirectWebsitePage): Record<string, unknown> {
  return {
    ok: true,
    read_id: page.readId,
    url: page.url,
    title: page.title,
    text: page.text,
    links: page.links,
    ...(page.unreadLinks && page.unreadLinks.length > 0 ? { unread_links: page.unreadLinks } : {}),
    kind: page.isSitemap ? 'sitemap' : 'html',
  }
}

export function directWebsiteToolError(error: unknown, url?: string): Record<string, unknown> {
  const code = errorCode(error) ?? 'read_failed'
  let safeUrl: string | undefined
  if (url) safeUrl = safeErrorUrl(url)
  return {
    ok: false,
    ...(safeUrl ? { url: safeUrl } : {}),
    code,
    error: safeMessage(error, '官网页面读取失败'),
  }
}
