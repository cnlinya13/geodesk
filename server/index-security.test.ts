import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

function routeBlock(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`route markers not found: ${startMarker}`)
  return source.slice(start, end)
}

describe('article write route source boundary', () => {
  it('rejects cross-site article requests before database or model calls', () => {
    const routes = [
      routeBlock('const articleGenerateId =', 'const articleWriteId ='),
      routeBlock('const articleWriteId =', 'const articleConfirmId ='),
      routeBlock('const articleConfirmId =', 'const diagnosisId ='),
    ]
    for (const route of routes) {
      const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
      const firstDatabaseOrModelCall = Math.min(
        ...['generateProjectArticles(', 'startArticleWriting(', 'confirmArticlePublished(']
          .map((marker) => route.indexOf(marker))
          .filter((index) => index >= 0),
      )
      expect(guard).toBeGreaterThanOrEqual(0)
      expect(route.indexOf("sendError(response, 403, 'cross_site_request'", guard)).toBeGreaterThan(guard)
      expect(guard).toBeLessThan(firstDatabaseOrModelCall)
    }
  })

  it('places the same-site guard before single-article deletion', () => {
    const route = routeBlock('const articleDeleteId =', 'const articleWriteId =')
    const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
    const database = route.indexOf('deleteArticle(')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(database).toBeGreaterThan(guard)
    expect(route.indexOf("sendError(response, 403, 'cross_site_request'", guard)).toBeGreaterThan(guard)
  })

  it('guards both destructive project-edit PATCH routes before reading or saving the body', () => {
    const routes = [
      routeBlock('const websiteId =', 'const articleGenerateId ='),
      routeBlock('if (request.method === \'PATCH\' && projectId)', 'sendError(response, 404, \'not_found\''),
    ]
    for (const route of routes) {
      const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
      const bodyRead = route.indexOf('readBody(request)')
      const database = Math.min(
        ...['updateProjectWebsiteWithChange(', 'updateProjectWithWebsiteChange(']
          .map((marker) => route.indexOf(marker))
          .filter((index) => index >= 0),
      )
      expect(guard).toBeGreaterThanOrEqual(0)
      expect(route.indexOf("sendError(response, 403, 'cross_site_request'", guard)).toBeGreaterThan(guard)
      expect(guard).toBeLessThan(bodyRead)
      expect(guard).toBeLessThan(database)
    }
  })

  it('guards single-question PATCH and DELETE before body or database access', () => {
    const route = routeBlock('const questionMutationIds =', 'const websiteId =')
    const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
    const bodyRead = route.indexOf('readBody(request)')
    const database = Math.min(
      ...['setQuestionLocked(', 'deleteQuestion(']
        .map((marker) => route.indexOf(marker))
        .filter((index) => index >= 0),
    )

    expect(guard).toBeGreaterThanOrEqual(0)
    expect(route.indexOf("sendError(response, 403, 'cross_site_request'", guard)).toBeGreaterThan(guard)
    expect(guard).toBeLessThan(bodyRead)
    expect(guard).toBeLessThan(database)
    expect(route).toContain("typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()")
    expect(route).toContain("request.method === 'PATCH' && typeof body.isLocked !== 'boolean'")
    expect(route).toContain("sendError(response, 409, 'project_changed'")
  })

  it('requires an expected project timestamp for generation and confirmation', () => {
    const routes = [
      routeBlock('const generateId =', 'const confirmId ='),
      routeBlock('const confirmId =', 'const questionMutationIds ='),
    ]
    for (const route of routes) {
      const timestampCheck = route.indexOf("typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt.trim()")
      const database = Math.min(
        ...['generateProjectQuestions(', 'confirmQuestions(']
          .map((marker) => route.indexOf(marker))
          .filter((index) => index >= 0),
      )
      expect(timestampCheck).toBeGreaterThanOrEqual(0)
      expect(timestampCheck).toBeLessThan(database)
      expect(route).toContain("sendError(response, 409, 'project_changed'")
    }
  })

  it('keeps the existing local Origin and Host boundary as the shared policy', () => {
    expect(source).toContain("if (originHeader === 'null') return true")
    expect(source).toContain('isAllowedLocalRuntimeOrigin(originHeader)')
    expect(source).toContain('isAllowedLocalRuntimeHostHeader(host)')
  })
})

describe('question generation background task protocol', () => {
  it('accepts a persisted task and returns 202 for both new and duplicate requests', () => {
    const route = routeBlock('const generateId =', 'const confirmId =')
    expect(route).toContain("getRunningAiTask(generateId, 'questions')")
    expect(route).toContain("sendJson(response, 202, { ok: true, task: existingTask })")
    expect(route).toContain("acceptAndRunAiTask(generateId, 'questions', null")
    expect(route).toContain("sendJson(response, 202, { ok: true, task })")
    expect(route).toContain("sendError(response, 503, 'generation_unavailable'")
  })

  it('keeps generation guards before any stream headers or generation call', () => {
    const route = routeBlock('const generateId =', 'const confirmId =')
    const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
    const bodyRead = route.indexOf('readBody(request)')
    const generation = route.indexOf('generateProjectQuestions(')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(bodyRead)
    expect(bodyRead).toBeLessThan(generation)
  })
})

describe('technical audit NDJSON protocol', () => {
  it('streams each item and only emits complete after executeTechnicalAudit returns', () => {
    const route = routeBlock("if (technicalAuditId && request.method === 'POST')", 'const projectId =')
    expect(route).toContain('acceptsTechnicalAuditStream(request)')
    expect(route).toContain("type: 'item'")
    expect(route).toContain('rule_version: TECHNICAL_AUDIT_RULE_VERSION')
    expect(route).toContain('completedCount')
    expect(route).toContain('total')
    expect(route).toContain("type: 'complete', audit")
    expect(route).toContain("streamError('technical_audit_failed'")
  })

  it('retains the original HTTP guard/error path until the first item starts the stream', () => {
    const route = routeBlock("if (technicalAuditId && request.method === 'POST')", 'const projectId =')
    const guard = route.indexOf('technicalAuditPostIsCrossSite(request)')
    const streamAccept = route.indexOf('const wantsStream = acceptsTechnicalAuditStream(request)')
    const execute = route.indexOf('executeTechnicalAudit(')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(streamAccept)
    expect(streamAccept).toBeLessThan(execute)
    expect(route).toContain("sendError(response, 409, 'technical_audit_in_progress'")
    expect(route).toContain("sendError(response, 503, 'technical_audit_execution_failed'")
  })
})
