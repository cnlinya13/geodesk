/**
 * Shared contract for the deterministic technical audit.  This module is
 * deliberately free of React and server imports so the API and the 201/202
 * views use the same stable group/item ids.
 */

export type TechnicalAuditStatus = 'unchecked' | 'pass' | 'fix' | 'review' | 'not_applicable'

export type TechnicalAuditItemDefinition = {
  id: string
  name: string
}

export type TechnicalAuditGroup = {
  id: string
  name: string
  items: TechnicalAuditItemDefinition[]
}

export type TechnicalAuditScope = {
  pages: string[]
  sampled_pages: string[]
  skipped_pages: string[]
  candidates: string[]
  requests: number
  request_limit: number
  page_limit: number
  response_limit_bytes: number
  time_limit_ms: number
  limits: string[]
}

export type TechnicalAuditEvidence = Record<string, unknown>
export type TechnicalAuditFacts = Record<string, unknown>

export type TechnicalAuditItem = {
  item_id: string
  status: TechnicalAuditStatus
  message_code: string
  facts: TechnicalAuditFacts
  evidence: TechnicalAuditEvidence
}

export type TechnicalAuditSnapshot = {
  checked_at: string
  website_url: string
  scope: TechnicalAuditScope
  items: TechnicalAuditItem[]
  /** Runner-only failures; the service rejects these snapshots before save. */
  execution_errors?: TechnicalAuditExecutionError[]
  /** Version of the confirmed rule set used to produce this snapshot. Older
   * snapshots may omit this field and must be rechecked under current rules. */
  rule_version?: number
}

export type TechnicalAuditExecutionError = {
  code: string
  pages?: string[]
}

/** The current contract keeps the narrowed 24-item catalogue while updating
 * the llms.txt candidate rule, the entered-root scope, and partial-run
 * persistence semantics.  v7 snapshots remain historical evidence and must
 * be rechecked under this rule set; the removed checks remain accepted only
 * through the explicit historical v6/v5 contracts below. */
export const TECHNICAL_AUDIT_RULE_VERSION = 8

/** Item ids removed when the first two modules were narrowed.  These ids are
 * kept as a data-compatibility allow-list only; they are not rendered or
 * produced by the current audit. */
export const TECHNICAL_AUDIT_LEGACY_REMOVED_ITEM_IDS = [
  'site.timeout',
  'crawl.target_crawler_policy',
  'crawl.cdn_waf',
  'crawl.captcha',
  'crawl.gptbot_policy',
] as const

/** A historical runner could persist one additional request-failure item. */
export const TECHNICAL_AUDIT_LEGACY_EXTRA_ITEM_IDS = ['site.request_failure'] as const

export const TECHNICAL_GROUPS: TechnicalAuditGroup[] = [
  {
    id: 'site_access',
    name: '网站访问',
    items: [
      { id: 'site.dns', name: 'DNS解析' },
      { id: 'site.https', name: 'HTTPS连接' },
      { id: 'site.http_status', name: 'HTTP状态码' },
      { id: 'site.redirect', name: '重定向' },
    ],
  },
  {
    id: 'crawler_access',
    name: '爬虫访问',
    items: [
      { id: 'crawl.robots_txt', name: 'robots.txt抓取规则' },
      { id: 'crawl.login', name: '登录限制' },
    ],
  },
  {
    id: 'index_summary',
    name: '索引与摘要',
    items: [
      { id: 'index.noindex', name: 'noindex指令' },
      { id: 'index.x_robots_tag', name: 'X-Robots-Tag' },
      { id: 'index.snippet', name: '摘要限制' },
    ],
  },
  {
    id: 'canonical_url',
    name: '规范网址',
    items: [
      { id: 'canonical.target', name: 'canonical目标地址' },
      { id: 'canonical.domain_conflict', name: '域名版本冲突' },
    ],
  },
  {
    id: 'internal_links',
    name: '内部链接',
    items: [
      { id: 'links.broken', name: '站内断链' },
      { id: 'links.navigation', name: '导航链接可抓取性' },
      { id: 'links.pagination', name: '分页链接可抓取性' },
    ],
  },
  {
    id: 'sitemap_discovery',
    name: '站点地图与说明文件',
    items: [
      { id: 'sitemap.generation', name: 'XML Sitemap生成' },
      { id: 'sitemap.coverage', name: '重要页面覆盖' },
      { id: 'sitemap.invalid_urls', name: '无效网址' },
      { id: 'sitemap.lastmod', name: '更新时间' },
      { id: 'discovery.llms_txt', name: 'llms.txt' },
    ],
  },
  {
    id: 'content_readability',
    name: '正文读取',
    items: [
      { id: 'content.html_body', name: 'HTML正文' },
      { id: 'content.javascript_render', name: 'JavaScript渲染依赖' },
      { id: 'content.html_structure', name: 'HTML结构' },
      { id: 'content.metadata', name: '元数据输出' },
      { id: 'content.structured_data', name: '结构化数据' },
    ],
  },
]

