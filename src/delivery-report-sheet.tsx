import { forwardRef } from 'react'
import type { DiagnosisAnswer, MonitoringRun, ProjectDetail } from './types'
import { QUESTION_TOTAL } from './business-rules'
import { translate, useI18n, type Locale } from './i18n'

export type DeliveryReportSheetProps = {
  project: ProjectDetail
  run: MonitoringRun
}

function reportDate(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(date).replaceAll('/', '-')
}

function reportDateTime(value: string | null, locale: Locale = 'zh-CN'): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(date).replaceAll('/', '-').replace(',', '')
}

function rateCount(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * QUESTION_TOTAL)
}

function rateLabel(value: number | null, unavailable = false, locale: Locale = 'zh-CN'): string {
  if (unavailable) return translate(locale, 'delivery.unavailable')
  const count = rateCount(value)
  return count === null ? '—' : `${count} / ${QUESTION_TOTAL}`
}

function rateChange(current: number | null, initial: number | null, unavailable = false, locale: Locale = 'zh-CN'): string {
  if (unavailable) return translate(locale, 'delivery.unavailable')
  const currentCount = rateCount(current)
  const initialCount = rateCount(initial)
  if (currentCount === null || initialCount === null) return '—'
  const delta = currentCount - initialCount
  if (delta === 0) return translate(locale, 'delivery.noChange')
  return `${delta > 0 ? '+' : ''}${delta} / ${QUESTION_TOTAL}`
}

function answerResult(value: boolean | null, unavailable = false, locale: Locale = 'zh-CN'): string {
  if (unavailable) return translate(locale, 'delivery.unavailable')
  if (value === true) return translate(locale, 'delivery.answerYes')
  if (value === false) return translate(locale, 'delivery.answerNo')
  return translate(locale, 'delivery.answerPending')
}

function answerClass(value: boolean | null, unavailable = false): string {
  return unavailable || value !== true
    ? 'delivery-report-question__result'
    : 'delivery-report-question__result delivery-report-question__result--yes'
}

function answerForPosition(project: ProjectDetail, run: MonitoringRun, position: number, locale: Locale = 'zh-CN'): DiagnosisAnswer {
  const fromRun = run.answers.find((answer) => answer.position === position)
  if (fromRun) return fromRun
  const question = project.questions.find((item) => item.position === position)?.question ?? translate(locale, 'common.question', { position })
  return {
    position,
    question,
    status: 'pending',
    answerText: null,
    citationUrls: [],
    responseModel: null,
    recommended: null,
    officialCitation: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

/**
 * A deliberately independent A4 source sheet for the current monitoring run.
 * It contains observed results only; it does not ask a model to write a summary
 * or infer that a change caused a metric movement.
 */
export const DeliveryReportSheet = forwardRef<HTMLElement, DeliveryReportSheetProps>(function DeliveryReportSheet({ project, run }, ref) {
  const { t, locale } = useI18n()
  const initialRun = project.initialDiagnosis?.run ?? null
  const websiteUnavailable = !project.websiteUrl
  const initialRecommendation = initialRun?.recommendationRate ?? project.initialRecommendationRate
  const initialCitation = initialRun?.officialCitationRate ?? project.initialOfficialCitationRate
  const answers = Array.from({ length: QUESTION_TOTAL }, (_, index) => answerForPosition(project, run, index + 1, locale))

  return (
    <section ref={ref} className="delivery-report-sheet" aria-label={t('delivery.aria')}>
      <header className="delivery-report-sheet__header">
        <div>
          <h1>{t('delivery.title')}</h1>
          <p className="delivery-report-sheet__company">{project.companyName}</p>
        </div>
        <div className="delivery-report-sheet__brand">{t('delivery.brand')}</div>
      </header>

      <section className="delivery-report-meta-grid">
        <div><span>{t('delivery.time')}</span><strong>{reportDateTime(run.completedAt ?? run.startedAt, locale)}</strong></div>
        <div><span>{t('delivery.roundLabel')}</span><strong>{t('delivery.round', { round: run.roundNumber })}</strong></div>
        <div><span>{t('delivery.target')}</span><strong>{project.optimizationTarget || t('common.companyOverall')}</strong></div>
        <div><span>{t('delivery.website')}</span><strong>{project.websiteUrl || t('common.notConfigured')}</strong></div>
        <div><span>{t('delivery.publishedAtStart')}</span><strong>{run.publishedArticleCount == null ? t('delivery.notRecorded') : t('delivery.articleCount', { count: run.publishedArticleCount })}</strong></div>
      </section>

      <section className="delivery-report-rates" aria-label={t('delivery.ratesAria')}>
        <div>
          <span>{t('delivery.recommendationRate')}</span>
          <strong>{rateLabel(run.recommendationRate, false, locale)}</strong>
          <small>{t('delivery.initial', { value: rateLabel(initialRecommendation, false, locale) })} · {t('delivery.current', { value: rateLabel(run.recommendationRate, false, locale) })} · {t('delivery.change', { value: rateChange(run.recommendationRate, initialRecommendation, false, locale) })}</small>
        </div>
        <div>
          <span>{t('delivery.citationRate')}</span>
          <strong>{rateLabel(run.officialCitationRate, websiteUnavailable, locale)}</strong>
          <small>{t('delivery.initial', { value: rateLabel(initialCitation, websiteUnavailable, locale) })} · {t('delivery.current', { value: rateLabel(run.officialCitationRate, websiteUnavailable, locale) })} · {t('delivery.change', { value: rateChange(run.officialCitationRate, initialCitation, websiteUnavailable, locale) })}</small>
        </div>
      </section>

      <section className="delivery-report-questions">
        <div className="delivery-report-questions__heading">
          <h2>{t('delivery.questionsHeading', { count: QUESTION_TOTAL })}</h2>
          <span>{t('delivery.questionsNote')}</span>
        </div>
        <ol>
          <li className="delivery-report-question delivery-report-question--header" aria-hidden="true"><span>{t('delivery.question')}</span><span>{t('delivery.recommendation')}</span><span>{t('delivery.citation')}</span></li>
          {answers.map((answer) => (
            <li className="delivery-report-question" key={answer.position}>
              <span className="delivery-report-question__text">Q{String(answer.position).padStart(2, '0')}　{answer.question}</span>
              <span className={answerClass(answer.recommended)}>{answerResult(answer.recommended, false, locale)}</span>
              <span className={answerClass(answer.officialCitation, websiteUnavailable)}>{answerResult(answer.officialCitation, websiteUnavailable, locale)}</span>
            </li>
          ))}
        </ol>
      </section>

      <footer className="delivery-report-sheet__footer">
        <span>{t('delivery.footerCausality')}</span>
        <span>{t('delivery.date', { date: reportDate(run.completedAt ?? run.startedAt, locale) })}</span>
      </footer>
    </section>
  )
})
