import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Info, ListChecks, X } from 'lucide-react'
import { fetchTechnicalAudit, runTechnicalAudit, type TechnicalAuditProgressEvent } from '../api'
import {
  TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS,
  TECHNICAL_AUDIT_RECHECK_ITEM_IDS,
  TECHNICAL_AUDIT_RULE_VERSION,
  TECHNICAL_AUDIT_UNSUPPORTED_ITEM_IDS,
  TECHNICAL_GROUPS,
  TECHNICAL_AUDIT_MESSAGES,
  technicalAuditMessage,
  type TechnicalAuditItem,
  type TechnicalAuditSnapshot,
  type TechnicalAuditStatus,
} from '../technical-audit'
import { TECHNICAL_AUDIT_HELP } from '../technical-audit-help'
import { apiErrorMessage, resolveUiMessage, translate, useI18n, type Locale, type MessageKey, type UiMessage } from '../i18n'
import { Button } from './UI'

type TechnicalAuditPanelProps = {
  projectId: string
  websiteUrl: string | null
}

type AuditFacts = Record<string, unknown>
type TechnicalAuditInfoTarget = 'scope' | string

const INTERNAL_NETWORK_MESSAGE_CODES = new Set(['timeout', 'total_budget_exhausted'])
const STRUCTURED_DATA_ITEM_ID = 'content.structured_data'
const LLMS_ITEM_ID = 'discovery.llms_txt'
const RECHECK_ITEM_IDS = new Set<string>(TECHNICAL_AUDIT_RECHECK_ITEM_IDS)
const LEGACY_STABLE_ITEM_IDS = new Set<string>(TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS)
const UNSUPPORTED_ITEM_IDS = new Set<string>(TECHNICAL_AUDIT_UNSUPPORTED_ITEM_IDS)

const technicalStatusKey: Record<TechnicalAuditStatus, MessageKey> = {
  unchecked: 'technical.status.unchecked',
  pass: 'technical.status.pass',
  fix: 'technical.status.fix',
  review: 'technical.status.review',
  not_applicable: 'technical.status.notApplicable',
}

const technicalGroupKey: Record<string, MessageKey> = {
  site_access: 'technical.group.site_access',
  crawler_access: 'technical.group.crawler_access',
  index_summary: 'technical.group.index_summary',
  canonical_url: 'technical.group.canonical_url',
  internal_links: 'technical.group.internal_links',
  sitemap_discovery: 'technical.group.sitemap_discovery',
  content_readability: 'technical.group.content_readability',
}

const technicalItemKey: Record<string, MessageKey> = {
  'site.dns': 'technical.item.site.dns',
  'site.https': 'technical.item.site.https',
  'site.http_status': 'technical.item.site.http_status',
  'site.redirect': 'technical.item.site.redirect',
  'crawl.robots_txt': 'technical.item.crawl.robots_txt',
  'crawl.login': 'technical.item.crawl.login',
  'index.noindex': 'technical.item.index.noindex',
  'index.x_robots_tag': 'technical.item.index.x_robots_tag',
  'index.snippet': 'technical.item.index.snippet',
  'canonical.target': 'technical.item.canonical.target',
  'canonical.domain_conflict': 'technical.item.canonical.domain_conflict',
  'links.broken': 'technical.item.links.broken',
  'links.navigation': 'technical.item.links.navigation',
  'links.pagination': 'technical.item.links.pagination',
  'sitemap.generation': 'technical.item.sitemap.generation',
  'sitemap.coverage': 'technical.item.sitemap.coverage',
  'sitemap.invalid_urls': 'technical.item.sitemap.invalid_urls',
  'sitemap.lastmod': 'technical.item.sitemap.lastmod',
  'discovery.llms_txt': 'technical.item.discovery.llms_txt',
  'content.html_body': 'technical.item.content.html_body',
  'content.javascript_render': 'technical.item.content.javascript_render',
  'content.html_structure': 'technical.item.content.html_structure',
  'content.metadata': 'technical.item.content.metadata',
  'content.structured_data': 'technical.item.content.structured_data',
}

const technicalMessageKey: Record<string, MessageKey> = Object.fromEntries(
  Object.keys(TECHNICAL_AUDIT_MESSAGES).map((code) => [code, `technical.message.${code}` as MessageKey]),
)

function translatedTechnicalMessage(messageCode: string, locale: Locale): string {
  const key = technicalMessageKey[messageCode]
  return key ? translate(locale, key) : technicalAuditMessage(messageCode)
}

const technicalBenefitLevelKey: Record<string, MessageKey> = {
  高: 'technical.benefitLevel.high',
  中: 'technical.benefitLevel.medium',
  低: 'technical.benefitLevel.low',
}

const technicalHelpText = (itemId: string, kind: 'benefit' | 'criteria', locale: Locale): string => {
  const help = TECHNICAL_AUDIT_HELP[itemId]
  if (!help) return ''
  const key = `technical.help.${itemId}.${kind}` as MessageKey
  const translated = translate(locale, key)
  if (translated !== key) return translated
  return kind === 'benefit' ? help.geoBenefit : help.passCriteria
}

