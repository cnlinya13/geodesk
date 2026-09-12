/**
 * Locale and fixed copy for the server-rendered diagnosis PDF.
 *
 * Keep this module independent from the React i18n provider: the report is
 * rendered by the Node API and must use the locale captured when its request
 * was accepted.
 */
import { QUESTION_TOTAL } from '../src/business-rules.ts'

export const DIAGNOSIS_REPORT_LOCALES = ['zh-CN', 'en'] as const
export type DiagnosisReportLocale = typeof DIAGNOSIS_REPORT_LOCALES[number]

export const DEFAULT_DIAGNOSIS_REPORT_LOCALE: DiagnosisReportLocale = 'zh-CN'

export function resolveDiagnosisReportLocale(value: unknown): DiagnosisReportLocale {
  return value === 'en' || value === 'zh-CN' ? value : DEFAULT_DIAGNOSIS_REPORT_LOCALE
}

export type DiagnosisReportCopy = {
  title: string
  brand: string
  diagnosisDate: string
  optimizationTarget: string
  website: string
  recommendationRate: string
  citationRate: string
  lockedQuestions: (count: number) => string
  detailHeading: (count: number) => string
  yesMeaning: string
  question: string
  recommendation: string
  citation: string
  footer: (count: number) => string
  noWebsite: string
  companyOverall: string
  unnamedCompany: string
  questionNotProvided: string
  resultYes: string
  resultNo: string
  resultPending: string
  resultUnavailable: string
  formatRate: (value: number | null) => string
}

const copy: Record<DiagnosisReportLocale, DiagnosisReportCopy> = {
  'zh-CN': {
    title: 'GEO 诊断报告',
    brand: 'GEO运营台',
    diagnosisDate: '诊断日期',
    optimizationTarget: '优化对象',
    website: '客户官网',
    recommendationRate: 'AI推荐率',
    citationRate: '官网引用率',
    lockedQuestions: (count) => `${count}个锁定问题`,
    detailHeading: (count) => `${count} 个问题诊断明细`,
    yesMeaning: '是 = 被推荐 / 引用客户官网',
    question: '问题',
    recommendation: '推荐',
    citation: '官网引用',
    footer: (count) => `本报告仅记录本次 ${count} 个问题的推荐与官网引用结果。`,
    noWebsite: '未配置官网',
    companyOverall: '公司整体',
    unnamedCompany: '未命名公司',
    questionNotProvided: '未提供问题',
    resultYes: '是',
    resultNo: '否',
    resultPending: '待判断',
    resultUnavailable: '无法判断',
    formatRate: (value) => formatRate(value, '（', '）'),
  },
  en: {
    title: 'GEO Diagnosis Report',
    brand: 'GEO Desk',
    diagnosisDate: 'Diagnosis date',
    optimizationTarget: 'Optimization target',
    website: 'Customer website',
    recommendationRate: 'AI recommendation rate',
    citationRate: 'Website citation rate',
    lockedQuestions: (count) => `${count} locked questions`,
    detailHeading: (count) => `Details for ${count} diagnosis questions`,
    yesMeaning: 'Yes = recommended / cited customer website',
    question: 'Question',
    recommendation: 'Recommendation',
    citation: 'Website citation',
    footer: (count) => `This report records recommendations and website citations for these ${count} questions.`,
    noWebsite: 'No website configured',
    companyOverall: 'Company overall',
    unnamedCompany: 'Unnamed company',
    questionNotProvided: 'Question not provided',
    resultYes: 'Yes',
    resultNo: 'No',
    resultPending: 'Pending',
    resultUnavailable: 'Unavailable',
    formatRate: (value) => formatRate(value, ' (', ')'),
  },
}

function formatRate(value: number | null, opening: string, closing: string): string {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1) return '—'
  return `${Math.round(value * 100)}%${opening}${Math.round(value * QUESTION_TOTAL)} / ${QUESTION_TOTAL}${closing}`
}

export function diagnosisReportCopy(locale: DiagnosisReportLocale = DEFAULT_DIAGNOSIS_REPORT_LOCALE): DiagnosisReportCopy {
  return copy[locale] ?? copy[DEFAULT_DIAGNOSIS_REPORT_LOCALE]
}
