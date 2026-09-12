import { parse, type HTMLElement } from 'node-html-parser'
import type {
  TechnicalAuditFacts,
  TechnicalAuditItem,
  TechnicalAuditScope,
  TechnicalAuditSnapshot,
  TechnicalAuditStatus,
} from '../src/technical-audit.ts'
import { TECHNICAL_AUDIT_ITEM_COUNT, TECHNICAL_AUDIT_RULE_VERSION } from '../src/technical-audit.ts'
import { TECHNICAL_AUDIT_LIMITS, SafeAuditHttpClient, TechnicalAuditHttpError, type PublicAddress, type SafeHttpClientOptions, type SafeHttpResponse, type SafeRequestTransport } from './technical-audit-http.ts'
import { evaluateRobots, evaluateRobotsWithRules, isRobotsText, parseRobots } from './technical-audit-robots.ts'
import type { WebsitePageResult } from './site-crawler.ts'
import { analyzeAnonymousPage, type LoginPageAnalysis } from './technical-audit-login.ts'
import { analyzeStructuredDataPage } from './technical-audit-structured.ts'

export type TechnicalAuditInput = {
  websiteUrl: string
  pages?: WebsitePageResult[]
}

export type TechnicalAuditRunOptions = {
  now?: () => Date
  client?: SafeAuditHttpClient
  transport?: SafeRequestTransport
  resolveHost?: (hostname: string) => Promise<PublicAddress[]>
  maxRequests?: number
  timeoutMs?: number
  totalTimeoutMs?: number
  maxDecompressedBytes?: number
  /** Optional per-item observer. Exceptions never change audit results. */
  onItem?: (item: TechnicalAuditItem, completedCount: number, total: number) => void | Promise<void>
  /**
   * Persistence hook for the service layer. Unlike the diagnostic observer,
   * a failed persistence write must stop the run so a caller never reports a
   * result that was not durably recorded.
   */
  onItemPersist?: (item: TechnicalAuditItem, completedCount: number, total: number) => void | Promise<void>
  /** Progress-shaped alias for callers that prefer one event object. */
  onProgress?: (progress: TechnicalAuditItemProgress) => void | Promise<void>
}

export type TechnicalAuditItemProgress = {
  item: TechnicalAuditItem
  completedCount: number
  total: number
}

type TechnicalAuditSitemapEvidence = {
  sitemaps: Capture[]
  sitemapCandidatesTruncated: boolean
}

type TechnicalAuditLlmsEvidence = {
  llms: Capture
}

type TechnicalAuditEvidenceLoaders = {
  loadSitemaps: () => Promise<TechnicalAuditSitemapEvidence>
  loadLlms: () => Promise<TechnicalAuditLlmsEvidence>
  finalMetadata: () => { checkedAt: string; scope: TechnicalAuditScope }
}

type Capture = {
  requestedUrl: string
  response: SafeHttpResponse | null
  errorCode: string | null
  dnsResolved?: boolean
  tlsEstablished?: boolean
  errorStatus?: number
  errorRedirects?: string[]
  redirectTarget?: string
}

type PageCapture = Capture & {
  html: string
  document: ReturnType<typeof parse> | null
}

type XmlNode = {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

const NON_USER_VISIBLE_NETWORK_ERRORS = new Set(['timeout', 'total_budget_exhausted'])

function item(item_id: string, status: TechnicalAuditStatus, message_code: string, facts: TechnicalAuditFacts = {}, evidence: Record<string, unknown> = {}): TechnicalAuditItem {
  return { item_id, status, message_code, facts, evidence }
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

/** Internal request key: strip credentials and fragment, but retain the
 * query because it is part of the resource being authorized and fetched.
 * Call safeUrl() when placing the value in snapshot evidence. */
function requestUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function safeUrlPath(value: string): string {
  const sanitized = safeUrl(value)
  if (!sanitized) return ''
  try { return new URL(sanitized).pathname || '/' } catch { return '' }
}

/** Keep the query component for robots matching.  Evidence URLs may be
 * redacted elsewhere, but a Disallow rule containing `?` must be evaluated
 * against the actual request path and query rather than a display-safe URL. */
function robotsRequestPath(value: string): string {
  try {
    const parsed = new URL(value)
    return `${parsed.pathname || '/'}${parsed.search}`
  } catch {
    return safeUrlPath(value)
  }
}

function sameOrigin(value: string, origin: string): boolean {
  try { return new URL(value).origin.toLowerCase() === origin.toLowerCase() } catch { return false }
}

/**
 * A user supplied path is the audit's root entry, not a hint to crawl the
 * entire origin.  A root entry such as `/about` may redirect within its own
 * path scope, but must not silently fall back to `/` (or another sibling
 * path).  The origin root remains the ordinary whole-origin scope.
 */
function sameReadScope(value: string | URL, root: URL): boolean {
  let target: URL
  try { target = new URL(typeof value === 'string' ? value : value.toString()) } catch { return false }
  if (target.origin.toLowerCase() !== root.origin.toLowerCase()) return false
  const rootPath = root.pathname || '/'
  if (rootPath === '/') return true
  const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const targetPath = target.pathname || '/'
  return targetPath === normalizedRoot || targetPath.startsWith(`${normalizedRoot}/`)
}

function relativeResourceUrl(root: URL, filename: string): string {
  // Treat a non-root entered path as a directory root for its companion
  // resources.  Thus `/about` checks `/about/robots.txt` and never falls back
  // to the origin-root files; the page request itself remains `/about`.
  const base = new URL(root.toString())
  if (base.pathname !== '/' && !base.pathname.endsWith('/')) base.pathname += '/'
  const resource = new URL(filename, base)
  resource.hash = ''
  return requestUrl(resource.toString())
}

function pageUrl(value: string, base: URL, origin: string): string | null {
  let parsed: URL
  try { parsed = new URL(value, base) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.origin.toLowerCase() !== origin.toLowerCase()) return null
  parsed.hash = ''
  return requestUrl(parsed.toString())
}

function captureErrorCode(error: unknown): string {
  if (error instanceof TechnicalAuditHttpError) return error.code
  return 'request_failure'
}

async function fetchCapture(client: SafeAuditHttpClient, url: string, accept: string): Promise<Capture> {
  try {
    const response = await client.get(url, accept)
    return {
      requestedUrl: requestUrl(url),
      response,
      errorCode: null,
      dnsResolved: response.dnsResolved,
      tlsEstablished: response.tlsEstablished,
    }
  } catch (error) {
    if (error instanceof TechnicalAuditHttpError) {
      return {
        requestedUrl: requestUrl(url),
        response: null,
        errorCode: error.code,
        dnsResolved: error.dnsResolved,
        tlsEstablished: error.tlsEstablished,
        errorStatus: error.responseStatus,
        errorRedirects: error.redirects?.slice(),
        redirectTarget: error.redirectTarget,
      }
    }
    return { requestedUrl: requestUrl(url), response: null, errorCode: captureErrorCode(error) }
  }
}

function captureText(capture: Capture): string {
  if (!capture.response) return ''
  return new TextDecoder('utf-8').decode(capture.response.body)
}

function captureUtf8Text(capture: Capture): { text: string; valid: boolean } {
  if (!capture.response) return { text: '', valid: false }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(capture.response.body), valid: true } }
  catch { return { text: '', valid: false } }
}

function captureStatus(capture: Capture): number | null {
  return capture.response?.status ?? null
}

/** Status evidence for the confirmed first module.  The legacy helper above
 * intentionally remains response-only for the unconfirmed modules. */
function firstModuleStatus(capture: Capture): number | null {
  return capture.response?.status ?? capture.errorStatus ?? null
}

function captureEvidence(capture: Capture): Record<string, unknown> {
  return {
    requested_url: safeUrl(capture.requestedUrl),
    final_url: capture.response?.url ? safeUrl(capture.response.url) : null,
    status: capture.response?.status ?? null,
    redirects: (capture.response?.redirects ?? []).map(safeUrl),
    error_code: capture.errorCode,
  }
}

function isNetworkProtectionError(code: string | null): boolean {
  return code !== null && NON_USER_VISIBLE_NETWORK_ERRORS.has(code)
}

function firstModuleEvidence(capture: Capture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Keep the legacy captureEvidence() contract for the later, unconfirmed
  // modules.  The first two modules have their own projection so newly
  // captured redirect-hop facts and internal timeout codes cannot alter their
  // historical evidence shape (or leak a request deadline to the UI).
  const evidence: Record<string, unknown> = {
    requested_url: safeUrl(capture.requestedUrl),
    // A blocked/invalid redirect target was not fetched and is therefore not
    // a final URL.  Keep it separately as the intended target for diagnosis.
    final_url: capture.response?.url ? safeUrl(capture.response.url) : null,
    redirect_target: capture.redirectTarget ? safeUrl(capture.redirectTarget) : null,
    // errorStatus is present only when the HTTP layer actually received a
    // response (for example, a failed redirect hop or a body-read failure).
    status: capture.response?.status ?? capture.errorStatus ?? null,
    redirects: (capture.response?.redirects ?? capture.errorRedirects ?? []).map(safeUrl),
    error_code: isNetworkProtectionError(capture.errorCode) ? 'network_unavailable' : capture.errorCode,
  }
  return { ...evidence, ...extra }
}

function safeRobotsPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? value
  return path.slice(0, 200)
}

function safeRobotsRule(rule: { allow: boolean; path: string }): { allow: boolean; path: string } {
  return { allow: rule.allow, path: safeRobotsPath(rule.path) }
}

function phaseCaptures(captures: Capture[]): { dnsResolved: boolean; tlsEstablished: boolean; tlsFailed: boolean } {
  let dnsResolved = false
  let tlsEstablished = false
  let tlsFailed = false
  for (const capture of captures) {
    dnsResolved ||= capture.dnsResolved === true || Boolean(capture.response)
    tlsEstablished ||= capture.tlsEstablished === true
    // A false/unknown handshake flag only means the request stopped before a
    // response.  Treat it as a TLS finding only when the transport explicitly
    // classified a certificate/TLS failure; TCP resets and deadlines must not
    // be turned into a fabricated certificate problem.
    tlsFailed ||= capture.errorCode === 'tls_failed'
  }
  return { dnsResolved, tlsEstablished, tlsFailed }
}

function configuredPageUrls(input: TechnicalAuditInput, origin: string): string[] {
  // Technical checks are an on-demand read of the user's exact entry URL.
  // The old implementation expanded this list from the persisted crawler
  // cache.  That made a later check depend on stale website content and could
  // silently turn one requested entry into a full-site crawl.  Keep `pages`
  // on the input type for source compatibility with older callers, but never
  // read it as an audit target.
  void origin
  void input.pages
  const target = requestUrl(input.websiteUrl)
  return target ? [target] : []
}

function parsePageCapture(capture: Capture): PageCapture {
  const html = captureText(capture)
  let document: ReturnType<typeof parse> | null = null
  if (html && (capture.response?.headers['content-type'] ?? '').includes('html')) {
    try { document = parse(html) } catch { document = null }
  }
  return { ...capture, html, document }
}

function allPageNodes(pages: PageCapture[]): HTMLElement[] {
  return pages.flatMap((page) => page.document ? [page.document] : [])
}

function getMetaContent(document: ReturnType<typeof parse>, name: string): string | null {
  const target = name.toLowerCase()
  const node = document.querySelectorAll('meta').find((meta) => {
    const metaName = (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase()
    return metaName === target
  })
  return node?.getAttribute('content')?.trim() ?? null
}

function getHeader(capture: Capture, name: string): string | null {
  return capture.response?.headers[name.toLowerCase()] ?? null
}

function linksFrom(document: ReturnType<typeof parse>, base: URL, origin: string): string[] {
  const links: string[] = []
  for (const node of document.querySelectorAll('a')) {
    const href = node.getAttribute('href')
    if (!href) continue
    const normalized = pageUrl(href, base, origin)
    if (normalized) links.push(normalized)
  }
  return [...new Set(links)]
}

function allStaticLinks(pages: PageCapture[], base: URL, origin: string): string[] {
  return [...new Set(pages.flatMap((page) => page.document ? linksFrom(page.document, base, origin) : []))]
}

function hasMatchingText(pages: PageCapture[], expression: RegExp): boolean {
  return pages.some((page) => expression.test(page.html) || expression.test(page.document?.textContent ?? ''))
}

function robotsResponseIsText(capture: Capture): boolean {
  if (!capture.response || capture.response.status < 200 || capture.response.status >= 300) return false
  const body = captureText(capture)
  const contentType = capture.response.headers['content-type'] ?? ''
  return !/html/i.test(contentType) && isRobotsText(body)
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number: string) => String.fromCodePoint(Number.parseInt(number, 16)))
}

function validXmlText(value: string): boolean {
  let index = 0
  while (index < value.length) {
    if (value[index] !== '&') { index += 1; continue }
    const end = value.indexOf(';', index + 1)
    if (end < 0) return false
    const entity = value.slice(index, end + 1)
    if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);$/i.test(entity)) return false
    const numberMatch = entity.match(/^&#(x?)([0-9a-f]+);$/i)
    if (numberMatch) {
      const codePoint = Number.parseInt(numberMatch[2], numberMatch[1].toLowerCase() === 'x' ? 16 : 10)
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false
    }
    index = end + 1
  }
  return true
}

/** Small non-expanding XML tokenizer for the sitemap subset.  It rejects all
 * declarations/DOCTYPEs and validates nesting/attributes instead of using the
 * HTML parser as an XML validator. */
export function parseStrictXml(source: string): XmlNode | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return null
  const root: XmlNode = { name: '#root', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let index = 0
  let nodeCount = 0
  const findTagEnd = (start: number): number => {
    let quote = ''
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const character = source[cursor]
      if (quote) { if (character === quote) quote = ''; continue }
      if (character === '"' || character === "'") { quote = character; continue }
      if (character === '>') return cursor
    }
    return -1
  }
  const appendText = (text: string): boolean => {
    if (!validXmlText(text)) return false
    stack[stack.length - 1].text += decodeXmlEntities(text)
    return true
  }
  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) {
      if (!appendText(source.slice(index))) return null
      return stack.length === 1 && root.children.length === 1 && !root.text.trim() ? root.children[0] : null
    }
    if (!appendText(source.slice(index, open))) return null
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      if (end < 0) return null
      index = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9)
      if (end < 0) return null
      if (stack.length === 1) return null
      stack[stack.length - 1].text += source.slice(open + 9, end)
      index = end + 3
      continue
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2)
      if (end < 0) return null
      index = end + 2
      continue
    }
    const end = findTagEnd(open + 1)
    if (end < 0) return null
    const token = source.slice(open + 1, end).trim()
    if (!token || token.startsWith('!')) return null
    if (token.startsWith('/')) {
      const name = token.slice(1).trim()
      if (!/^[A-Za-z_][\w:.-]*$/.test(name) || stack.length <= 1 || stack[stack.length - 1].name !== name) return null
      stack.pop()
      index = end + 1
      continue
    }
    const selfClosing = /\/\s*$/.test(token)
    const content = selfClosing ? token.replace(/\/\s*$/, '').trim() : token
    const nameMatch = content.match(/^([A-Za-z_][\w:.-]*)/)
    if (!nameMatch) return null
    const name = nameMatch[1]
    const attributes: Record<string, string> = {}
    const attributeNames = new Set<string>()
    let cursor = name.length
    while (cursor < content.length) {
      while (/\s/.test(content[cursor] ?? '')) cursor += 1
      if (cursor >= content.length) break
      const attrMatch = content.slice(cursor).match(/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/s)
      if (!attrMatch) return null
      const value = attrMatch[3]
      if (!validXmlText(value)) return null
      if (attributeNames.has(attrMatch[1])) return null
      attributeNames.add(attrMatch[1])
      attributes[attrMatch[1]] = decodeXmlEntities(value)
      cursor += attrMatch[0].length
    }
    nodeCount += 1
    if (nodeCount > 10_000 || stack.length >= 64) return null
    const node: XmlNode = { name, attributes, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    index = end + 1
  }
  return stack.length === 1 && root.children.length === 1 ? root.children[0] : null
}

function xmlDescendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = []
  for (const child of node.children) {
    if (child.name.toLowerCase() === name.toLowerCase()) result.push(child)
    result.push(...xmlDescendants(child, name))
  }
  return result
}

function xmlText(node: XmlNode): string {
  return `${node.text}${node.children.map(xmlText).join('')}`.trim()
}

function collectSitemap(xml: XmlNode | null): { urls: string[]; lastmods: string[]; invalid: string[]; valid: boolean } {
  if (!xml) return { urls: [], lastmods: [], invalid: [], valid: false }
  const rootName = xml.name.toLowerCase()
  if (rootName !== 'urlset' && rootName !== 'sitemapindex') return { urls: [], lastmods: [], invalid: [], valid: false }
  const entryName = rootName === 'urlset' ? 'url' : 'sitemap'
  const entries = xml.children.filter((child) => child.name.toLowerCase() === entryName)
  const urls: string[] = []
  const lastmods: string[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    const loc = entry.children.find((child) => child.name.toLowerCase() === 'loc')
    const location = loc ? xmlText(loc) : ''
    if (!location) { invalid.push('missing_loc'); continue }
    urls.push(location)
    const lastmod = entry.children.find((child) => child.name.toLowerCase() === 'lastmod')
    if (lastmod) lastmods.push(xmlText(lastmod))
  }
  return { urls, lastmods, invalid, valid: true }
}