const technicalDetailKey: Record<string, MessageKey> = {
  not_applicable: 'technical.detail.generic.notApplicable',
  incomplete: 'technical.detail.generic.incomplete',
  reviewSuffix: 'technical.detail.generic.reviewSuffix',
  structuredDataNoConclusion: 'technical.detail.generic.structuredDataNoConclusion',
  siteDns: 'technical.detail.site.dns',
  siteHttpsDns: 'technical.detail.site.https.dns',
  siteHttps: 'technical.detail.site.https',
  siteHttpStatus: 'technical.detail.site.http_status',
  siteRedirect: 'technical.detail.site.redirect',
  crawlLogin: 'technical.detail.crawl.login',
  indexVisibility: 'technical.detail.index.visibility',
  canonicalTarget: 'technical.detail.canonical.target',
  canonicalDomain: 'technical.detail.canonical.domain',
  linksBroken: 'technical.detail.links.broken',
  linksNavigation: 'technical.detail.links.navigation',
  linksPagination: 'technical.detail.links.pagination',
  sitemapCoverage: 'technical.detail.sitemap.coverage',
  contentJavascript: 'technical.detail.content.javascript',
  contentInteraction: 'technical.detail.content.interaction',
  structuredApplicable: 'technical.detail.structured.applicable',
  structuredVisible: 'technical.detail.structured.visible',
  legacyCms: 'technical.detail.legacy.cms',
  legacyCanonicalDuplicate: 'technical.detail.legacy.canonicalDuplicate',
  legacyCanonicalMigration: 'technical.detail.legacy.canonicalMigration',
  legacyOrphan: 'technical.detail.legacy.orphan',
  legacySitemapPlatform: 'technical.detail.legacy.sitemapPlatform',
  renderNotExercised: 'technical.detail.generic.renderNotExercised',
  jsonldInvalid: 'technical.detail.generic.jsonldInvalid',
  structuredVisibleReview: 'technical.detail.generic.structuredVisibleReview',
  review: 'technical.detail.generic.review',
  inconsistent: 'technical.detail.generic.inconsistent',
  unknown: 'technical.detail.generic.unknown',
}

function translatedTechnicalDetail(code: string, locale: Locale): string {
  const key = technicalDetailKey[code]
  return key ? translate(locale, key) : code
}

function technicalJoin(left: string, right: string, locale: Locale): string {
  if (!left) return right
  if (!right) return left
  return locale === 'en'
    ? `${left.replace(/[.!?]+$/u, '')}. ${right}`
    : `${left.replace(/[。；]+$/u, '')}；${right}`
}

export type TechnicalAuditRunToken = {
  token: number
  projectId: string
  websiteUrl: string
}

export type TechnicalAuditRunGuard = {
  begin: (projectId: string, websiteUrl: string) => TechnicalAuditRunToken | null
  isCurrent: (run: TechnicalAuditRunToken) => boolean
  finish: (token: number) => void
  invalidate: () => void
}

export function createTechnicalAuditRunGuard(): TechnicalAuditRunGuard {
  let sequence = 0
  let active: TechnicalAuditRunToken | null = null
  return {
    begin(projectId, websiteUrl) {
      if (active) return null
      active = { token: ++sequence, projectId, websiteUrl }
      return active
    },
    isCurrent(run) {
      return Boolean(active && active.token === run.token && active.projectId === run.projectId && active.websiteUrl === run.websiteUrl)
    },
    finish(token) {
      if (active?.token === token) active = null
    },
    invalidate() {
      active = null
      sequence += 1
    },
  }
}

function factsOf(item: TechnicalAuditItem | undefined): AuditFacts {
  if (!item || !item.facts || typeof item.facts !== 'object' || Array.isArray(item.facts)) return {}
  return item.facts as AuditFacts
}

function evidenceOf(item: TechnicalAuditItem): Record<string, unknown> {
  if (!item.evidence || typeof item.evidence !== 'object' || Array.isArray(item.evidence)) return {}
  return item.evidence as Record<string, unknown>
}

function safeEvidenceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname}`.slice(0, 160)
  } catch {
    return null
  }
}

function safeEvidenceStatus(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) return null
  return value
}

function safeEvidenceCode(value: unknown, hideInternalNetworkCodes = false): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) return null
  // Request deadlines remain an internal transport safeguard.  They are not
  // one of the confirmed technical-optimization tasks and must not surface as
  // a timeout fault in the customer-facing panel.
  if (hideInternalNetworkCodes && INTERNAL_NETWORK_MESSAGE_CODES.has(value)) return null
  return value
}

function safeEvidencePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().split(/[?#]/, 1)[0]?.slice(0, 200) ?? ''
  return sanitized || null
}

function robotsRestrictionDescription(value: unknown, locale: Locale = 'zh-CN'): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const path = safeEvidencePath(record.path)
  const rule = record.rule
  const matchedRule = rule && typeof rule === 'object' && !Array.isArray(rule) ? rule as Record<string, unknown> : null
  const rulePath = safeEvidencePath(matchedRule?.path)
  const ruleName = matchedRule?.allow === true
    ? translate(locale, 'technical.evidence.allow')
    : matchedRule?.allow === false
      ? translate(locale, 'technical.evidence.disallow')
      : null
  if (!path) return null
  return ruleName && rulePath
    ? translate(locale, 'technical.evidence.robotsMatched', { path, rule: `${ruleName} ${rulePath}` })
    : translate(locale, 'technical.evidence.robotsNoRule', { path })
}

function evidenceDescription(value: unknown, hideInternalNetworkCodes = false, locale: Locale = 'zh-CN'): string | null {
  if (typeof value === 'string') {
    const url = safeEvidenceUrl(value)
    return url ? translate(locale, 'technical.evidence.url', { url }) : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const url = safeEvidenceUrl(record.url ?? record.requested_url ?? record.final_url ?? record.target ?? record.href)
  const status = safeEvidenceStatus(record.status)
  const errorCode = safeEvidenceCode(record.error_code ?? record.error, hideInternalNetworkCodes)
  const details = [
    url ? translate(locale, 'technical.evidence.url', { url }) : '',
    status === null ? '' : translate(locale, 'technical.evidence.status', { status }),
    errorCode ? translate(locale, 'technical.evidence.error', { code: errorCode }) : '',
  ].filter(Boolean)
  return details.length ? details.join(translate(locale, 'technical.evidence.separator')) : null
}

function structuredDataEvidenceDetails(item: TechnicalAuditItem, add: (value: string | null) => void, locale: Locale = 'zh-CN'): void {
  const evidence = evidenceOf(item)
  const pages = Array.isArray(evidence.pages) ? evidence.pages : []
  const pageRecords = pages.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
  const pageUrl = (page: Record<string, unknown>): string => safeEvidenceUrl(page.url) ?? translate(locale, 'technical.evidence.page')
  const issueText = (page: Record<string, unknown>, issue: Record<string, unknown>): string | null => {
    const format = issue.format === 'JSON-LD' || issue.format === 'Microdata' || issue.format === 'RDFa' ? issue.format : null
    const reason = typeof issue.reason === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(issue.reason) ? issue.reason : null
    const location = typeof issue.location === 'string'
      ? issue.location.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
      : ''
    if (!format || !reason || !location) return null
    return translate(locale, 'technical.evidence.structuredIssue', {
      page: pageUrl(page),
      format,
      reason,
      location,
    })
  }
  const pageIssues = (page: Record<string, unknown>): Record<string, unknown>[] => {
    if (!Array.isArray(page.issues)) return []
    return page.issues.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
  }
  const isParserOnly = (page: Record<string, unknown>): boolean => {
    const issues = pageIssues(page)
    return issues.length > 0 && issues.every((issue) => issue.reason === 'parser_error')
  }
  const incompletePages = factsOf(item).incomplete_pages
  const hasIncompletePages = typeof incompletePages === 'number' && Number.isInteger(incompletePages) && incompletePages > 0
  const problemLimit = hasIncompletePages ? 2 : 3
  let problemCount = 0
  const problemValues = new Set<string>()
  const addProblem = (value: string | null) => {
    if (problemCount >= problemLimit || !value || problemValues.has(value)) return
    problemValues.add(value)
    add(value)
    problemCount += 1
  }

  // Keep structured-data evidence page-specific and bounded.  Successful
  // pages are deliberately skipped so a repair message does not imply they
  // are faults.
  for (const page of pageRecords) {
    if (Array.isArray(page.formats) && page.formats.length === 0 && !isParserOnly(page)) {
      addProblem(translate(locale, 'technical.evidence.structuredMissing', { page: pageUrl(page) }))
    }
  }
  for (const page of pageRecords) {
    for (const issue of pageIssues(page)) {
      if (issue.reason === 'parser_error') continue
      addProblem(issueText(page, issue))
    }
  }

  if (hasIncompletePages) {
    add(translate(locale, 'technical.evidence.structuredIncomplete', { count: Math.min(incompletePages, 10_000) }))
  }
}

function evidenceDetails(item: TechnicalAuditItem, locale: Locale = 'zh-CN'): string[] {
  const evidence = evidenceOf(item)
  const hideInternalNetworkCodes = RECHECK_ITEM_IDS.has(item.item_id)
  const details: string[] = []
  const add = (value: string | null) => {
    if (value && !details.includes(value) && details.length < 3) details.push(value)
  }

  const describeEvidence = (entry: unknown): string | null => evidenceDescription(entry, hideInternalNetworkCodes, locale)
  const addArray = (value: unknown, describe: (entry: unknown) => string | null = describeEvidence) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (details.length >= 3) return
      add(describe(entry))
    }
  }
  if (item.item_id === STRUCTURED_DATA_ITEM_ID) {
    structuredDataEvidenceDetails(item, add, locale)
    return details
  }
  // Page-level failures are more actionable than a successful root request;
  // keep them ahead of generic request evidence when the snapshot is capped.
  addArray(evidence.page_failures)
  addArray(evidence.target_check)
  addArray(evidence.broken_links)
  addArray(evidence.dead_urls)
  addArray(evidence.invalid_urls)
  addArray(evidence.blocked_links)
  addArray(evidence.unverified_links)
  addArray(evidence.candidates)
  if (item.item_id === 'crawl.robots_txt') addArray(evidence.restricted_targets, (entry) => robotsRestrictionDescription(entry, locale))
  if (item.item_id === 'crawl.login') {
    addArray(evidence.blocked_pages)
    addArray(factsOf(item).blocked_pages)
  }

  const requestedUrl = safeEvidenceUrl(evidence.requested_url)
  const finalUrl = safeEvidenceUrl(evidence.final_url)
  const status = safeEvidenceStatus(evidence.status)
  const errorCode = safeEvidenceCode(evidence.error_code ?? evidence.error, hideInternalNetworkCodes)
  if (details.length < 3 && (requestedUrl || finalUrl || status !== null || errorCode)) {
    const urls = requestedUrl && finalUrl && requestedUrl !== finalUrl
      ? translate(locale, 'technical.evidence.requestFinal', { requested: requestedUrl, final: finalUrl })
      : requestedUrl || finalUrl
    add([
      urls ?? '',
      status === null ? '' : translate(locale, 'technical.evidence.status', { status }),
      errorCode ? translate(locale, 'technical.evidence.error', { code: errorCode }) : '',
    ].filter(Boolean).join(translate(locale, 'technical.evidence.separator')))
  }
  return details
}

function policyMessage(item: TechnicalAuditItem, locale: Locale = 'zh-CN'): string | null {
  if (item.item_id !== 'crawl.robots_txt') return null
  const policy = factsOf(item).policy
  const messageCode = policy === 'allowed'
    ? 'robots_allowed'
    : policy === 'restricted'
      ? 'robots_restricted'
      : policy === 'mixed'
        ? 'robots_mixed'
        : policy === 'not_declared'
          ? 'robots_not_declared'
          : null
  return messageCode ? translatedTechnicalMessage(messageCode, locale) : null
}

function notApplicableMessage(item: TechnicalAuditItem, locale: Locale = 'zh-CN'): string {
  if (item.item_id === 'discovery.llms_txt' && item.message_code === 'llms_optional_missing') {
    return translatedTechnicalMessage('llms_optional_missing', locale)
  }
  return translatedTechnicalDetail('not_applicable', locale)
}

const CAPABILITY_MESSAGE_CODES: Record<string, string> = {
  'content.html_body': 'html_body_scope',
  'content.javascript_render': 'javascript_render_scope',
  'content.html_structure': 'html_structure_scope',
  'content.metadata': 'metadata_scope',
  'content.structured_data': 'structured_data_scope',
  'sitemap.lastmod': 'sitemap_lastmod_scope',
}

function appendCapabilityMessage(message: string, itemId: string | undefined, locale: Locale = 'zh-CN'): string {
  const messageCode = itemId ? CAPABILITY_MESSAGE_CODES[itemId] : undefined
  if (!messageCode) return message
  const capability = translatedTechnicalMessage(messageCode, locale)
  if (!message) return capability
  if (message.includes(capability)) return message
  return technicalJoin(message, capability, locale)
}

const SHARED_SPECIFIC_MESSAGE_CODES = new Set([
  'robots_allowed', 'robots_restricted', 'robots_mixed', 'robots_not_declared', 'robots_unreadable',
  'legacy_rule_recheck', 'login_required', 'login_evidence_insufficient', 'login_challenge',
  'llms_present', 'llms_missing', 'llms_unavailable', 'llms_optional_missing', 'llms_declared_missing', 'llms_invalid', 'llms_not_confirmed', 'llms_broken_link',
  'https_required', 'http_error', 'html_body_missing', 'html_structure_invalid', 'metadata_incomplete',
  'canonical_missing', 'canonical_review', 'canonical_target_missing', 'canonical_target_cross_origin',
  'broken_link', 'navigation_not_crawlable', 'pagination_not_crawlable',
  'sitemap_missing', 'sitemap_invalid', 'sitemap_invalid_url', 'sitemap_lastmod_invalid', 'sitemap_lastmod_missing',
  'structured_type_review', 'structured_type_missing', 'structured_id_missing', 'structured_visible_mismatch', 'structured_duplicate',
  'structured_data_missing', 'structured_data_invalid',
])

function itemSpecificMessageCode(item: TechnicalAuditItem, facts: AuditFacts): string | null {
  switch (item.item_id) {
    case 'site.dns':
      return 'siteDns'
    case 'site.https':
      return item.message_code === 'dns_failed'
        ? 'siteHttpsDns'
        : 'siteHttps'
    case 'site.http_status':
      return 'siteHttpStatus'
    case 'site.redirect':
      if (item.message_code === 'redirect_loop' || item.message_code === 'redirect_invalid' || item.message_code === 'redirect_blocked' || item.message_code === 'redirect_limit') return item.message_code
      return 'siteRedirect'
    case 'crawl.login':
      if (item.message_code === 'login_required') {
        return facts.blocked === true ? 'login_required' : 'crawlLogin'
      }
      if (item.message_code === 'login_challenge' || item.message_code === 'login_evidence_insufficient') return item.message_code
      return facts.blocked === true ? 'login_required' : 'crawlLogin'
    case 'index.cms_search_visibility':
      return 'legacyCms'
    case 'index.noindex':
    case 'index.x_robots_tag':
    case 'index.snippet':
      return 'indexVisibility'
    case 'canonical.target':
      return 'canonicalTarget'
    case 'canonical.duplicate':
      return 'legacyCanonicalDuplicate'
    case 'canonical.domain_conflict':
      return 'canonicalDomain'
    case 'canonical.migration_redirect':
      return 'legacyCanonicalMigration'
    case 'links.orphan':
      return 'legacyOrphan'
    case 'links.broken':
      return 'linksBroken'
    case 'links.navigation':
      return 'linksNavigation'
    case 'links.pagination':
      return 'linksPagination'
    case 'sitemap.platform_submission':
      return 'legacySitemapPlatform'
    case 'sitemap.coverage':
      return 'sitemapCoverage'
    case 'content.javascript_render':
      return 'contentJavascript'
    case 'content.click_load':
    case 'content.scroll_load':
      return 'contentInteraction'
    case 'structured.applicable_type':
      return 'structuredApplicable'
    case 'structured.visible_consistency':
      return 'structuredVisible'
    default:
      return null
  }
}

function itemSpecificMessage(item: TechnicalAuditItem, facts: AuditFacts, locale: Locale = 'zh-CN'): string | null {
  const code = itemSpecificMessageCode(item, facts)
  if (!code) return null
  return technicalMessageKey[code]
    ? translatedTechnicalMessage(code, locale)
    : translatedTechnicalDetail(code, locale)
}

export function fallbackMessage(item: TechnicalAuditItem, locale: Locale = 'zh-CN'): string {
  // Only the six narrowed first-two-module items may receive the new generic
  // network wording.  Historical later-module results must keep their old
  // message-code interpretation intact.
  const messageCode = RECHECK_ITEM_IDS.has(item.item_id) && INTERNAL_NETWORK_MESSAGE_CODES.has(item.message_code)
    ? 'network_unavailable'
    : item.message_code
  const messageItem = messageCode === item.message_code ? item : { ...item, message_code: messageCode }
  const facts = factsOf(messageItem)
  const sharedMessage = SHARED_SPECIFIC_MESSAGE_CODES.has(messageCode)
    && !(messageItem.item_id === 'crawl.login' && messageCode === 'login_required' && facts.blocked !== true)
    ? translatedTechnicalMessage(messageCode, locale)
    : null
  const base = sharedMessage
    ?? itemSpecificMessage(messageItem, facts, locale)
    ?? (messageCode === 'dns_failed' && item.item_id === 'site.dns' ? translatedTechnicalDetail('siteDns', locale) : null)
    ?? (messageCode === 'render_not_exercised' ? translatedTechnicalDetail('renderNotExercised', locale) : null)
    ?? (messageCode === 'jsonld_invalid' ? translatedTechnicalDetail('jsonldInvalid', locale) : null)
    ?? (messageCode === 'structured_visible_review' ? translatedTechnicalDetail('structuredVisibleReview', locale) : null)
    ?? (messageCode === 'review' || messageCode === 'no_baseline' || messageCode === 'limit_partial' || messageCode === 'network_unavailable'
      ? translatedTechnicalDetail('review', locale)
      : messageCode === 'pass' || messageCode === 'not_applicable'
        ? translatedTechnicalDetail('inconsistent', locale)
        : translatedTechnicalDetail('unknown', locale))
  const evidence = evidenceDetails(item, locale)
  if (!evidence.length) return base
  const evidenceLabel = translate(locale, 'technical.evidence.label')
  return locale === 'en'
    ? `${base} (${evidenceLabel}: ${evidence.join('; ')})`
    : `${base}（${evidenceLabel}：${evidence.join('；')}）`
}

export type TechnicalAuditItemDisplay = {
  status: TechnicalAuditStatus | 'checking'
  label: string
  tone: TechnicalAuditStatus
  message: string
  showStatus?: boolean
}

function legacyResultMessageCode(itemId: string | undefined, ruleVersion: number | undefined): 'legacy_rule_recheck' | 'legacy_scope_recheck' | null {
  if (!itemId || ruleVersion === TECHNICAL_AUDIT_RULE_VERSION) return null
  // v2/v3 kept only the four homepage-only site checks stable.  The robots
  // target set changed with the full-crawl scope, so it also needs a scope
  // recheck. v1/omitted snapshots predate the current rule contract and keep
  // no trustworthy current result; an unknown version is never current.
  if (ruleVersion === 2 || ruleVersion === 3) return LEGACY_STABLE_ITEM_IDS.has(itemId) ? null : 'legacy_scope_recheck'
  // v4-v6 results remain readable as historical evidence, but the current
  // rules have since changed.  Do not let an old snapshot's pass/fix status
  // masquerade as a conclusion from the current scope; the two special
  // items above additionally stay unchecked until they are rerun.
  if (ruleVersion === 6 || ruleVersion === 5 || ruleVersion === 4) return 'legacy_rule_recheck'
  if (ruleVersion === 1 || ruleVersion === undefined) return 'legacy_rule_recheck'
  return 'legacy_rule_recheck'
}

function incompleteResultMessage(locale: Locale = 'zh-CN'): string {
  return translatedTechnicalDetail('incomplete', locale)
}

export function technicalAuditItemDisplay(
  item: TechnicalAuditItem | undefined,
  hasCompletedSnapshot = false,
  ruleVersion?: number,
  definitionId?: string,
  isChecking = false,
  locale: Locale = 'zh-CN',
): TechnicalAuditItemDisplay {
  const itemId = definitionId ?? item?.item_id

  // While a run is in flight, a missing row has not produced a conclusion
  // yet. Keep it distinct from the finished-run unchecked state so the UI
  // communicates that this item is still being streamed.
  if (isChecking && !item) {
    return {
      status: 'checking',
      label: locale === 'zh-CN' ? '检查中' : translate(locale, 'technical.checking'),
      tone: 'unchecked',
      message: '',
    }
  }

  // The structured-data item is a current-rule conclusion only.  A stale
  // source, an execution-incomplete status, or any other status must never
  // render as a pass/fix badge that looks like a current result.  Keep the
  // item visible as an explicit unchecked state so an empty badge cannot be
  // mistaken for a completed check.
  if (itemId === STRUCTURED_DATA_ITEM_ID) {
    const currentConclusion = ruleVersion === TECHNICAL_AUDIT_RULE_VERSION
      && Boolean(item && (item.status === 'pass' || item.status === 'fix'))
    if (!currentConclusion) {
      const noConclusion = translatedTechnicalDetail('structuredDataNoConclusion', locale)
      const message = !item || ruleVersion !== TECHNICAL_AUDIT_RULE_VERSION || item.status === 'unchecked'
        ? noConclusion
        : item.status === 'not_applicable'
          ? notApplicableMessage(item, locale)
          : technicalJoin(
            appendCapabilityMessage(fallbackMessage(item, locale), itemId, locale),
            translatedTechnicalDetail('reviewSuffix', locale),
            locale,
          )
      return {
        status: 'unchecked',
        label: translate(locale, technicalStatusKey.unchecked),
        tone: 'unchecked',
        message,
      }
    }
  }

  // llms.txt is a required two-state check in the current rules.  Keep any
  // historical result, including historical not_applicable, out of the
  // current badge; the item remains visibly unchecked with a recheck reminder.
  const isKnownStaleVersion = typeof ruleVersion === 'number' && ruleVersion !== TECHNICAL_AUDIT_RULE_VERSION
  if (itemId === LLMS_ITEM_ID && (hasCompletedSnapshot || isKnownStaleVersion)
    && (ruleVersion !== TECHNICAL_AUDIT_RULE_VERSION || !item || (item.status !== 'pass' && item.status !== 'fix'))) {
    return {
      status: 'unchecked',
      label: translate(locale, technicalStatusKey.unchecked),
      tone: 'unchecked',
      message: translate(locale, 'technical.llmsRuleUpdated'),
    }
  }

  // Missing or explicitly unchecked entries are execution-incomplete, not a
  // strategy review.  This also covers partial snapshots: a completed
  // snapshot does not turn an absent item into a current conclusion.
  if (!item || item.status === 'unchecked') {
    if (hasCompletedSnapshot) {
      return {
        status: 'unchecked',
        label: translate(locale, technicalStatusKey.unchecked),
        tone: 'unchecked',
        message: incompleteResultMessage(locale),
      }
    }
    return {
      status: 'unchecked',
      label: translate(locale, technicalStatusKey.unchecked),
      tone: 'unchecked',
      message: '',
    }
  }

  // These checks are deliberately not wired to an automated detector.  Keep
  // their raw historical result out of the status semantics, including when
  // an old snapshot claimed pass/fix.
  if (itemId && UNSUPPORTED_ITEM_IDS.has(itemId) && (hasCompletedSnapshot || item)) {
    return {
      status: 'unchecked',
      label: translate(locale, technicalStatusKey.unchecked),
      tone: 'unchecked',
      message: translatedTechnicalMessage('check_not_implemented', locale),
    }
  }

  const legacyMessageCode = item && (hasCompletedSnapshot || isKnownStaleVersion)
    ? legacyResultMessageCode(itemId, ruleVersion)
    : null
  if (legacyMessageCode) {
    return {
      status: 'review',
      label: translate(locale, technicalStatusKey.review),
      tone: 'review',
      message: translatedTechnicalMessage(legacyMessageCode, locale),
    }
  }

  if (item.status === 'pass') {
    return {
      status: 'pass',
      label: translate(locale, technicalStatusKey.pass),
      tone: 'pass',
      message: appendCapabilityMessage(policyMessage(item, locale) ?? '', itemId, locale),
    }
  }

  if (item.status === 'not_applicable') {
    return {
      status: 'not_applicable',
      label: translate(locale, technicalStatusKey.not_applicable),
      tone: 'not_applicable',
      message: notApplicableMessage(item, locale),
    }
  }

  if (item.status === 'review') {
    const message = appendCapabilityMessage(fallbackMessage(item, locale), itemId, locale)
    return {
      status: 'review',
      label: translate(locale, technicalStatusKey.review),
      tone: 'review',
      message: technicalJoin(message, translatedTechnicalDetail('reviewSuffix', locale), locale),
    }
  }

  return {
    status: 'fix',
    label: translate(locale, technicalStatusKey.fix),
    tone: 'fix',
    message: appendCapabilityMessage(fallbackMessage(item, locale), itemId, locale),
  }
}

function snapshotItems(snapshot: TechnicalAuditSnapshot | null): Map<string, TechnicalAuditItem> {
  return new Map((snapshot?.items ?? []).map((item) => [item.item_id, item]))
}

export function technicalAuditScopeNote(snapshot: TechnicalAuditSnapshot | null, locale: Locale = 'zh-CN'): string {
  const homepageScope = translate(locale, 'technical.scope.homepageOnly')
  const llmsRuleUpdate = translate(locale, 'technical.llmsRuleUpdated')
  if (!snapshot) return translate(locale, 'technical.scope.initial')

  const scope = snapshot.scope as Partial<TechnicalAuditSnapshot['scope']> | undefined
  const planned = Array.isArray(scope?.pages) ? scope.pages : null
  const valid = Array.isArray(scope?.sampled_pages) ? scope.sampled_pages : null
  const skipped = Array.isArray(scope?.skipped_pages) ? scope.skipped_pages : null
  if (!planned || !valid || !skipped) {
    return snapshot.rule_version === 4 || snapshot.rule_version === 5 || snapshot.rule_version === 6 || snapshot.rule_version === TECHNICAL_AUDIT_RULE_VERSION
      ? [
        translate(locale, 'technical.scope.incompleteCurrent'),
        snapshot.rule_version === 4 ? translate(locale, 'technical.scope.structuredRuleUpdated') : '',
        snapshot.rule_version === 4 || snapshot.rule_version === 5 || snapshot.rule_version === 6 ? llmsRuleUpdate : '',
        homepageScope,
      ].filter(Boolean).join(translate(locale, 'technical.scope.separator'))
      : [translate(locale, 'technical.scope.historicalIncomplete'), homepageScope].join(translate(locale, 'technical.scope.separator'))
  }

  const plannedPages = planned.length
  const validPages = valid.length
  if (snapshot.rule_version === 4) {
    return [
      translate(locale, 'technical.scope.currentStats', { planned: plannedPages, valid: validPages, skipped: skipped.length }),
      translate(locale, 'technical.scope.structuredRuleUpdated'),
      llmsRuleUpdate,
      homepageScope,
    ].join(translate(locale, 'technical.scope.separator'))
  }
  if (snapshot.rule_version !== TECHNICAL_AUDIT_RULE_VERSION && snapshot.rule_version !== 6 && snapshot.rule_version !== 5) {
    return [
      translate(locale, 'technical.scope.historicalStats', { planned: plannedPages, valid: validPages }),
      homepageScope,
    ].join(translate(locale, 'technical.scope.separator'))
  }

  if (snapshot.rule_version === 5 || snapshot.rule_version === 6) {
    return [
      translate(locale, 'technical.scope.currentStats', { planned: plannedPages, valid: validPages, skipped: skipped.length }),
      llmsRuleUpdate,
      homepageScope,
    ].join(translate(locale, 'technical.scope.separator'))
  }

  return [
    translate(locale, 'technical.scope.currentStats', { planned: plannedPages, valid: validPages, skipped: skipped.length }),
    homepageScope,
  ].join(translate(locale, 'technical.scope.separator'))
}

function isCurrentProject(projectId: string, websiteUrl: string | null, expectedProjectId: string, expectedWebsiteUrl: string | null): boolean {
  return projectId === expectedProjectId && websiteUrl === expectedWebsiteUrl
}

function technicalAuditInfoId(target: TechnicalAuditInfoTarget): string {
  if (target === 'scope') return 'technical-audit-info'
  return `technical-audit-info-${target.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function TechnicalAuditPanel({ projectId, websiteUrl }: TechnicalAuditPanelProps) {
  const { t, locale } = useI18n()
  const [snapshot, setSnapshot] = useState<TechnicalAuditSnapshot | null>(null)
  // Keep an in-flight run separate from the persisted snapshot.  The latter
  // remains available for rollback, but must not leak stale badges while the
  // new per-item stream is still being consumed.
  const [draftItems, setDraftItems] = useState<Map<string, TechnicalAuditItem> | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [activeInfo, setActiveInfo] = useState<TechnicalAuditInfoTarget | null>(null)
  const [error, setError] = useState<UiMessage>('')
  const errorText = resolveUiMessage(error, locale)
  const requestIdRef = useRef(0)
  const runGuardRef = useRef<TechnicalAuditRunGuard | null>(null)
  const infoButtonRef = useRef<HTMLButtonElement | null>(null)
  const infoPanelRef = useRef<HTMLDivElement | null>(null)
  if (!runGuardRef.current) runGuardRef.current = createTechnicalAuditRunGuard()
  const projectRef = useRef({ projectId, websiteUrl })

  const closeInfo = useCallback(() => {
    setActiveInfo(null)
    infoButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    projectRef.current = { projectId, websiteUrl }
  }, [projectId, websiteUrl])

  useEffect(() => {
    setActiveInfo(null)
  }, [projectId, websiteUrl])

  useEffect(() => {
    if (!activeInfo) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closeInfo()
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node) {
        const targetElement = target instanceof Element ? target : null
        if (infoPanelRef.current?.contains(target) || infoButtonRef.current?.contains(target) || targetElement?.closest('.technical-audit-panel__info-button')) return
      }
      setActiveInfo(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [activeInfo, closeInfo])

  useLayoutEffect(() => {
    if (!activeInfo || activeInfo === 'scope') return

    const reposition = () => {
      const trigger = infoButtonRef.current
      const panel = infoPanelRef.current
      if (!trigger || !panel) return

      const viewportPadding = 8
      const gap = 4
      const triggerRect = trigger.getBoundingClientRect()
      if (triggerRect.bottom <= 0 || triggerRect.top >= window.innerHeight) {
        setActiveInfo(null)
        return
      }

      panel.style.position = 'fixed'
      panel.style.right = 'auto'
      panel.style.width = `${Math.max(0, Math.min(280, window.innerWidth - viewportPadding * 2))}px`
      panel.style.maxHeight = `${Math.max(0, window.innerHeight - viewportPadding * 2)}px`

      const panelRect = panel.getBoundingClientRect()
      const left = Math.min(
        Math.max(triggerRect.left, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - panelRect.width - viewportPadding),
      )
      const belowTop = triggerRect.bottom + gap
      const aboveTop = triggerRect.top - gap - panelRect.height
      const viewportBottom = window.innerHeight - viewportPadding
      const top = belowTop + panelRect.height <= viewportBottom || aboveTop < viewportPadding
        ? Math.min(Math.max(belowTop, viewportPadding), Math.max(viewportPadding, viewportBottom - panelRect.height))
        : aboveTop

      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
    }

    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [activeInfo])

  useEffect(() => {
    const requestId = ++requestIdRef.current
    const requestedProject = { projectId, websiteUrl }
    setSnapshot(null)
    setDraftItems(null)
    setError('')
    runGuardRef.current?.invalidate()
    setChecking(false)
    if (!websiteUrl) {
      setLoading(false)
      return
    }

    setLoading(true)
    void fetchTechnicalAudit(projectId)
      .then((result) => {
        if (requestIdRef.current !== requestId || !isCurrentProject(projectRef.current.projectId, projectRef.current.websiteUrl, requestedProject.projectId, requestedProject.websiteUrl)) return
        setSnapshot(result)
      })
      .catch((cause) => {
        if (requestIdRef.current !== requestId || !isCurrentProject(projectRef.current.projectId, projectRef.current.websiteUrl, requestedProject.projectId, requestedProject.websiteUrl)) return
        setError(apiErrorMessage(cause, 'error.server.technical_audit_unavailable'))
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false)
      })

    return () => {
      requestIdRef.current += 1
    }
  }, [projectId, websiteUrl])

  const check = useCallback(() => {
    if (!websiteUrl || loading || checking) return
    const run = runGuardRef.current?.begin(projectId, websiteUrl)
    if (!run) return
    const requestId = ++requestIdRef.current
    const requestedProject = { projectId, websiteUrl }
    setChecking(true)
    setDraftItems(new Map())
    setError('')
    const onProgress = (progress: TechnicalAuditProgressEvent) => {
      if (requestIdRef.current !== requestId
        || !runGuardRef.current?.isCurrent(run)
        || !isCurrentProject(projectRef.current.projectId, projectRef.current.websiteUrl, requestedProject.projectId, requestedProject.websiteUrl)) return
      setDraftItems((current) => {
        const next = new Map(current ?? [])
        next.set(progress.item.item_id, progress.item)
        return next
      })
    }
    void runTechnicalAudit(projectId, onProgress)
      .then((result) => {
        if (requestIdRef.current !== requestId || !runGuardRef.current?.isCurrent(run) || !isCurrentProject(projectRef.current.projectId, projectRef.current.websiteUrl, requestedProject.projectId, requestedProject.websiteUrl)) return
        setSnapshot(result)
        setDraftItems(null)
      })
      .catch((cause) => {
        if (requestIdRef.current !== requestId || !runGuardRef.current?.isCurrent(run) || !isCurrentProject(projectRef.current.projectId, projectRef.current.websiteUrl, requestedProject.projectId, requestedProject.websiteUrl)) return
        // A failed run is not an item conclusion. Keep the completed draft
        // rows visible while surfacing the execution error through the
        // existing panel feedback region; the next explicit run can retry.
        setError(apiErrorMessage(cause, 'error.server.technical_audit_execution_failed'))
      })
      .finally(() => {
        if (requestIdRef.current === requestId && runGuardRef.current?.isCurrent(run)) {
          runGuardRef.current.finish(run.token)
          setChecking(false)
        }
      })
  }, [checking, loading, projectId, websiteUrl])

  const items = useMemo(() => draftItems ?? snapshotItems(snapshot), [draftItems, snapshot])
  // A missing rule_version is intentionally left unknown.  The display helper
  // keeps it out of the current-rule path instead of silently treating it as
  // a current result.
  const displayHasCompletedSnapshot = checking ? false : Boolean(snapshot)
  const snapshotRuleVersion = checking ? TECHNICAL_AUDIT_RULE_VERSION : snapshot?.rule_version
  const checkedAt = checking ? null : snapshot?.checked_at ?? null
  const buttonLabel = checking ? t('technical.checking') : t('technical.check')

  return (
    <section className="technical-audit-panel" aria-labelledby="technical-audit-title">
      <header className="technical-audit-panel__header">
        <div className="technical-audit-panel__title">
          <h2 id="technical-audit-title">{t('technical.title')}</h2>
          <button
            ref={activeInfo === 'scope' ? infoButtonRef : undefined}
            type="button"
            className="technical-audit-panel__info-button"
            aria-label={t('technical.info')}
            title={t('technical.info')}
            aria-expanded={activeInfo === 'scope'}
            aria-controls={technicalAuditInfoId('scope')}
            onClick={() => setActiveInfo((current) => current === 'scope' ? null : 'scope')}
          >
            <Info size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <Button type="button" className="technical-audit-panel__check" icon={<ListChecks size={16} strokeWidth={1.8} />} onClick={check} disabled={!websiteUrl || loading || checking}>
          {buttonLabel}
        </Button>
      </header>
      {activeInfo === 'scope' ? (
        <div ref={infoPanelRef} id={technicalAuditInfoId('scope')} className="technical-audit-panel__info" role="status">
          <button
            type="button"
            className="technical-audit-panel__info-button technical-audit-panel__info-close"
            aria-label={t('technical.closeInfo')}
            onClick={closeInfo}
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div>{loading ? t('technical.reading') : checkedAt ? t('technical.latest', { date: new Date(checkedAt).toLocaleString(locale) }) : t('technical.notChecked')}</div>
          <div>{technicalAuditScopeNote(checking ? null : snapshot, locale)}</div>
        </div>
      ) : null}
      <div className="technical-audit-panel__card">
        {errorText ? <div className="technical-audit-panel__error" role="alert">{errorText}</div> : null}
        {!websiteUrl ? <div className="technical-audit-panel__empty" role="status">{t('technical.websiteRequired')}</div> : null}
        <div className="technical-audit-panel__groups">
          {TECHNICAL_GROUPS.map((group, groupIndex) => (
            <section className="technical-audit-group" key={group.id} aria-labelledby={`technical-audit-group-${group.id}`}>
              <h3 id={`technical-audit-group-${group.id}`}><span>{groupIndex + 1}</span>{technicalGroupKey[group.id] ? t(technicalGroupKey[group.id]) : group.name}</h3>
              <ul>
                {group.items.map((definition) => {
                  const item = items.get(definition.id)
                  const help = TECHNICAL_AUDIT_HELP[definition.id]
                  const infoId = technicalAuditInfoId(definition.id)
                  const display = locale === 'zh-CN'
                    ? technicalAuditItemDisplay(item, displayHasCompletedSnapshot, snapshotRuleVersion, definition.id, checking)
                    : technicalAuditItemDisplay(item, displayHasCompletedSnapshot, snapshotRuleVersion, definition.id, checking, locale)
                  const displayLabel = display.status === 'checking' ? t('technical.checking') : t(technicalStatusKey[display.status])
                  const itemName = technicalItemKey[definition.id] ? t(technicalItemKey[definition.id]) : definition.name
                  return (
                    <li className={`technical-audit-item technical-audit-item--${display.status}`} key={definition.id}>
                      <div className="technical-audit-item__row">
                        <div className="technical-audit-item__label">
                          <button
                            ref={activeInfo === definition.id ? infoButtonRef : undefined}
                            type="button"
                            className="technical-audit-panel__info-button technical-audit-item__info-button"
                            aria-label={locale === 'en' ? `View ${itemName} check details` : `查看${itemName}检查说明`}
                            title={locale === 'en' ? `View ${itemName} check details` : `查看${itemName}检查说明`}
                            aria-expanded={activeInfo === definition.id}
                            aria-controls={infoId}
                            onClick={() => setActiveInfo((current) => current === definition.id ? null : definition.id)}
                          >
                            <Info size={15} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                          <span className="technical-audit-item__name">{itemName}</span>
                        </div>
                        {display.showStatus === false ? null : <span className={`technical-audit-item__status technical-audit-item__status--${display.tone}`} data-status={display.status}>{displayLabel}</span>}
                      </div>
                      {activeInfo === definition.id ? (
                        <div ref={infoPanelRef} id={infoId} className="technical-audit-panel__info technical-audit-item__info" role="status">
                          <button
                            type="button"
                            className="technical-audit-panel__info-button technical-audit-panel__info-close"
                            aria-label={t('technical.closeInfo')}
                            onClick={closeInfo}
                          >
                            <X size={14} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                          <div>
                            <div className="technical-audit-panel__info-benefit-title">
                              <strong>{t('technical.benefit')}</strong>
                              <span
                                className="technical-audit-panel__benefit-level"
                                aria-label={t('technical.benefitAria', { level: technicalBenefitLevelKey[help.benefitLevel] ? t(technicalBenefitLevelKey[help.benefitLevel]) : help.benefitLevel })}
                                title={t('technical.benefitTitle')}
                              >
                                {technicalBenefitLevelKey[help.benefitLevel] ? t(technicalBenefitLevelKey[help.benefitLevel]) : help.benefitLevel}
                              </span>
                            </div>
                            <p>{technicalHelpText(definition.id, 'benefit', locale)}</p>
                          </div>
                          <div><strong>{t('technical.criteria')}</strong><p>{technicalHelpText(definition.id, 'criteria', locale)}</p></div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
