import type { WebsitePageResult } from './site-crawler.ts'

/**
 * A raw span belonging to one character range in the cleaned text.  The
 * cleaner deliberately keeps this mapping in memory only; the raw crawl
 * cache remains the source of truth and is never replaced by cleaned text.
 */
export type ContentAuditRawCharSpan = {
  rawStart: number
  rawEnd: number
}

export type ContentAuditSharedLocation = {
  page: string
  pageUrl: string
  rawStart: number
  rawEnd: number
  statement: string
  context: string
  cleanText: string
}

export type ContentAuditCleanedLine = {
  text: string
  cleanStart: number
  cleanEnd: number
  rawStart: number
  rawEnd: number
  /** Exact raw key of the complete public block represented on another page. */
  sharedKey?: string
  /** Position of this line within the complete shared block. */
  sharedLineIndex?: number
}

/** The model-facing page plus an exact in-memory map back to the crawl cache. */
export type ContentAuditCleanedPage = WebsitePageResult & {
  rawBodyText: string
  truncated: boolean
  bodyCharMap: readonly (ContentAuditRawCharSpan | null)[]
  lines: readonly ContentAuditCleanedLine[]
  sharedLocations: ReadonlyMap<string, readonly ContentAuditSharedLocation[]>
  /** Index of the first equivalent page, when model extraction can be reused. */
  duplicateOf?: number
}

export type ContentAuditCleaningProgress = {
  /** Number of pages complete for the page-facing progress display. */
  cleanedPages: number
  totalPages: number
}

export type ContentAuditCleaningOptions = {
  onProgress?: (progress: ContentAuditCleaningProgress) => void | Promise<void>
}

type RawLine = {
  rawText: string
  rawStart: number
  rawContentEnd: number
  rawEnd: number
  text: string
  charMap: ContentAuditRawCharSpan[]
  originalIndex: number
  keep: boolean
}

const TRUNCATION_MARKER = '[正文因长度限制未完整保存]'

function normalizeLine(value: string): string {
  return value.normalize('NFKC').replace(/[\t\f\v ]+/gu, ' ').trim()
}

function cleanKey(value: string): string {
  // Exact public-block deduplication must not turn model/product identifiers,
  // case-sensitive URLs, or differently formatted numbers into one claim.
  return value.replace(/[\t\f\v ]+/gu, ' ').trim()
}

function pageName(page: WebsitePageResult): string {
  return page.title.trim() || page.url
}

function splitRawLines(value: string): Array<{ text: string; start: number; contentEnd: number; end: number }> {
  const lines: Array<{ text: string; start: number; contentEnd: number; end: number }> = []
  let start = 0
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char !== '\n' && char !== '\r') {
      index += 1
      continue
    }
    const contentEnd = index
    const end = char === '\r' && value[index + 1] === '\n' ? index + 2 : index + 1
    lines.push({ text: value.slice(start, contentEnd), start, contentEnd, end })
    start = end
    index = end
  }
  if (start < value.length || lines.length === 0) {
    lines.push({ text: value.slice(start), start, contentEnd: value.length, end: value.length })
  }
  return lines
}

function isSafeZeroWidthNoise(char: string): boolean {
  // U+200B and U+FEFF are spacing/BOM artefacts frequently left by copied
  // web text.  Do not remove joiners/non-joiners: those can be meaningful in
  // scripts and emoji sequences.
  return char === '\u200B' || char === '\uFEFF'
}

function cleanRawLine(raw: { text: string; start: number; contentEnd: number; end: number }): RawLine {
  const visible: Array<{ char: string; start: number; end: number }> = []
  let index = 0
  while (index < raw.text.length) {
    const char = raw.text[index] ?? ''
    if (isSafeZeroWidthNoise(char)) {
      index += 1
      continue
    }
    if (/\p{Cc}/u.test(char) && char !== '\t') {
      index += 1
      continue
    }
    if (/\s/u.test(char)) {
      const runStart = index
      index += 1
      while (index < raw.text.length && !isSafeZeroWidthNoise(raw.text[index] ?? '') && /\s/u.test(raw.text[index] ?? '')) index += 1
      visible.push({ char: ' ', start: runStart, end: index })
      continue
    }
    visible.push({ char, start: index, end: index + 1 })
    index += 1
  }

  let first = 0
  let last = visible.length
  while (first < last && visible[first]?.char === ' ') first += 1
  while (last > first && visible[last - 1]?.char === ' ') last -= 1
  const selected = visible.slice(first, last)
  const text = selected.map((item) => item.char).join('')
  const charMap = selected.map((item) => ({ rawStart: raw.start + item.start, rawEnd: raw.start + item.end }))
  return {
    rawText: raw.text,
    rawStart: raw.start,
    rawContentEnd: raw.contentEnd,
    rawEnd: raw.end,
    text,
    charMap,
    originalIndex: 0,
    keep: Boolean(text),
  }
}

