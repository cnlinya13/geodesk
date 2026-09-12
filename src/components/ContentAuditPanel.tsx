import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Info, ScanText } from 'lucide-react'
import './ContentAuditPanel.css'
import { Button, Icon, IconButton, Modal, OperationFeedback, StatusBadge } from './UI'
import { apiErrorMessage, resolveUiMessage, translate, useI18n, type Locale, type UiMessage } from '../i18n'
import {
  contentAuditConclusionTone,
  contentAuditFailureSummary,
  contentAuditItems,
  safeContentAuditUrl,
  type ContentAuditEvidence,
  type ContentAuditIssue,
  type ContentAuditItem,
  type ContentAuditLocation,
  type ContentAuditRecord,
  type ContentAuditReview,
  type ContentAuditResult,
  type ContentAuditSource,
  type ContentAuditStatus,
} from '../content-audit'

export type ContentAuditPanelProps = {
  /**
   * A record supplied by the content-audit API. `null` means that the GET
   * request succeeded but no run exists yet; leaving this prop undefined keeps
   * the old view-only/unavailable fixture contract intact.
   */
  record?: ContentAuditRecord | null
  result?: ContentAuditResult | null
  status?: ContentAuditStatus
  loading?: boolean
  loadError?: UiMessage
  /** A persisted-task failure, kept separate from a status GET failure. */
  taskError?: UiMessage
  /** True while the background content-audit task is still running. */
  taskActive?: boolean
  onCheck?: () => void | Promise<void>
}

type EvidenceModalProps = {
  item: ContentAuditItem
  onClose: () => void
  internal?: boolean
  reviews?: readonly ContentAuditReview[]
}

const MAX_COLLAPSED_ITEMS = 3

function statusLabel(status: ContentAuditStatus, checkInFlight = false, locale: Locale = 'zh-CN'): string {
  if (status === 'checking' || checkInFlight) return translate(locale, 'content.checking')
  return translate(locale, 'content.check')
}

function conclusionLabel(conclusion: NonNullable<ContentAuditItem['conclusion']>, locale: Locale): string {
  if (conclusion === 'supported') return translate(locale, 'content.conclusion.supported')
  if (conclusion === 'conflict') return translate(locale, 'content.conclusion.conflict')
  return translate(locale, 'content.conclusion.insufficient')
}

function issueTypeLabel(type: ContentAuditIssue['type'], locale: Locale): string {
  if (type === 'conflict') return translate(locale, 'content.issue.conflict')
  if (type === 'incomplete') return translate(locale, 'content.issue.incomplete')
  return translate(locale, 'content.issue.risk')
}

function contentAuditProgressFeedback(progress: ContentAuditRecord['progress'] | undefined, locale: Locale = 'zh-CN'): string | null {
  if (!progress || typeof progress !== 'object') return null
  const hasCoverageCounters = progress.failedPages !== undefined
    || progress.pendingPages !== undefined
    || progress.baselineReady !== undefined
    || progress.baselineSource !== undefined
  if (!hasCoverageCounters) return null
  if (progress.baselineReady === false) return translate(locale, 'content.progress.baseline')

  const total = Number.isSafeInteger(progress.totalPages) && progress.totalPages >= 0 ? progress.totalPages : 0
  const read = Number.isSafeInteger(progress.processedPages) && progress.processedPages >= 0 ? Math.min(progress.processedPages, total) : 0
  const suppliedFailed = Number.isSafeInteger(progress.failedPages) && (progress.failedPages ?? 0) >= 0 ? Math.min(progress.failedPages ?? 0, total - read) : undefined
  const suppliedPending = Number.isSafeInteger(progress.pendingPages) && (progress.pendingPages ?? 0) >= 0 ? Math.min(progress.pendingPages ?? 0, total - read) : undefined
  const remaining = Math.max(0, total - read)
  const failed = suppliedFailed ?? Math.max(0, remaining - (suppliedPending ?? 0))
  // If old or partially upgraded data under-reports the partition, show a
  // balanced remainder as pending rather than an impossible total.
  const pending = Math.max(0, remaining - failed)
  const scope = progress.baselineSource === 'links' ? translate(locale, 'content.progressScope') : ''
  return translate(locale, 'content.progress', { read, total, failed, pending, scope })
}

function contentAuditProgressBar(progress: ContentAuditRecord['progress'] | undefined): { read: number; total: number } | null {
  if (!progress || progress.baselineReady === false) return null
  const total = Number.isSafeInteger(progress.totalPages) && progress.totalPages > 0 ? progress.totalPages : 0
  if (total === 0) return null
  const read = Number.isSafeInteger(progress.processedPages) && progress.processedPages >= 0
    ? Math.min(progress.processedPages, total)
    : 0
  return { read, total }
}

type ContentAuditFeedbackTone = 'neutral' | 'success' | 'warning' | 'error'

type ContentAuditFeedback = {
  text: string
  tone: ContentAuditFeedbackTone
  indeterminate?: boolean
}

function trimFeedbackPunctuation(value: string): string {
  return value.replace(/[。.!！?？]+$/u, '').trim()
}

/**
 * Error text can originate in a persisted record or an API exception. Keep
 * the action feedback short and safe without changing the underlying record.
 */
function safeFeedbackText(value: unknown, fallback = ''): string {
  const raw = typeof value === 'string' && value.trim() ? value : fallback
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[-_ ]?key|access[-_ ]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
}

function checkErrorFeedback(value: string, locale: Locale = 'zh-CN'): string {
  const fallback = translate(locale, 'content.failure')
  const message = safeFeedbackText(value, fallback)
  return message || fallback
}

