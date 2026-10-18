import { useI18n, type Locale, type MessageKey } from '../i18n'
import type { AnswerChange, AnswerChangeKind, CompareRunSummary, RunComparison } from '../run-compare'
import { Button, Modal } from './UI'

function formatDateTime(value: string | null, locale: Locale): string {
  // 与 App.tsx 的 formatDateTime 保持一致的展示口径，组件内自包含避免循环引用
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function formatRateDelta(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null) return null
  const delta = Math.round((current - previous) * 100)
  if (delta === 0) return null
  return `${delta > 0 ? '+' : ''}${delta}%`
}

function formatBool(value: boolean | null, t: (key: MessageKey) => string): string {
  if (value === null) return t('compare.valueUnknown')
  return value ? t('compare.valueYes') : t('compare.valueNo')
}

function RunLabel({ summary }: { summary: CompareRunSummary }) {
  const { t } = useI18n()
  return (
    <>{summary.runType === 'initial' ? t('compare.initialRun') : t('compare.roundLabel', { round: String(summary.roundNumber) })}</>
  )
}

function ChangeBadges({ change }: { change: AnswerChange }) {
  const { t } = useI18n()
  const labels: Record<AnswerChangeKind, string> = {
    recommended: t('compare.changeKind.recommended'),
    citation: t('compare.changeKind.citation'),
    citationUrls: t('compare.changeKind.citationUrls'),
  }
  return (
    <span className="run-compare__badges">
      {change.kinds.map((kind) => (
        <span key={kind} className={`run-compare__badge run-compare__badge--${kind}`}>{labels[kind]}</span>
      ))}
    </span>
  )
}

function ChangeDetail({ change }: { change: AnswerChange }) {
  const { t } = useI18n()
  return (
    <dl className="run-compare__detail">
      {change.kinds.includes('recommended') ? (
        <div className="run-compare__detail-row">
          <dt>{t('compare.changeKind.recommended')}</dt>
          <dd>
            <span className="run-compare__before">{formatBool(change.previous.recommended, t)}</span>
            <span className="run-compare__arrow" aria-hidden="true">→</span>
            <span className="run-compare__after">{formatBool(change.current.recommended, t)}</span>
          </dd>
        </div>
      ) : null}
      {change.kinds.includes('citation') ? (
        <div className="run-compare__detail-row">
          <dt>{t('compare.changeKind.citation')}</dt>
          <dd>
            <span className="run-compare__before">{formatBool(change.previous.officialCitation, t)}</span>
            <span className="run-compare__arrow" aria-hidden="true">→</span>
            <span className="run-compare__after">{formatBool(change.current.officialCitation, t)}</span>
          </dd>
        </div>
      ) : null}
      {change.kinds.includes('citationUrls') ? (
        <div className="run-compare__detail-row">
          <dt>{t('compare.changeKind.citationUrls')}</dt>
          <dd>
            {change.addedUrls.length > 0 ? (
              <div className="run-compare__urls">
                <span className="run-compare__urls-label">{t('compare.addedUrls')}</span>
                <ul>{change.addedUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul>
              </div>
            ) : null}
            {change.removedUrls.length > 0 ? (
              <div className="run-compare__urls">
                <span className="run-compare__urls-label">{t('compare.removedUrls')}</span>
                <ul>{change.removedUrls.map((url) => <li key={url}><span className="run-compare__removed-url">{url}</span></li>)}</ul>
              </div>
            ) : null}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

export function RunCompareModal({ comparison, onClose }: { comparison: RunComparison; onClose: () => void }) {
  const { t, locale } = useI18n()
  const { current, previous, changes, unchanged } = comparison
  const recommendationDelta = formatRateDelta(current.recommendationRate, previous.recommendationRate)
  const citationDelta = formatRateDelta(current.officialCitationRate, previous.officialCitationRate)

  return (
    <Modal
      title={t('compare.title')}
      onSubmit={(event) => event.preventDefault()}
      onClose={onClose}
      submitLabel=""
      footer={
        <div className="modal__footer">
          <Button type="button" variant="secondary" onClick={onClose}>{t('compare.close')}</Button>
        </div>
      }
      className="run-compare-modal"
      focusManagement
    >
      <div className="run-compare">
        <section aria-label={t('compare.overviewAria')}>
          <table className="run-compare__table">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">{t('compare.metric')}</span></th>
                <th scope="col">{t('compare.currentRound')}（<RunLabel summary={current} />）</th>
                <th scope="col">{t('compare.previousRound')}（<RunLabel summary={previous} />）</th>
                <th scope="col">{t('compare.change')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t('compare.model')}</th>
                <td>{current.model ?? '—'}</td>
                <td>{previous.model ?? '—'}</td>
                <td>{current.model !== previous.model ? t('compare.modelChanged') : t('compare.noChange')}</td>
              </tr>
              <tr>
                <th scope="row">{t('compare.completedAt')}</th>
                <td>{formatDateTime(current.completedAt, locale)}</td>
                <td>{formatDateTime(previous.completedAt, locale)}</td>
                <td aria-hidden="true">—</td>
              </tr>
              <tr>
                <th scope="row">{t('compare.recommendationRate')}</th>
                <td>{formatRate(current.recommendationRate)}</td>
                <td>{formatRate(previous.recommendationRate)}</td>
                <td>{recommendationDelta ?? t('compare.noChange')}</td>
              </tr>
              <tr>
                <th scope="row">{t('compare.citationRate')}</th>
                <td>{formatRate(current.officialCitationRate)}</td>
                <td>{formatRate(previous.officialCitationRate)}</td>
                <td>{citationDelta ?? t('compare.noChange')}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section aria-label={t('compare.changedHeading', { count: String(changes.length) })}>
          <h3 className="run-compare__heading">{t('compare.changedHeading', { count: String(changes.length) })}</h3>
          {changes.length === 0 ? (
            <p className="run-compare__empty">{t('compare.noQuestionChange')}</p>
          ) : (
            <ol className="run-compare__changes">
              {changes.map((change) => (
                <li key={change.position} className="run-compare__change">
                  <div className="run-compare__change-head">
                    <span className="run-compare__position">Q{change.position}</span>
                    <span className="run-compare__question">{change.question}</span>
                    <ChangeBadges change={change} />
                  </div>
                  <ChangeDetail change={change} />
                </li>
              ))}
            </ol>
          )}
        </section>

        <details className="run-compare__unchanged">
          <summary>{t('compare.unchangedHeading', { count: String(unchanged.length) })}</summary>
          {unchanged.length === 0 ? null : (
            <ol>
              {unchanged.map((item) => (
                <li key={item.position}><span className="run-compare__position">Q{item.position}</span> {item.question}</li>
              ))}
            </ol>
          )}
        </details>
      </div>
    </Modal>
  )
}