function isEdge(index: number, total: number): boolean {
  return index < 24 || index >= Math.max(0, total - 24)
}

function isNavigationLabel(value: string): boolean {
  const normalized = normalizeLine(value)
  if (!normalized || normalized.length > 80) return false
  const link = structuredLink(normalized)
  const label = link?.label ?? normalized
    .replace(/\s*切换子菜单\s*$/u, '')
    .trim()
  if (/^(?:首页|网站首页|关于我们|公司介绍|企业介绍|企业概况|产品|产品中心|服务|服务中心|企业服务|解决方案|案例|客户案例|联系我们|联系|导航|菜单|切换子菜单|展开菜单|关闭菜单|站内搜索|搜索|登录|登入|注册|退出|公司链接|品牌链接)$/iu.test(label)) return true
  return /切换子菜单$/u.test(normalized)
}

function structuredLink(value: string): { label: string; url: string; menuSuffix: boolean } | null {
  const match = normalizeLine(value).match(/^(.+?)\s*\((https?:\/\/[^)]+)\)\s*(切换子菜单)?$/iu)
  if (!match?.[1] || !match[2]) return null
  return { label: match[1].trim(), url: match[2], menuSuffix: Boolean(match[3]) }
}

function protectedNavigationLabel(value: string): boolean {
  const label = normalizeLine(value)
  if (!label) return true
  // A company/legal identity is evidence, not a menu command, even when it
  // appears as a short link in a header/footer block.
  if (/(?:有限公司|有限责任公司|公司|集团)$/u.test(label)) return true
  // Keep links that carry content claims, conditions, dates, prices, or
  // provenance.  The URL itself is intentionally not inspected for ':';
  // normal HTTP(S) URLs necessarily contain it.
  return /\d|(?:价格|金额|元|￥|¥|折扣|优惠|百分之|保证|承诺|包过|一定|必须|条件|前提|适用|仅限|(?:政策)?依据|(?:政策|官方|原文|证据|资料)?来源|原文|出处|参考(?:文献|资料)?|资质|证书|备案|许可证|免责声明|隐私(?:政策|声明)?|服务条款|法律声明)/iu.test(label)
}

function safeMenuLink(value: string): boolean {
  const link = structuredLink(value)
  if (!link) return false
  try {
    // Validate the structured URL but do not restrict its path to '/': real
    // menus commonly point to /about, /services, /contact, etc.
    new URL(link.url)
  } catch {
    return false
  }
  if (link.menuSuffix) return !protectedNavigationLabel(link.label)
  return link.label.length <= 16 && !protectedNavigationLabel(link.label)
}

function safePlainMenuLabel(value: string): boolean {
  const label = normalizeLine(value)
  if (!label || label.length > 16 || protectedNavigationLabel(label)) return false
  // Plain text fixtures can omit the crawler's structured URL, but only a
  // fixed set of generic menu labels may be treated as navigation in that
  // representation.  Arbitrary short prose remains source content.
  return /^(?:首页|网站首页|关于我们|公司介绍|企业介绍|企业概况|产品|产品中心|服务|服务中心|企业服务|解决方案|案例|客户案例|联系我们|联系|导航|菜单|切换子菜单|展开菜单|关闭菜单|站内搜索|搜索|登录|登入|注册|退出|公司链接|品牌链接)$/iu.test(label)
}

