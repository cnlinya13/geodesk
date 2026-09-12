import html2canvas from 'html2canvas'
import { jsPDF, type ImageCompression, type jsPDFOptions } from 'jspdf'

/** The report sheet is intentionally kept at the same fixed size as the UI. */
export const REPORT_WIDTH_PX = 794
export const REPORT_HEIGHT_PX = 1123
export const A4_WIDTH_MM = 210
export const A4_HEIGHT_MM = 297
export const REPORT_CAPTURE_SCALE = 2

export type DiagnosisReportCaptureOptions = {
  backgroundColor: '#ffffff'
  height: number
  logging: false
  scale: number
  width: number
  windowHeight: number
  windowWidth: number
}

export interface DiagnosisReportCanvas {
  height: number
  toDataURL: (type?: string, quality?: number) => string
  width: number
}

export interface DiagnosisReportPdfDocument {
  addImage: (imageData: string, format: string, x: number, y: number, width: number, height: number, alias?: string, compression?: ImageCompression) => unknown
  output?: (type: 'blob') => Blob
  save: (filename: string) => unknown
}

export interface DiagnosisReportPdfInput {
  companyName: string
  diagnosisDate: string | null
  element: HTMLElement
}

export interface DiagnosisReportPdfDependencies {
  capture?: (element: HTMLElement, options: DiagnosisReportCaptureOptions) => Promise<DiagnosisReportCanvas>
  createPdf?: (options: jsPDFOptions) => DiagnosisReportPdfDocument
  waitForFonts?: () => Promise<void>
}

const defaultCapture = (element: HTMLElement, options: DiagnosisReportCaptureOptions): Promise<DiagnosisReportCanvas> => html2canvas(element, options)
const defaultCreatePdf = (options: jsPDFOptions): DiagnosisReportPdfDocument => new jsPDF(options)

/** Wait for the bundled local font before html2canvas measures any text. */
export async function waitForLocalFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.ready) return
  await document.fonts.ready
}

/**
 * Replace characters that are not valid in a downloaded filename while
 * retaining readable company names and dates (including Chinese characters).
 */
export function sanitizeDiagnosisReportFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
}

export function buildDiagnosisReportFilename(companyName: string, diagnosisDate: string | null): string {
  const company = sanitizeDiagnosisReportFilenamePart(companyName) || '未命名公司'
  const date = sanitizeDiagnosisReportFilenamePart(diagnosisDate ?? '') || '未标注日期'
  return `${company}-${date}.pdf`
}

function fittedPageImage(canvas: DiagnosisReportCanvas): { height: number; width: number; x: number; y: number } {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error('PDF内容尺寸无效，请重试')
  }

  const scale = Math.min(A4_WIDTH_MM / canvas.width, A4_HEIGHT_MM / canvas.height)
  const width = canvas.width * scale
  const height = canvas.height * scale
  return {
    width,
    height,
    x: (A4_WIDTH_MM - width) / 2,
    y: (A4_HEIGHT_MM - height) / 2,
  }
}

type RenderedDiagnosisReportPdf = {
  filename: string
  pdf: DiagnosisReportPdfDocument
}

async function renderDiagnosisReportPdf(
  input: DiagnosisReportPdfInput,
  dependencies: DiagnosisReportPdfDependencies = {},
): Promise<RenderedDiagnosisReportPdf> {
  const waitForFonts = dependencies.waitForFonts ?? waitForLocalFonts
  const capture = dependencies.capture ?? defaultCapture
  const createPdf = dependencies.createPdf ?? defaultCreatePdf

  await waitForFonts()
  const canvas = await capture(input.element, {
    backgroundColor: '#ffffff',
    height: REPORT_HEIGHT_PX,
    logging: false,
    scale: REPORT_CAPTURE_SCALE,
    width: REPORT_WIDTH_PX,
    windowHeight: REPORT_HEIGHT_PX,
    windowWidth: REPORT_WIDTH_PX,
  })

  const image = canvas.toDataURL('image/png', 1)
  const imageBox = fittedPageImage(canvas)
  const pdf = createPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  pdf.addImage(image, 'PNG', imageBox.x, imageBox.y, imageBox.width, imageBox.height, undefined, 'FAST')

  const filename = buildDiagnosisReportFilename(input.companyName, input.diagnosisDate)
  return { filename, pdf }
}

/** Render one report sheet into a Blob without triggering a download. */
export async function prepareDiagnosisReportPdf(
  input: DiagnosisReportPdfInput,
  dependencies: DiagnosisReportPdfDependencies = {},
): Promise<{ blob: Blob; filename: string }> {
  const rendered = await renderDiagnosisReportPdf(input, dependencies)
  if (!rendered.pdf.output) throw new Error('PDF输出不可用，请重试')
  return { blob: rendered.pdf.output('blob'), filename: rendered.filename }
}

/** Render one report sheet and download it as a single-page A4 PDF. */
export async function exportDiagnosisReportToPdf(
  input: DiagnosisReportPdfInput,
  dependencies: DiagnosisReportPdfDependencies = {},
): Promise<string> {
  const rendered = await renderDiagnosisReportPdf(input, dependencies)
  const { filename, pdf } = rendered
  pdf.save(filename)
  return filename
}
