import { describe, expect, it } from 'vitest'
import type { jsPDFOptions } from 'jspdf'
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  buildDeliveryReportFilename,
  DELIVERY_REPORT_CAPTURE_SCALE,
  DELIVERY_REPORT_PAGE_HEIGHT_PX,
  DELIVERY_REPORT_WIDTH_PX,
  prepareDeliveryReportPdf,
  type DeliveryReportCanvas,
  type DeliveryReportCanvasContext,
  type DeliveryReportPdfDocument,
} from './delivery-report-pdf'

function sourceElement(scrollHeight = DELIVERY_REPORT_PAGE_HEIGHT_PX): HTMLElement {
  return {
    scrollHeight,
    getBoundingClientRect: () => ({ height: scrollHeight } as DOMRect),
    querySelectorAll: () => [],
  } as unknown as HTMLElement
}

function fakeCanvas(width: number, height: number, onDraw?: (args: unknown[]) => void): DeliveryReportCanvas {
  const context: DeliveryReportCanvasContext = {
    fillStyle: '',
    fillRect: () => undefined,
    drawImage: (...args) => onDraw?.(args),
  }
  return {
    width,
    height,
    getContext: () => context,
    toDataURL: () => `data:image/png;base64,${width}x${height}`,
  }
}

describe('monitoring delivery report PDF export', () => {
  it('waits for fonts, captures a Noto report source, and prepares a downloadable A4 blob', async () => {
    const events: string[] = []
    let captureOptions: Record<string, unknown> | undefined
    let pdfOptions: jsPDFOptions | undefined
    let imageArgs: unknown[] = []
    let outputType = ''
    const pdf: DeliveryReportPdfDocument = {
      addImage: (...args) => { imageArgs = args },
      output: (type) => { outputType = type; return new Blob(['pdf']) },
    }

    const prepared = await prepareDeliveryReportPdf(
      { element: sourceElement(), companyName: '示例/公司:名称', monitoringDate: '2026-09-04T00:00:00.000Z' },
      {
        waitForFonts: async () => { events.push('fonts') },
        capture: async (_element, options) => {
          events.push('capture')
          captureOptions = options
          return fakeCanvas(DELIVERY_REPORT_WIDTH_PX * 2, DELIVERY_REPORT_PAGE_HEIGHT_PX * 2)
        },
        createPdf: (options) => { events.push('pdf'); pdfOptions = options; return pdf },
        safeBreakOffsets: () => [],
      },
    )

    expect(events).toEqual(['fonts', 'capture', 'pdf'])
    expect(captureOptions).toMatchObject({
      backgroundColor: '#ffffff',
      height: DELIVERY_REPORT_PAGE_HEIGHT_PX,
      logging: false,
      scale: DELIVERY_REPORT_CAPTURE_SCALE,
      width: DELIVERY_REPORT_WIDTH_PX,
      windowHeight: DELIVERY_REPORT_PAGE_HEIGHT_PX,
      windowWidth: DELIVERY_REPORT_WIDTH_PX,
    })
    expect(pdfOptions).toEqual({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    expect(imageArgs[0]).toContain('data:image/png')
    expect(imageArgs[1]).toBe('PNG')
    expect(imageArgs[2]).toBe(0)
    expect(imageArgs[3]).toBe(0)
    expect(imageArgs[4]).toBe(A4_WIDTH_MM)
    expect(imageArgs[5]).toBe(A4_HEIGHT_MM)
    expect(prepared.filename).toBe('示例-公司-名称-交付报告-2026-09-04.pdf')
    expect(prepared.pageCount).toBe(1)
    expect(outputType).toBe('blob')
  })

  it('paginates at DOM-safe question boundaries and keeps each page at A4 size', async () => {
    const addedImages: unknown[][] = []
    let pageAdds = 0
    const pdf: DeliveryReportPdfDocument = {
      addImage: (...args) => { addedImages.push(args) },
      addPage: () => { pageAdds += 1 },
      output: () => new Blob(['pdf']),
    }
    const prepared = await prepareDeliveryReportPdf(
      { element: sourceElement(2_700), companyName: '长问题公司', monitoringDate: '2026-09-04T00:00:00.000Z' },
      {
        capture: async () => fakeCanvas(1_588, 5_400),
        createPdf: () => pdf,
        createCanvas: (width, height) => fakeCanvas(width, height),
        // The canvas is 2x CSS pixels. The renderer should prefer 700 CSS px
        // (1,400 canvas px) and then 1,800 CSS px (3,600 canvas px) instead
        // of cutting at the mechanical 2,246 px A4 boundary. The last value
        // represents the footer boundary and avoids a blank trailing page.
        safeBreakOffsets: () => [700, 1_800, 2_700],
      },
    )

    expect(prepared.pageCount).toBe(3)
    expect(pageAdds).toBe(2)
    expect(addedImages).toHaveLength(3)
    for (const args of addedImages) {
      expect(args[4]).toBe(A4_WIDTH_MM)
      expect(args[5]).toBe(A4_HEIGHT_MM)
    }
  })

  it('keeps Chinese names and sanitizes unsafe filename characters', () => {
    expect(buildDeliveryReportFilename('  星河<>:"/\\|?*科技  ', '2026/09/04')).toBe('星河-科技-交付报告-2026-09-04.pdf')
    expect(buildDeliveryReportFilename('', null)).toBe('未命名公司-交付报告-未标注日期.pdf')
  })
})