function isNoiseLine(value: string, index: number, total: number): boolean {
  const normalized = normalizeLine(value)
  const edge = isEdge(index, total)
  if (!normalized) return false
  if (normalized === TRUNCATION_MARKER) return false
  if (/^(?:跳到|跳过|跳至).{0,100}(?:内容|正文|main|主要)/iu.test(normalized) || /^skip\s+to\s+(?:content|main)/iu.test(normalized)) return true
  if (/^(?:返回顶部|回到顶部|back\s+to\s+top)$/iu.test(normalized) && edge) return true
  if (edge && (/^(?:cookie|cookies)\s*(?:设置|同意|接受|拒绝|关闭|政策)?$/iu.test(normalized)
    || /^(?:同意|接受|拒绝|关闭|允许|继续|设置).{0,20}(?:cookie|cookies|隐私)/iu.test(normalized))) return true
  if (/^(?:登录|登入|注册|退出登录|会员登录|sign\s*in|log\s*in|login)$/iu.test(normalized) && edge) return true
  if (/^(?:分享|分享到|share(?:\s+this)?|微信|微博|facebook|twitter|linkedin)$/iu.test(normalized) && edge) return true
  if (/^(?:在线咨询|立即咨询|免费咨询|咨询客服|联系客服|获取报价|预约咨询|马上咨询|在线客服)$/iu.test(normalized) && edge) return true
  if (edge && /^(?:阅读更多|相关文章|相关阅读|推荐阅读|上一篇|下一篇|热门文章)(?:\s*[:：]?[^。！？\n]{0,120}\s*\(https?:\/\/|\s+https?:\/\/|\s*$)/iu.test(normalized)) return true
  return false
}

function navigationRunIndexes(rawLines: readonly RawLine[]): Set<number> {
  const result = new Set<number>()
  const publicBlockIndexes = footerPublicBlockIndexes(rawLines)
  const simple = (line: RawLine): boolean => {
    const value = normalizeLine(line.text)
    const link = structuredLink(value)
    const candidate = link ? safeMenuLink(value) : safePlainMenuLabel(value)
    return Boolean(value)
      && candidate
      && !/[。！？；,。！？]/u.test(link?.label ?? value)
      && !/#article-section-\d+/iu.test(value)
      && !/^(?:文章目录|目录|table\s+of\s+contents)$/iu.test(value)
      && !/\b(?:20\d{2}|19\d{2})[年/-]\d{1,2}/u.test(value)
      // A contact/address line can sit directly beside the site's menu (and
      // may be the only public line on a short page).  Never absorb an
      // explicit public claim into a navigation run merely because the
      // surrounding lines look like menu labels.
      && !publicMarker(value)
      && !publicLineCandidate(line, line.originalIndex, rawLines.length, rawLines, publicBlockIndexes)
  }
  for (const seed of rawLines) {
    if (!isEdge(seed.originalIndex, rawLines.length) || !isNavigationLabel(seed.text)) continue
    const indexes = [seed.originalIndex]
    for (const direction of [-1, 1]) {
      let index = seed.originalIndex + direction
      let steps = 0
      while (index >= 0 && index < rawLines.length && steps < 30) {
        const line = rawLines[index]
        if (!line || !simple(line)) break
        indexes.push(index)
        index += direction
        steps += 1
      }
    }
    // A single “首页” or “搜索” line can be legitimate article text.  Only
    // remove a clearly contiguous menu cluster anchored by an operation row.
    if (indexes.length >= 3) for (const index of indexes) result.add(index)
  }
  return result
}

function headerIdentityLink(value: string): { label: string; url: string } | null {
  const link = structuredLink(value)
  if (!link || link.menuSuffix) return null
  const label = normalizeLine(link.label)
  if (!label || label.length > 100 || /[。！？；]/u.test(label)) return null
  // Only treat an explicit company/enterprise identity as a header identity.
  // Ordinary body links containing a company name must not be deduplicated.
  if (!/(?:有限公司|有限责任公司|集团|公司|企业|corp\.?|inc\.?)$/iu.test(label)) return null
  try {
    new URL(link.url)
  } catch {
    return null
  }
  return { label, url: link.url }
}

function headerDuplicateIndexes(
  rawLines: readonly RawLine[],
  navigationIndexes: ReadonlySet<number>,
): Set<number> {
  const result = new Set<number>()
  const indexes = [...navigationIndexes].sort((left, right) => left - right)
  let cursor = 0
  while (cursor < indexes.length) {
    const start = indexes[cursor]
    if (start === undefined) break
    let end = start
    while (cursor + 1 < indexes.length && indexes[cursor + 1] === end + 1) {
      cursor += 1
      end = indexes[cursor] as number
    }
    // The header identity appears on both sides of the confirmed menu run
    // in the current crawler output.  Remove only the exact trailing copy;
    // requiring both sides and an exact structured link match prevents body
    // company names or unrelated footer links from being swallowed.
    if (start > 0 && end + 1 < rawLines.length) {
      const before = headerIdentityLink(rawLines[start - 1]?.text ?? '')
      const after = headerIdentityLink(rawLines[end + 1]?.text ?? '')
      if (before && after && before.label === after.label && before.url === after.url) result.add(end + 1)
    }
    cursor += 1
  }
  return result
}

function publicMarker(value: string): boolean {
  return footerAnchor(value)
    || footerContactLine(value)
    || /^(?:(?:办公|联系|注册地址|公司)?地址)\s*[:：]\s*\S/iu.test(normalizeLine(value))
    || /^(?:备案|许可证|公众号|官方客服|公司名称)\s*[:：]/iu.test(normalizeLine(value))
    || /^(?:资质|证书|认证)(?:编号|名称|有效期)?\s*[:：]/iu.test(normalizeLine(value))
}

function footerAnchor(value: string): boolean {
  const normalized = normalizeLine(value)
  return /^(?:.{0,40}(?:ICP备案|ICP(?:证|备案)?(?:编号)?|备案号)\s*[:：]?\s*\S+|版权所有(?:\s*[:：]|\s+\d{4}|$)|copyright\s*(?:©\s*)?\d{4}|©\s*\d{4})/iu.test(normalized)
    || /^https?:\/\/(?:www\.)?beian\.miit\.gov\.cn(?:\/|$)/iu.test(normalized)
}

function footerAddressLine(value: string): boolean {
  const normalized = normalizeLine(value)
  if (!normalized || normalized.length > 100 || /[。！？；，,]/u.test(normalized)) return false
  const labeled = normalized.match(/^(?:(?:办公|联系|注册地址|公司)?地址)\s*[:：]\s*(.+)$/u)
  const candidate = labeled?.[1]?.trim() ?? normalized
  if (!candidate || candidate.length > 90) return false
  if (labeled) return !/[。！？；，,]/u.test(candidate)
  if (!labeled && /^(?:业务|正文|提供|说明|材料|项目|客户|服务)/u.test(candidate)) return false
  const roadIndex = candidate.search(/路|街|巷|道/u)
  const roadPrefix = roadIndex >= 0 ? candidate.slice(0, roadIndex) : ''
  if (!labeled && /(?:我们|本公司|在|于|提供|说明|服务|业务|正文|包含|适用|材料|项目|客户|联系)/u.test(roadPrefix)) return false
  // A contact address is a complete line ending in a numbered unit; do not
  // classify a sentence merely because it mentions a road and a number.
  const hasStreetNumber = /(?:路|街|巷|道)[^\n]{0,40}\d{1,6}(?:[-－]\d{1,6})?(?:(?:号|室|楼|栋|座|单元)\d{0,6})+$/u.test(candidate)
  const hasNumberedUnit = /\d{1,6}[-－]?\d{0,6}(?:(?:号|室|楼|栋|座|单元)\d{0,6})+$/u.test(candidate)
  return hasStreetNumber || hasNumberedUnit
}

function footerIdentityLine(value: string): boolean {
  const normalized = normalizeLine(value)
  if (!normalized || normalized.length > 100 || /[。！？；]/u.test(normalized)) return false
  const labeled = normalized.match(/^(?:公司名称|企业名称|集团名称|主体名称|公司名|企业名)\s*[:：]\s*(.+)$/iu)
  const candidate = labeled?.[1]?.trim() ?? normalized
  if (!candidate || /[，,：:]/u.test(candidate)) return false
  // An unlabeled identity line must end in a legal/company identity suffix;
  // generic words such as “本公司负责整理材料” are ordinary prose, not a
  // footer company row.  Explicit name labels may use the shorter “公司” or
  // “企业” suffix as the label itself supplies the identity boundary.
  const suffix = labeled
    ? /(?:有限责任公司|股份有限公司|有限公司|集团|公司|企业|corp\.?|inc\.?)$/iu
    : /(?:有限责任公司|股份有限公司|有限公司|集团|corp\.?|inc\.?)$/iu
  return suffix.test(candidate)
}

function footerContactLine(value: string): boolean {
  const normalized = normalizeLine(value)
  if (!normalized || normalized.length > 120 || /[。！？；]/u.test(normalized)) return false
  const email = /^(?:业务|工作|电子|联系|公司)?邮箱\s*[:：]\s*[^\s@]+@[^\s@]+$/iu.test(normalized)
  const phone = /^(?:联系电话|联系?电话|手机|热线|客服电话|官方客服)\s*[:：]\s*[+]?\d[\d ()－-]{5,}\s*$/iu.test(normalized)
  return email || phone
}

function footerSupportLine(value: string): boolean {
  const normalized = normalizeLine(value)
  if (!normalized || normalized.length > 240) return false
  return publicMarker(normalized)
    || footerContactLine(normalized)
    || footerAddressLine(normalized)
    || footerIdentityLine(normalized)
}

function footerPublicBlockIndexes(allLines: readonly Pick<RawLine, 'text'>[]): Set<number> {
  const result = new Set<number>()
  const anchors = allLines
    .map((line, index) => ({ index, value: normalizeLine(line.text) }))
    .filter(({ value }) => publicMarker(value))
  for (const anchor of anchors) {
    let start = anchor.index
    let end = anchor.index
    while (start > 0 && footerSupportLine(allLines[start - 1]?.text ?? '')) start -= 1
    while (end + 1 < allLines.length && footerSupportLine(allLines[end + 1]?.text ?? '')) end += 1
    const blockLines = allLines.slice(start, end + 1)
    const publicCount = blockLines.filter((line) => publicMarker(normalizeLine(line.text))).length
    const supportCount = blockLines.filter((line) => footerSupportLine(line.text)).length
    const hasFooterAnchor = footerAnchor(anchor.value)
    // A standard ICP/copyright/official-record anchor can identify a compact
    // footer together with its adjacent identity, address and contact rows.
    // Without that anchor, require at least two explicit public rows and a
    // page boundary so ordinary article claims are not treated as a block.
    if (hasFooterAnchor ? supportCount < 2 : publicCount < 2) continue
    // A pair of contact-labelled lines is only a public template block when
    // it sits at a page boundary (or carries an explicit copyright/record
    // anchor).  This avoids extracting an arbitrary pair of article claims
    // merely because they contain words such as “地址” or “证书”.
    if (!hasFooterAnchor && start !== 0 && end !== allLines.length - 1) continue
    for (let index = start; index <= end; index += 1) result.add(index)
  }
  return result
}

function publicLineCandidate(
  line: Pick<RawLine, 'text'>,
  index: number,
  total: number,
  _allLines: readonly Pick<RawLine, 'text'>[] = [],
  publicBlockIndexes: ReadonlySet<number> = new Set(),
): boolean {
  const value = normalizeLine(line.text)
  if (!value || value.length > 240 || value === TRUNCATION_MARKER) return false
  void total
  return publicBlockIndexes.has(index) && footerSupportLine(value)
}

function recommendationHeading(value: string): boolean {
  const label = structuredLink(normalizeLine(value))?.label ?? normalizeLine(value)
  return /^(?:相关文章|类似文章|相关阅读|推荐阅读|热门文章)$/iu.test(label)
}

function articleNavigationHeading(value: string): boolean {
  return /^(?:文章导航|文章导航栏|文章翻页|分页导航)$/iu.test(normalizeLine(value))
}

function recommendationTerminator(value: string): boolean {
  const normalized = normalizeLine(value)
  const link = structuredLink(normalized)
  if (link) return /^(?:阅读更多|阅读全文|查看详情)(?:\s|$)/iu.test(link.label)
  return /^(?:阅读更多|阅读全文|查看详情)\s*[:：]?\s*(?:https?:\/\/\S+)?$/iu.test(normalized)
}

function recommendationCardSegment(lines: readonly RawLine[]): boolean {
  const values = lines.map((line) => normalizeLine(line.text)).filter(Boolean)
  if (values.length === 0 || values.length > 16) return false
  if (values.some((value) => publicMarker(value))) return false
  const linkCount = values.filter((value) => Boolean(structuredLink(value))).length
  const hasAuthor = values.some((value) => /(?:作者|author|admin)/iu.test(value))
  const hasDate = values.some((value) => /(?:发表于|发布日期|发布时间|日期|20\d{2}[年./-]\d{1,2}(?:[月./-]\d{1,2})?)/iu.test(value))
  // A recommendation card is not just a short “read more” CTA: require the
  // link-backed title/category rows and the author/date metadata pattern
  // emitted by the current crawler before removing the complete card group.
  return linkCount >= 2 && hasAuthor && hasDate
}

function recommendationGroupIndexes(rawLines: readonly RawLine[]): Set<number> {
  const result = new Set<number>()
  const footerIndexes = footerPublicBlockIndexes(rawLines)
  for (let headingIndex = 0; headingIndex < rawLines.length; headingIndex += 1) {
    const heading = rawLines[headingIndex]
    if (!heading || !recommendationHeading(heading.text)) continue
    const terminators: number[] = []
    let segmentStart = headingIndex + 1
    let valid = true
    for (let index = segmentStart; index < rawLines.length; index += 1) {
      const value = normalizeLine(rawLines[index]?.text ?? '')
      if (footerIndexes.has(index)) break
      if (!value) continue
      if (!recommendationTerminator(value)) continue
      const segment = rawLines.slice(segmentStart, index)
      if (!recommendationCardSegment(segment)) {
        valid = false
        break
      }
      terminators.push(index)
      segmentStart = index + 1
    }
    if (!valid || terminators.length < 2) continue
    const lastTerminator = terminators.at(-1)
    if (lastTerminator === undefined) continue

    // Anything between the final card and a detected public footer must be
    // empty.  A legal/policy paragraph here means the boundary is uncertain;
    // retain the entire region rather than swallowing it.
    const footerStart = [...footerIndexes].filter((index) => index > lastTerminator).sort((left, right) => left - right)[0]
    const afterEnd = footerStart ?? rawLines.length
    if (rawLines.slice(lastTerminator + 1, afterEnd).some((line) => Boolean(normalizeLine(line?.text ?? '')))) continue
    if (!footerStart && rawLines.slice(lastTerminator + 1).some((line, offset) => {
      const index = lastTerminator + 1 + offset
      return Boolean(normalizeLine(line?.text ?? '')) && !isNoiseLine(line?.text ?? '', index, rawLines.length)
    })) continue

    let removalStart = headingIndex
    // The current article template places a two-link article pager directly
    // before the recommendation heading.  Include that explicit pager in the
    // same removable tail, but only when the boundary is unambiguous.
    for (let candidate = Math.max(0, headingIndex - 3); candidate < headingIndex; candidate += 1) {
      if (!articleNavigationHeading(rawLines[candidate]?.text ?? '')) continue
      const pager = rawLines.slice(candidate + 1, headingIndex).filter((line) => Boolean(normalizeLine(line.text)))
      if (pager.length >= 2 && pager.every((line) => Boolean(structuredLink(normalizeLine(line.text))))) removalStart = candidate
    }
    for (let index = removalStart; index <= lastTerminator; index += 1) result.add(index)
  }
  return result
}

function contextFor(rawBody: string, start: number, end: number): string {
  const before = Math.max(0, start - 140)
  const after = Math.min(rawBody.length, end + 140)
  return rawBody.slice(before, after).replace(/\r\n?/gu, '\n').trim()
}

function buildCleanedPage(page: WebsitePageResult): ContentAuditCleanedPage {
  // Keep the existing crawler truncation contract while excluding its marker
  // from model input and offset calculations, as the prior checker did.
  const rawBodyText = page.bodyText.split(TRUNCATION_MARKER).join('')
  const rawLines = splitRawLines(rawBodyText).map((line, index) => {
    const cleaned = cleanRawLine(line)
    cleaned.originalIndex = index
    return cleaned
  })
  const total = rawLines.length
  const navigationIndexes = navigationRunIndexes(rawLines)
  const headerDuplicates = headerDuplicateIndexes(rawLines, navigationIndexes)
  const recommendationIndexes = recommendationGroupIndexes(rawLines)
  const allTocLinks = rawLines
    .map((line, index) => ({ line, index, value: normalizeLine(line.text) }))
    .filter((item) => /#article-section-\d+(?:\b|$)/iu.test(item.value))
  const tocLabelIndex = allTocLinks.length > 0
    ? rawLines.findIndex((line, index) => index < (allTocLinks[0]?.index ?? 0)
      && (allTocLinks[0]?.index ?? 0) - index <= 4
      && /^(?:文章目录|目录|table\s+of\s+contents)$/iu.test(normalizeLine(line.text)))
    : -1
  const tocLinks: typeof allTocLinks = []
  if (tocLabelIndex >= 0) {
    for (let index = tocLabelIndex + 1; index < rawLines.length; index += 1) {
      const value = normalizeLine(rawLines[index]?.text ?? '')
      if (!value) continue
      if (!/#article-section-\d+(?:\b|$)/iu.test(value)) break
      tocLinks.push({ line: rawLines[index] as RawLine, index, value })
    }
  }
  const tocLabels = tocLinks.map(({ value }) => normalizeLine(value.replace(/\s*\([^)]*#article-section-\d+[^)]*\)\s*$/iu, '')))
  const hasMatchingHeading = tocLabelIndex >= 0
    && tocLabels.length > 0
    && tocLabels.every((label) => label.length > 0
      && rawLines.some((line, index) => index > (tocLinks.at(-1)?.index ?? 0)
        && cleanKey(normalizeLine(line.text)) === cleanKey(label)))
  const removableTocIndexes = hasMatchingHeading
    ? new Set<number>([tocLabelIndex, ...tocLinks.map(({ index }) => index)])
    : new Set<number>()
  for (const line of rawLines) {
    const value = normalizeLine(line.text)
    if (removableTocIndexes.has(line.originalIndex)) {
      line.keep = false
      continue
    }
    if (recommendationIndexes.has(line.originalIndex)) {
      line.keep = false
      continue
    }
    if (navigationIndexes.has(line.originalIndex)
      || headerDuplicates.has(line.originalIndex)
      || isNoiseLine(line.text, line.originalIndex, total)) line.keep = false
  }

  const kept = rawLines.filter((line) => line.keep && Boolean(line.text))
  const lines: ContentAuditCleanedLine[] = []
  const charMap: Array<ContentAuditRawCharSpan | null> = []
  let cleanOffset = 0
  for (const line of kept) {
    if (lines.length > 0) {
      charMap.push(null) // A clean separator has no raw span; source IDs never cross it.
      cleanOffset += 1
    }
    const cleanStart = cleanOffset
    for (const span of line.charMap) {
      charMap.push(span)
      cleanOffset += 1
    }
    lines.push({ text: line.text, cleanStart, cleanEnd: cleanOffset, rawStart: line.rawStart, rawEnd: line.rawEnd })
  }
  return {
    ...page,
    bodyText: lines.map((line) => line.text).join('\n'),
    rawBodyText,
    truncated: page.bodyText.includes(TRUNCATION_MARKER),
    bodyCharMap: charMap,
    lines,
    sharedLocations: new Map(),
  }
}

function applySharedPublicBlockDedup(pages: ContentAuditCleanedPage[]): void {
  type PublicBlockOccurrence = {
    pageIndex: number
    page: ContentAuditCleanedPage
    lines: ContentAuditCleanedLine[]
    rawText: string
  }
  const blocks = new Map<string, PublicBlockOccurrence[]>()
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    if (!page || page.status !== 'success') continue
    const rawLines = splitRawLines(page.rawBodyText)
    const publicBlockIndexes = footerPublicBlockIndexes(rawLines)
    const blockIndexes = [...publicBlockIndexes].sort((left, right) => left - right)
    let cursor = 0
    while (cursor < blockIndexes.length) {
      const startIndex = blockIndexes[cursor]
      if (startIndex === undefined) break
      let endIndex = startIndex
      while (cursor + 1 < blockIndexes.length && blockIndexes[cursor + 1] === endIndex + 1) {
        cursor += 1
        endIndex = blockIndexes[cursor] as number
      }
      const blockLines: ContentAuditCleanedLine[] = []
      let complete = true
      for (let rawIndex = startIndex; rawIndex <= endIndex; rawIndex += 1) {
        const raw = rawLines[rawIndex]
        const line = raw ? page.lines.find((candidate) => candidate.rawStart === raw.start) : undefined
        if (!raw || !line) {
          complete = false
          break
        }
        const sourceLine: RawLine = {
          rawText: page.rawBodyText.slice(line.rawStart, line.rawEnd).replace(/\r\n?$/u, ''),
          rawStart: line.rawStart,
          rawContentEnd: Math.min(line.rawEnd, page.rawBodyText.length),
          rawEnd: line.rawEnd,
          text: line.text,
          charMap: [],
          originalIndex: rawIndex,
          keep: true,
        }
        if (!publicLineCandidate(sourceLine, rawIndex, rawLines.length, rawLines, publicBlockIndexes)) {
          complete = false
          break
        }
        blockLines.push(line)
      }
      if (complete && blockLines.length > 0) {
        const rawStart = rawLines[startIndex]?.start ?? 0
        const rawEnd = rawLines[endIndex]?.end ?? rawStart
        const rawText = page.rawBodyText.slice(rawStart, rawEnd)
        const values = blocks.get(rawText) ?? []
        values.push({ pageIndex, page, lines: blockLines, rawText })
        blocks.set(rawText, values)
      }
      cursor += 1
    }
  }

  const removal = new Map<number, Set<string>>()
  for (const [blockKey, values] of blocks) {
    // Compare complete public blocks, not isolated address/email lines.  A
    // shared address inside two different companies must not inherit the
    // other company's review context.
    const byPage = new Map<number, PublicBlockOccurrence>()
    for (const value of values) if (!byPage.has(value.pageIndex)) byPage.set(value.pageIndex, value)
    const uniqueValues = [...byPage.values()]
    if (uniqueValues.length < 2) continue
    const representative = uniqueValues[0]
    if (!representative) continue
    for (let lineIndex = 0; lineIndex < representative.lines.length; lineIndex += 1) {
      const lineValues = uniqueValues
        .map((value) => ({ value, line: value.lines[lineIndex] }))
        .filter((entry): entry is { value: PublicBlockOccurrence; line: ContentAuditCleanedLine } => Boolean(entry.line))
      if (lineValues.length !== uniqueValues.length) continue
      const key = `${blockKey}\u001f${lineIndex}`
      const locations: ContentAuditSharedLocation[] = lineValues.map(({ line, value }) => ({
        page: pageName(value.page),
        pageUrl: value.page.url,
        rawStart: line.rawStart,
        rawEnd: line.rawEnd,
        statement: value.page.rawBodyText.slice(line.rawStart, line.rawEnd),
        context: contextFor(value.page.rawBodyText, line.rawStart, line.rawEnd),
        cleanText: line.text,
      }))
      const representativeLocations = new Map(representative.page.sharedLocations)
      representativeLocations.set(key, locations)
      // Keep the cleaned-line key available for local inspection/backward
      // compatibility; source fragments use the block-qualified key above
      // so two different public blocks cannot collide.
      const cleanLineKey = cleanKey(representative.lines[lineIndex]?.text ?? '')
      if (cleanLineKey && !representativeLocations.has(cleanLineKey)) representativeLocations.set(cleanLineKey, locations)
      representative.page.sharedLocations = representativeLocations
      representative.lines[lineIndex].sharedKey = blockKey
      representative.lines[lineIndex].sharedLineIndex = lineIndex
    }
    for (const value of uniqueValues.slice(1)) {
      const pageRemovals = removal.get(value.pageIndex) ?? new Set<string>()
      for (const line of value.lines) {
        pageRemovals.add(`${line.rawStart}:${line.rawEnd}`)
      }
      removal.set(value.pageIndex, pageRemovals)
    }
  }

  for (const [pageIndex, ranges] of removal) {
    const page = pages[pageIndex]
    if (!page) continue
    const nextLines = page.lines.filter((line) => !ranges.has(`${line.rawStart}:${line.rawEnd}`))
    rebuildPageBody(page, nextLines)
  }
}

function rebuildPageBody(page: ContentAuditCleanedPage, lines: readonly ContentAuditCleanedLine[]): void {
  const nextLines: ContentAuditCleanedLine[] = []
  const nextMap: Array<ContentAuditRawCharSpan | null> = []
  let offset = 0
  for (const line of lines) {
    if (nextLines.length > 0) {
      nextMap.push(null)
      offset += 1
    }
    const cleanStart = offset
    const sourceMap = page.bodyCharMap.slice(line.cleanStart, line.cleanEnd).filter((span): span is ContentAuditRawCharSpan => span !== null)
    for (const span of sourceMap) {
      nextMap.push(span)
      offset += 1
    }
    nextLines.push({ ...line, cleanStart, cleanEnd: offset })
  }
  page.bodyText = nextLines.map((line) => line.text).join('\n')
  page.lines = nextLines
  page.bodyCharMap = nextMap
}

function markEquivalentPages(pages: ContentAuditCleanedPage[]): void {
  const firstByKey = new Map<string, number>()
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    if (!page || page.status !== 'success' || page.truncated) continue
    // Reuse is intentionally based on the exact cached text, not the cleaned
    // presentation.  Two pages can clean to the same text while their raw
    // offsets, conditions, or navigation boundaries differ.
    const key = `${page.title}\u001f${page.rawBodyText}`
    const first = firstByKey.get(key)
    if (first === undefined) firstByKey.set(key, index)
    else page.duplicateOf = first
  }
}

/**
 * Clean a crawl snapshot locally.  No network, model, database or source
 * cache writes occur here.  The callback is awaited so a caller can persist
 * each confirmed cleaning checkpoint before proceeding.
 */
export async function cleanContentAuditPages(
  pages: readonly WebsitePageResult[],
  options: ContentAuditCleaningOptions = {},
): Promise<ContentAuditCleanedPage[]> {
  const cleaned: ContentAuditCleanedPage[] = []
  // Build one page at a time so a caller can persist actual local work rather
  // than replaying progress after constructing the entire site snapshot.
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    if (!page) continue
    cleaned.push(buildCleanedPage(page))
    // Keep the final page count for the second, cross-page dedup pass.  This
    // prevents a displayed 100% from claiming completion before shared block
    // source mappings have been built.
    const visible = pages.length <= 1 ? 0 : Math.min(index + 1, pages.length - 1)
    await options.onProgress?.({ cleanedPages: visible, totalPages: pages.length })
  }
  markEquivalentPages(cleaned)
  applySharedPublicBlockDedup(cleaned)
  await options.onProgress?.({ cleanedPages: cleaned.length, totalPages: pages.length })
  return cleaned
}

export function cleanContentAuditPage(page: WebsitePageResult): ContentAuditCleanedPage {
  const pages = [buildCleanedPage(page)]
  markEquivalentPages(pages)
  applySharedPublicBlockDedup(pages)
  return pages[0] as ContentAuditCleanedPage
}