export const TECHNICAL_AUDIT_ITEM_COUNT = TECHNICAL_GROUPS.reduce((total, group) => total + group.items.length, 0)

export const TECHNICAL_AUDIT_CURRENT_ITEM_IDS = TECHNICAL_GROUPS.flatMap((group) => group.items.map((item) => item.id))

/** The complete v6 contract (31 items) is retained for parsing historical
 * snapshots.  Keep the seven unimplemented checks in this explicit set even
 * though they are no longer part of the current catalog. */
export const TECHNICAL_AUDIT_V6_ITEM_IDS = [
  'site.dns',
  'site.https',
  'site.http_status',
  'site.redirect',
  'crawl.robots_txt',
  'crawl.login',
  'index.noindex',
  'index.x_robots_tag',
  'index.snippet',
  'index.cms_search_visibility',
  'canonical.target',
  'canonical.duplicate',
  'canonical.domain_conflict',
  'canonical.migration_redirect',
  'links.orphan',
  'links.broken',
  'links.navigation',
  'links.pagination',
  'sitemap.generation',
  'sitemap.coverage',
  'sitemap.invalid_urls',
  'sitemap.lastmod',
  'sitemap.platform_submission',
  'discovery.llms_txt',
  'content.html_body',
  'content.javascript_render',
  'content.click_load',
  'content.scroll_load',
  'content.html_structure',
  'content.metadata',
  'content.structured_data',
] as const

/** The complete v5 contract (34 items) is retained for parsing historical
 * snapshots.  Keep this list explicit: the current catalog is intentionally
 * smaller after the publish-sync placeholders were removed in v6. */
export const TECHNICAL_AUDIT_V5_ITEM_IDS = [
  'site.dns',
  'site.https',
  'site.http_status',
  'site.redirect',
  'crawl.robots_txt',
  'crawl.login',
  'index.noindex',
  'index.x_robots_tag',
  'index.snippet',
  'index.cms_search_visibility',
  'canonical.target',
  'canonical.duplicate',
  'canonical.domain_conflict',
  'canonical.migration_redirect',
  'links.orphan',
  'links.broken',
  'links.navigation',
  'links.pagination',
  'sitemap.generation',
  'sitemap.coverage',
  'sitemap.invalid_urls',
  'sitemap.lastmod',
  'sitemap.platform_submission',
  'discovery.llms_txt',
  'content.html_body',
  'content.javascript_render',
  'content.click_load',
  'content.scroll_load',
  'content.html_structure',
  'content.metadata',
  'content.structured_data',
  'sync.cache_refresh',
  'sync.update_notification',
  'sync.notification_receipt',
] as const

/** v5's three checks that were removed from the v6 current contract. */
export const TECHNICAL_AUDIT_LEGACY_PUBLISH_SYNC_ITEM_IDS = [
  'sync.cache_refresh',
  'sync.update_notification',
  'sync.notification_receipt',
] as const

/** v4 had a dedicated five-item structured-data group.  Keep the historical
 * set explicit rather than deriving it from the v5 count. */
export const TECHNICAL_AUDIT_LEGACY_STRUCTURED_ITEM_IDS = [
  'structured.applicable_type',
  'structured.jsonld_syntax',
  'structured.duplicate_conflict',
  'structured.entity_id',
  'structured.visible_consistency',
] as const

export const TECHNICAL_AUDIT_LEGACY_CURRENT_ITEM_IDS = [
  'site.dns',
  'site.https',
  'site.http_status',
  'site.redirect',
  'crawl.robots_txt',
  'crawl.login',
  'index.noindex',
  'index.x_robots_tag',
  'index.snippet',
  'index.cms_search_visibility',
  'canonical.target',
  'canonical.duplicate',
  'canonical.domain_conflict',
  'canonical.migration_redirect',
  'links.orphan',
  'links.broken',
  'links.navigation',
  'links.pagination',
  'sitemap.generation',
  'sitemap.coverage',
  'sitemap.invalid_urls',
  'sitemap.lastmod',
  'sitemap.platform_submission',
  'discovery.llms_txt',
  'content.html_body',
  'content.javascript_render',
  'content.click_load',
  'content.scroll_load',
  'content.html_structure',
  'content.metadata',
  'sync.cache_refresh',
  'sync.update_notification',
  'sync.notification_receipt',
  'structured.applicable_type',
  'structured.jsonld_syntax',
  'structured.duplicate_conflict',
  'structured.entity_id',
  'structured.visible_consistency',
] as const