function loadErrorFeedback(value: string, locale: Locale = 'zh-CN'): string {
  const fallback = translate(locale, 'content.readFailure', { detail: translate(locale, 'content.partial') })
  return safeFeedbackText(value, fallback) || fallback
}

function recordErrorFeedback(value: string, locale: Locale = 'zh-CN'): string {
  const detail = trimFeedbackPunctuation(safeFeedbackText(value, translate(locale, 'content.partial')))
  return translate(locale, 'content.checkFailure', { detail })
}

function executionErrorDetail(summary: string): string {
  return trimFeedbackPunctuation(summary)
}

function safeText(value: unknown, fallback = '未提供'): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

type ContentAuditTextRange = { start: number; end: number }

function exactTextRanges(text: string, needle: string): ContentAuditTextRange[] {
  if (!text || !needle) return []
  const ranges: ContentAuditTextRange[] = []
  let cursor = 0
  while (cursor <= text.length - needle.length) {
    const start = text.indexOf(needle, cursor)
    if (start < 0) break
    ranges.push({ start, end: start + needle.length })
    cursor = start + Math.max(needle.length, 1)
  }
  return ranges
}

function contentAuditTextRanges(text: string, needle: string): ContentAuditTextRange[] {
  const exact = exactTextRanges(text, needle)
  if (exact.length > 0) return exact
  const normalizedNeedle = needle.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return normalizedNeedle !== needle ? exactTextRanges(text, normalizedNeedle) : []
}

