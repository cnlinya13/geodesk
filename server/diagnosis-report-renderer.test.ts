import { describe, expect, it } from 'vitest'
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  DIAGNOSIS_REPORT_FONT_FILE,
  DIAGNOSIS_REPORT_FONT_FAMILY,
  DiagnosisReportRenderError,
  renderDiagnosisReport,
  type DiagnosisReportPdfDocument,
  type DiagnosisReportRenderInput,
} from './diagnosis-report-renderer.ts'

function input(overrides: Partial<DiagnosisReportRenderInput> = {}): DiagnosisReportRenderInput {
  return {
    companyName: '示例公司',
    diagnosisDate: '2026-09-08T10:00:00.000Z',
    websiteUrl: 'https://example.test',
    optimizationTarget: '企业数字化服务',
    recommendationRate: 0.5,
    officialCitationRate: 0.25,
    answers: Array.from({ length: 20 }, (_, index) => ({
      position: index + 1,
      question: `企业客户选择服务商时应关注什么${index + 1}？`,
      recommended: index % 2 === 0,
      officialCitation: index % 4 === 0,
    })),
    ...overrides,
  }
}

function fakePdf(split: (value: string, width: number, options?: Record<string, unknown>) => string[] = (value) => [value]): {
  pdf: DiagnosisReportPdfDocument
  calls: { fonts: string[]; text: Array<{ value: string | string[]; x: number; y: number }>; options?: Record<string, unknown> }
} {
  const calls: { fonts: string[]; text: Array<{ value: string | string[]; x: number; y: number }>; options?: Record<string, unknown> } = {
    fonts: [],
    text: [],
  }
  const pdf: DiagnosisReportPdfDocument = {
    addFileToVFS: (filename, file) => { calls.fonts.push(`${filename}:${file.length}`) },
    addFont: (filename, family, style) => { calls.fonts.push(`${filename}:${family}:${style}`) },
    setFont: (family, style) => { calls.fonts.push(`${family}:${style ?? ''}`) },
    setFontSize: () => undefined,
    setTextColor: () => undefined,
    setDrawColor: () => undefined,
    setLineWidth: () => undefined,
    text: (value, x, y) => { calls.text.push({ value, x, y }) },
    line: () => undefined,
    splitTextToSize: split,
    output: () => new TextEncoder().encode('%PDF-test'),
    getNumberOfPages: () => 1,
  }
  return { pdf, calls }
}

describe('Node diagnosis report renderer', () => {
  it('embeds the injected font, keeps the A4 document to one page, and emits searchable text operators', async () => {
    const { pdf, calls } = fakePdf()
    const result = await renderDiagnosisReport(input(), {
      fontData: new Uint8Array([1, 2, 3]),
      createPdf: (options) => {
        calls.options = options as Record<string, unknown>
        return pdf
      },
    })

    expect(result.toString('ascii', 0, 5)).toBe('%PDF-')
    expect(calls.options).toMatchObject({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    expect(calls.fonts).toContain(`${DIAGNOSIS_REPORT_FONT_FILE}:NotoSansSC:normal`)
    expect(calls.fonts).toContain(`${DIAGNOSIS_REPORT_FONT_FAMILY}:normal`)
    expect(calls.fonts.some((value) => value.includes('bold'))).toBe(false)
    expect(calls.text.some((entry) => String(entry.value).includes('GEO 诊断报告'))).toBe(true)
    expect(calls.text.some((entry) => String(entry.value).includes('Q20'))).toBe(true)
  })

  it('renders a real single-page A4 PDF with the bundled Noto Sans SC font', async () => {
    const result = await renderDiagnosisReport(input())
    expect(result.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // jsPDF stores the page dimensions in points; these markers also guard
    // against accidentally creating a second page in future layout changes.
    expect(result.length).toBeGreaterThan(10_000)
    expect(result.toString('latin1')).toContain('/Count 1')
    expect(result.toString('latin1')).toContain(`${A4_WIDTH_MM}`.slice(0, 1))
    expect(result.toString('latin1')).toContain(`${A4_HEIGHT_MM}`.slice(0, 1))
  })

  it('fails explicitly when the production font is unavailable instead of falling back', async () => {
    let createCalls = 0
    await expect(renderDiagnosisReport(input(), {
      fontPath: '/tmp/geodesk-font-does-not-exist.ttf',
      createPdf: () => {
        createCalls += 1
        return fakePdf().pdf
      },
    })).rejects.toMatchObject<Partial<DiagnosisReportRenderError>>({ message: 'report_pdf_font_unavailable' })
    expect(createCalls).toBe(0)
  })

  it('fails rather than clipping a question set that cannot fit one page', async () => {
    const { pdf } = fakePdf(() => Array.from({ length: 100 }, () => 'long line'))
    await expect(renderDiagnosisReport(input(), { fontData: new Uint8Array([1]), createPdf: () => pdf }))
      .rejects.toMatchObject<Partial<DiagnosisReportRenderError>>({ message: 'report_pdf_content_overflow' })
  })

  it('keeps the official-citation column unavailable when no website was configured', async () => {
    const { pdf, calls } = fakePdf()
    await renderDiagnosisReport(input({ websiteUrl: null, officialCitationRate: null, answers: input().answers.map((answer) => ({ ...answer, officialCitation: null })) }), {
      fontData: new Uint8Array([1]),
      createPdf: () => pdf,
    })
    expect(calls.text.some((entry) => String(entry.value).includes('未配置官网'))).toBe(true)
    expect(calls.text.some((entry) => String(entry.value).includes('无法判断'))).toBe(true)
  })

  it('localizes fixed template copy and date/rate formatting without translating supplied content', async () => {
    const { pdf, calls } = fakePdf()
    await renderDiagnosisReport(input({
      locale: 'en',
      companyName: '星河中文公司',
      optimizationTarget: '企业数字化服务',
      answers: input().answers.map((answer, index) => ({
        ...answer,
        officialCitation: index === 0 ? null : answer.officialCitation,
      })),
    }), {
      fontData: new Uint8Array([1]),
      createPdf: () => pdf,
    })

    const text = calls.text.flatMap((entry) => Array.isArray(entry.value) ? entry.value : [entry.value]).join('\n')
    expect(text).toContain('GEO Diagnosis Report')
    expect(text).toContain('Diagnosis date')
    expect(text).toContain('Optimization target')
    expect(text).toContain('Customer website')
    expect(text).toContain('AI recommendation rate')
    expect(text).toContain('Website citation rate')
    expect(text).toContain('09/08/2026')
    expect(text).toContain('50% (10 / 20)')
    expect(text).toContain('Yes = recommended / cited customer website')
    expect(text).toContain('Details for 20 diagnosis questions')
    expect(text).toContain('Question')
    expect(text).toContain('Recommendation')
    expect(text).toContain('Website citation')
    expect(text).toContain('Yes')
    expect(text).toContain('No')
    expect(text).toContain('Pending')
    expect(text).toContain('This report records recommendations and website citations for these 20 questions.')
    expect(text).toContain('星河中文公司')
    expect(text).toContain('企业数字化服务')
    expect(text).not.toContain('GEO 诊断报告')
    expect(text).not.toContain('诊断日期')
    expect(text).not.toContain('优化对象')
  })
})
