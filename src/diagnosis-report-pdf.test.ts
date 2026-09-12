import { describe, expect, it } from 'vitest'
import type { jsPDFOptions } from 'jspdf'
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  buildDiagnosisReportFilename,
  exportDiagnosisReportToPdf,
  prepareDiagnosisReportPdf,
  REPORT_CAPTURE_SCALE,
  REPORT_HEIGHT_PX,
  REPORT_WIDTH_PX,
  type DiagnosisReportPdfDocument,
} from './diagnosis-report-pdf'

describe('diagnosis report PDF export', () => {
  it('waits for fonts, captures the fixed report, and saves a centered A4 PDF', async () => {
    const events: string[] = []
    let captureOptions: Record<string, unknown> | undefined
    let pdfOptions: jsPDFOptions | undefined
    let imageArgs: unknown[] = []
    let savedFilename = ''
    let outputType = ''
    const pdf: DiagnosisReportPdfDocument = {
      addImage: (...args) => {
        imageArgs = args
      },
      output: (type) => {
        outputType = type
        return new Blob(['pdf'])
      },
      save: (filename) => {
        savedFilename = filename
      },
    }

    const filename = await exportDiagnosisReportToPdf(
      { element: {} as HTMLElement, companyName: '示例/公司:名称', diagnosisDate: '2026-09-04' },
      {
        waitForFonts: async () => { events.push('fonts') },
        capture: async (_element, options) => {
          events.push('capture')
          captureOptions = options
          return { width: REPORT_WIDTH_PX * 2, height: REPORT_HEIGHT_PX * 2, toDataURL: () => 'data:image/png;base64,test' }
        },
        createPdf: (options) => {
          events.push('pdf')
          pdfOptions = options
          return pdf
        },
      },
    )

    expect(events).toEqual(['fonts', 'capture', 'pdf'])
    expect(captureOptions).toMatchObject({
      backgroundColor: '#ffffff',
      height: REPORT_HEIGHT_PX,
      logging: false,
      scale: REPORT_CAPTURE_SCALE,
      width: REPORT_WIDTH_PX,
      windowHeight: REPORT_HEIGHT_PX,
      windowWidth: REPORT_WIDTH_PX,
    })
    expect(pdfOptions).toEqual({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    expect(imageArgs[0]).toBe('data:image/png;base64,test')
    expect(imageArgs[1]).toBe('PNG')
    expect(imageArgs[2]).toBeGreaterThanOrEqual(0)
    expect(imageArgs[3]).toBeGreaterThanOrEqual(0)
    expect(imageArgs[4]).toBeCloseTo(A4_WIDTH_MM, 1)
    expect(imageArgs[5]).toBeCloseTo(A4_HEIGHT_MM, 1)
    expect(savedFilename).toBe('示例-公司-名称-2026-09-04.pdf')
    expect(filename).toBe(savedFilename)
    expect(outputType).toBe('')
  })

  it('prepares a Blob without saving or downloading it', async () => {
    let saveCalls = 0
    let outputType = ''
    const blob = new Blob(['pdf'])
    const prepared = await prepareDiagnosisReportPdf(
      { element: {} as HTMLElement, companyName: '示例公司', diagnosisDate: '2026-09-04' },
      {
        waitForFonts: async () => undefined,
        capture: async () => ({ width: REPORT_WIDTH_PX, height: REPORT_HEIGHT_PX, toDataURL: () => 'data:image/png;base64,test' }),
        createPdf: () => ({
          addImage: () => undefined,
          output: (type: 'blob') => { outputType = type; return blob },
          save: () => { saveCalls += 1 },
        }),
      },
    )

    expect(prepared.filename).toBe('示例公司-2026-09-04.pdf')
    expect(prepared.blob).toBe(blob)
    expect(outputType).toBe('blob')
    expect(saveCalls).toBe(0)
  })

  it('cleans invalid characters and supplies safe fallback filename parts', () => {
    expect(buildDiagnosisReportFilename('  星河<>:"/\\|?*科技  ', '2026/09/04')).toBe('星河-科技-2026-09-04.pdf')
    expect(buildDiagnosisReportFilename('', null)).toBe('未命名公司-未标注日期.pdf')
  })
})
