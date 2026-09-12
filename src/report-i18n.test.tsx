import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiagnosisReportSheet } from './App'
import { I18nProvider } from './i18n'
import type { ProjectDetail } from './types'

function fixtureProject(): ProjectDetail {
  return {
    id: 'diagnosis-report-i18n',
    companyName: '星河中文公司',
    websiteUrl: 'https://example.test',
    optimizationTarget: '企业数字化服务',
    initialDiagnosisCompletedAt: '2026-09-07T01:01:00.000Z',
    initialDiagnosis: {
      run: { completedAt: '2026-09-07T01:01:00.000Z', recommendationRate: 0.4, officialCitationRate: 0.35 },
      answers: Array.from({ length: 20 }, (_, index) => ({
        position: index + 1,
        question: `诊断问题${index + 1}`,
        recommended: index < 8,
        officialCitation: index < 7,
      })),
    },
  } as unknown as ProjectDetail
}

describe('report templates and locale boundaries', () => {
  it('localizes the diagnosis report template without translating customer or AI content', () => {
    const project = fixtureProject()
    const zhHtml = renderToStaticMarkup(<DiagnosisReportSheet project={project} />)
    const enHtml = renderToStaticMarkup(<I18nProvider><DiagnosisReportSheet project={project} /></I18nProvider>)

    expect(zhHtml).toContain('GEO 诊断报告')
    expect(enHtml).toContain('GEO Diagnosis Report')
    expect(enHtml).toContain('Optimization target')
    expect(enHtml).toContain('诊断问题1')
    expect(enHtml).toContain('企业数字化服务')
    expect(enHtml).not.toContain('优化对象')
  })
})
