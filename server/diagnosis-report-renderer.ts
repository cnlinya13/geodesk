import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { jsPDF, type jsPDFOptions } from 'jspdf'
import {
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from '../src/business-rules.ts'
import {
  DEFAULT_DIAGNOSIS_REPORT_LOCALE,
  diagnosisReportCopy,
  type DiagnosisReportCopy,
  type DiagnosisReportLocale,
} from './diagnosis-report-locale.ts'

/** The report is always rendered on one A4 portrait page. */
export const A4_WIDTH_MM = 210
export const A4_HEIGHT_MM = 297
export const DIAGNOSIS_REPORT_FONT_FAMILY = 'NotoSansSC'
export const DIAGNOSIS_REPORT_FONT_FILE = 'NotoSansSC-Regular.ttf'
export const DEFAULT_DIAGNOSIS_REPORT_FONT_PATH = fileURLToPath(
  new URL(`./assets/${DIAGNOSIS_REPORT_FONT_FILE}`, import.meta.url),
)

export type DiagnosisReportAnswer = {
  position: number
  question: string
  recommended: boolean | null
  officialCitation: boolean | null
}

export type DiagnosisReportRenderInput = {
  companyName: string
  diagnosisDate: string | null
  websiteUrl: string | null
  optimizationTarget: string | null
  recommendationRate: number | null
  officialCitationRate: number | null
  answers: readonly DiagnosisReportAnswer[]
  /** The locale captured when the report-producing request was accepted. */
  locale?: DiagnosisReportLocale
}

export type DiagnosisReportPdfDocument = {
  addFileToVFS: (filename: string, file: string) => unknown
  addFont: (filename: string, family: string, style: string) => unknown
  setFont: (family: string, style?: string, weight?: string | number) => unknown
  setFontSize: (size: number) => unknown
  setTextColor: (r: number, g?: number, b?: number) => unknown
  setDrawColor: (r: number, g?: number, b?: number) => unknown
  setLineWidth: (width: number) => unknown
  text: (text: string | string[], x: number, y: number, options?: Record<string, unknown>) => unknown
  line: (x1: number, y1: number, x2: number, y2: number) => unknown
  splitTextToSize: (text: string, maxWidth: number, options?: Record<string, unknown>) => string[]
  output: (type: 'arraybuffer') => ArrayBuffer | Uint8Array
  getNumberOfPages?: () => number
}

export type DiagnosisReportRendererDependencies = {
  /** Injected by isolated tests; production reads the bundled TTF. */
  fontData?: Uint8Array
  fontPath?: string
  readFont?: (path: string) => Promise<Uint8Array>
  createPdf?: (options: jsPDFOptions) => DiagnosisReportPdfDocument
}

export class DiagnosisReportRenderError extends Error {}

const defaultCreatePdf = (options: jsPDFOptions): DiagnosisReportPdfDocument => new jsPDF(options) as unknown as DiagnosisReportPdfDocument

function safeText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return trimmed || fallback
}

function formatReportDate(value: string | null, locale: DiagnosisReportLocale): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function formatResult(value: boolean | null, websiteConfigured: boolean, copy: DiagnosisReportCopy): string {
  if (!websiteConfigured) return copy.resultUnavailable
  if (value === true) return copy.resultYes
  if (value === false) return copy.resultNo
  return copy.resultPending
}

function asBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

async function loadFont(dependencies: DiagnosisReportRendererDependencies): Promise<Uint8Array> {
  if (dependencies.fontData) {
    if (dependencies.fontData.byteLength === 0) throw new DiagnosisReportRenderError('report_pdf_font_unavailable')
    return dependencies.fontData
  }

  const path = dependencies.fontPath ?? DEFAULT_DIAGNOSIS_REPORT_FONT_PATH
  try {
    const bytes = await (dependencies.readFont ?? (async (fontPath: string) => readFile(fontPath)))(path)
    if (!bytes.byteLength) throw new Error('empty_font')
    return bytes
  } catch {
    // A Chinese PDF without an embedded font silently produces unreadable
    // glyphs.  Do not fall back to a system font or to browser rendering.
    throw new DiagnosisReportRenderError('report_pdf_font_unavailable')
  }
}

function validateInput(input: DiagnosisReportRenderInput): DiagnosisReportAnswer[] {
  if (!safeText(input.companyName, '')) throw new DiagnosisReportRenderError('report_pdf_company_required')
  if (input.answers.length !== QUESTION_TOTAL) throw new DiagnosisReportRenderError('report_pdf_answers_incomplete')

  const positions = new Set<number>()
  const answers = input.answers.slice().sort((a, b) => a.position - b.position)
  for (const answer of answers) {
    if (!Number.isInteger(answer.position) || answer.position < QUESTION_POSITION_MIN || answer.position > QUESTION_POSITION_MAX || positions.has(answer.position)) {
      throw new DiagnosisReportRenderError('report_pdf_answers_incomplete')
    }
    if (!safeText(answer.question, '')) throw new DiagnosisReportRenderError('report_pdf_question_invalid')
    positions.add(answer.position)
  }
  if (positions.size !== QUESTION_TOTAL) throw new DiagnosisReportRenderError('report_pdf_answers_incomplete')
  return answers
}

