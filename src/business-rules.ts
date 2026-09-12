/**
 * Shared product rules used by both the browser and server runtime. Keep the
 * total derived from the category quotas so validation, progress and reports
 * cannot silently drift from the generated question set.
 */
export const QUESTION_GROUP_COUNTS = {
  recommendation: 10,
  selection: 6,
  decision: 4,
} as const

export type QuestionCategory = keyof typeof QUESTION_GROUP_COUNTS

export const QUESTION_TOTAL = Object.values(QUESTION_GROUP_COUNTS)
  .reduce((total, count) => total + count, 0)

export const QUESTION_POSITION_MIN = 1
export const QUESTION_POSITION_MAX = QUESTION_TOTAL

export const ARTICLE_OPTIMIZATION_DIRECTIONS = ['主题内容补充', '补充 FAQ', '补充权威来源'] as const
export type ArticleOptimizationDirection = typeof ARTICLE_OPTIMIZATION_DIRECTIONS[number]
