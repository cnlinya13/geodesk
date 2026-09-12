import html2canvas from 'html2canvas'
import { jsPDF, type ImageCompression, type jsPDFOptions } from 'jspdf'

/** The report is rendered at a stable CSS width and may grow to multiple A4 pages. */
export const DELIVERY_REPORT_WIDTH_PX = 794
export const DELIVERY_REPORT_PAGE_HEIGHT_PX = 1123
export const DELIVERY_REPORT_CAPTURE_SCALE = 2
export const A4_WIDTH_MM = 210
export const A4_HEIGHT_MM = 297

export type DeliveryReportCaptureOptions = {
  backgroundColor: '#ffffff'
  height: number
  logging: false
  scale: number
  width: number
  windowHeight: number
  windowWidth: number
}

export interface DeliveryReportCanvas {
  height: number
  toDataURL: (type?: string, quality?: number) => string
  width: number
  getContext?: (contextId: '2d') => unknown
}

export interface DeliveryReportCanvasContext {
  fillStyle: string
  fillRect: (x: number, y: number, width: number, height: number) => void
  drawImage: (
    image: DeliveryReportCanvas,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ) => void
}

export interface DeliveryReportPdfDocument {
  addImage: (imageData: string, format: string, x: number, y: number, width: number, height: number, alias?: string, compression?: ImageCompression) => unknown
  addPage?: (format?: string | number[], orientation?: 'portrait' | 'landscape' | 'p' | 'l') => unknown
  output?: (type: 'blob') => Blob
}

export interface DeliveryReportPdfInput {
  companyName: string
  monitoringDate: string | null
  element: HTMLElement
}

export interface DeliveryReportPdfDependencies {
  capture?: (element: HTMLElement, options: DeliveryReportCaptureOptions) => Promise<DeliveryReportCanvas>
  createCanvas?: (width: number, height: number) => DeliveryReportCanvas
  createPdf?: (options: jsPDFOptions) => DeliveryReportPdfDocument
  /** Test hook for supplying DOM-safe page boundaries in CSS pixels. */
  safeBreakOffsets?: (element: HTMLElement) => readonly number[]
  waitForFonts?: () => Promise<void>
}

const defaultCapture = (element: HTMLElement, options: DeliveryReportCaptureOptions): Promise<DeliveryReportCanvas> => html2canvas(element, options)
const defaultCreatePdf = (options: jsPDFOptions): DeliveryReportPdfDocument => new jsPDF(options)

/** Wait for the bundled local Noto Sans SC face before measuring report text. */
export async function waitForDeliveryReportFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.ready) return
  await document.fonts.ready
}

export function sanitizeDeliveryReportFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
}

export function buildDeliveryReportFilename(companyName: string, monitoringDate: string | null): string {
  const company = sanitizeDeliveryReportFilenamePart(companyName) || '未命名公司'
  const parsedDate = monitoringDate ? new Date(monitoringDate) : null
  const date = parsedDate && !Number.isNaN(parsedDate.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Shanghai',
    }).format(parsedDate).replaceAll('/', '-')
    : sanitizeDeliveryReportFilenamePart(monitoringDate ?? '') || '未标注日期'
  return `${company}-交付报告-${date}.pdf`
}

function reportContentHeight(element: HTMLElement): number {
  const scrollHeight = Number.isFinite(element.scrollHeight) ? element.scrollHeight : 0
  const rectHeight = typeof element.getBoundingClientRect === 'function' && Number.isFinite(element.getBoundingClientRect().height)
    ? element.getBoundingClientRect().height
    : 0
  return Math.max(DELIVERY_REPORT_PAGE_HEIGHT_PX, Math.ceil(scrollHeight || rectHeight || DELIVERY_REPORT_PAGE_HEIGHT_PX))
}

function pageHeightForCanvas(canvas: DeliveryReportCanvas): number {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('PDF内容尺寸无效，请重试')
  }
  return Math.max(1, Math.round(canvas.width * A4_HEIGHT_MM / A4_WIDTH_MM))
}

function defaultCreateCanvas(width: number, height: number): DeliveryReportCanvas | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function defaultSafeBreakOffsets(element: HTMLElement): readonly number[] {
  if (typeof element.getBoundingClientRect !== 'function' || typeof element.querySelectorAll !== 'function') return []
  const root = element.getBoundingClientRect()
  const boundaries: number[] = []
  const nodes = element.querySelectorAll<HTMLElement>([
    '.delivery-report-sheet__header',
    '.delivery-report-meta-grid',
    '.delivery-report-rates',
    '.delivery-report-questions__heading',
    '.delivery-report-question',
    '.delivery-report-sheet__footer',
  ].join(', '))
  nodes.forEach((node) => {
    const rect = node.getBoundingClientRect()
    const bottom = rect.bottom - root.top
    if (Number.isFinite(bottom) && bottom > 0) boundaries.push(bottom)
  })
  return boundaries
}

