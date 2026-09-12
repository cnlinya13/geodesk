/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(fileURLToPath(new URL('./App.css', import.meta.url)), 'utf8')
const contentAuditCss = readFileSync(fileURLToPath(new URL('./components/ContentAuditPanel.css', import.meta.url)), 'utf8')

describe('English interface layout', () => {
  it('sizes the long article headers and statuses without changing Chinese table rules', () => {
    expect(appCss).toMatch(/:lang\(en\) \.articles-table__optimization-col \{[\s\S]*?width: 180px;/)
    expect(appCss).toMatch(/:lang\(en\) \.articles-table__question-col \{[\s\S]*?width: 180px;/)
    expect(appCss).toMatch(/:lang\(en\) \.articles-table__status-col \{[\s\S]*?width: 176px;/)
    expect(appCss).toMatch(/:lang\(en\) \.articles-table td:not\(:first-child\) \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/)
    expect(appCss).toMatch(/:lang\(en\) \.articles-table td:last-child \{[\s\S]*?overflow: hidden;/)
    expect(appCss).toContain('.articles-table__optimization-col {\n  width: 120px;')
  })

  it('keeps English buttons intrinsic and lets the title action retain its label', () => {
    expect(appCss).toMatch(/:lang\(en\) \.article-action-bar \.operation-bar__right > \.button \{[\s\S]*?min-width: max-content;[\s\S]*?flex: 0 1 auto;/)
    expect(appCss).toMatch(/:lang\(en\) \.articles-table__title-cell--with-action \.article-start-writing \{[\s\S]*?min-width: max-content;/)
    expect(contentAuditCss).toMatch(/:lang\(en\) \.content-audit-panel__check \{[\s\S]*?width: max-content;[\s\S]*?min-width: max-content;/)
  })

  it('provides responsive English header tracks and report columns', () => {
    expect(contentAuditCss).toMatch(/:lang\(en\) \.content-audit-panel__header \{[\s\S]*?grid-template-columns: max-content minmax\(0, 1fr\) max-content;/)
    expect(contentAuditCss).toMatch(/@media \(max-width: 1180px\) \{[\s\S]*?:lang\(en\) \.content-audit-panel__header \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) max-content;/)
    expect(appCss).toMatch(/:lang\(en\) \.report-question \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 116px 116px;/)
    expect(appCss).toMatch(/:lang\(en\) \.delivery-report-question \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 96px 96px;/)
  })
})
