import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeliveryReportSheet } from './delivery-report-sheet'
import { I18nProvider } from './i18n'
import type { ProjectDetail } from './types'

function fixtureProject(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  const answers = Array.from({ length: 20 }, (_, index) => ({
    position: index + 1,
    question: `监测问题${index + 1}`,
    status: 'success' as const,
    answerText: `回答${index + 1}`,
    citationUrls: [],
    responseModel: 'fixture',
    recommended: index < 8,
    officialCitation: index < 5,
    error: null,
    startedAt: '2026-09-07T01:00:00.000Z',
    completedAt: '2026-09-07T01:01:00.000Z',
  }))
  return {
    id: 'delivery-project',
    companyName: '星河中文公司',
    websiteUrl: 'https://example.test',
    optimizationTarget: '企业数字化服务',
    initialRecommendationRate: 0.25,
    initialOfficialCitationRate: 0.2,
    initialDiagnosis: {
      run: { recommendationRate: 0.25, officialCitationRate: 0.2 },
    },
    questions: answers.map(({ position, question }) => ({ position, question, generatedAt: '' })),
    ...overrides,
  } as unknown as ProjectDetail
}

function fixtureRun(overrides: Partial<ProjectDetail['monitoringRuns'][number]> = {}): ProjectDetail['monitoringRuns'][number] {
  return {
    id: 'monitor-run-2',
    runType: 'monitoring',
    roundNumber: 2,
    status: 'completed',
    requestedModel: 'fixture',
    publishedArticleCount: 3,
    startedAt: '2026-09-07T01:00:00.000Z',
    completedAt: '2026-09-07T01:01:00.000Z',
    summaryAnalysis: null,
    summaryModel: 'fixture',
    summaryError: null,
    recommendationRate: 0.4,
    officialCitationRate: 0.35,
    answers: Array.from({ length: 20 }, (_, index) => ({
      position: index + 1,
      question: `监测问题${index + 1}`,
      status: 'success' as const,
      answerText: `回答${index + 1}`,
      citationUrls: [],
      responseModel: 'fixture',
      recommended: index < 8,
      officialCitation: index < 7,
      error: null,
      startedAt: '2026-09-07T01:00:00.000Z',
      completedAt: '2026-09-07T01:01:00.000Z',
    })),
    ...overrides,
  } as ProjectDetail['monitoringRuns'][number]
}

describe('DeliveryReportSheet', () => {
  it('renders the monitoring snapshot, rate changes, round and all twenty result rows', () => {
    const html = renderToStaticMarkup(<DeliveryReportSheet project={fixtureProject()} run={fixtureRun()} />)
    expect(html).toContain('GEO 交付报告')
    expect(html).toContain('本轮开始时已确认发布')
    expect(html).toContain('3 篇')
    expect(html).toContain('第 2 轮')
    expect(html).toContain('初始 5 / 20')
    expect(html).toContain('本轮 8 / 20')
    expect(html).toContain('变化 +3 / 20')
    expect(html).toContain('官网引用率')
    expect(html).toContain('Q01')
    expect(html).toContain('Q20')
    expect(html).toContain('监测日期：2026-09-07')
    expect(html).toContain('不证明内容优化与指标变化之间存在因果关系')
    expect(html).not.toContain('text-overflow')
  })

  it('does not turn missing snapshots or unavailable citation rates into zero', () => {
    const project = fixtureProject({ websiteUrl: null })
    const run = fixtureRun({ publishedArticleCount: null, officialCitationRate: null })
    const html = renderToStaticMarkup(<DeliveryReportSheet project={project} run={run} />)
    expect(html).toContain('未记录')
    expect(html).toContain('未配置官网')
    expect(html).toContain('官网引用率')
    expect(html).toContain('不可计算')
    expect(html).not.toContain('0 / 20')
  })

  it('wraps long Chinese questions as normal text instead of truncating them', () => {
    const longQuestion = '这是一个需要在交付报告中完整保留并允许自然换行的长问题，不能通过省略号截断，也不能因为页面高度有限而隐藏后半段内容。'.repeat(5)
    const run = fixtureRun({ answers: [{ ...fixtureRun().answers[0], question: longQuestion }, ...fixtureRun().answers.slice(1)] })
    const html = renderToStaticMarkup(<DeliveryReportSheet project={fixtureProject()} run={run} />)
    expect(html).toContain(longQuestion)
    expect(html).toContain('delivery-report-question__text')
    expect(html).not.toContain('…')
  })

  it('uses the current locale for fixed report copy while preserving customer and question content', () => {
    const project = fixtureProject()
    const run = fixtureRun()
    const zhHtml = renderToStaticMarkup(<DeliveryReportSheet project={project} run={run} />)
    const enHtml = renderToStaticMarkup(<I18nProvider><DeliveryReportSheet project={project} run={run} /></I18nProvider>)

    expect(zhHtml).toContain('GEO 交付报告')
    expect(enHtml).toContain('GEO Delivery Report')
    expect(enHtml).toContain('Optimization target')
    expect(enHtml).toContain('星河中文公司')
    expect(enHtml).toContain('企业数字化服务')
    expect(enHtml).toContain('监测问题1')
    expect(enHtml).not.toContain('本轮开始时已确认发布')
  })
})
