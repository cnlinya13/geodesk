import { parse } from 'node-html-parser'

export const DEFAULT_MAX_PAGES = 200
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000
const DEFAULT_MAX_BODY_CHARS = 20_000
const MAX_SITEMAPS = 50
const MAX_REDIRECTS = 10
const MAX_DISCOVERY_MULTIPLIER = 10
const TRUNCATION_MARKER = '[正文因长度限制未完整保存]'

export type CrawlStatus = 'completed' | 'failed'
export type WebsitePageStatus = 'success' | 'failed'

export type WebsitePageResult = {
  url: string
  title: string
  bodyText: string
  status: WebsitePageStatus
  error: string | null
}

export type WebsiteCrawlResult = {
  startUrl: string
  source: 'sitemap' | 'links'
  status: CrawlStatus
  incomplete: boolean
  error: string | null
  discoveredCount: number
  successCount: number
  failedCount: number
  pages: WebsitePageResult[]
}

export type CrawlOptions = {
  fetch?: typeof fetch
  maxPages?: number
  timeoutMs?: number
  maxResponseBytes?: number
  maxBodyChars?: number
}

type CrawlContext = {
  fetch: typeof fetch
  baseHost: string
  allowedHosts: Set<string>
  maxPages: number
  timeoutMs: number
  maxResponseBytes: number
  maxBodyChars: number
}

class CrawlError extends Error {}

function validStartUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new CrawlError('官网地址不是有效的URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CrawlError('官网地址必须使用HTTP或HTTPS')
  }
  if (url.username || url.password || !url.hostname) {
    throw new CrawlError('官网地址格式不受支持')
  }
  return url
}

function normaliseUrl(value: string, base?: URL): string | null {
  let url: URL
  try {
    url = base ? new URL(value, base) : new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  if (url.username || url.password || !url.hostname) {
    return null
  }
  url.hash = ''
  url.search = ''
  return url.toString()
}

function siteHosts(host: string): Set<string> {
  const hosts = new Set<string>([host.toLowerCase()])
  let parsed: URL
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    return hosts
  }
  const hostname = parsed.hostname.toLowerCase()
  const port = parsed.port ? `:${parsed.port}` : ''
  if (hostname.startsWith('www.')) hosts.add(`${hostname.slice(4)}${port}`)
  else hosts.add(`www.${hostname}${port}`)
  return hosts
}

function isSameSiteHost(value: string, context: CrawlContext): boolean {
  try {
    return context.allowedHosts.has(new URL(value).host.toLowerCase())
  } catch {
    return false
  }
}

function canonicalUrl(value: string, base?: URL): string | null {
  const normalised = normaliseUrl(value, base)
  return normalised
}

function identityUrl(value: string, context: CrawlContext): string | null {
  const normalised = normaliseUrl(value)
  if (!normalised) return null
  try {
    const url = new URL(normalised)
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    }
    const host = url.host.toLowerCase()
    if (context.allowedHosts.has(host) && siteHosts(context.baseHost).has(host)) url.host = context.baseHost
    return url.toString()
  } catch {
    return null
  }
}

function canAcceptRedirectHost(value: string, context: CrawlContext): boolean {
  try {
    const host = new URL(value).host.toLowerCase()
    if (context.allowedHosts.has(host)) return true
    return siteHosts(context.baseHost).has(host)
  } catch {
    return false
  }
}

function isLoginPath(pathname: string): boolean {
  const parts = pathname.toLowerCase().split('/').filter(Boolean)
  const blocked = new Set(['login', 'signin', 'sign-in', 'logout', 'register', 'signup', 'sign-up', 'account', 'auth', 'admin', 'wp-admin', 'wp-login.php'])
  return parts.some((part) => blocked.has(part) || part.startsWith('wp-login'))
}

function isAttachmentPath(pathname: string): boolean {
  const pathWithoutTrailingSlash = pathname.replace(/\/+$/, '')
  return /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|bz2|csv|json|xml|rss|atom|jpe?g|png|gif|webp|svg|ico|bmp|mp[34]|mov|avi|wav|ogg|webm|exe|dmg|apk)$/i.test(pathWithoutTrailingSlash)
}