function pageCanonical(page: PageCapture, origin: string): { value: string | null; same: boolean; cross: boolean } {
  const node = page.document?.querySelectorAll('link').find((link) => (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'))
  const raw = node?.getAttribute('href')?.trim() ?? null
  if (!raw) return { value: null, same: false, cross: false }
  try {
    const target = new URL(raw, page.response?.url ?? page.requestedUrl)
    const value = requestUrl(target.toString())
    return { value, same: target.origin.toLowerCase() === origin.toLowerCase(), cross: target.origin.toLowerCase() !== origin.toLowerCase() }
  } catch {
    return { value: raw, same: false, cross: true }
  }
}

function jsonLdNodes(pages: PageCapture[]): { raw: string; value: unknown; pageIndex: number; valid: boolean }[] {
  const result: { raw: string; value: unknown; pageIndex: number; valid: boolean }[] = []
  pages.forEach((page, pageIndex) => {
    for (const script of page.document?.querySelectorAll('script') ?? []) {
      if ((script.getAttribute('type') ?? '').toLowerCase() !== 'application/ld+json') continue
      const raw = script.textContent.trim()
      try { result.push({ raw, value: JSON.parse(raw) as unknown, pageIndex, valid: true }) } catch { result.push({ raw, value: null, pageIndex, valid: false }) }
    }
  })
  return result
}

function flattenedJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenedJsonLd)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const graph = Array.isArray(record['@graph']) ? record['@graph'].flatMap(flattenedJsonLd) : []
  const ownKeys = Object.keys(record).filter((key) => key !== '@context' && key !== '@graph')
  return [...(ownKeys.length ? [record] : []), ...graph]
}

function safeFactText(value: string, limit = 120): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
}

function hasOwnValue(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]))
  }
  return false
}

function isUnrestrictedRobotsHeader(value: string): boolean {
  const directives = value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
  return directives.length > 0 && directives.every((directive) => directive === 'index' || directive === 'follow' || directive === 'all')
}

function hasInteractiveNavigationControl(anchor: HTMLElement): boolean {
  const role = (anchor.getAttribute('role') ?? '').trim().toLowerCase()
  return role === 'button' || role === 'menuitem' || role === 'tab'
    || Boolean(anchor.getAttribute('aria-controls'))
    || Boolean(anchor.getAttribute('aria-expanded'))
    || Boolean(anchor.getAttribute('aria-haspopup'))
    || Boolean(anchor.getAttribute('data-toggle'))
    || Boolean(anchor.getAttribute('data-bs-toggle'))
}

function hasValidFragmentTarget(anchor: HTMLElement, document: ReturnType<typeof parse>): boolean {
  const href = (anchor.getAttribute('href') ?? '').trim()
  if (!href.startsWith('#')) return false
  const fragment = href.slice(1)
  if (!fragment) return true
  return document.querySelectorAll('[id], [name]').some((node) => node.getAttribute('id') === fragment || node.getAttribute('name') === fragment)
}