function HighlightedText({ text, needle, enabled }: { text: unknown; needle: unknown; enabled: boolean }) {
  const { t } = useI18n()
  const displayText = typeof text === 'string' && text.trim() ? text : t('common.notProvided')
  if (!enabled || typeof text !== 'string' || !text.trim() || typeof needle !== 'string' || !needle.trim()) return <>{displayText}</>
  const ranges = contentAuditTextRanges(text, needle)
  if (ranges.length === 0) return <>{displayText}</>
  const fragments: ReactNode[] = []
  let cursor = 0
  ranges.forEach((range, index) => {
    if (range.start > cursor) fragments.push(text.slice(cursor, range.start))
    fragments.push(<mark className="content-audit-evidence__highlight" key={`${range.start}-${range.end}-${index}`}>{text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  })
  if (cursor < text.length) fragments.push(text.slice(cursor))
  return <>{fragments}</>
}

function auditLocationList(item: ContentAuditItem, locale: Locale = 'zh-CN'): Array<{
  page: string
  pageUrl?: string | null
  location: string
  context: string
  statement: string
}> {
  if (Array.isArray(item.locations) && item.locations.length > 0) {
    return item.locations.map((location) => ({
      page: location.page,
      pageUrl: location.pageUrl,
      location: location.location,
      context: location.context,
      statement: location.statement,
    }))
  }
  return [{
    page: item.evidence.page || item.page,
    pageUrl: item.evidence.pageUrl,
    location: item.evidence.pageExcerpt?.location ?? translate(locale, 'common.notProvided'),
    context: item.evidence.pageExcerpt?.context ?? translate(locale, 'common.notProvided'),
    statement: item.evidence.statement || item.statement,
  }]
}

function sourceRelationLabel(relation: ContentAuditSource['relation'], locale: Locale = 'zh-CN'): string {
  if (relation === 'supports') return translate(locale, 'content.relation.supports')
  if (relation === 'contradicts') return translate(locale, 'content.relation.contradicts')
  if (relation === 'context') return translate(locale, 'content.relation.context')
  return translate(locale, 'content.relation.unknown')
}

export function contentAuditRunKey(record: ContentAuditRecord | null | undefined, result: ContentAuditResult | null | undefined): string {
  if (record !== undefined) return `record:${record?.startedAt ?? 'idle'}`
  const firstItemId = result && Array.isArray(result.items) ? result.items[0]?.id ?? 'empty' : 'empty'
  return `static:${result?.checkedAt ?? 'unmarked'}:${firstItemId}`
}

function evidenceSources(evidence: ContentAuditEvidence) {
  return Array.isArray(evidence.sources) ? evidence.sources : []
}

function evidenceComparisons(evidence: ContentAuditEvidence) {
  return Array.isArray(evidence.comparisons) ? evidence.comparisons : []
}

function evidenceSourceIssues(evidence: ContentAuditEvidence) {
  return Array.isArray(evidence.sourceIssues) ? evidence.sourceIssues : []
}

function itemIssues(item: ContentAuditItem): ContentAuditIssue[] {
  if (!Array.isArray(item.issues)) return []
  return item.issues.filter((issue): issue is ContentAuditIssue => Boolean(issue)
    && typeof issue === 'object'
    && (issue.type === 'conflict' || issue.type === 'incomplete' || issue.type === 'risk')
    && typeof issue.reason === 'string'
    && issue.reason.trim().length > 0
    && typeof issue.suggestion === 'string'
    && issue.suggestion.trim().length > 0)
}

function normalizedAuditIdentity(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : ''
}

function primaryAuditLocation(item: ContentAuditItem): ContentAuditLocation {
  return {
    page: item.evidence.page || item.page,
    pageUrl: item.evidence.pageUrl ?? '',
    statement: item.evidence.statement || item.statement,
    location: item.evidence.pageExcerpt?.location ?? '',
    context: item.evidence.pageExcerpt?.context ?? '',
  }
}

function auditLocationIdentity(location: Pick<ContentAuditLocation, 'pageUrl' | 'statement' | 'location'>): string {
  return [location.pageUrl, location.statement, location.location].map(normalizedAuditIdentity).join('\u001f')
}

function auditLocationSetIdentity(item: ContentAuditItem): string {
  const locations = [
    primaryAuditLocation(item),
    ...(Array.isArray(item.locations) ? item.locations : []),
    ...evidenceComparisons(item.evidence),
  ]
  return Array.from(new Set(locations.map((location) => auditLocationIdentity(location)))).sort().join('\u001e')
}

function auditConflictIdentity(item: ContentAuditItem, issue: ContentAuditIssue): string {
  return [
    auditLocationSetIdentity(item),
    normalizedAuditIdentity(issue.reason),
    normalizedAuditIdentity(issue.suggestion),
  ].join('\u001d')
}

function auditConflictIdentities(item: ContentAuditItem): string[] {
  return itemIssues(item)
    .filter((issue) => issue.type === 'conflict')
    .map((issue) => auditConflictIdentity(item, issue))
}

function isBidirectionalConflictPair(first: ContentAuditItem, second: ContentAuditItem): boolean {
  const firstPrimary = auditLocationIdentity(primaryAuditLocation(first))
  const secondPrimary = auditLocationIdentity(primaryAuditLocation(second))
  if (!firstPrimary || !secondPrimary || firstPrimary === secondPrimary) return false
  const firstComparisons = new Set(evidenceComparisons(first.evidence).map((location) => auditLocationIdentity(location)))
  const secondComparisons = new Set(evidenceComparisons(second.evidence).map((location) => auditLocationIdentity(location)))
  return firstComparisons.has(secondPrimary) && secondComparisons.has(firstPrimary)
}

function canMergeContentAuditItems(first: ContentAuditItem, second: ContentAuditItem): boolean {
  if (auditLocationSetIdentity(first) !== auditLocationSetIdentity(second)) return false
  if (!isBidirectionalConflictPair(first, second)) return false
  const firstConflicts = new Set(auditConflictIdentities(first))
  return auditConflictIdentities(second).some((identity) => firstConflicts.has(identity))
}

function uniqueAuditLocations(locations: readonly ContentAuditLocation[]): ContentAuditLocation[] {
  const seen = new Set<string>()
  return locations.filter((location) => {
    const identity = auditLocationIdentity(location)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function uniqueAuditIssues(issues: readonly ContentAuditIssue[]): ContentAuditIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const identity = [issue.type, normalizedAuditIdentity(issue.reason), normalizedAuditIdentity(issue.suggestion)].join('\u001f')
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function mergeContentAuditPair(first: ContentAuditItem, second: ContentAuditItem): ContentAuditItem {
  const firstMainLocations = [
    primaryAuditLocation(first),
    ...(Array.isArray(first.locations) ? first.locations : []),
  ]
  const firstMainLocationIdentities = new Set(firstMainLocations.map((location) => auditLocationIdentity(location)))
  const comparisons = uniqueAuditLocations([
    ...evidenceComparisons(first.evidence),
    primaryAuditLocation(second),
    ...(Array.isArray(second.locations) ? second.locations : []),
    ...evidenceComparisons(second.evidence),
  ]).filter((location) => !firstMainLocationIdentities.has(auditLocationIdentity(location)))
  const locations = Array.isArray(first.locations) ? uniqueAuditLocations(first.locations) : []
  return {
    ...first,
    section: first.section,
    risk: first.risk ?? second.risk,
    ...(first.review ?? second.review ? { review: first.review ?? second.review } : {}),
    issues: uniqueAuditIssues([...itemIssues(first), ...itemIssues(second)]),
    locations: locations.length > 0 ? locations : undefined,
    evidence: {
      ...first.evidence,
      comparisons,
    },
  }
}

export function mergeContentAuditItems(items: readonly ContentAuditItem[]): ContentAuditItem[] {
  const merged: ContentAuditItem[] = []
  const consumed = new Set<number>()
  items.forEach((item, index) => {
    if (consumed.has(index)) return
    let displayItem = item
    for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
      if (consumed.has(nextIndex)) continue
      const nextItem = items[nextIndex]
      if (!canMergeContentAuditItems(displayItem, nextItem)) continue
      displayItem = mergeContentAuditPair(displayItem, nextItem)
      consumed.add(nextIndex)
      break
    }
    merged.push(displayItem)
  })
  return merged
}

function issueTypeTone(type: ContentAuditIssue['type']): 'warning' | 'danger' {
  return type === 'conflict' ? 'danger' : 'warning'
}

function itemSection(item: ContentAuditItem, locale: Locale = 'zh-CN'): string {
  const section = (item as ContentAuditItem & { section?: unknown }).section
  return safeText(section, locale === 'en' ? 'Unlabeled' : '未标注')
}

function itemRisk(item: ContentAuditItem) {
  const risk = item.risk
  return risk && typeof risk.reason === 'string' && risk.reason.trim()
    ? risk
    : null
}

function reviewStatusLabel(status: ContentAuditReview['status'], locale: Locale = 'zh-CN'): string {
  if (status === 'passed') return translate(locale, 'content.review.passed')
  if (status === 'persists') return translate(locale, 'content.review.persists')
  return translate(locale, 'content.review.unverified')
}

function reviewStatusTone(status: ContentAuditReview['status']): 'success' | 'warning' | 'neutral' {
  if (status === 'passed') return 'success'
  if (status === 'persists') return 'warning'
  return 'neutral'
}

function reviewEntriesForItem(item: ContentAuditItem, reviews: readonly ContentAuditReview[]): ContentAuditReview[] {
  const entries: ContentAuditReview[] = []
  const seen = new Set<string>()
  const add = (review: ContentAuditReview | null | undefined) => {
    if (!review || typeof review.issueId !== 'string' || !review.issueId.trim() || seen.has(review.issueId)) return
    if (review.status !== 'passed' && review.status !== 'persists' && review.status !== 'unverified') return
    seen.add(review.issueId)
    entries.push(review)
  }
  add(item.review)
  reviews.filter((review) => review.issueId === item.id).forEach(add)
  return entries
}

function EvidenceLink({ value, label, fallbackLabel }: { value: unknown; label?: string; fallbackLabel?: string }) {
  const { t } = useI18n()
  const url = safeContentAuditUrl(value)
  if (!url) return <span>{label ?? fallbackLabel ?? t('common.notProvided')}</span>
  return <a href={url} target="_blank" rel="noopener noreferrer">{label ?? url}</a>
}

function safeContentAuditDiagnosticUrl(value: unknown): string | null {
  const safeUrl = safeContentAuditUrl(value)
  if (!safeUrl) return null
  try {
    const parsed = new URL(safeUrl)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function EvidenceField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="content-audit-evidence__field">
      <h3>{label}</h3>
      <div className="content-audit-evidence__value">{children}</div>
    </section>
  )
}

function ReviewDetails({ reviews }: { reviews: readonly ContentAuditReview[] }) {
  const { t, locale } = useI18n()
  const notProvided = t('common.notProvided')
  const displayText = (value: unknown, fallback = notProvided) => safeText(value, fallback)
  if (reviews.length === 0) return null
  return (
    <EvidenceField label={t('content.review')}>
      <div className="content-audit-evidence__reviews">
        {reviews.map((review) => {
          const evidence = review.evidence && typeof review.evidence === 'object' ? review.evidence : null
          const evidencePageUrl = safeContentAuditUrl(review.pageUrl ?? evidence?.pageUrl)
          const comparisonEvidence = evidence ? evidenceComparisons(evidence) : []
          const evidenceStatement = evidence?.statement ?? review.statement
          const evidenceContext = evidence?.pageExcerpt?.context
          return (
            <article className="content-audit-evidence__review" key={`${review.issueId}-${review.checkedAt ?? ''}`}>
              <div><StatusBadge tone={reviewStatusTone(review.status)}>{reviewStatusLabel(review.status, locale)}</StatusBadge></div>
              <div><strong>{t('content.statement')}：</strong>{displayText(review.statement)}</div>
              <div><strong>{t('content.reviewPage')}：</strong>{displayText(review.page)}{evidencePageUrl ? <span> · <EvidenceLink value={evidencePageUrl} label={t('content.openPage')} fallbackLabel={notProvided} /></span> : null}</div>
              {review.checkedAt ? <div><strong>{t('content.reviewAt')}：</strong>{displayText(review.checkedAt)}</div> : null}
              <div><strong>{t('content.reviewReason')}：</strong>{displayText(review.reason)}</div>
              <div><strong>{t('content.reviewAdvice')}：</strong>{displayText(review.suggestion)}</div>
              {evidence ? (
                <div className="content-audit-evidence__review-evidence">
                  <strong>{t('content.evidence')}：</strong>
                  {evidenceContext ? <div><span>{t('content.original')}：</span><HighlightedText text={evidenceContext} needle={evidenceStatement} enabled /></div> : <div>{displayText(evidenceStatement)}</div>}
                  {evidence.pageExcerpt?.location ? <div><span>{t('content.position')}：</span>{displayText(evidence.pageExcerpt.location)}</div> : null}
                  {comparisonEvidence.length > 0 ? <div><span>{t('content.comparisonEvidence')}：</span>{comparisonEvidence.map((comparison) => `${displayText(comparison.page)}：${displayText(comparison.statement)}`).join('；')}</div> : null}
                </div>
              ) : <div><strong>{t('content.evidence')}：</strong>{t('common.notProvided')}</div>}
            </article>
          )
        })}
      </div>
    </EvidenceField>
  )
}

export function ContentAuditEvidenceModal({ item, onClose, internal, reviews = [] }: EvidenceModalProps) {
  const { t, locale } = useI18n()
  const notProvided = t('common.notProvided')
  const displayText = (value: unknown, fallback = notProvided) => safeText(value, fallback)
  const evidence = item.evidence
  const sources = evidenceSources(evidence)
  const comparisons = evidenceComparisons(evidence)
  const sourceIssues = evidenceSourceIssues(evidence)
  const issues = itemIssues(item)
  const isInternal = internal ?? issues.length > 0
  const risk = itemRisk(item)
  const conclusion = item.conclusion ? conclusionLabel(item.conclusion, locale) : null
  const checkedAt = displayText(evidence.checkedAt)
  const pageUrl = safeContentAuditUrl(evidence.pageUrl)
  const locations = auditLocationList(item, locale)
  const primaryStatement = typeof evidence.statement === 'string' && evidence.statement.trim() ? evidence.statement : item.statement
  const reviewEntries = reviewEntriesForItem(item, reviews)

  return (
    <Modal
      title={isInternal ? t('content.detailsInternal') : t('content.detailsEvidence')}
      titleAccessory={isInternal
        ? issues.length > 0 ? <div className="content-audit-evidence-modal__issue-types">{issues.map((issue, index) => <StatusBadge key={`${issue.type}-${index}`} tone={issueTypeTone(issue.type)}>{issueTypeLabel(issue.type, locale)}</StatusBadge>)}</div> : undefined
        : conclusion ? <StatusBadge tone={contentAuditConclusionTone(item.conclusion!)}>{conclusion}</StatusBadge> : undefined}
      onSubmit={(event) => event.preventDefault()}
      onClose={onClose}
      submitLabel=""
      className="content-audit-evidence-modal"
      focusManagement
      closeOnBackdrop
      footer={(
        <div className="modal__footer content-audit-evidence-modal__footer">
          <Button type="button" variant="secondary" onClick={onClose}>{t('content.close')}</Button>
        </div>
      )}
    >
      <div className="content-audit-evidence__scroll">
        <p className="content-audit-evidence__statement"><HighlightedText text={primaryStatement} needle={primaryStatement} enabled={isInternal} /></p>
        <div className="content-audit-evidence__meta">
          <div className="content-audit-evidence__meta-item"><span>{t('content.page')}</span><strong>{displayText(evidence.page, item.page)}</strong></div>
          <div className="content-audit-evidence__meta-item"><span>{t('content.checkedAt')}</span><strong>{checkedAt}</strong></div>
          <div className="content-audit-evidence__meta-url"><span>URL</span>{pageUrl ? <EvidenceLink value={pageUrl} fallbackLabel={notProvided} /> : <strong>{notProvided}</strong>}</div>
        </div>
        <EvidenceField label={t('content.pageText')}>
          {evidence.pageExcerpt ? (
            <div className="content-audit-evidence__excerpt">
              <div><strong>{t('content.position')}：</strong>{displayText(evidence.pageExcerpt.location)}</div>
              <div><strong>{t('content.context')}：</strong><HighlightedText text={evidence.pageExcerpt.context} needle={primaryStatement} enabled={isInternal} /></div>
            </div>
          ) : <span>{t('common.notProvided')}</span>}
        </EvidenceField>
        {locations.length > 1 ? (
          <EvidenceField label={t('content.positions', { count: locations.length })}>
            <div className="content-audit-evidence__locations">
              {locations.map((location, index) => {
                const locationUrl = safeContentAuditUrl(location.pageUrl)
                return (
                  <article className="content-audit-evidence__location" key={`${location.pageUrl ?? ''}-${location.location}-${index}`}>
                    <div><strong>{displayText(location.page)}</strong>{locationUrl ? <span> · <EvidenceLink value={locationUrl} label={t('content.openPage')} fallbackLabel={notProvided} /></span> : null}</div>
                    <div><strong>{t('content.position')}：</strong>{displayText(location.location)}</div>
                    <div><strong>{t('content.context')}：</strong><HighlightedText text={location.context} needle={location.statement} enabled={isInternal} /></div>
                  </article>
                )
              })}
            </div>
          </EvidenceField>
        ) : null}
        {comparisons.length > 0 ? (
          <EvidenceField label={t('content.internalComparisons', { count: comparisons.length })}>
            <div className="content-audit-evidence__comparisons">
              {comparisons.map((comparison, index) => {
                const comparisonUrl = safeContentAuditUrl(comparison.pageUrl)
                return (
                  <article className="content-audit-evidence__comparison" key={`${comparison.pageUrl}-${comparison.location}-${index}`}>
                    <div><strong>{displayText(comparison.page)}</strong>{comparisonUrl ? <span> · <EvidenceLink value={comparisonUrl} label={t('content.openCollectedPage')} fallbackLabel={notProvided} /></span> : null}</div>
                    <div><strong>{t('content.originalSentence')}：</strong><HighlightedText text={comparison.statement} needle={comparison.statement} enabled={isInternal} /></div>
                    <div><strong>{t('content.position')}：</strong>{displayText(comparison.location)}</div>
                    <div><strong>{t('content.context')}：</strong><HighlightedText text={comparison.context} needle={comparison.statement} enabled={isInternal} /></div>
                  </article>
                )
              })}
            </div>
          </EvidenceField>
        ) : null}
        <ReviewDetails reviews={reviewEntries} />
        {isInternal ? (
          <EvidenceField label={t('content.questions')}>
            <div className="content-audit-evidence__issues">
              {issues.map((issue, index) => (
                <article className="content-audit-evidence__issue" key={`${issue.type}-${index}`}>
                  <div><StatusBadge tone={issueTypeTone(issue.type)}>{issueTypeLabel(issue.type, locale)}</StatusBadge></div>
                  <div><strong>{t('content.reason')}：</strong>{displayText(issue.reason)}</div>
                  <div><strong>{t('content.advice')}：</strong>{displayText(issue.suggestion)}</div>
                </article>
              ))}
            </div>
          </EvidenceField>
        ) : (
          <>
            <EvidenceField label={t('content.sources')}>
              {sources.length > 0 ? (
                <div className="content-audit-evidence__sources">
                  {sources.map((source, index) => (
                    <article className="content-audit-evidence__source" key={`${source.name}-${index}`}>
                      <strong>{displayText(source.name)}</strong>
                      <div>{t('content.origin')}：{displayText(source.origin)}</div>
                      <div>{t('content.version')}：{displayText(source.versionAt)}</div>
                      <div>{t('content.relation')}：{sourceRelationLabel(source.relation, locale)}</div>
                      <div>{t('content.authority')}：{displayText(source.authorityReason)}</div>
                      <div>{t('content.sourceUrl')}：{source.url ? <EvidenceLink value={source.url} fallbackLabel={notProvided} /> : <span>{notProvided}</span>}</div>
                      <div>{t('content.sourceText')}：{displayText(source.sourceText)}</div>
                    </article>
                  ))}
                </div>
              ) : <span>{t('common.notProvided')}</span>}
            </EvidenceField>
            {sourceIssues.length > 0 ? (
              <EvidenceField label={item.conclusion === 'insufficient' ? t('content.unverifiedReason') : t('content.sourceReading')}>
                <div className="content-audit-evidence__source-issues">
                  {sourceIssues.map((issue, index) => {
                    const issueUrl = safeContentAuditDiagnosticUrl(issue.sourceUrl)
                    return (
                      <article className="content-audit-evidence__source-issue" key={`${issue.stage}-${issue.sourceUrl ?? ''}-${index}`}>
                        <div><strong>{t('content.sourceReading')}：</strong>{displayText(issue.message, t('content.readingFailure'))}</div>
                        {issueUrl ? <div><strong>{t('content.sourceUrl')}：</strong><EvidenceLink value={issueUrl} fallbackLabel={notProvided} /></div> : null}
                        {typeof issue.attempts === 'number' ? <div><strong>{t('content.attempts')}：</strong>{issue.attempts}{locale === 'en' ? ' attempts' : ' 次'}</div> : null}
                        {issue.resolution ? <div><strong>{t('content.result')}：</strong>{displayText(issue.resolution)}</div> : null}
                      </article>
                    )
                  })}
                </div>
              </EvidenceField>
            ) : null}
            {risk ? (
              <EvidenceField label={t('content.risk')}>
                <div className="content-audit-evidence__risk">
                  <div><strong>{t('content.reason')}：</strong>{displayText(risk.reason)}</div>
                  <div><strong>{t('content.advice')}：</strong>{displayText(risk.suggestion)}</div>
                </div>
              </EvidenceField>
            ) : null}
          </>
        )}
        <EvidenceField label={t('content.judgment')}>{displayText(evidence.judgment)}</EvidenceField>
        <EvidenceField label={t('content.suggestion')}>{displayText(evidence.suggestion)}</EvidenceField>
      </div>
    </Modal>
  )
}

function AuditRow({ item, reviews, onOpen }: { item: ContentAuditItem; reviews: readonly ContentAuditReview[]; onOpen: (item: ContentAuditItem) => void }) {
  const { t, locale } = useI18n()
  const notProvided = t('common.notProvided')
  const displayText = (value: unknown, fallback = notProvided) => safeText(value, fallback)
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen(item)
  }
  const handleClick = (_event: MouseEvent<HTMLTableRowElement>) => onOpen(item)
  const risk = itemRisk(item)
  const issues = itemIssues(item)
  const reviewEntries = reviewEntriesForItem(item, reviews)
  return (
    <tr tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown} aria-label={t('content.viewDetails', { page: displayText(item.page) })}>
      <td className="content-audit-panel__statement-cell" title={item.page}>
        <span className="content-audit-panel__statement-line">
          <span className="content-audit-panel__statement">{displayText(item.page)}</span>
        </span>
      </td>
      <td title={itemSection(item)}>{itemSection(item)}</td>
      <td>
        <div className="content-audit-panel__conclusion-cell">
          {issues.length > 0 ? issues.map((issue, index) => <StatusBadge key={`${issue.type}-${index}`} tone={issueTypeTone(issue.type)}>{issueTypeLabel(issue.type, locale)}</StatusBadge>) : item.conclusion ? <StatusBadge tone={contentAuditConclusionTone(item.conclusion)}>{conclusionLabel(item.conclusion, locale)}</StatusBadge> : null}
          {issues.length === 0 && risk ? (
            <div className="content-audit-panel__risk" title={risk.reason}>
              <StatusBadge tone="warning">{t('content.expressionRisk')}</StatusBadge>
              <span className="content-audit-panel__risk-reason">{displayText(risk.reason)}</span>
            </div>
          ) : null}
          {reviewEntries.map((review) => <StatusBadge key={`review-${review.issueId}`} tone={reviewStatusTone(review.status)}>{reviewStatusLabel(review.status, locale)}</StatusBadge>)}
        </div>
      </td>
    </tr>
  )
}

function InfoPopover({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  return (
    <div className="content-audit-panel__info" id="content-audit-info" role="note">
      <IconButton className="content-audit-panel__info-close" label={t('content.closeInfo')} onClick={onClose}><Icon name="x" size={14} /></IconButton>
      <p>{t('content.infoText')}</p>
    </div>
  )
}

function ExcludedPages({ pages }: { pages: ContentAuditResult['excludedPages'] }) {
  const { t } = useI18n()
  const notProvided = t('common.notProvided')
  const displayText = (value: unknown, fallback = notProvided) => safeText(value, fallback)
  if (!Array.isArray(pages) || pages.length === 0) return null
  return (
    <details className="content-audit-panel__excluded-pages">
      <summary>{t('content.excluded', { count: pages.length })}</summary>
      <ul>
        {pages.map((page, index) => {
          const url = safeContentAuditUrl(page.url)
          return (
            <li key={`${page.url}-${index}`}>
              {url ? <EvidenceLink value={url} label={url} fallbackLabel={notProvided} /> : <span>{displayText(page.url)}</span>}
              <span>：{displayText(page.reason)}</span>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

export function ContentAuditPanel({ record, result = null, status: statusProp, loading = false, loadError = '', taskError = '', taskActive = false, onCheck }: ContentAuditPanelProps) {
  const { t, locale } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [selectedItemRunKey, setSelectedItemRunKey] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [checkInFlight, setCheckInFlight] = useState(false)
  const [checkError, setCheckError] = useState<UiMessage>('')
  const infoButtonRef = useRef<HTMLButtonElement | null>(null)
  // `record === null` is a meaningful API response (no run yet). Keeping the
  // distinction from an omitted prop preserves the old static/unavailable
  // panel fixtures while letting the live workspace map a missing record to
  // the idle state.
  const loadErrorText = resolveUiMessage(loadError, locale)
  const taskErrorText = resolveUiMessage(taskError, locale)
  const status: ContentAuditStatus = record !== undefined
    ? record === null
      ? loadErrorText ? 'unavailable' : 'idle'
      : record.status
    : statusProp ?? 'unavailable'
  const effectiveResult = record !== undefined ? record?.result ?? null : result
  const previousResult = record && !effectiveResult && (status === 'checking' || status === 'failed')
    ? record.previousResult ?? null
    : null
  const showingPreviousResult = Boolean(previousResult)
  const displayedResult = effectiveResult ?? previousResult
  const internalResult = displayedResult?.scope === 'website_internal'
  const legacyResult = Boolean(displayedResult && !internalResult)
  const items = internalResult ? mergeContentAuditItems(contentAuditItems(displayedResult)) : []
  const reviews = internalResult && Array.isArray(displayedResult?.reviews) ? displayedResult.reviews : []
  const runKey = contentAuditRunKey(record, result)
  const selectedItem = selectedItemId && selectedItemRunKey === runKey ? items.find((item) => item.id === selectedItemId) ?? null : null
  const loadingState = loading
  const runningState = taskActive || checkInFlight || status === 'checking'
  const unavailableState = status === 'unavailable'
  const canCheck = Boolean(onCheck) && !loadingState && !unavailableState && !runningState
  const visibleItems = expanded ? items : items.slice(0, MAX_COLLAPSED_ITEMS)
  const hasToggle = items.length > MAX_COLLAPSED_ITEMS
  const recordError = record?.error?.trim() ?? ''
  const executionErrors = record && Array.isArray(record.executionErrors) ? record.executionErrors : []
  // Only a checking record represents this run's progress. A background task
  // can briefly coexist with an older completed record; never reuse that old
  // 100% snapshot as the current run's progress display.
  const progressFeedback = record?.status === 'checking' ? contentAuditProgressFeedback(record.progress, locale) : null
  const progressBarState = record?.status === 'checking' ? contentAuditProgressBar(record.progress) : null
  const runningFeedbackText = progressFeedback ?? t('content.running')

  useEffect(() => {
    setExpanded(false)
    setSelectedItemId(null)
    setSelectedItemRunKey(null)
    setCheckInFlight(false)
    setCheckError('')
  }, [runKey])

  useEffect(() => {
    if (!infoOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (infoButtonRef.current?.contains(target)) return
      const panel = document.getElementById('content-audit-info')
      if (panel?.contains(target)) return
      setInfoOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setInfoOpen(false)
      window.setTimeout(() => infoButtonRef.current?.focus(), 0)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [infoOpen])

  const handleCheck = () => {
    if (!onCheck || !canCheck) return
    setCheckError('')
    try {
      const check = onCheck()
      if (!check || typeof check.then !== 'function') return
      setCheckInFlight(true)
      void check
        .catch((cause: unknown) => {
          setCheckError(apiErrorMessage(cause, 'error.server.content_audit_failed'))
        })
        .finally(() => setCheckInFlight(false))
    } catch (cause) {
      setCheckError(apiErrorMessage(cause, 'error.server.content_audit_failed'))
      setCheckInFlight(false)
    }
  }

  const executionFailureMessage = executionErrors.length > 0
    ? contentAuditFailureSummary(executionErrors)
    : ''
  const persistedFailureMessage = executionFailureMessage || (recordError ? recordErrorFeedback(recordError, locale) : '')
  const checkErrorText = resolveUiMessage(checkError, locale)
  const checkFailureMessage = checkErrorText ? checkErrorFeedback(checkErrorText, locale) : ''
  const taskFailureMessage = taskErrorText ? checkErrorFeedback(taskErrorText, locale) : ''
  const executionDetail = executionFailureMessage ? executionErrorDetail(executionFailureMessage) : ''
  const terminalFailureMessage = checkFailureMessage || persistedFailureMessage || taskFailureMessage || t('content.failure')
  const terminalFailureState = !legacyResult && !checkInFlight && (
    status === 'failed'
      || (Boolean(taskFailureMessage) && status !== 'checking' && status !== 'completed')
  )
  const headerFeedback: ContentAuditFeedback[] = []
  const addHeaderFeedback = (text: string, tone: ContentAuditFeedbackTone, indeterminate = false) => {
    const normalized = text.trim()
    if (!normalized || headerFeedback.some((feedback) => feedback.text === normalized)) return
    headerFeedback.push({ text: normalized, tone, ...(indeterminate ? { indeterminate: true } : {}) })
  }

  // Loading and polling failures are independent from the record state. Keep
  // both messages when they overlap so a status update cannot hide a read
  // failure from the operator.
  if (loadErrorText) addHeaderFeedback(loadErrorFeedback(loadErrorText, locale), 'error')
  if (loadingState && !runningState) addHeaderFeedback(t('content.statusRead'), 'neutral')
  if (checkFailureMessage && !terminalFailureState) addHeaderFeedback(checkFailureMessage, 'error')

  if (!legacyResult) {
    if (status === 'failed' && !checkInFlight) {
      addHeaderFeedback(terminalFailureMessage, 'error')
    } else if (executionFailureMessage && status === 'checking') {
      addHeaderFeedback(t('content.executionIssue', { detail: executionDetail || t('content.partial') }), 'warning')
    } else if (taskFailureMessage && status !== 'checking' && status !== 'completed' && !checkInFlight) {
      // A failed background task may briefly have no persisted record. Keep
      // its execution failure visible, but never let an old task error leak
      // into a newer checking or completed run.
      addHeaderFeedback(terminalFailureMessage, 'error')
    }
  }

  if (status === 'completed' && !loadingState && !runningState && !checkFailureMessage && !legacyResult) {
      addHeaderFeedback(
      internalResult
        ? items.length > 0
          ? t('content.completedCount', { count: items.length })
          : t('content.completedEmpty')
        : t('content.completed'),
      executionFailureMessage ? 'warning' : 'success',
    )
    if (executionFailureMessage) {
      addHeaderFeedback(t('content.partialFailure', { detail: executionDetail || t('content.partial') }), 'warning')
    }
  }

  const firstRunEmpty = items.length === 0
    && displayedResult === null
    && !showingPreviousResult
    && ((status === 'idle'
      && !loadingState
      && !checkInFlight
      && !loadErrorText
      && !checkFailureMessage)
      || status === 'checking'
      || status === 'failed')
  const tableEmptyMessage = firstRunEmpty
    ? t('content.empty')
    : items.length === 0 && (status === 'unavailable' || legacyResult)
      ? t('content.emptyUnavailable')
      : null

  return (
    <section className="content-audit-panel" aria-label={t('content.title')} aria-busy={loadingState || runningState}>
      <header className="content-audit-panel__header">
        <div className="content-audit-panel__title">
          <span className="content-audit-panel__ai-badge" aria-hidden="true">AI</span>
          <h2>{t('content.title')}</h2>
          <span className="content-audit-panel__info-trigger">
            <button
              ref={infoButtonRef}
              type="button"
              className="content-audit-panel__info-button"
              aria-label={t('content.info')}
              aria-controls="content-audit-info"
              aria-expanded={infoOpen}
              onClick={() => setInfoOpen((current) => !current)}
            ><Info size={15} strokeWidth={1.8} /></button>
            {infoOpen ? <InfoPopover onClose={() => { setInfoOpen(false); infoButtonRef.current?.focus() }} /> : null}
          </span>
        </div>
        <div
          className="content-audit-panel__header-status"
          aria-hidden={headerFeedback.length > 0 || runningState ? undefined : 'true'}
        >{runningState ? (
          <OperationFeedback tone="neutral" className="content-audit-panel__checking-feedback content-audit-panel__progress-feedback">
            <div className="content-audit-panel__progress-content">
              <span className="content-audit-panel__progress-text">{runningFeedbackText}</span>
              <span
                className="content-audit-panel__progress-bar"
                role="progressbar"
                aria-label={t('content.statusProgress')}
                aria-valuemin={0}
                {...(progressBarState ? { 'aria-valuemax': progressBarState.total, 'aria-valuenow': progressBarState.read } : {})}
              >
                <span
                  className={`content-audit-panel__progress-bar-fill${progressBarState ? '' : ' content-audit-panel__progress-bar-fill--indeterminate'}`}
                  {...(progressBarState ? { style: { width: `${Math.round((progressBarState.read / progressBarState.total) * 100)}%` } } : {})}
                />
              </span>
            </div>
          </OperationFeedback>
        ) : null}{headerFeedback.map((feedback) => feedback.indeterminate ? (
          <OperationFeedback key={`${feedback.tone}-${feedback.text}`} tone={feedback.tone} className="content-audit-panel__checking-feedback">
            <span>{feedback.text}</span>
          </OperationFeedback>
        ) : (
          <OperationFeedback key={`${feedback.tone}-${feedback.text}`} tone={feedback.tone}>{feedback.text}</OperationFeedback>
        ))}</div>
        <Button className="content-audit-panel__check" icon={<ScanText size={16} strokeWidth={1.8} />} disabled={!canCheck} onClick={handleCheck}>{runningState ? statusLabel(status, true, locale) : loadingState ? t('content.loading') : locale === 'zh-CN' ? statusLabel(status, false) : statusLabel(status, false, locale)}</Button>
      </header>
      <div className={`content-audit-panel__card${items.length > MAX_COLLAPSED_ITEMS ? ' content-audit-panel__card--has-toggle' : ''}`}>
        <div id="content-audit-results" className={`content-audit-panel__table-scroll${expanded ? ' content-audit-panel__table-scroll--expanded' : ''}`}>
          <table className="content-audit-panel__table">
            <colgroup><col /><col className="content-audit-panel__page-col" /><col className="content-audit-panel__conclusion-col" /></colgroup>
            <thead><tr><th>{t('content.articleTitle')}</th><th>{t('content.section')}</th><th>{t('content.issueType')}</th></tr></thead>
            <tbody>{visibleItems.map((item) => <AuditRow key={item.id} item={item} reviews={reviews} onOpen={(nextItem) => { setSelectedItemId(nextItem.id); setSelectedItemRunKey(runKey) }} />)}</tbody>
          </table>
          {tableEmptyMessage ? <div className="content-audit-panel__empty" role="status">{tableEmptyMessage}</div> : null}
        </div>
        {internalResult ? <ExcludedPages pages={displayedResult?.excludedPages} /> : null}
        {hasToggle ? (
          <button
            type="button"
            className="content-audit-panel__toggle"
            aria-label={expanded ? t('content.collapse') : t('content.expand')}
            aria-controls="content-audit-results"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >{expanded ? <ChevronUp size={11} strokeWidth={1.8} /> : <ChevronDown size={11} strokeWidth={1.8} />}</button>
        ) : null}
      </div>
      {selectedItem ? <ContentAuditEvidenceModal item={selectedItem} internal={internalResult} reviews={reviews} onClose={() => { setSelectedItemId(null); setSelectedItemRunKey(null) }} /> : null}
    </section>
  )
}