function splitCanvasIntoPages(
  canvas: DeliveryReportCanvas,
  createCanvas: (width: number, height: number) => DeliveryReportCanvas | null,
  safeBreakOffsets: readonly number[] = [],
): DeliveryReportCanvas[] {
  const pageHeight = pageHeightForCanvas(canvas)
  const scale = canvas.width / DELIVERY_REPORT_WIDTH_PX
  const safeBreaks = [...safeBreakOffsets]
    .filter((offset) => Number.isFinite(offset) && offset > 0)
    .map((offset) => Math.round(offset * scale))
    .filter((offset) => offset <= canvas.height)
    .sort((a, b) => a - b)
  // The source sheet keeps a small bottom padding for screen layout. Once a
  // footer boundary is available, crop that padding from the pagination
  // calculation so it cannot become a mostly blank trailing PDF page.
  const contentHeight = safeBreaks.at(-1) ?? canvas.height

  // A one-page report does not need an intermediate canvas. For a long report,
  // prefer the last question/footer boundary that fits on the current page. A
  // question taller than one page is the only case that can still be split.
  if (contentHeight <= pageHeight) return [canvas]

  const pages: DeliveryReportCanvas[] = []
  let sourceY = 0
  while (sourceY < contentHeight) {
    const targetY = Math.min(contentHeight, sourceY + pageHeight)
    const safeBoundary = safeBreaks
      .filter((offset) => offset > sourceY && offset <= targetY)
      .at(-1) ?? targetY
    const sourceHeight = Math.max(1, safeBoundary - sourceY)
    const page = createCanvas(canvas.width, pageHeight)
    if (!page) throw new Error('PDF分页画布不可用，请重试')
    const context = page.getContext?.('2d') as DeliveryReportCanvasContext | null | undefined
    if (!context) throw new Error('PDF分页画布不可用，请重试')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, page.width, page.height)
    context.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, page.width, sourceHeight)
    pages.push(page)
    sourceY = safeBoundary
  }
  return pages
}

type RenderedDeliveryReportPdf = {
  filename: string
  pages: DeliveryReportCanvas[]
  pdf: DeliveryReportPdfDocument
}

async function renderDeliveryReportPdf(
  input: DeliveryReportPdfInput,
  dependencies: DeliveryReportPdfDependencies = {},
): Promise<RenderedDeliveryReportPdf> {
  const waitForFonts = dependencies.waitForFonts ?? waitForDeliveryReportFonts
  const capture = dependencies.capture ?? defaultCapture
  const createPdf = dependencies.createPdf ?? defaultCreatePdf
  const createCanvas = dependencies.createCanvas ?? defaultCreateCanvas
  const safeBreakOffsets = dependencies.safeBreakOffsets ?? defaultSafeBreakOffsets

  await waitForFonts()
  const height = reportContentHeight(input.element)
  const canvas = await capture(input.element, {
    backgroundColor: '#ffffff',
    height,
    logging: false,
    scale: DELIVERY_REPORT_CAPTURE_SCALE,
    width: DELIVERY_REPORT_WIDTH_PX,
    windowHeight: height,
    windowWidth: DELIVERY_REPORT_WIDTH_PX,
  })
  const pages = splitCanvasIntoPages(canvas, createCanvas, safeBreakOffsets(input.element))
  const pdf = createPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  pages.forEach((page, index) => {
    if (index > 0) {
      if (!pdf.addPage) throw new Error('PDF分页输出不可用，请重试')
      pdf.addPage('a4', 'portrait')
    }
    pdf.addImage(page.toDataURL('image/png', 1), 'PNG', 0, 0, A4_WIDTH_MM, A4_HEIGHT_MM, undefined, 'FAST')
  })
  const filename = buildDeliveryReportFilename(input.companyName, input.monitoringDate)
  return { filename, pages, pdf }
}

/** Render a delivery report into a Blob without downloading it. */
export async function prepareDeliveryReportPdf(
  input: DeliveryReportPdfInput,
  dependencies: DeliveryReportPdfDependencies = {},
): Promise<{ blob: Blob; filename: string; pageCount: number }> {
  const rendered = await renderDeliveryReportPdf(input, dependencies)
  if (!rendered.pdf.output) throw new Error('PDF输出不可用，请重试')
  return { blob: rendered.pdf.output('blob'), filename: rendered.filename, pageCount: rendered.pages.length }
}
