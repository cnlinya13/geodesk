/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

describe('workspace outer scrolling', () => {
  it('owns the shared vertical scroll on the workspace page', () => {
    expectDeclarations('.workspace-page', [
      'overflow-y: auto;',
      'overscroll-behavior: contain;',
      'scrollbar-gutter: stable;',
    ])
    const page = rule('.workspace-page')
    expect(page).not.toContain('overflow: hidden;')
    expect(page).not.toContain('overflow: auto;')
  })

  it('leaves the stage viewport in normal flow without a second scroll container', () => {
    expectDeclarations('.workspace-stage-viewport', [
      'flex: 0 0 auto;',
      'overflow: visible;',
    ])
    const viewport = rule('.workspace-stage-viewport')
    expect(viewport).not.toContain('overflow: auto;')
    expect(viewport).not.toContain('overflow-y: auto;')
    expect(viewport).not.toContain('overscroll-behavior:')
    expect(viewport).not.toContain('scrollbar-gutter:')
  })

  it('keeps the pipeline in normal flow and preserves fixed stage sizing', () => {
    expectDeclarations('.workspace-pipeline', ['flex: 0 0 auto;'])
    expect(rule('.workspace-pipeline')).not.toContain('position: sticky;')

    expect(appCss).toContain('.diagnosis-stage {\n  height: calc(100vh - 166px);\n  min-height: calc(100vh - 166px);')
    expect(appCss).toContain('.scope-stage {\n  min-height: calc(100vh - 166px);')
    expect(appCss).toContain('.optimization-stage {\n  display: flex;\n  min-height: calc(100vh - 200px);\n  height: calc(100vh - 200px);')
    expect(appCss).toContain('.monitoring-stage {\n  display: flex;\n  min-height: 0;\n  flex-direction: column;\n  height: calc(100vh - 190px);')
  })

  it('preserves necessary inner scroll regions', () => {
    expectDeclarations('.question-list', ['overflow-y: auto;'])
    expectDeclarations('.diagnosis-answer-list', ['overflow-y: auto;'])
    expectDeclarations('.diagnosis-answer-detail__scroll', ['overflow-y: auto;'])
    expect(appCss).toContain('.articles-table-scroll {\n  height: 100%;\n  overflow: auto;')
    expectDeclarations('.monitoring-history-list', ['overflow-y: auto;'])
  })
})
