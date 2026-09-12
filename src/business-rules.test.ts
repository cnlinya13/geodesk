import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ARTICLE_OPTIMIZATION_DIRECTIONS,
  QUESTION_GROUP_COUNTS,
  QUESTION_POSITION_MAX,
  QUESTION_POSITION_MIN,
  QUESTION_TOTAL,
} from './business-rules'

describe('shared business rules', () => {
  it('derives the fixed question total and position range from the 10/6/4 quotas', () => {
    expect(QUESTION_GROUP_COUNTS).toEqual({ recommendation: 10, selection: 6, decision: 4 })
    expect(QUESTION_TOTAL).toBe(20)
    expect(QUESTION_POSITION_MIN).toBe(1)
    expect(QUESTION_POSITION_MAX).toBe(QUESTION_TOTAL)
  })

  it('keeps the three article optimization directions in one ordered source', () => {
    expect(ARTICLE_OPTIMIZATION_DIRECTIONS).toEqual(['主题内容补充', '补充 FAQ', '补充权威来源'])
  })

  it('keeps persisted question-position migration bounds aligned with QUESTION_TOTAL', () => {
    const migrationFiles = [
      '002_website_questions.sql',
      '003_initial_diagnosis.sql',
      '005_articles.sql',
      '006_monitoring_and_article_questions.sql',
      '007_fix_question_positions_validator.sql',
      '012_article_targets_and_dedup.sql',
    ]
    const sql = migrationFiles
      .map((name) => readFileSync(fileURLToPath(new URL(`../server/migrations/${name}`, import.meta.url)), 'utf8'))
      .join('\n')
    const maximums = [
      ...sql.matchAll(/\bposition\s+between\s+1\s+and\s+(\d+)/gi),
      ...sql.matchAll(/jsonb_array_length\(value\)\s*>\s*(\d+)/gi),
      ...sql.matchAll(/\bnumeric_position\s*>\s*(\d+)/gi),
    ].map((match) => Number(match[1]))

    expect(maximums.length).toBeGreaterThan(0)
    expect(maximums.every((maximum) => maximum === QUESTION_TOTAL)).toBe(true)
  })
})
