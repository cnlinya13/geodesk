/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(fileURLToPath(new URL('./App.css', import.meta.url)), 'utf8')
const contentAuditCss = readFileSync(fileURLToPath(new URL('./components/ContentAuditPanel.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const start = appCss.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS rule not found: ${selector}`)
  const end = appCss.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  return appCss.slice(start, end)
}

function lastRule(selector: string): string {
  const start = appCss.lastIndexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS rule not found: ${selector}`)
  const end = appCss.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  return appCss.slice(start, end)
}

function expectDeclarations(selector: string, declarations: string[]) {
  const block = rule(selector)
  for (const declaration of declarations) expect(block).toContain(declaration)
}

function expectSourceDeclarations(source: string, selector: string, declarations: string[]) {
  const start = source.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS rule not found: ${selector}`)
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  const block = source.slice(start, end)
  for (const declaration of declarations) expect(block).toContain(declaration)
}

describe('business list style consistency', () => {
  it('uses the same compact table row and cell spacing', () => {
    for (const selector of ['.projects-table td', '.articles-table td']) {
      expectDeclarations(selector, ['height: 64px;', 'padding: 0 16px;'])
    }

    expectDeclarations('.projects-table', ['font-size: 13px;'])
    expectDeclarations('.projects-table td:nth-child(2),\n.projects-table td:nth-child(5)', ['color: var(--muted);', 'font-size: 12px;'])
    expectDeclarations('.articles-table td:not(:first-child)', ['font-size: 12px;'])
    expectDeclarations('.articles-table__updated-cell', ['font-size: 12px;'])
  })

  it('keeps diagnosis page height within its viewport and contains answer-list overscroll', () => {
    expectDeclarations('.diagnosis-stage', [
      'height: calc(100vh - 202px);',
      'min-height: calc(100vh - 202px);',
    ])
    expectDeclarations('.answer-explorer--diagnosis .diagnosis-answer-list,\n.answer-explorer--diagnosis .diagnosis-answer-detail__scroll,\n.answer-explorer--monitoring .diagnosis-answer-list,\n.answer-explorer--monitoring .diagnosis-answer-detail__scroll,\n.monitoring-stage .monitoring-history-list', ['overscroll-behavior-y: contain;'])
    expectDeclarations('.diagnosis-answer-list', ['overflow-y: auto;'])
    expectDeclarations('.diagnosis-answer-detail__scroll', ['overflow-y: auto;'])
    expect(lastRule('.scope-stage')).toContain('min-height: calc(100vh - 202px);')
    expectDeclarations('.scope-layout', ['min-height: calc(100vh - 202px);'])
    expect(lastRule('.monitoring-stage')).toContain('height: calc(100vh - 202px);')
    expect(lastRule('.monitoring-stage')).toContain('min-height: 0;')
    expect(lastRule('.monitoring-history-list')).toContain('overflow-y: auto;')
  })

  it('keeps stage spacing and natural-growth contracts aligned with the compact viewport', () => {
    expectDeclarations('.workspace-stage-viewport', ['padding: 24px 44px 34px;'])
    expectDeclarations('.optimization-stage', [
      'min-height: calc(100vh - 202px);',
      'height: calc(100vh - 202px);',
    ])
    expectDeclarations('.optimization-stage:not(:has(.website-setup-card))', ['height: auto;'])
    expectDeclarations('.scope-stage', ['min-height: calc(100vh - 202px);'])
    expectDeclarations('.scope-layout', ['min-height: calc(100vh - 202px);'])
  })

  it('uses a 40px minimum for question headers without clipping wrapped content', () => {
    for (const selector of ['.question-card__header', '.diagnosis-qa-card__header']) {
      const block = rule(selector)
      expect(block).toContain('min-height: 40px;')
      expect(block).not.toMatch(/(?:^|\n)\s*height:/)
    }
  })

  it('bottom-aligns every operation row and action group while preserving centered feedback', () => {
    for (const selector of [
      '.operation-bar',
      '.question-card__header',
      '.diagnosis-qa-card__header',
      '.monitoring-operation-bar',
      '.article-action-bar',
      '.report-page__actions',
    ]) expectDeclarations(selector, ['align-items: end;'])

    for (const selector of [
      '.operation-bar__left,\n.operation-bar__center,\n.operation-bar__right',
      '.question-card__heading',
      '.question-card__tools',
      '.diagnosis-qa-card__actions',
      '.monitoring-operation-actions',
      '.list-toolbar__actions',
      '.report-page__action-buttons',
      '.technical-audit-panel__header',
      '.technical-audit-panel__title',
    ]) expectDeclarations(selector, ['align-items: flex-end;'])

    expectDeclarations('.modal__footer', ['align-items: center;'])
    expectDeclarations('.project-form-modal__footer', ['align-items: center;'])
    expectDeclarations('.project-form-modal__footer-actions', ['align-items: center;'])
    expectDeclarations('.project-form-modal__feedback', ['align-items: center;'])
    expectDeclarations('.preview-modal .modal__footer', ['align-items: center;'])
    expectDeclarations('.preview-modal__delete-group,\n.preview-modal__footer-actions', ['align-items: center;'])
    expectDeclarations('.preview-modal__feedback', ['align-items: center;'])
    expectDeclarations('.operation-feedback', ['align-items: center;', 'justify-content: flex-end;'])
    expectSourceDeclarations(contentAuditCss, '.content-audit-panel__header', ['align-items: end;'])
    expectSourceDeclarations(contentAuditCss, '.content-audit-panel__title', ['align-items: flex-end;'])
    expectSourceDeclarations(contentAuditCss, '.content-audit-panel__header-status', [
      'min-height: 40px;',
      'align-items: center;',
      'justify-content: flex-end;',
    ])
    expectSourceDeclarations(contentAuditCss, '.content-audit-panel__check', ['align-self: flex-end;'])
  })

  it('uses the shared 16px content gaps and 18px section titles', () => {
    expectDeclarations('.monitoring-main', ['gap: 16px;'])
    expectDeclarations('.optimization-article-list', ['gap: 16px;'])
    expectDeclarations('.technical-audit-panel__card', ['margin-top: 16px;'])
    expectDeclarations('.technical-audit-panel__header h2,\n.article-action-bar__title', [
      'font-size: 18px;',
      'line-height: 26px;',
    ])
  })

  it('aligns the diagnosis answer table header with the two-column explorer', () => {
    expectDeclarations('.diagnosis-layout,\n.diagnosis-answer-table-header', ['grid-template-columns: 380px minmax(0, 1fr);'])
    const header = lastRule('.diagnosis-answer-table-header')
    for (const declaration of [
      'height: 52px;',
      'min-height: 52px;',
      'flex: 0 0 52px;',
      'background: var(--surface-subtle);',
      'border-bottom: 1px solid var(--line);',
    ]) expect(header).toContain(declaration)
    expectDeclarations('.diagnosis-answer-table-header > span', [
      'height: 100%;',
      'padding: 0 16px;',
      'color: var(--muted);',
      'font-size: 13px;',
      'font-weight: normal;',
      'text-align: left;',
    ])
    expectDeclarations('.diagnosis-answer-table-header > span:first-child', ['border-right: 1px solid var(--line-strong);'])
  })

  it('matches business table card and header dimensions for the monitoring scope list', () => {
    expectDeclarations('.question-card', [
      'gap: 0;',
      'padding: 0;',
      'border-radius: var(--radius-md);',
    ])
    expectDeclarations('.question-card > .inline-notice,\n.question-card > .scope-warning', ['margin: 16px;'])
    const questionHeader = lastRule('.question-list__header')
    for (const declaration of [
      'height: 52px;',
      'min-height: 52px;',
      'flex: 0 0 52px;',
      'padding: 0 16px;',
      'color: var(--muted);',
      'background: var(--surface-subtle);',
      'border-bottom: 1px solid var(--line);',
      'font-size: 13px;',
      'font-weight: normal;',
    ]) expect(questionHeader).toContain(declaration)
  })

  it('keeps the read-only scope list neutral and separated without a fake selection', () => {
    expectDeclarations('.question-list', ['gap: 0;', 'align-content: start;'])
    expectDeclarations('.question-list li', [
      'min-height: 64px;',
      'padding: 0 16px;',
      'color: var(--ink);',
      'background: var(--surface);',
      'border-bottom: 1px solid var(--line);',
      'border-radius: 0;',
      'font-size: 13px;',
    ])
    expectDeclarations('.question-list li:last-child', ['border-bottom: 0;'])
    expectDeclarations('.question-list .question-index', ['color: var(--muted);'])
    expect(appCss).not.toMatch(/\.question-list li:first-child/)
    expectDeclarations('.question-list li:hover', ['background: var(--list-hover);'])
    expect(rule('.question-list li')).not.toMatch(/(?:^|\n)\s*cursor:/)
    expectDeclarations('.question-list__category', ['color: var(--muted);', 'font-size: 12px;'])
  })

  it('uses one 64px double-line row for diagnosis, monitoring, and history selectors', () => {
    for (const selector of ['.diagnosis-answer-list__item', '.monitoring-history-list__item']) {
      expectDeclarations(selector, [
        'height: 64px;',
        'min-height: 64px;',
        'padding: 8px 16px;',
      ])
    }

    expect(appCss).not.toMatch(/\.monitoring-answer-explorer \.diagnosis-answer-list__item\s*\{/)
    expectDeclarations('.diagnosis-answer-list__item--active:hover', ['background: var(--blue-soft);'])
    expectDeclarations('.monitoring-history-list__item--active:hover', ['background: var(--blue-soft);'])
  })

  it('keeps technical audit rows readable, compact, and naturally expandable for explanations', () => {
    expectDeclarations('.technical-audit-panel__info', [
      'position: absolute;',
      'width: min(280px, 100%);',
      'padding: 10px 36px 10px 12px;',
      'font-size: 11px;',
    ])
    expectDeclarations('.technical-audit-panel__info-close', ['position: absolute;', 'top: 6px;', 'right: 6px;'])
    expectDeclarations('.technical-audit-panel__info strong', ['display: block;', 'font-weight: normal;'])
    expectDeclarations('.technical-audit-panel__info p', ['margin: 2px 0 0;'])
    expectDeclarations('.technical-audit-panel__info-benefit-title', ['display: flex;', 'gap: 6px;'])
    expectDeclarations('.technical-audit-panel__benefit-level', [
      'color: var(--muted);',
      'background: var(--surface-subtle);',
      'border: 1px solid var(--line);',
      'font-size: 10px;',
    ])
    expectDeclarations('.technical-audit-panel__groups', ['padding: 0;', 'gap: 0;'])
    expectDeclarations('.technical-audit-group', ['padding: 8px 12px;'])
    expectDeclarations('.technical-audit-group + .technical-audit-group', ['border-top: 1px solid var(--line);'])
    expectDeclarations('.technical-audit-group h3', ['font-size: 13px;'])
    expectDeclarations('.technical-audit-group h3 > span', ['font-size: 12px;'])
    expectDeclarations('.technical-audit-group ul', ['gap: 0;'])
    expectDeclarations('.technical-audit-item', ['padding: 0;'])
    expectDeclarations('.technical-audit-item__row', ['min-height: 32px;'])
    expectDeclarations('.technical-audit-item__label', ['display: flex;', 'min-width: 0;', 'gap: 4px;'])
    expectDeclarations('.technical-audit-item__info-button', ['width: 20px;', 'height: 20px;'])
    expectDeclarations('.technical-audit-item__info', [
      'top: 32px;',
      'left: 0;',
      'max-height: min(240px, calc(100vh - 32px));',
      'overflow-y: auto;',
    ])
    expectDeclarations('.technical-audit-item__name', ['color: var(--ink);', 'font-size: 13px;'])
    expectDeclarations('.technical-audit-item__status', [
      'display: inline-flex;',
      'padding: 3px 8px;',
      'border-radius: 999px;',
      'font-size: 12px;',
      'line-height: 1.4;',
    ])
    expectDeclarations('.technical-audit-item__message', ['font-size: 12px;'])

    for (const selector of ['.technical-audit-item', '.technical-audit-item__message']) {
      expect(rule(selector)).not.toMatch(/(?:^|\n)\s*(?:height|min-height):/)
    }
    expectDeclarations('.technical-audit-item__status--unchecked,\n.technical-audit-item__status--neutral,\n.technical-audit-item__status--not_applicable', [
      'background: var(--surface-subtle);',
      'border: 1px solid var(--line);',
    ])
    expectDeclarations('.technical-audit-item__status--pass', ['background: var(--success-soft);'])
    expectDeclarations('.technical-audit-item__status--fix', ['background: var(--danger-soft);'])
    expectDeclarations('.technical-audit-item__status--review', ['background: var(--warning-soft);'])
  })
})