type TableLayout = {
  fontSize: number
  lineHeight: number
  rows: Array<{ answer: DiagnosisReportAnswer; lines: string[]; height: number }>
  totalHeight: number
}

/**
 * Fit the complete question table instead of clipping or silently dropping
 * long question text.  The lower bound is deliberately explicit: an input
 * that cannot fit one A4 page fails the report task and remains retryable.
 */
function fitTable(
  pdf: DiagnosisReportPdfDocument,
  answers: DiagnosisReportAnswer[],
  questionWidth: number,
  maxHeight: number,
  questionFallback: string,
): TableLayout {
  for (let fontSize = 8.5; fontSize >= 5.5; fontSize -= 0.25) {
    pdf.setFontSize(fontSize)
    const lineHeight = Math.max(4.1, fontSize * 0.48)
    const rows = answers.map((answer) => {
      const lines = pdf.splitTextToSize(`Q${String(answer.position).padStart(2, '0')}  ${safeText(answer.question, questionFallback)}`, questionWidth, { fontSize })
      const height = Math.max(6.2, lines.length * lineHeight + 1.8)
      return { answer, lines, height }
    })
    const totalHeight = rows.reduce((sum, row) => sum + row.height, 0)
    if (totalHeight <= maxHeight) return { fontSize, lineHeight, rows, totalHeight }
  }
  throw new DiagnosisReportRenderError('report_pdf_content_overflow')
}

function drawLabelValue(
  pdf: DiagnosisReportPdfDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
  valueFontSize = 8.5,
): number {
  pdf.setTextColor(100, 106, 116)
  pdf.setFontSize(7)
  pdf.text(label, x, y)
  pdf.setTextColor(27, 31, 38)
  pdf.setFontSize(valueFontSize)
  const lines = pdf.splitTextToSize(value, width, { fontSize: valueFontSize })
  pdf.text(lines, x, y + 4.5, { lineHeightFactor: 1.1 })
  return Math.max(9, lines.length * 4.2 + 8)
}

/**
 * Render a searchable, single-page A4 diagnosis report in the Node process.
 * The report intentionally uses text operators rather than a screenshot so
 * Chinese text remains selectable/searchable in the downloaded PDF.
 */