/** Checks that are intentionally not automated in the current contract.  The
 * backend may return them as unchecked with check_not_implemented; the UI
 * uses this list to avoid presenting an unavailable check as a defect. */
export const TECHNICAL_AUDIT_UNSUPPORTED_ITEM_IDS = [
] as const

/** The four homepage-only site checks whose v2/v3 meaning remains useful when
 * the page scope changes.  robots.txt now follows the complete successful
 * crawl target set and therefore must be rechecked. */
export const TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS = [
  'site.dns',
  'site.https',
  'site.http_status',
  'site.redirect',
] as const

/** First-two-module items whose transport evidence uses the scoped network
 * wording in the compatibility UI.  This is separate from the v2 legacy
 * stable-item list above. */
export const TECHNICAL_AUDIT_RECHECK_ITEM_IDS = [
  'site.dns',
  'site.https',
  'site.http_status',
  'site.redirect',
  'crawl.robots_txt',
  'crawl.login',
] as const

/** Fixed, deterministic copy.  A rule may add a safe URL/status placeholder
 * to facts/evidence; it must never interpolate untrusted response bodies. */
export const TECHNICAL_AUDIT_MESSAGES: Record<string, string> = {
  pass: '本轮检查完成，证据满足当前规则。',
  fix: '发现明确的技术问题，请按证据定位并修复后复查。',
  review: '当前证据不足以自动判断；检测未完成不等于已确认网站故障。',
  not_applicable: '本轮范围确认该检查不适用，不代表全站已完成配置。',
  unchecked: '尚未执行本轮检查。',
  check_not_implemented: '当前未接入该项自动检测；重复检查不会完成该项。',
  network_unavailable: '请求未完成，暂不能判断该项目。',
  dns_failed: 'DNS解析未完成，相关连接检查暂不能判断。',
  legacy_rule_recheck: '旧规则结果，请重新检查；检测未完成不等于已确认网站故障。',
  legacy_scope_recheck: '历史抽样检查，非全量；旧范围结果，请按全部已采集页面重新检查；检测未完成不等于已确认网站故障。',
  html_body_scope: 'HTML正文仅验证HTML文本输出，不证明正文完整。',
  javascript_render_scope: 'JavaScript渲染依赖仅表示静态HTML有可读正文，不证明无需JavaScript。',
  html_structure_scope: 'HTML结构仅检查html、head、body是否存在。',
  metadata_scope: '元数据仅检查title元素和description是否存在。',
  sitemap_lastmod_scope: '更新时间仅检查lastmod日期是否可解析，不证明真实更新时间。',
  structured_data_scope: '本项是结构化数据的存在性与基础解析检查：结构化数据仅检查每页是否有JSON-LD、Microdata或RDFa中的至少一种实际标记，以及标记能否通过基础解析；JSON-LD仅检查JSON语法和非空声明识别，不展开远程上下文。本项不代表完整JSON-LD或Schema规范、类型适用性、字段完整性、实体冲突、语义一致性或平台富媒体规则校验。',
  login_required: '匿名访问目标正文时检测到明确的登录限制，请核实公开传播策略。',
  login_evidence_insufficient: '未取得足够的目标正文证据，暂不能判断是否存在登录限制。',
  login_challenge: '目标页面返回了验证或挑战替代页，未取得足够正文证据，暂不能判断登录限制。',
  budget_exhausted: '已达到本轮请求预算，未完成部分暂不能判断。',
  robots_allowed: '本轮通用robots规则未限制已配置目标路径；不代表任何特定AI一定可以访问、收录或引用。',
  robots_restricted: '通用robots规则限制了部分目标页面；请结合公开传播目标核实，不自动要求放开。',
  robots_mixed: '通用robots规则在不同目标页面上的结果不同，已保留被限制的路径和规则。',
  robots_not_declared: '未发现适用于通用User-agent:*的限制；不代表任何特定AI一定可以访问、收录或引用。',
  robots_unreadable: '无法可靠读取或解析robots.txt，暂不能判断通用抓取规则。',
  redirect_loop: '检测到重定向循环，目标页面无法稳定到达最终地址，请修正跳转配置。',
  redirect_invalid: '检测到无效重定向目标或缺少目标地址，请修正跳转配置。',
  redirect_blocked: '重定向目标未被本次检查跟随，暂不能确认跳转是否正常；请核实目标范围。',
  redirect_limit: '重定向超过本轮跟随上限，暂不能确认跳转是否正常；不因次数本身直接判定为故障。',
  llms_present: '在本轮范围内发现可读取的llms.txt，并完成基础结构检查。',
  llms_missing: '必备llms.txt返回404/410，暂未读取到文件，请补充后复查。',
  llms_unavailable: '本轮无法读取或确认llms.txt，请检查robots规则、网络连接和请求预算后复查。',
  llms_optional_missing: '本轮范围未发现llms.txt；该文件为可选配置，不要求修复。',
  llms_declared_missing: '已声明的llms.txt地址不可访问，请更新声明地址或恢复文件。',
  llms_invalid: 'llms.txt编码无效、为空、返回HTML页面或缺少Markdown一级标题，请修正后复查。',
  llms_not_confirmed: '返回内容不是可确认的llms.txt，可能是网站回退页，请核实。',
  llms_broken_link: '说明文件包含失效链接，请更新对应链接。',
  no_baseline: '缺少发布或平台基线，暂不能自动判断同步状态。',
  limit_partial: '本轮范围或请求预算限制了检查覆盖，未完成部分暂不能判断。',
  https_required: '当前官网地址使用HTTP，HTTPS连接尚未建立；请确认并迁移到HTTPS。',
  http_error: '官网返回了非成功HTTP状态，请根据状态码检查服务器或发布配置。',
  html_body_missing: 'HTML中未读取到可见正文，需检查服务端输出或渲染依赖。',
  html_structure_invalid: 'HTML缺少必要的html、head或body结构，请修正页面输出。',
  metadata_incomplete: '本次页面清单中缺少标题或description元数据，请逐页核实页面模板。',
  canonical_missing: '本次页面清单未输出canonical，需结合页面用途确认规范地址。',
  canonical_review: 'canonical目标存在策略或范围不确定，请核实目标地址和页面意图。',
  canonical_target_missing: 'canonical目标返回404/410，请修正目标地址或恢复目标页面。',
  broken_link: '本次页面清单中的站内链接抽查返回404/410，请修正对应链接目标。',
  navigation_not_crawlable: '导航包含javascript或仅片段链接，需提供可抓取的HTML链接。',
  pagination_not_crawlable: '分页包含不可直接抓取的链接形式，请检查分页输出。',
  sitemap_missing: '本轮未发现可读取的XML Sitemap；需结合站点范围确认是否应配置。',
  sitemap_invalid: 'XML Sitemap结构无法通过严格解析，请修正XML后复查。',
  sitemap_invalid_url: 'XML Sitemap包含无效或越出官网范围的网址，请修正对应loc。',
  sitemap_lastmod_invalid: 'XML Sitemap包含无法解析的更新时间，请修正lastmod格式。',
  sitemap_lastmod_missing: 'XML Sitemap未提供可检查的更新时间，需结合更新流程确认。',
  structured_type_review: '已读取JSON-LD类型，但是否适用于页面需结合可见内容和业务意图确认。',
  structured_type_missing: 'JSON-LD缺少@type，无法判断结构化数据适用类型。',
  structured_id_missing: '部分结构化实体缺少@id，需结合实体标识方案确认。',
  structured_visible_mismatch: '结构化数据字段与可见正文存在不一致，请核对页面输出。',
  structured_duplicate: '检测到重复实体标识，需核对是否为同一实体的重复或冲突输出。',
  structured_data_missing: '检查清单中有页面未发现有效的JSON-LD、Microdata或RDFa标记，请补充或核实页面输出。',
  structured_data_invalid: '发现JSON-LD、Microdata或RDFa标记的基础解析错误，请修正后复查。',
  structured_data_execution_failed: '结构化数据检查未能完成全部页面，未生成本轮新结论；请检查执行条件后重试。',
  canonical_target_cross_origin: 'canonical指向其他origin，需核实跨域规范化是否为有意策略。',
}

export function technicalAuditMessage(messageCode: string): string {
  return TECHNICAL_AUDIT_MESSAGES[messageCode] ?? TECHNICAL_AUDIT_MESSAGES.review
}