function needsDynamicLinkReview(anchor: HTMLElement, document: ReturnType<typeof parse>): boolean {
  const href = (anchor.getAttribute('href') ?? '').trim()
  if (!/^(?:javascript:|#)/i.test(href)) return false
  if (hasInteractiveNavigationControl(anchor) || hasValidFragmentTarget(anchor, document)) return false
  return true
}

async function buildSnapshot(input: TechnicalAuditInput, pages: PageCapture[], requestedPages: string[], client: SafeAuditHttpClient, root: PageCapture, robots: Capture, sameOriginUrl: string, evidenceLoaders: TechnicalAuditEvidenceLoaders, onItem?: TechnicalAuditRunOptions['onItem'], onProgress?: TechnicalAuditRunOptions['onProgress'], onItemPersist?: TechnicalAuditRunOptions['onItemPersist']): Promise<TechnicalAuditSnapshot> {
  const actualPages = pages.filter((page) => page.response?.status && page.response.status >= 200 && page.response.status < 300)
  const readablePages = actualPages.filter((page) => Boolean(page.document))
  const documents = allPageNodes(actualPages)
  const rootError = root.errorCode
  const rootStatus = firstModuleStatus(root)
  // Keep the legacy projection for the still-unconfirmed modules below.  The
  // first six items use firstModuleEvidence() so phase/redirect facts and
  // timeout redaction remain local to the confirmed rules.
  const headerContentTypes = actualPages.map((page) => getHeader(page, 'content-type')).filter(Boolean)
  const pageHtmlCount = actualPages.length
  const allLinks = allStaticLinks(actualPages, new URL(input.websiteUrl), sameOriginUrl)
  const canonicalResults = actualPages.map((page) => pageCanonical(page, sameOriginUrl))
  const canonicalValues = canonicalResults.map((result) => result.value).filter((value): value is string => Boolean(value))
  const robotsText = captureText(robots)
  const robotsTextUsable = robotsResponseIsText(robots)
  const robotsGroups = robotsTextUsable ? parseRobots(robotsText) : []
  const robotsReadable = robotsTextUsable
  const robotsMissing = [404, 410].includes(firstModuleStatus(robots) ?? 0)
  const robotsUnreadable = !robotsReadable && !robotsMissing
  const noPageEvidence = readablePages.length === 0
  const plannedCaptureIncomplete = requestedPages.some((url) => !pages.some((page) => page.requestedUrl === url))
  const pageEvidenceIncomplete = pages.some((page) => Boolean(page.errorCode))
    || pages.some((page) => {
      const status = page.response?.status
      return status !== undefined && (status < 200 || status >= 300)
    })
    || actualPages.some((page) => !page.document)
    || readablePages.length < 1
    || plannedCaptureIncomplete
  const emptyBodyPages = actualPages.filter((page) => Boolean(page.document) && !(page.document?.querySelector('body')?.textContent.trim() ?? ''))
  const configuredTargets = configuredPageUrls(input, sameOriginUrl)
  const configuredTargetPaths = [...new Set(configuredTargets.map(robotsRequestPath).filter(Boolean))]
  const targetCaptures: PageCapture[] = pages

  const selectedPageCaptures = new Map<string, PageCapture>()
  for (const page of pages) {
    const requestedUrl = requestUrl(page.requestedUrl)
    if (requestedUrl) selectedPageCaptures.set(requestedUrl, page)
    const responseUrl = requestUrl(page.response?.url ?? '')
    if (responseUrl) selectedPageCaptures.set(responseUrl, page)
  }
  const selectedCaptureFor = (url: string): Capture | undefined => selectedPageCaptures.get(url)

  const items: TechnicalAuditItem[] = []
  const appendItem = async (entry: TechnicalAuditItem): Promise<void> => {
    items.push(entry)
    const completedCount = items.length
    // Persistence is deliberately before the observer.  A browser stream can
    // disappear at any point, but a result must never be announced before its
    // durable partial snapshot exists.  Persistence errors are intentional
    // control flow and must propagate to the service.
    if (onItemPersist) await onItemPersist(entry, completedCount, TECHNICAL_AUDIT_ITEM_COUNT)
    try {
      if (onItem) {
        await onItem(entry, completedCount, TECHNICAL_AUDIT_ITEM_COUNT)
      } else if (onProgress) {
        await onProgress({ item: entry, completedCount, total: TECHNICAL_AUDIT_ITEM_COUNT })
      }
    } catch {
      // A disconnected or otherwise failing observer must not alter the
      // deterministic audit or its eventual persistence.
    }
  }
  const phase = phaseCaptures([root, robots, ...targetCaptures])
  const dnsFailure = [root, robots, ...targetCaptures].some((capture) => capture.errorCode === 'dns_failed' && capture.dnsResolved !== true)
  await appendItem(item(
    'site.dns',
    phase.dnsResolved ? 'pass' : 'review',
    phase.dnsResolved ? 'pass' : dnsFailure ? 'dns_failed' : 'network_unavailable',
    { resolved: phase.dnsResolved, rule_version: TECHNICAL_AUDIT_RULE_VERSION },
    firstModuleEvidence(root, { sampled_pages: pageHtmlCount, dns_resolved: phase.dnsResolved }),
  ))
  const websiteProtocol = new URL(input.websiteUrl).protocol
  const httpsStatus: TechnicalAuditStatus = websiteProtocol === 'https:'
    ? phase.tlsEstablished && !phase.tlsFailed ? 'pass' : 'review'
    : noPageEvidence ? 'review' : 'fix'
  const httpsCode = websiteProtocol === 'https:'
    ? phase.tlsFailed ? 'tls_failed' : phase.tlsEstablished ? 'pass' : rootError === 'dns_failed' ? 'dns_failed' : 'network_unavailable'
    : noPageEvidence ? 'network_unavailable' : 'https_required'
  await appendItem(item(
    'site.https',
    httpsStatus,
    httpsCode,
    { protocol: websiteProtocol, tls_established: websiteProtocol === 'https:' ? phase.tlsEstablished : false, tls_failed: websiteProtocol === 'https:' ? phase.tlsFailed : false, rule_version: TECHNICAL_AUDIT_RULE_VERSION },
    firstModuleEvidence(root, { sampled_pages: pageHtmlCount, tls_established: phase.tlsEstablished }),
  ))
  // The confirmed HTTP-status rule is deliberately scoped to the configured
  // homepage capture only.  Saved inner-page failures remain available to the
  // later modules but cannot turn this item into an aggregate site finding.
  const httpStatusFailure = rootStatus !== null && rootStatus >= 400
  const httpStatusAvailable = rootStatus !== null
  await appendItem(item(
    'site.http_status',
    httpStatusFailure ? 'fix' : httpStatusAvailable && rootStatus < 400 ? 'pass' : 'review',
    httpStatusFailure ? 'http_error' : httpStatusAvailable && rootStatus < 400 ? 'pass' : 'network_unavailable',
    { status: rootStatus, rule_version: TECHNICAL_AUDIT_RULE_VERSION },
    firstModuleEvidence(root),
  ))

  // Redirect is also an homepage-only rule.  A successful root response is
  // enough to confirm that its chain completed, including a final 404 (the
  // HTTP item owns that status).  Only explicit loop/invalid evidence is a
  // fix; cross-origin/limit and other incomplete root captures stay review.
  const redirectError = rootError
  const redirectStatus: TechnicalAuditStatus = redirectError === 'redirect_loop' || redirectError === 'redirect_invalid'
    ? 'fix'
    : redirectError ? 'review' : 'pass'
  const redirectCode = redirectError === 'redirect_loop' || redirectError === 'redirect_invalid'
    ? redirectError
    : redirectStatus === 'review'
      ? redirectError === 'redirect_blocked' || redirectError === 'redirect_limit' ? redirectError : 'network_unavailable'
      : 'pass'
  const redirectCount = root.response?.redirects.length ?? root.errorRedirects?.length ?? 0
  await appendItem(item(
    'site.redirect',
    redirectStatus,
    redirectCode,
    { count: redirectCount, rule_version: TECHNICAL_AUDIT_RULE_VERSION },
    firstModuleEvidence(root),
  ))

  const robotsStatus = firstModuleStatus(robots)
  // Generic policy is evaluated against every configured target path, not
  // only the bounded page sample.  This adds no requests and prevents an
  // unsampled configured page from disappearing from the robots result.
  const genericRobots = robotsTextUsable ? evaluateRobotsWithRules(robotsGroups, '*', configuredTargetPaths) : null
  const genericResults = genericRobots?.results ?? []
  const genericRestricted = genericResults.filter((result) => !result.allowed)
  const genericRules = robotsGroups.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules)
  const safeRobotResults = genericResults.map((result) => ({ path: safeRobotsPath(result.path), allowed: result.allowed }))
  const safeRestricted = genericRestricted.map((result) => ({ path: safeRobotsPath(result.path), rule: result.matched_rule ? safeRobotsRule(result.matched_rule) : null }))
  const genericPolicy = genericRobots?.policy ?? 'not_declared'
  const robotsPolicyStatus: TechnicalAuditStatus = robotsMissing || (robotsReadable && (genericPolicy === 'allowed' || genericPolicy === 'not_declared')) ? 'pass' : 'review'
  const robotsPolicyCode = robotsUnreadable
    ? 'robots_unreadable'
    : robotsMissing || genericPolicy === 'not_declared'
      ? 'robots_not_declared'
      : robotsPolicyStatus === 'review' && genericPolicy === 'restricted'
        ? 'robots_restricted'
        : robotsPolicyStatus === 'review' && genericPolicy === 'mixed'
          ? 'robots_mixed'
          : 'pass'
  await appendItem(item(
    'crawl.robots_txt',
    robotsPolicyStatus,
    robotsPolicyCode,
    { status: robotsStatus, groups: robotsGroups.length, policy: genericPolicy, generic_group: robotsGroups.some((group) => group.agents.includes('*')), restricted_targets: safeRestricted.map((result) => result.path), rule_version: TECHNICAL_AUDIT_RULE_VERSION },
    { ...firstModuleEvidence(robots), paths: safeRobotResults, restricted_targets: safeRestricted, rules: genericRules.map(safeRobotsRule) },
  ))

  const loginAnalyses: Array<{ page: PageCapture; analysis: LoginPageAnalysis | null }> = targetCaptures.map((page) => ({
    page,
    analysis: page.document && page.html ? analyzeAnonymousPage({ html: page.html, requestedUrl: page.requestedUrl, finalUrl: page.response?.url ?? null }) : null,
  }))
  const loginBlocked = loginAnalyses.filter((entry) => entry.analysis?.blocked)
  const loginChallenges = loginAnalyses.filter((entry) => entry.analysis?.challenge)
  const loginEvidenceIncomplete = targetCaptures.length === 0
    || plannedCaptureIncomplete
    || targetCaptures.some((page) => !page.response || page.response.status < 200 || page.response.status >= 300 || !page.document)
    || loginAnalyses.some((entry) => !entry.analysis || !entry.analysis.readable && !entry.analysis.blocked)
  const loginStatus: TechnicalAuditStatus = loginBlocked.length ? 'fix' : loginEvidenceIncomplete ? 'review' : 'pass'
  const loginCode = loginBlocked.length ? 'login_required' : loginChallenges.length ? 'login_challenge' : loginEvidenceIncomplete ? 'login_evidence_insufficient' : 'pass'
  await appendItem(item(
    'crawl.login',
    loginStatus,
    loginCode,
    {
      blocked: loginBlocked.length > 0,
      blocked_pages: loginBlocked.map((entry) => safeUrl(entry.page.response?.url ?? entry.page.requestedUrl)),
      challenge_pages: loginChallenges.map((entry) => safeUrl(entry.page.response?.url ?? entry.page.requestedUrl)),
      readable_pages: loginAnalyses.filter((entry) => entry.analysis?.readable).length,
      evidence_incomplete: loginEvidenceIncomplete,
      rule_version: TECHNICAL_AUDIT_RULE_VERSION,
    },
    {
      pages: loginAnalyses.map(({ page, analysis }) => ({
        url: safeUrl(page.response?.url ?? page.requestedUrl),
        status: page.response?.status ?? null,
        analysis: analysis ? {
          readable: analysis.readable,
          blocked: analysis.blocked,
          challenge: analysis.challenge,
          redirected_to_login: analysis.redirected_to_login,
          candidate: analysis.candidate,
          visible_text_length: analysis.visible_text_length,
          substantive_text_length: analysis.substantive_text_length,
          login_signals: analysis.login_signals,
          challenge_signals: analysis.challenge_signals,
        } : null,
      })),
    },
  ))

  const robotMeta = documents.flatMap((document) => document.querySelectorAll('meta')).filter((node) => /^(?:robots|googlebot|bingbot|gptbot)$/i.test(node.getAttribute('name') ?? node.getAttribute('property') ?? '')).map((node) => node.getAttribute('content') ?? '')
  const noindex = robotMeta.filter((value) => /\bnoindex\b/i.test(value))
  const xRobots = actualPages.map((page) => getHeader(page, 'x-robots-tag')).filter((value): value is string => Boolean(value))
  const snippets = [...robotMeta, ...xRobots].filter((value) => /nosnippet|max-snippet\s*:\s*0|max-snippet\s*=\s*0/i.test(value))
  await appendItem(item('index.noindex', noPageEvidence || pageEvidenceIncomplete ? 'review' : noindex.length ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : noindex.length ? 'review' : 'pass', { directives: noindex.map((value) => safeFactText(value)) }, { pages: pageHtmlCount }))
  const xRobotsRestricted = xRobots.some((value) => !isUnrestrictedRobotsHeader(value))
  await appendItem(item('index.x_robots_tag', noPageEvidence || pageEvidenceIncomplete ? 'review' : xRobotsRestricted ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : xRobotsRestricted ? 'review' : 'pass', { directives: xRobots.map((value) => safeFactText(value)), restricted: xRobotsRestricted }, { pages: pageHtmlCount }))
  await appendItem(item('index.snippet', noPageEvidence || pageEvidenceIncomplete ? 'review' : snippets.length ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : snippets.length ? 'review' : 'pass', { restrictions: snippets.map((value) => safeFactText(value)) }, { pages: pageHtmlCount }))

  const missingCanonical = canonicalResults.some((result) => !result.value)
  const crossCanonical = canonicalResults.filter((result) => result.cross).map((result) => safeUrl(result.value ?? ''))
  const canonicalTargetBroken = canonicalResults.some((result) => {
    if (!result.value) return false
    const capture = selectedCaptureFor(result.value)
    const status = capture ? firstModuleStatus(capture) : null
    return status !== null && [404, 410].includes(status)
  })
  const sampledPageUrls = new Set(actualPages.map((page) => requestUrl(page.response?.url ?? page.requestedUrl)))
  const canonicalTargetUnverified = canonicalResults.some((result) => {
    if (!result.value || !result.same || canonicalTargetBroken) return false
    const capture = selectedCaptureFor(result.value)
    if (capture?.errorCode) return true
    const status = capture ? firstModuleStatus(capture) : null
    if (status !== null && status >= 400 && status !== 404 && status !== 410) return true
    return false
  })
  await appendItem(item('canonical.target', canonicalTargetBroken ? 'fix' : noPageEvidence || pageEvidenceIncomplete ? 'review' : missingCanonical || crossCanonical.length || canonicalTargetUnverified ? 'review' : 'pass', canonicalTargetBroken ? 'canonical_target_missing' : noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : missingCanonical || crossCanonical.length || canonicalTargetUnverified ? 'canonical_review' : 'pass', { count: canonicalValues.length }, { cross_origin: crossCanonical, target_check: canonicalResults.map((result) => {
    const capture = result.value ? selectedCaptureFor(result.value) : undefined
    return { url: safeUrl(result.value ?? ''), status: result.value ? capture ? firstModuleStatus(capture) : sampledPageUrls.has(result.value) ? 200 : null : null, error: result.value ? capture?.errorCode ?? null : null }
  }) }))
  const domainConflict = canonicalResults.some((result) => result.cross)
  await appendItem(item('canonical.domain_conflict', noPageEvidence || pageEvidenceIncomplete ? 'review' : domainConflict ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : domainConflict ? 'canonical_target_cross_origin' : 'pass', { detected: domainConflict }, { pages: pageHtmlCount }))

  const checkedLinks = allLinks.filter((link) => Boolean(selectedCaptureFor(link)))
  const unverifiedLinks = allLinks.filter((link) => !selectedCaptureFor(link))
  const brokenLinkTargets = checkedLinks.filter((link) => [404, 410].includes(firstModuleStatus(selectedCaptureFor(link) as Capture) ?? 0))
  const blockedLinkTargets = checkedLinks.filter((link) => {
    const capture = selectedCaptureFor(link)
    const status = capture ? firstModuleStatus(capture) : null
    return Boolean(capture?.errorCode) || Boolean(status !== null && status >= 400 && ![404, 410].includes(status))
  })
  const linksStatus: TechnicalAuditStatus = brokenLinkTargets.length
    ? 'fix'
    : blockedLinkTargets.length || noPageEvidence || pageEvidenceIncomplete || (allLinks.length > 0 && checkedLinks.length === 0)
      ? 'review'
      : allLinks.length === 0 ? 'not_applicable' : 'pass'
  const linksCode = brokenLinkTargets.length
    ? 'broken_link'
    : noPageEvidence
      ? 'network_unavailable'
      : blockedLinkTargets.length || pageEvidenceIncomplete || (allLinks.length > 0 && checkedLinks.length === 0)
      ? 'limit_partial'
      : allLinks.length === 0 ? 'not_applicable' : 'pass'
  await appendItem(item('links.broken', linksStatus, linksCode, { checked: checkedLinks.length, sampled: checkedLinks.length, unverified: unverifiedLinks.length, broken: brokenLinkTargets.length }, { broken_links: brokenLinkTargets.map(safeUrl), checked_links: checkedLinks.slice(0, 20).map(safeUrl), unverified_links: unverifiedLinks.slice(0, 20).map(safeUrl) }))
  const navigationAnchors = documents.flatMap((document) => document.querySelectorAll('nav,header').flatMap((node) => node.querySelectorAll('a').map((anchor) => ({ anchor, document }))))
  const navigationReview = navigationAnchors.some(({ anchor, document }) => needsDynamicLinkReview(anchor, document))
  const navigationDynamic = navigationAnchors.filter(({ anchor }) => /^(?:javascript:|#)/i.test(anchor.getAttribute('href') ?? '')).length
  await appendItem(item('links.navigation', navigationReview ? 'review' : noPageEvidence || pageEvidenceIncomplete ? 'review' : 'pass', navigationReview ? 'review' : noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : 'pass', { links: navigationAnchors.length, dynamic: navigationDynamic }, { pages: pageHtmlCount }))
  const paginationAnchors = documents.flatMap((document) => document.querySelectorAll('a').filter((node) => /(?:next|下一页|page=|分页)/i.test(`${node.getAttribute('rel') ?? ''} ${node.getAttribute('aria-label') ?? ''} ${node.textContent}`)).map((anchor) => ({ anchor, document })))
  const paginationReview = paginationAnchors.some(({ anchor, document }) => needsDynamicLinkReview(anchor, document))
  await appendItem(item('links.pagination', paginationReview ? 'review' : noPageEvidence || pageEvidenceIncomplete ? 'review' : paginationAnchors.length ? 'pass' : 'not_applicable', paginationReview ? 'review' : noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : paginationAnchors.length ? 'pass' : 'not_applicable', { links: paginationAnchors.length, dynamic: paginationAnchors.filter(({ anchor }) => /^(?:javascript:|#)/i.test(anchor.getAttribute('href') ?? '')).length }, { pages: pageHtmlCount }))

  const { sitemaps, sitemapCandidatesTruncated } = await evidenceLoaders.loadSitemaps()
  const sitemapCaptures = sitemaps.length ? sitemaps : [{ requestedUrl: `${sameOriginUrl}/sitemap.xml`, response: null, errorCode: 'request_failure' }]
  const sitemapDatas = sitemapCaptures.map((capture) => capture.response?.status && capture.response.status >= 200 && capture.response.status < 300 ? collectSitemap(parseStrictXml(captureText(capture))) : { urls: [], lastmods: [], invalid: [], valid: false })
  const sitemapData = {
    urls: sitemapDatas.flatMap((data) => data.urls),
    lastmods: sitemapDatas.flatMap((data) => data.lastmods),
    invalid: sitemapDatas.flatMap((data) => data.invalid),
    valid: sitemapDatas.some((data) => data.valid),
  }
  const sitemapInvalidUrls = sitemapData.urls.filter((value) => !sameOrigin(value, sameOriginUrl) || !/^https?:\/\//i.test(value))
  const sitemapCrossOrigin = sitemapData.urls.filter((value) => !sameOrigin(value, sameOriginUrl))
  const sitemapMalformedUrls = sitemapData.urls.filter((value) => {
    try { const target = new URL(value); return target.protocol !== 'http:' && target.protocol !== 'https:' }
    catch { return true }
  })
  const sitemapDeadUrls = sitemapData.urls.filter((value) => {
    const normalized = requestUrl(value)
    const capture = selectedCaptureFor(normalized)
    const status = capture ? firstModuleStatus(capture) : null
    return status === 404 || status === 410
  })
  const sitemapBlockedUrls = sitemapData.urls.filter((value) => {
    const normalized = requestUrl(value)
    const capture = selectedCaptureFor(normalized)
    const status = capture ? firstModuleStatus(capture) : null
    return Boolean(capture?.errorCode) || Boolean(status !== null && status >= 400 && status !== 404 && status !== 410)
  })
  const sitemapSameOriginUrls = sitemapData.urls.filter((value) => sameOrigin(value, sameOriginUrl))
  const checkedSitemapUrls = new Set(selectedPageCaptures.keys())
  const sitemapSampleIncomplete = sitemapSameOriginUrls.some((value) => !checkedSitemapUrls.has(requestUrl(value)))
  const sitemapHasValid = sitemapData.valid
  const sitemapResponseIncomplete = sitemapCaptures.some((capture) => !capture.response || capture.response.status < 200 || capture.response.status >= 300)
  const sitemapExplicitInvalid = sitemapCaptures.some((capture, index) => {
    const status = capture.response?.status
    const data = sitemapDatas[index]
    return status !== undefined && status >= 200 && status < 300 && (!data?.valid || Boolean(data.invalid.length))
  })
  const sitemapCaptureIncomplete = sitemapResponseIncomplete || sitemapExplicitInvalid
  const sitemapNotFound = sitemapCaptures.every((capture) => capture.response?.status === 404 || capture.response?.status === 410)
  const sitemapEvidence = { candidates: sitemapCaptures.map(captureEvidence) }
  await appendItem(item('sitemap.generation', sitemapExplicitInvalid ? 'fix' : sitemapHasValid && !sitemapResponseIncomplete ? 'pass' : 'review', sitemapExplicitInvalid ? 'sitemap_invalid' : sitemapHasValid && !sitemapResponseIncomplete ? 'pass' : sitemapNotFound ? 'sitemap_missing' : 'review', { statuses: sitemapCaptures.map(captureStatus), entries: sitemapData.urls.length, candidate_budget_exhausted: sitemapCandidatesTruncated, invalid_candidates: sitemapExplicitInvalid ? 1 : 0 }, sitemapEvidence))
  const sampledPaths = new Set(actualPages.map((page) => safeUrlPath(page.response?.url ?? page.requestedUrl)))
  const sitemapPaths = new Set(sitemapData.urls.map(safeUrlPath))
  const coverage = sampledPaths.size > 0 && [...sampledPaths].every((path) => sitemapPaths.has(path))
  await appendItem(item('sitemap.coverage', noPageEvidence || pageEvidenceIncomplete || !sitemapHasValid || sitemapCaptureIncomplete ? 'review' : coverage ? 'pass' : 'review', noPageEvidence || pageEvidenceIncomplete || !sitemapHasValid || sitemapCaptureIncomplete ? 'review' : coverage ? 'pass' : 'limit_partial', { sampled_pages: sampledPaths.size, covered: [...sampledPaths].filter((path) => sitemapPaths.has(path)).length }, { scope: 'configured_pages_only' }))
  const sitemapDeterministicFix = sitemapDeadUrls.length || sitemapMalformedUrls.length || sitemapData.invalid.length
  const sitemapUncertain = sitemapCrossOrigin.length || sitemapBlockedUrls.length || sitemapInvalidUrls.length || sitemapCaptureIncomplete
  await appendItem(item('sitemap.invalid_urls', !sitemapHasValid ? 'review' : sitemapDeterministicFix ? 'fix' : sitemapUncertain ? 'review' : 'pass', !sitemapHasValid ? 'review' : sitemapDeterministicFix ? 'sitemap_invalid_url' : sitemapUncertain ? 'limit_partial' : 'pass', { invalid: sitemapInvalidUrls.length + sitemapData.invalid.length, malformed: sitemapMalformedUrls.length, dead: sitemapDeadUrls.length, blocked: sitemapBlockedUrls.length, sample_incomplete: sitemapSampleIncomplete, candidate_budget_exhausted: sitemapCandidatesTruncated }, { invalid_urls: sitemapInvalidUrls.slice(0, 20).map(safeUrl), dead_urls: sitemapDeadUrls.slice(0, 20).map(safeUrl) }))
  const invalidLastmod = sitemapData.lastmods.filter((value) => Number.isNaN(Date.parse(value)))
  await appendItem(item('sitemap.lastmod', invalidLastmod.length ? 'fix' : noPageEvidence || !sitemapHasValid || sitemapCaptureIncomplete ? 'review' : sitemapData.lastmods.length ? 'pass' : 'review', invalidLastmod.length ? 'sitemap_lastmod_invalid' : noPageEvidence || !sitemapHasValid || sitemapCaptureIncomplete ? 'review' : sitemapData.lastmods.length ? 'pass' : 'sitemap_lastmod_missing', { count: sitemapData.lastmods.length, invalid: invalidLastmod.length }, { lastmod: sitemapData.lastmods.slice(0, 10).map(safeFactText) }))

  const { llms } = await evidenceLoaders.loadLlms()
  // llms.txt is deliberately a single, relative companion resource of the
  // exact user-entered entry URL.  Do not discover alternatives from HTML or
  // HTTP Link declarations and do not fall back to the origin root.
  const llmsCandidates = [llms]
  const llmsCandidatesTruncated = false
  let llmsStatus: TechnicalAuditStatus = 'fix'
  let llmsCode = 'llms_unavailable'
  let llmsFacts: TechnicalAuditFacts = { presence: 'unconfirmed', candidates: llmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), files_checked: llmsCandidates.length, candidate_budget_exhausted: llmsCandidatesTruncated }
  let llmsEvidence: Record<string, unknown> = { candidates: llmsCandidates.map(captureEvidence), candidate_budget_exhausted: llmsCandidatesTruncated }
  const llmsAnalyses = llmsCandidates.flatMap((candidate) => {
    if (!candidate.response || candidate.response.status < 200 || candidate.response.status >= 300) return []
    const decoded = captureUtf8Text(candidate)
    const body = decoded.text
    const isHtmlFallback = /<\s*(?:html|body|head)\b/i.test(body) || /html/i.test(candidate.response.headers['content-type'] ?? '')
    const h1 = /^\s*#\s+\S/m.test(body.replace(/^\uFEFF/, ''))
    const formatIssues = !decoded.valid
      ? ['invalid_utf8']
      : [
        ...(!body.trim() ? ['empty'] : []),
        ...(isHtmlFallback ? ['html_fallback'] : []),
        ...(!h1 ? ['missing_h1'] : []),
      ]
    return [{ candidate, decoded, body, isHtmlFallback, h1, formatIssues }]
  })
  const usableLlms = llmsAnalyses.filter((analysis) => !analysis.isHtmlFallback && analysis.decoded.valid && Boolean(analysis.body.trim()) && analysis.h1)
  const invalidLlmsContent = llmsAnalyses.filter((analysis) => analysis.formatIssues.length > 0)
  const missingLlmsCandidates = llmsCandidates.filter((candidate) => candidate.response?.status === 404 || candidate.response?.status === 410)
  const unavailableLlmsCandidates = llmsCandidates.filter((candidate) => {
    const status = candidate.response?.status
    return Boolean(candidate.errorCode) || Boolean(status !== undefined && (status < 200 || status >= 300) && status !== 404 && status !== 410)
  })
  if (usableLlms.length) {
    llmsStatus = 'pass'
    llmsCode = 'llms_present'
    llmsFacts = { presence: 'present', candidates: usableLlms.map((analysis) => safeUrl(analysis.candidate.response?.url ?? analysis.candidate.requestedUrl)), files_checked: llmsCandidates.length, valid_files: usableLlms.length, has_h1: true, candidate_budget_exhausted: llmsCandidatesTruncated }
    llmsEvidence = { candidates: llmsCandidates.map(captureEvidence), candidate_budget_exhausted: llmsCandidatesTruncated }
  } else if (invalidLlmsContent.length) {
    llmsCode = 'llms_invalid'
    llmsFacts = { presence: 'invalid', candidates: llmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), files_checked: llmsCandidates.length, invalid_files: invalidLlmsContent.map((analysis) => ({ url: safeUrl(analysis.candidate.response?.url ?? analysis.candidate.requestedUrl), reasons: analysis.formatIssues })), candidate_budget_exhausted: llmsCandidatesTruncated }
    llmsEvidence = { candidates: llmsCandidates.map(captureEvidence), invalid_files: invalidLlmsContent.map((analysis) => ({ url: safeUrl(analysis.candidate.response?.url ?? analysis.candidate.requestedUrl), reasons: analysis.formatIssues })), candidate_budget_exhausted: llmsCandidatesTruncated }
  } else if (unavailableLlmsCandidates.length) {
    llmsCode = 'llms_unavailable'
    llmsFacts = { presence: 'unavailable', candidates: llmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), files_checked: llmsCandidates.length, unavailable_files: unavailableLlmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), candidate_budget_exhausted: llmsCandidatesTruncated }
    llmsEvidence = { candidates: llmsCandidates.map(captureEvidence), unavailable_files: unavailableLlmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), candidate_budget_exhausted: llmsCandidatesTruncated }
  } else {
    llmsCode = 'llms_missing'
    llmsFacts = { presence: 'missing', candidates: llmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), files_checked: llmsCandidates.length, missing_files: missingLlmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), candidate_budget_exhausted: llmsCandidatesTruncated }
    llmsEvidence = { candidates: llmsCandidates.map(captureEvidence), missing_files: missingLlmsCandidates.map((candidate) => safeUrl(candidate.requestedUrl)), candidate_budget_exhausted: llmsCandidatesTruncated }
  }
  await appendItem(item('discovery.llms_txt', llmsStatus, llmsCode, llmsFacts, llmsEvidence))

  const bodyTexts = actualPages.map((page) => page.document?.querySelector('body')?.textContent.trim() ?? '').filter(Boolean)
  const scripts = documents.flatMap((document) => document.querySelectorAll('script'))
  const dynamicShell = bodyTexts.some((text) => text.length < 80) && scripts.length > 0
  await appendItem(item('content.html_body', noPageEvidence ? 'review' : emptyBodyPages.length ? 'fix' : pageEvidenceIncomplete ? 'review' : bodyTexts.length ? 'pass' : 'fix', noPageEvidence ? 'network_unavailable' : emptyBodyPages.length || !bodyTexts.length ? 'html_body_missing' : pageEvidenceIncomplete ? 'limit_partial' : 'pass', { pages_with_body: bodyTexts.length, total_pages: pageHtmlCount, empty_pages: emptyBodyPages.length }, { content_types: headerContentTypes }))
  const staticAnalyses = actualPages.map((page) => page.document && page.html ? analyzeAnonymousPage({ html: page.html, requestedUrl: page.requestedUrl, finalUrl: page.response?.url ?? null }) : null)
  const staticReadable = staticAnalyses.length > 0 && staticAnalyses.every((analysis) => analysis?.readable === true)
  await appendItem(item('content.javascript_render', noPageEvidence || pageEvidenceIncomplete || !staticReadable ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : !staticReadable ? 'review' : 'pass', { scripts: scripts.length, dynamic_shell: dynamicShell, static_readable: staticReadable }, { pages: pageHtmlCount }))
  const structureInvalid = documents.some((document) => !Boolean(document.querySelector('html') && document.querySelector('head') && document.querySelector('body')))
  await appendItem(item('content.html_structure', structureInvalid ? 'fix' : noPageEvidence || pageEvidenceIncomplete ? 'review' : 'pass', structureInvalid ? 'html_structure_invalid' : noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : 'pass', { pages: pageHtmlCount }, { pages: pageHtmlCount }))
  const metadataMissing = documents.filter((document) => !document.querySelector('title') || !getMetaContent(document, 'description')).length
  await appendItem(item('content.metadata', noPageEvidence || pageEvidenceIncomplete || metadataMissing ? 'review' : 'pass', noPageEvidence ? 'network_unavailable' : pageEvidenceIncomplete ? 'limit_partial' : metadataMissing ? 'metadata_incomplete' : 'pass', { pages: pageHtmlCount, missing_pages: metadataMissing }, { pages: pageHtmlCount }))

  // Structured data is intentionally the only item that can be omitted from
  // a runner snapshot.  A missing/non-HTML/robots-blocked page is an execution
  // failure, not a third status.  If a successfully read page has a clear
  // missing/invalid marker, retain that fix conclusion and include the number
  // of incomplete pages in facts instead of pretending the whole crawl passed.
  const structuredPageFailures = pages.flatMap((page) => {
    if (page.errorCode === 'robots_blocked') return [{ code: 'robots_blocked', url: safeUrl(page.requestedUrl) }]
    if (!page.response) return [{ code: 'page_request_failed', url: safeUrl(page.requestedUrl) }]
    if (page.response.status < 200 || page.response.status >= 300) return [{ code: 'page_request_failed', url: safeUrl(page.response.url || page.requestedUrl) }]
    if (!page.document) {
      const contentType = page.response.headers['content-type'] ?? ''
      return [{ code: /html/i.test(contentType) ? 'html_parse_failed' : 'non_html_response', url: safeUrl(page.response.url || page.requestedUrl) }]
    }
    return []
  })
  // Always analyze every successfully read HTML page before deciding whether
  // an incomplete crawl can still yield a deterministic finding.  Previously
  // this work was skipped when any page failed, so a missing marker on one
  // page was hidden by an unrelated 503 on another page.
  const structuredPages = await Promise.all(actualPages.filter((page) => Boolean(page.document)).map(async (page) => ({
    page,
    result: await analyzeStructuredDataPage({
      html: page.html,
      pageUrl: page.response?.url ?? page.requestedUrl,
      document: page.document,
    }),
  })))
  const structuredParserFailures = structuredPages.flatMap(({ page, result }) => result.issues.some((issue) => issue.reason === 'parser_error')
    ? [{ code: 'structured_parser_error', url: safeUrl(page.response?.url ?? page.requestedUrl) }]
    : [])
  const structuredExecutionErrors = [...new Map([...structuredPageFailures, ...structuredParserFailures].map((failure) => [`${failure.code}\u0000${failure.url}`, failure])).values()]
  const pagesWithMarkers = structuredPages.filter((entry) => entry.result.formats.length > 0).length
  const missingPages = structuredPages.filter((entry) => entry.result.formats.length === 0)
  const pagesWithFix = structuredPages.filter((entry) => {
    const websiteIssues = entry.result.issues.some((issue) => issue.reason !== 'parser_error')
    const parserOnly = entry.result.issues.length > 0 && !websiteIssues
    return websiteIssues || (!parserOnly && entry.result.formats.length === 0)
  })
  const invalidPages = structuredPages.filter((entry) => entry.result.issues.some((issue) => issue.reason !== 'parser_error'
    && (issue.reason !== 'empty_declaration' || entry.result.formats.length > 0)))
  const pageEvidence = structuredPages.map(({ page, result }) => ({
    url: safeUrl(page.response?.url ?? page.requestedUrl),
    formats: result.formats,
    evidence: result.evidence,
    issues: result.issues.map((issue) => ({ format: issue.format, reason: issue.reason, location: issue.location })),
  }))
  let structuredItem: TechnicalAuditItem | null = null
  if (pagesWithFix.length) {
    structuredItem = item(
      'content.structured_data',
      'fix',
      invalidPages.length > 0 ? 'structured_data_invalid' : 'structured_data_missing',
      {
        pages: structuredPages.length,
        pages_with_markers: pagesWithMarkers,
        missing_pages: missingPages.length,
        invalid_pages: invalidPages.length,
        incomplete_pages: structuredExecutionErrors.length,
        formats: [...new Set(structuredPages.flatMap((entry) => entry.result.formats))],
      },
      { pages: pageEvidence, incomplete_pages: structuredExecutionErrors.map((failure) => failure.url) },
    )
  } else if (!structuredExecutionErrors.length) {
    structuredItem = item(
      'content.structured_data',
      'pass',
      'pass',
      {
        pages: structuredPages.length,
        pages_with_markers: pagesWithMarkers,
        missing_pages: missingPages.length,
        invalid_pages: invalidPages.length,
        formats: [...new Set(structuredPages.flatMap((entry) => entry.result.formats))],
      },
      { pages: pageEvidence },
    )
  }
  if (structuredItem) await appendItem(structuredItem)

  const expectedIds = new Set([
    'site.dns', 'site.https', 'site.http_status', 'site.redirect',
    'crawl.robots_txt', 'crawl.login',
    'index.noindex', 'index.x_robots_tag', 'index.snippet',
    'canonical.target', 'canonical.domain_conflict',
    'links.broken', 'links.navigation', 'links.pagination',
    'sitemap.generation', 'sitemap.coverage', 'sitemap.invalid_urls', 'sitemap.lastmod', 'discovery.llms_txt',
    'content.html_body', 'content.javascript_render', 'content.html_structure', 'content.metadata',
    'content.structured_data',
  ])
  const itemIds = items.map((entry) => entry.item_id)
  const uniqueItemIds = new Set(itemIds)
  const expectedSnapshotIds = structuredItem || !structuredExecutionErrors.length
    ? expectedIds
    : new Set([...expectedIds].filter((id) => id !== 'content.structured_data'))
  const completeItemContract = itemIds.length === expectedSnapshotIds.size
    && uniqueItemIds.size === itemIds.length
    && uniqueItemIds.size === expectedSnapshotIds.size
    && [...uniqueItemIds].every((id) => expectedSnapshotIds.has(id))
  if (!completeItemContract) throw new Error('technical_audit_item_contract_invalid')
  void client
  const { checkedAt, scope } = evidenceLoaders.finalMetadata()
  const snapshot: TechnicalAuditSnapshot = { checked_at: checkedAt, website_url: input.websiteUrl, scope, items, rule_version: TECHNICAL_AUDIT_RULE_VERSION }
  // A failed read leaves the affected item absent from this partial snapshot.
  // It is intentionally not serialized as an execution error: the customer
  // panel shows that item as unchecked and must not expose transport/parser
  // failure reasons as a technical conclusion.
  return snapshot
}

export async function runTechnicalAudit(input: TechnicalAuditInput, options: TechnicalAuditRunOptions = {}): Promise<TechnicalAuditSnapshot> {
  let website: URL
  try { website = new URL(input.websiteUrl) } catch { throw new Error('website_url_invalid') }
  if (website.protocol !== 'http:' && website.protocol !== 'https:' || website.username || website.password) throw new Error('website_url_invalid')
  const origin = website.origin.toLowerCase()
  const targets = configuredPageUrls(input, origin)
  const perRequestTimeout = options.timeoutMs ?? TECHNICAL_AUDIT_LIMITS.requestTimeoutMs
  const defaultRequestLimit = Math.max(40, (targets.length + 10) * (TECHNICAL_AUDIT_LIMITS.maxRedirects + 1))
  const requestLimit = options.maxRequests ?? defaultRequestLimit
  const totalTimeoutMs = options.totalTimeoutMs ?? Math.max(45_000, requestLimit * perRequestTimeout + 1_000)
  const startedAt = Date.now()
  // The robots file is the first network resource.  Once it has been read,
  // pass the same detector policy into the HTTP client so a redirect cannot
  // bypass the runner's pre-request robots gate.
  let robotsRequestActive = true
  let pageRequestActive = false
  let robotsGate: (url: URL) => boolean = () => true
  const robotsUrl = relativeResourceUrl(website, 'robots.txt')
  const robotsPath = (() => {
    try { return new URL(robotsUrl).pathname } catch { return '/robots.txt' }
  })()
  const client = options.client ?? new SafeAuditHttpClient({
    origin,
    maxRequests: requestLimit,
    timeoutMs: options.timeoutMs,
    deadlineAt: startedAt + totalTimeoutMs,
    maxDecompressedBytes: options.maxDecompressedBytes,
    transport: options.transport,
    resolveHost: options.resolveHost,
    authorizeUrl: (url) => {
      // The first request is limited to the exact companion robots pathname.
      // This matters for a path-scoped entry such as `/about`: a redirect from
      // `/about/robots.txt` to the origin-root `/robots.txt` must not silently
      // broaden the audit's read scope before the robots policy is known.
      if (url.origin.toLowerCase() !== origin) return false
      if (robotsRequestActive) return url.pathname === robotsPath
      // Every later resource (the configured page, sitemap candidates and the
      // one llms.txt file) must remain within the input root.  The HTTP client
      // also enforces same-origin; this path check prevents upward redirects
      // and robots-declared candidates from escaping a scoped entry path.
      return sameReadScope(url, website) && robotsGate(url)
    },
  } satisfies SafeHttpClientOptions)
  const robots = await fetchCapture(client, robotsUrl, 'text/plain,*/*;q=0.1')
  robotsRequestActive = false
  const robotsMissing = [404, 410].includes(firstModuleStatus(robots) ?? 0)
  const robotsUsable = robotsResponseIsText(robots)
  const robotsGroups = robotsUsable ? parseRobots(captureText(robots)) : []
  const robotsCanFetch = (url: string): boolean => {
    if (robotsMissing) return true
    if (!robotsUsable) return false
    const evaluation = evaluateRobots(robotsGroups, 'geodesk', [robotsRequestPath(url)])
    return evaluation?.results[0]?.allowed ?? true
  }
  robotsGate = (url) => robotsCanFetch(url.toString())
  const pages: PageCapture[] = []
  for (const target of targets) {
    let capture: Capture
    if (!robotsCanFetch(target)) {
      capture = { requestedUrl: target, response: null, errorCode: 'robots_blocked' }
    } else {
      pageRequestActive = true
      try {
        capture = await fetchCapture(client, target, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1')
      } finally {
        pageRequestActive = false
      }
    }
    pages.push(parsePageCapture(capture))
  }
  const rootRequestUrl = requestUrl(input.websiteUrl)
  const root = pages.find((page) => page.requestedUrl === rootRequestUrl) ?? parsePageCapture({ requestedUrl: rootRequestUrl, response: null, errorCode: 'request_failure' })
  const isValidPageCapture = (page: PageCapture): boolean => Boolean(
    page.response
      && page.response.status >= 200
      && page.response.status < 300
      && page.document,
  )
  const skippedPages = [...new Set(pages.filter((page) => !isValidPageCapture(page)).map((page) => requestUrl(page.requestedUrl)).filter(Boolean))]
  // Sitemap and llms evidence is intentionally loaded at the point where the
  // corresponding items are about to be finalized.  This keeps the original
  // request order and limits while allowing the first fourteen independent
  // items to reach observers before a slow sitemap/llms request completes.
  let sitemapEvidencePromise: Promise<TechnicalAuditSitemapEvidence> | null = null
  let sitemapEvidence: TechnicalAuditSitemapEvidence | null = null
  const loadSitemaps = async (): Promise<TechnicalAuditSitemapEvidence> => {
    if (sitemapEvidencePromise === null) {
      sitemapEvidencePromise = (async () => {
        const sitemapHintsAll = [...new Set(captureText(robots).split(/\r?\n/).flatMap((line) => {
          const separator = line.indexOf(':')
          if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== 'sitemap') return []
          const value = line.slice(separator + 1).trim()
          try {
            const target = new URL(value, origin)
            return target.origin.toLowerCase() === origin && sameReadScope(target, website)
              ? [requestUrl(target.toString())]
              : []
          } catch { return [] }
        }))]
        const sitemapHints = sitemapHintsAll.slice(0, 3)
        const sitemapCandidateBudget = sitemapHintsAll.length > 3
        const sitemapTargets = sitemapHints.length ? sitemapHints : [relativeResourceUrl(website, 'sitemap.xml')]
        const sitemaps: Capture[] = []
        for (const target of sitemapTargets) sitemaps.push(robotsCanFetch(target)
          ? await fetchCapture(client, target, 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1')
          : { requestedUrl: target, response: null, errorCode: 'robots_blocked' })
        // A sitemap index is still bounded: only same-origin child locations up to
        // the remaining candidate allowance are inspected, never recursively crawled.
        const childSitemapTargetsAll = sitemaps.flatMap((capture) => {
          if (!capture.response || capture.response.status < 200 || capture.response.status >= 300) return []
          const parsed = parseStrictXml(captureText(capture))
          if (!parsed || parsed.name.toLowerCase() !== 'sitemapindex') return []
          const data = collectSitemap(parsed)
          return data.urls
            .filter((value) => sameOrigin(value, origin))
            .map((value) => {
              try { return sameReadScope(value, website) ? requestUrl(value) : '' } catch { return '' }
            })
            .filter((value) => value && !sitemaps.some((item) => item.requestedUrl === value))
        })
        const childSitemapTargets = childSitemapTargetsAll.slice(0, Math.max(0, 5 - sitemaps.length))
        const sitemapChildBudget = childSitemapTargetsAll.length > childSitemapTargets.length
        for (const target of childSitemapTargets) sitemaps.push(robotsCanFetch(target)
          ? await fetchCapture(client, target, 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1')
          : { requestedUrl: target, response: null, errorCode: 'robots_blocked' })
        const result: TechnicalAuditSitemapEvidence = { sitemaps, sitemapCandidatesTruncated: sitemapCandidateBudget || sitemapChildBudget }
        sitemapEvidence = result
        return result
      })()
    }
    return sitemapEvidencePromise
  }

  let llmsEvidencePromise: Promise<TechnicalAuditLlmsEvidence> | null = null
  let llmsEvidence: TechnicalAuditLlmsEvidence | null = null
  let networkFinishedAt: number | null = null
  const loadLlms = async (): Promise<TechnicalAuditLlmsEvidence> => {
    if (llmsEvidencePromise === null) {
      llmsEvidencePromise = (async () => {
        const llmsUrl = relativeResourceUrl(website, 'llms.txt')
        const llms = robotsCanFetch(llmsUrl)
          ? await fetchCapture(client, llmsUrl, 'text/plain,text/markdown,text/*;q=0.9,*/*;q=0.1')
          : { requestedUrl: llmsUrl, response: null, errorCode: 'robots_blocked' }
        const result: TechnicalAuditLlmsEvidence = { llms }
        llmsEvidence = result
        networkFinishedAt = Date.now()
        return result
      })()
    }
    return llmsEvidencePromise
  }

  const evidenceLoaders: TechnicalAuditEvidenceLoaders = {
    loadSitemaps,
    loadLlms,
    finalMetadata: () => {
      if (!sitemapEvidence || !llmsEvidence || networkFinishedAt === null) throw new Error('technical_audit_evidence_incomplete')
      const limits: string[] = []
      const used = client.requestsUsed
      if (used >= client.requestLimit) limits.push('request_budget_exhausted')
      if (networkFinishedAt - startedAt >= totalTimeoutMs) limits.push('time_budget_exhausted')
      if (skippedPages.length > 0) limits.push('page_check_incomplete')
      if (pages.some((page) => page.errorCode === 'response_too_large')) limits.push('response_size_limited')
      const scope: TechnicalAuditScope = {
        pages: targets.map(safeUrl),
        sampled_pages: pages.filter(isValidPageCapture).map((page) => safeUrl(page.response?.url ?? page.requestedUrl)),
        skipped_pages: skippedPages.map(safeUrl),
        candidates: [robots.requestedUrl, ...sitemapEvidence.sitemaps.map((capture) => capture.requestedUrl), llmsEvidence.llms.requestedUrl].filter(Boolean).map(safeUrl),
        requests: used,
        request_limit: client.requestLimit,
        page_limit: targets.length,
        response_limit_bytes: options.maxDecompressedBytes ?? TECHNICAL_AUDIT_LIMITS.maxDecompressedBytes,
        time_limit_ms: totalTimeoutMs,
        limits,
      }
      return { checkedAt: (options.now ?? (() => new Date()))().toISOString(), scope }
    },
  }
  return await buildSnapshot(
    input,
    pages,
    targets,
    client,
    root,
    robots,
    origin,
    evidenceLoaders,
    options.onItem,
    options.onProgress,
    options.onItemPersist,
  )
}