export async function renderDiagnosisReport(
  input: DiagnosisReportRenderInput,
  dependencies: DiagnosisReportRendererDependencies = {},
): Promise<Buffer> {
  const answers = validateInput(input)
  const locale = input.locale ?? DEFAULT_DIAGNOSIS_REPORT_LOCALE
  const copy = diagnosisReportCopy(locale)
  const font = await loadFont(dependencies)
  const createPdf = dependencies.createPdf ?? defaultCreatePdf
  const pdf = createPdf({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })

  pdf.addFileToVFS(DIAGNOSIS_REPORT_FONT_FILE, asBase64(font))
  pdf.addFont(DIAGNOSIS_REPORT_FONT_FILE, DIAGNOSIS_REPORT_FONT_FAMILY, 'normal')
  pdf.setFont(DIAGNOSIS_REPORT_FONT_FAMILY, 'normal')
  pdf.setTextColor(27, 31, 38)

  const left = 14
  const right = A4_WIDTH_MM - 14
  const width = right - left
  let y = 15

  // Header: same information hierarchy as the existing report sheet, with
  // normal font weight throughout (size, not boldness, creates hierarchy).
  pdf.setFontSize(17)
  pdf.text(copy.title, left, y)
  pdf.setFontSize(10)
  pdf.setTextColor(91, 97, 107)
  const companyName = safeText(input.companyName, copy.unnamedCompany)
  const companyLines = pdf.splitTextToSize(companyName, width - 40, { fontSize: 10 })
  pdf.text(companyLines, left, y + 7, { lineHeightFactor: 1.1 })
  pdf.setFontSize(8)
  pdf.text(copy.brand, right, y + 2, { align: 'right' })
  y += Math.max(18, 7 + companyLines.length * 4.2 + 3)
  pdf.setDrawColor(224, 227, 232)
  pdf.setLineWidth(0.3)
  pdf.line(left, y, right, y)
  y += 7

  const metaGap = 5
  const metaWidth = (width - metaGap * 2) / 3
  const metaHeight = Math.max(
    drawLabelValue(pdf, copy.diagnosisDate, formatReportDate(input.diagnosisDate, locale), left, y, metaWidth),
    drawLabelValue(pdf, copy.optimizationTarget, safeText(input.optimizationTarget, copy.companyOverall), left + metaWidth + metaGap, y, metaWidth),
    drawLabelValue(pdf, copy.website, safeText(input.websiteUrl, copy.noWebsite), left + (metaWidth + metaGap) * 2, y, metaWidth, 7.5),
  )
  y += metaHeight + 3

  const rateGap = 5
  const rateWidth = (width - rateGap) / 2
  const rateItems: Array<[string, string, string]> = [
    [copy.recommendationRate, copy.formatRate(input.recommendationRate), copy.lockedQuestions(QUESTION_TOTAL)],
    [copy.citationRate, input.websiteUrl ? copy.formatRate(input.officialCitationRate) : copy.noWebsite, copy.lockedQuestions(QUESTION_TOTAL)],
  ]
  const rateTop = y
  for (const [index, [label, value, caption]] of rateItems.entries()) {
    const x = left + index * (rateWidth + rateGap)
    pdf.setDrawColor(232, 234, 238)
    pdf.setLineWidth(0.25)
    pdf.line(x, rateTop, x + rateWidth, rateTop)
    pdf.setTextColor(100, 106, 116)
    pdf.setFontSize(7)
    pdf.text(label, x, rateTop + 4)
    pdf.setTextColor(27, 31, 38)
    pdf.setFontSize(index === 1 && input.websiteUrl ? 10 : 9)
    pdf.text(value, x, rateTop + 10)
    pdf.setTextColor(120, 126, 136)
    pdf.setFontSize(6.5)
    pdf.text(caption, x, rateTop + 15)
  }
  y += 21

  pdf.setTextColor(27, 31, 38)
  pdf.setFontSize(11)
  pdf.text(copy.detailHeading(QUESTION_TOTAL), left, y)
  pdf.setTextColor(100, 106, 116)
  pdf.setFontSize(7)
  pdf.text(copy.yesMeaning, right, y, { align: 'right' })
  y += 5

  const questionX = left + 1
  const questionWidth = width - 52
  const recommendationX = left + width - 40
  const citationX = left + width - 19
  const tableHeaderHeight = 7
  const footerFontSize = 6.5
  pdf.setFontSize(footerFontSize)
  const footerLines = pdf.splitTextToSize(copy.footer(QUESTION_TOTAL), width - 20, { fontSize: footerFontSize })
  const footerLineHeight = 3.6
  const footerHeight = Math.max(9, footerLines.length * footerLineHeight + 1.5)
  const tableAvailableHeight = A4_HEIGHT_MM - y - tableHeaderHeight - footerHeight - 7
  const table = fitTable(pdf, answers, questionWidth, tableAvailableHeight, copy.questionNotProvided)

  pdf.setDrawColor(213, 216, 222)
  pdf.setLineWidth(0.3)
  pdf.line(left, y, right, y)
  pdf.setTextColor(100, 106, 116)
  pdf.setFontSize(7)
  pdf.text(copy.question, questionX, y + 4.5)
  pdf.text(copy.recommendation, recommendationX, y + 4.5, { align: 'center' })
  pdf.text(copy.citation, citationX, y + 4.5, { align: 'center' })
  y += tableHeaderHeight

  for (const row of table.rows) {
    const rowTop = y
    pdf.setDrawColor(236, 238, 242)
    pdf.setLineWidth(0.2)
    pdf.line(left, rowTop + row.height, right, rowTop + row.height)
    pdf.setFontSize(table.fontSize)
    pdf.setTextColor(27, 31, 38)
    pdf.text(row.lines, questionX, rowTop + table.lineHeight + 0.8, { lineHeightFactor: 1 })
    pdf.setFontSize(7)
    pdf.setTextColor(27, 31, 38)
    pdf.text(formatResult(row.answer.recommended, true, copy), recommendationX, rowTop + row.height / 2 + 1.4, { align: 'center' })
    pdf.text(formatResult(row.answer.officialCitation, Boolean(input.websiteUrl), copy), citationX, rowTop + row.height / 2 + 1.4, { align: 'center' })
    y += row.height
  }

  pdf.setTextColor(100, 106, 116)
  pdf.setFontSize(footerFontSize)
  pdf.text(footerLines, left, A4_HEIGHT_MM - 8 - (footerLines.length - 1) * footerLineHeight, { lineHeightFactor: 1 })
  pdf.text('1 / 1', right, A4_HEIGHT_MM - 8, { align: 'right' })

  if (pdf.getNumberOfPages && pdf.getNumberOfPages() !== 1) {
    throw new DiagnosisReportRenderError('report_pdf_page_count_invalid')
  }
  const output = pdf.output('arraybuffer')
  const bytes = output instanceof ArrayBuffer ? Buffer.from(new Uint8Array(output)) : Buffer.from(output)
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new DiagnosisReportRenderError('report_pdf_output_invalid')
  }
  return bytes
}
