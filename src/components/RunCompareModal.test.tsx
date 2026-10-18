import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n'
import type { RunComparison } from '../run-compare'
import { RunCompareModal } from './RunCompareModal'

function fixture(): RunComparison {
  return {
    current: {
      id: 'r2',
      runType: 'monitoring',
      roundNumber: 2,
      model: 'doubao-seed-1-6-250615',
      completedAt: '2026-10-17T12:00:00.000Z',
      recommendationRate: 0.7,
      officialCitationRate: 0.5,
    },
    previous: {
      id: 'r1',
      runType: 'monitoring',
      roundNumber: 1,
      model: 'doubao-seed-1-6-250615',
      completedAt: '2026-10-16T12:00:00.000Z',
      recommendationRate: 0.6,
      officialCitationRate: 0.55,
    },
    changes: [
      {
        position: 2,
        question: '哪家公司做代理记账好？',
        kinds: ['recommended', 'citationUrls'],
        previous: { recommended: false, officialCitation: false, citationUrls: [] },
        current: { recommended: true, officialCitation: false, citationUrls: ['https://example.test/a'] },
        addedUrls: ['https://example.test/a'],
        removedUrls: [],
      },
    ],
    unchanged: [{ position: 1, question: '代理记账多少钱？' }],
  }
}

function render(comparison: RunComparison): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <RunCompareModal comparison={comparison} onClose={() => undefined} />
    </I18nProvider>,
  )
}

describe('RunCompareModal', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['zh-CN'], language: 'zh-CN' },
    })
  })

  it('renders the overview table with rate deltas', () => {
    const html = render(fixture())
    expect(html).toContain('轮次对比')
    expect(html).toContain('第 2 轮')
    expect(html).toContain('第 1 轮')
    expect(html).toContain('70%')
    expect(html).toContain('60%')
    // 推荐率 +10%，引用率 -5%
    expect(html).toContain('+10%')
    expect(html).toContain('-5%')
  })

  it('renders changed questions with badges and before/after values', () => {
    const html = render(fixture())
    expect(html).toContain('有变化的问题（1）')
    expect(html).toContain('哪家公司做代理记账好？')
    expect(html).toContain('推荐')
    expect(html).toContain('引用链接')
    expect(html).toContain('https://example.test/a')
    // 否 -> 是
    expect(html).toContain('否')
    expect(html).toContain('是')
  })

  it('collapses unchanged questions in a details element', () => {
    const html = render(fixture())
    expect(html).toContain('无变化的问题（1）')
    expect(html).toContain('<details')
    expect(html).toContain('代理记账多少钱？')
  })

  it('shows an empty state when nothing changed', () => {
    const html = render({ ...fixture(), changes: [], unchanged: [] })
    expect(html).toContain('无结构化变化')
  })
})
