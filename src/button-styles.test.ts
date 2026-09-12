/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appCss = readFileSync(fileURLToPath(new URL('./App.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const start = appCss.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`CSS rule not found: ${selector}`)
  const end = appCss.indexOf('\n}', start)
  if (end < 0) throw new Error(`CSS rule is not closed: ${selector}`)
  return appCss.slice(start, end)
}

function expectDeclarations(selector: string, declarations: string[]) {
  const block = rule(selector)
  for (const declaration of declarations) expect(block).toContain(declaration)
}

describe('compact button design tokens', () => {
  it('keeps regular buttons compact, content-sized, and readable', () => {
    expectDeclarations('.button', [
      'width: fit-content;',
      'height: 32px;',
      'min-height: 32px;',
      'max-width: 100%;',
      'align-self: center;',
      'gap: 6px;',
      'padding: 0 12px;',
      'border-radius: 6px;',
      'font-size: 14px;',
    ])

    for (const variant of ['.button--primary', '.button--secondary', '.button--quiet', '.button--danger']) {
      const block = rule(variant)
      expect(block).not.toMatch(/(?:^|\n)\s*(?:width|height|min-height):/)
    }
  })

  it('bottom-aligns scoped operation buttons while keeping modal footer buttons centered', () => {
    expectDeclarations('.button', ['align-self: center;'])
    for (const selector of [
      '.operation-bar .button',
      '.technical-audit-panel__header > .button',
    ]) expectDeclarations(selector, ['align-self: flex-end;'])
    expect(appCss).not.toContain('.modal__footer .button {')
  })

  it('uses the same compact entry sizing for the workbench control', () => {
    expectDeclarations('.brand-button', [
      'width: fit-content;',
      'height: 32px;',
      'gap: 6px;',
      'padding: 0 12px;',
      'border-radius: 6px;',
      'font-size: 14px;',
    ])
    expect(rule('.brand-button')).not.toMatch(/(?:^|\n)\s*min-width:/)
  })

  it('keeps regular icon controls at 32px while preserving inline edit at 24px', () => {
    expectDeclarations('.icon-button', ['width: 32px;', 'height: 32px;'])
    expectDeclarations('.icon-button--small', ['width: 24px;', 'height: 24px;'])
    expectDeclarations('.settings-button', ['width: 32px;', 'height: 32px;'])
    expectDeclarations('.modal__header .icon-button', ['width: 32px;', 'height: 32px;', 'border-radius: 6px;'])
  })

  it('does not reintroduce page-specific fixed button widths or heights', () => {
    const legacyFixedSelectors = [
      '.list-toolbar__actions > .button',
      '.question-card__tools .button:first-of-type',
      '.question-card__tools .button:last-of-type',
      '.diagnosis-qa-card__actions .button',
      '.diagnosis-qa-card__actions .button--primary',
      '.website-setup-card__save,\n.website-setup-card__disabled-action',
      '.article-action-bar .button',
      '.modal:not(.preview-modal) .modal__footer .button:first-of-type',
      '.modal:not(.preview-modal) .modal__footer .button:last-of-type',
      '.preview-modal__footer .button:first-of-type',
      '.preview-modal__footer .button:last-of-type',
      '.monitoring-operation-bar .button',
      '.monitoring-operation-bar .operation-bar__left > .button',
      '.monitoring-operation-bar .operation-bar__right > .button:first-child',
      '.monitoring-operation-bar .operation-bar__right > .button:last-child',
    ]

    for (const selector of legacyFixedSelectors) expect(appCss).not.toContain(`${selector} {`)

    const websiteDisabledAction = rule('.website-setup-card__disabled-action')
    expect(websiteDisabledAction).not.toMatch(/(?:^|\n)\s*(?:width|height|min-height):/)
    expect(appCss).not.toMatch(/\.technical-audit-panel__check\s*\{[^}]*\b(?:width|height|min-height|padding|font-size)\s*:/s)
  })

  it('keeps inline notice copy at 12px while sizing retry buttons at 14px', () => {
    expectDeclarations('.inline-notice', ['font-size: 12px;'])
    expectDeclarations('.inline-notice .button', ['font-size: 14px;'])
  })

  it('lets disabled monitoring actions use the global disabled opacity', () => {
    expectDeclarations('.button:disabled', ['opacity: 0.48;'])
    expect(appCss).not.toContain('.monitoring-operation-bar .operation-bar__right > .button:last-child:disabled {')
  })
})