function isCrawlablePageUrl(value: string, context: CrawlContext): boolean {
  if (!isSameSiteHost(value, context)) {
    return false
  }
  try {
    const url = new URL(value)
    return !isLoginPath(url.pathname) && !isAttachmentPath(url.pathname)
  } catch {
    return false
  }
}

function isSitemapUrl(value: string, context: CrawlContext): boolean {
  if (!isSameSiteHost(value, context)) {
    return false
  }
  try {
    const pathname = new URL(value).pathname.toLowerCase().replace(/\/+$/, '')
    return pathname.endsWith('.xml') || pathname.endsWith('.xml.gz') || pathname.includes('sitemap')
  } catch {
    return false
  }
}

function responseContentType(response: Response): string {
  return response.headers.get('content-type')?.toLowerCase() ?? ''
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new CrawlError('响应内容超过大小限制')
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new CrawlError('响应内容超过大小限制')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new CrawlError('请求超时')), timeoutMs)
      promise.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchText(url: string, context: CrawlContext, kind: 'page' | 'text' | 'sitemap'): Promise<{ text: string; contentType: string; finalUrl: string }> {
  let currentUrl = normaliseUrl(url)
  if (!currentUrl || !isSameSiteHost(currentUrl, context)) {
    throw new CrawlError('跳转到了官网之外的主机')
  }

  const deadline = Date.now() + context.timeoutMs
  const redirects = new Set<string>()
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new CrawlError('请求超时')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remainingMs)
    let response: Response
    try {
      const request = context.fetch(currentUrl, {
        // Do not let fetch follow an untrusted Location before we can check it.
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: kind === 'page' ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' : 'text/plain,application/xml,text/xml,*/*;q=0.1' },
      })
      response = await withTimeout(request, remainingMs)

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new CrawlError('官网跳转缺少目标地址')
        const nextUrl = normaliseUrl(location, new URL(currentUrl))
        if (!nextUrl || !canAcceptRedirectHost(nextUrl, context)) {
          throw new CrawlError('跳转到了官网之外的主机')
        }
        // A page redirect must not turn a login route or an attachment into
        // a crawl request. Sitemap/robots text redirects intentionally keep
        // their existing, less restrictive handling.
        const nextHost = new URL(nextUrl).host.toLowerCase()
        const hostWasAlreadyAllowed = context.allowedHosts.has(nextHost)
        context.allowedHosts.add(nextHost)
        if (kind === 'page' && !isCrawlablePageUrl(nextUrl, context)) {
          if (!hostWasAlreadyAllowed) context.allowedHosts.delete(nextHost)
          throw new CrawlError('重定向目标不是可读取的页面')
        }
        if (redirects.has(nextUrl) || nextUrl === currentUrl) {
          throw new CrawlError('官网跳转次数过多')
        }
        redirects.add(currentUrl)
        currentUrl = nextUrl
        continue
      }

      const responseUrl = normaliseUrl(response.url || currentUrl)
      if (!responseUrl || !isSameSiteHost(responseUrl, context)) {
        throw new CrawlError('跳转到了官网之外的主机')
      }
      if (!response.ok) {
        throw new CrawlError(`HTTP ${response.status}`)
      }
      const contentType = responseContentType(response)
      if (kind === 'page' && contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new CrawlError('响应不是HTML页面')
      }
      if (kind === 'sitemap' && contentType && !contentType.includes('xml') && !contentType.includes('text/plain') && !contentType.includes('html')) {
        throw new CrawlError('站点地图格式不受支持')
      }

      const remainingBodyMs = deadline - Date.now()
      if (remainingBodyMs <= 0) throw new CrawlError('请求超时')
      const text = await withTimeout(boundedText(response, context.maxResponseBytes), remainingBodyMs)
      return { text, contentType, finalUrl: responseUrl }
    } catch (error) {
      if (error instanceof CrawlError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CrawlError('请求超时')
      }
      throw new CrawlError('请求失败')
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  throw new CrawlError('官网跳转次数过多')
}

function parseSitemapLocations(text: string): { sitemaps: string[]; pages: string[] } {
  const root = parse(text)
  const sitemaps: string[] = []
  const pages: string[] = []
  for (const node of root.querySelectorAll('sitemapindex sitemap loc')) {
    const value = node.textContent.trim()
    if (value) sitemaps.push(value)
  }
  for (const node of root.querySelectorAll('urlset url loc')) {
    const value = node.textContent.trim()
    if (value) pages.push(value)
  }
  if (sitemaps.length === 0 && pages.length === 0) {
    for (const node of root.querySelectorAll('loc')) {
      const value = node.textContent.trim()
      if (!value) continue
      if (/sitemap/i.test(value) || /\.xml(?:\.gz)?(?:$|[?#])/i.test(value)) sitemaps.push(value)
      else pages.push(value)
    }
  }
  return { sitemaps, pages }
}

async function discoverSitemapPages(context: CrawlContext, candidates: string[]): Promise<string[]> {
  const visited = new Set<string>()
  const pages: string[] = []
  const queue = candidates.slice()
  while (queue.length > 0 && visited.size < MAX_SITEMAPS) {
    const candidate = queue.shift()
    if (!candidate) continue
    const sitemapUrl = canonicalUrl(candidate)
    if (!sitemapUrl || !isSitemapUrl(sitemapUrl, context) || visited.has(sitemapUrl)) continue
    visited.add(sitemapUrl)
    let text: string
    try {
      text = (await fetchText(sitemapUrl, context, 'sitemap')).text
    } catch {
      continue
    }
    const locations = parseSitemapLocations(text)
    for (const location of locations.pages) {
      const pageUrl = canonicalUrl(location)
      if (pageUrl && isCrawlablePageUrl(pageUrl, context)) pages.push(pageUrl)
    }
    for (const location of locations.sitemaps) {
      const childUrl = canonicalUrl(location)
      if (childUrl && isSitemapUrl(childUrl, context) && !visited.has(childUrl)) queue.push(childUrl)
    }
  }
  return [...new Set(pages)]
}

function robotsSitemaps(text: string, base: URL): string[] {
  const values: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i)
    if (!match?.[1]) continue
    const url = normaliseUrl(match[1], base)
    if (url) values.push(url)
  }
  return [...new Set(values)]
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractPage(text: string, maxBodyChars: number, pageUrl: string): { title: string; bodyText: string; links: string[]; truncated: boolean } {
  const root = parse(text)
  const title = cleanText(root.querySelector('title')?.textContent ?? '')
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg']) {
    for (const node of root.querySelectorAll(selector)) node.remove()
  }

  const body = root.querySelector('body')
  if (!body) {
    root.querySelector('head')?.remove()
    // A title without a body is metadata, not usable page content.
    root.querySelector('title')?.remove()
  }
  const contentRoot = body ?? root
  const links = root.querySelectorAll('a').map((node) => node.getAttribute('href')?.trim()).filter((href): href is string => Boolean(href))

  // Keep useful links in the existing bodyText field. Attachments are not
  // queued for fetching, but their URLs remain available to later prompts.
  const base = new URL(pageUrl)
  for (const anchor of contentRoot.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')?.trim()
    if (!href) continue
    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    const linkText = cleanText(anchor.textContent)
    const linkLabel = isAttachmentPath(resolved.pathname) ? '[附件未读取]' : ''
    anchor.textContent = linkText
      ? `${linkText}${linkLabel ? ` ${linkLabel}` : ''} (${resolved.toString()})`
      : `${linkLabel ? `${linkLabel} ` : ''}${resolved.toString()}`
  }

  // Structured text keeps block-level content on separate lines. Join table
  // cells explicitly so a table does not collapse into an unreadable token.
  for (const row of contentRoot.querySelectorAll('tr')) {
    const cells = row.children.filter((child) => child.tagName === 'TH' || child.tagName === 'TD')
    if (cells.length > 0) row.textContent = cells.map((cell) => cleanText(cell.textContent)).join(' | ')
  }

  const fullBodyText = contentRoot.structuredText
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .join('\n')
  if (!fullBodyText) throw new CrawlError('页面没有可读取的正文')

  if (/^(?:loading(?:[. ……]*)?|please enable javascript|enable javascript|javascript is required|请启用javascript|正在加载)[.!。！… ]*$/i.test(fullBodyText)) {
    throw new CrawlError('页面仅返回JavaScript壳，未取得正文')
  }

  if (fullBodyText.length <= maxBodyChars) return { title, bodyText: fullBodyText, links, truncated: false }
  const prefixLength = Math.max(0, maxBodyChars - TRUNCATION_MARKER.length - 1)
  const prefix = fullBodyText.slice(0, prefixLength).trimEnd()
  const bodyText = prefix ? `${prefix}\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER
  return { title, bodyText, links, truncated: true }
}

function pagePriority(value: string): number {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname).toLowerCase().replace(/\/+$/, '') || '/'
    if (pathname === '/') return 0
    const segments = pathname.split('/').filter(Boolean)
    const hasTerm = (...terms: string[]) => segments.some((segment) => terms.some((term) => segment === term || segment.includes(term)))
    if (hasTerm('about', 'company', 'corporate', 'profile', 'who-we-are', '关于', '公司介绍')) return 10
    if (hasTerm('product', 'service', 'solution', 'offering', '产品', '服务', '解决方案')) return 20
    if (hasTerm('contact', '联系我们', '联系')) return 30
    if (hasTerm('case', 'customer', 'portfolio', 'success-story', '案例', '客户')) return 40
    if (hasTerm('faq', 'frequently-asked', 'question', 'help', '常见问题', '问题')) return 50
    if (hasTerm('news', 'blog', 'press', 'media', 'insight', 'article', '新闻', '文章')) return 60
  } catch {
    // The URL has already been normalised before it reaches this function.
  }
  return 100
}

type PendingPage = { url: string; priority: number; order: number }

export async function crawlWebsite(startUrl: string, options: CrawlOptions = {}): Promise<WebsiteCrawlResult> {
  const parsedStart = validStartUrl(startUrl)
  const baseHost = parsedStart.host.toLowerCase()
  // A www/apex counterpart is only admitted after an actual redirect proves
  // it is the same website; a link alone must not expand the crawl boundary.
  const allowedHosts = new Set<string>([baseHost])
  const normalisedStart = normaliseUrl(parsedStart.toString())
  if (!normalisedStart) throw new CrawlError('官网地址不是有效的URL')

  const context: CrawlContext = {
    fetch: options.fetch ?? fetch,
    baseHost,
    allowedHosts,
    maxPages: Math.max(1, Math.min(DEFAULT_MAX_PAGES, options.maxPages ?? DEFAULT_MAX_PAGES)),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxBodyChars: options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
  }

  const canonicalStart = canonicalUrl(normalisedStart)
  if (!canonicalStart || !isSameSiteHost(canonicalStart, context)) throw new CrawlError('官网地址不是有效的URL')
  const origin = new URL(canonicalStart)
  const sitemapCandidates: string[] = []
  try {
    const robots = await fetchText(new URL('/robots.txt', origin).toString(), context, 'text')
    sitemapCandidates.push(...robotsSitemaps(robots.text, origin))
  } catch {
    // robots.txt is optional; continue with the conventional sitemap path.
  }
  sitemapCandidates.push(new URL('/sitemap.xml', origin).toString())
  const sitemapPages = await discoverSitemapPages(context, sitemapCandidates)
  const source: 'sitemap' | 'links' = sitemapPages.length > 0 ? 'sitemap' : 'links'
  const seen = new Set<string>()
  const pending: PendingPage[] = []
  let nextOrder = 0
  let discoveryLimitReached = false
  // Failed pages must not consume the 200 successful-page allowance. Keep a
  // finite discovery guard for pathological sites that emit endless unique
  // links, while leaving enough room to pass failures before valid pages.
  const maxDiscovered = Math.max(context.maxPages * MAX_DISCOVERY_MULTIPLIER, context.maxPages + 100)

  const addPage = (value: string, base?: URL): boolean => {
    const url = canonicalUrl(value, base)
    const identity = url ? identityUrl(url, context) : null
    if (!url || !identity || !isCrawlablePageUrl(url, context) || seen.has(identity)) return false
    if (seen.size >= maxDiscovered) {
      discoveryLimitReached = true
      return false
    }
    seen.add(identity)
    pending.push({ url, priority: pagePriority(url), order: nextOrder++ })
    pending.sort((left, right) => left.priority - right.priority || left.order - right.order)
    return true
  }

  addPage(canonicalStart)
  // Sitemap locations are all discovered before crawling starts. Sorting the
  // pending queue makes core pages win the cap even when the sitemap is news-first.
  for (const candidate of [...sitemapPages].sort((left, right) => pagePriority(left) - pagePriority(right))) addPage(candidate)

  const pages: WebsitePageResult[] = []
  const savedPageIdentities = new Set<string>()
  let reachedLimit = false
  let bodyTruncated = false
  while (pending.length > 0) {
    if (pages.filter((page) => page.status === 'success').length >= context.maxPages) {
      reachedLimit = true
      break
    }
    const entry = pending.shift()
    if (!entry) break
    const url = entry.url
    const requestedIdentity = identityUrl(url, context)
    if (requestedIdentity && savedPageIdentities.has(requestedIdentity)) continue
    try {
      const response = await fetchText(url, context, 'page')
      const extracted = extractPage(response.text, context.maxBodyChars, response.finalUrl)
      const finalIdentity = identityUrl(response.finalUrl, context) ?? response.finalUrl
      if (!savedPageIdentities.has(finalIdentity)) {
        savedPageIdentities.add(finalIdentity)
        pages.push({ url: response.finalUrl, title: extracted.title, bodyText: extracted.bodyText, status: 'success', error: null })
      }
      bodyTruncated = bodyTruncated || extracted.truncated
      if (pages.filter((page) => page.status === 'success').length >= context.maxPages) {
        reachedLimit = true
        break
      }
      for (const href of extracted.links) {
        addPage(href, new URL(response.finalUrl))
      }
    } catch (error) {
      if (!requestedIdentity || !savedPageIdentities.has(requestedIdentity)) {
        if (requestedIdentity) savedPageIdentities.add(requestedIdentity)
        pages.push({ url, title: '', bodyText: '', status: 'failed', error: error instanceof Error ? error.message : '读取失败' })
      }
    }
  }

  const successCount = pages.filter((page) => page.status === 'success').length
  const failedCount = pages.length - successCount
  const incomplete = reachedLimit || discoveryLimitReached || failedCount > 0 || bodyTruncated
  let error: string | null = null
  if (successCount === 0) error = '官网页面读取失败'
  else if (reachedLimit && failedCount > 0) error = `已达到${context.maxPages}个有效页面上限，且有页面读取失败`
  else if (reachedLimit) error = `已达到${context.maxPages}个有效页面上限，未继续读取`
  else if (discoveryLimitReached && failedCount > 0) error = '发现页面数量达到安全上限，且有页面读取失败'
  else if (discoveryLimitReached) error = '发现页面数量达到安全上限，未继续读取'
  else if (bodyTruncated && failedCount > 0) error = '部分页面正文读取不完整，且有页面读取失败'
  else if (bodyTruncated) error = '部分页面正文读取不完整'
  else if (failedCount > 0) error = '部分官网页面读取失败'

  return {
    startUrl: canonicalStart,
    source,
    status: successCount > 0 ? 'completed' : 'failed',
    incomplete,
    error,
    discoveredCount: seen.size,
    successCount,
    failedCount,
    pages,
  }
}
