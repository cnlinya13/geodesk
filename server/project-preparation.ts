import process from 'node:process'
import { parse } from 'node-html-parser'
import {
  beginQuestionGeneration,
  getProjectDetail,
  projectQuestionInput,
  saveQuestionGenerationError,
  saveQuestions,
} from './db.ts'
import {
  generateQuestions,
  QuestionGenerationError,
  QUESTION_SOURCE_INSUFFICIENT_MESSAGE,
  type QuestionGenerationProgress,
} from './question-generator.ts'
import { SafeAuditHttpClient, TechnicalAuditHttpError, type PublicAddress, type SafeHttpResponse, type SafeRequestTransport } from './technical-audit-http.ts'
import { evaluateRobots, isRobotsText, parseRobots } from './technical-audit-robots.ts'
import { analyzeAnonymousPage } from './technical-audit-login.ts'
import type { WebsitePageResult } from './site-crawler.ts'

export class ProjectPreparationError extends Error {}

export type GenerateProjectQuestionsOptions = {
  stream?: boolean
  onProgress?: (progress: QuestionGenerationProgress) => void | Promise<void>
  signal?: AbortSignal
  taskId?: string
  /** Injectable transport for the one website-only, task-scoped read. */
  websiteFetch?: typeof fetch
}

function configuration(): { apiKey: string; modelId: string } {
  return {
    apiKey: process.env.DOUBAO_API_KEY?.trim() ?? '',
    modelId: process.env.DOUBAO_MODEL_ID?.trim() ?? '',
  }
}

const TEMPORARY_READ_MAX_RESPONSE_BYTES = 1_000_000
const TEMPORARY_READ_MAX_TEXT_CHARS = 20_000
const TEMPORARY_READ_TIMEOUT_MS = 8_000
const TEMPORARY_READ_TOTAL_TIMEOUT_MS = 16_000
const TEMPORARY_READ_MAX_REDIRECTS = 3

function websiteUrlForTemporaryRead(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new ProjectPreparationError('website_url_invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !parsed.hostname) {
    throw new ProjectPreparationError('website_url_invalid')
  }
  // Fragments are not sent over HTTP. Keep query parameters because they are
  // part of the user-supplied page identity and may select the actual page.
  parsed.hash = ''
  return parsed
}

function sameReadScope(value: URL, root: URL): boolean {
  if (value.origin.toLowerCase() !== root.origin.toLowerCase()) return false
  const rootPath = root.pathname || '/'
  if (rootPath === '/') return true
  const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const targetPath = value.pathname || '/'
  return targetPath === normalizedRoot || targetPath.startsWith(`${normalizedRoot}/`)
}

function relativeResourceUrl(root: URL, filename: string): string {
  const base = new URL(root.toString())
  if (base.pathname !== '/' && !base.pathname.endsWith('/')) base.pathname += '/'
  const resource = new URL(filename, base)
  resource.hash = ''
  return resource.toString()
}

async function fetchResponseBodyBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > maxBytes) throw new TechnicalAuditHttpError('response_too_large', '响应内容超过大小限制', response.url)
    return body
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new TechnicalAuditHttpError('response_too_large', '响应内容超过大小限制', response.url)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function transportFromFetcher(fetcher: typeof fetch, signal?: AbortSignal): SafeRequestTransport {
  return async (url: URL, _address: PublicAddress, options): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
    const controller = new AbortController()
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs))
    try {
      const response = await fetcher(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: requestSignal,
        headers: options.headers,
      })
      const body = await fetchResponseBodyBounded(response, options.maxWireBytes)
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
}

function responseFromSafeHttp(response: SafeHttpResponse): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body.toString('utf8'),
  }
}

function temporaryPageFromHtml(url: string, html: string): WebsitePageResult {
  const root = parse(html)
  const title = root.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim() ?? ''
  for (const selector of ['script', 'style', 'noscript', 'template', 'svg']) {
    for (const node of root.querySelectorAll(selector)) node.remove()
  }
  const body = root.querySelector('body')
  if (!body) root.querySelector('head')?.remove()
  const text = (body ?? root).structuredText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  if ((!title && !text) || text.length > TEMPORARY_READ_MAX_TEXT_CHARS) {
    throw new ProjectPreparationError('website_read_failed')
  }
  return { url, title, bodyText: text, status: 'success', error: null }
}

/**
 * Read exactly one HTML page for a website-only question generation request.
 * This function deliberately has no database/cache side effect.  Redirects
 * stay on the exact submitted origin, response/body sizes are bounded, and
 * script/style markup is removed before the temporary text enters the model
 * prompt.
 */
export async function readTemporaryWebsitePage(
  websiteUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WebsitePageResult> {
  const root = websiteUrlForTemporaryRead(websiteUrl)
  if (signal?.aborted) throw new ProjectPreparationError('website_read_failed')
  const robotsUrl = relativeResourceUrl(root, 'robots.txt')
  const robotsPath = new URL(robotsUrl).pathname

  // The default transport is the SSRF-safe client (DNS pinning, public-IP
  // filtering, TLS verification, bounded redirects and response sizes).  A
  // test or caller supplied fetcher is adapted to the same client interface;
  // it never replaces the client's URL, redirect or robots authorization.
  let robotsRequestActive = true
  let pageRequestActive = false
  let robotsGate: (url: URL) => boolean = () => true
  // SafeAuditHttpClient intentionally redacts query strings from its public
  // response URL. Capture the actual URL at the authorization boundary for
  // the temporary page identity instead; this is also the last URL admitted
  // to DNS/transport, including a redirect's query.
  let lastAuthorizedPageUrl = root.toString()
  const client = new SafeAuditHttpClient({
    origin: root.origin,
    // One robots resource and one page resource, each with bounded redirect
    // hops.  Redirects still count against this task-local budget.
    maxRequests: 2 * (TEMPORARY_READ_MAX_REDIRECTS + 1),
    timeoutMs: TEMPORARY_READ_TIMEOUT_MS,
    deadlineAt: Date.now() + TEMPORARY_READ_TOTAL_TIMEOUT_MS,
    maxDecompressedBytes: TEMPORARY_READ_MAX_RESPONSE_BYTES,
    maxRedirects: TEMPORARY_READ_MAX_REDIRECTS,
    ...(fetcher === fetch ? {} : { transport: transportFromFetcher(fetcher, signal) }),
    authorizeUrl: (url) => {
      if (robotsRequestActive) {
        // The rules file is relative to the submitted entry, and redirects
        // may not fall back to the origin root or escape that entry scope.
        // Do not use a boolean phase flag as an unconditional allow.
        return sameReadScope(url, root) && url.pathname === robotsPath
      }
      if (!pageRequestActive) return false
      const allowed = sameReadScope(url, root) && robotsGate(url)
      if (allowed) lastAuthorizedPageUrl = url.toString()
      return allowed
    },
  })

  try {
    const robotsResponse = await client.get(robotsUrl, 'text/plain,*/*;q=0.1')
    robotsRequestActive = false
    const robots = responseFromSafeHttp(robotsResponse)
    const robotsMissing = [404, 410].includes(robots.status)
    const contentType = robots.headers['content-type'] ?? ''
    const robotsUsable = robots.status >= 200 && robots.status < 300
      && !/html|xhtml|json/i.test(contentType)
      && isRobotsText(robots.body)
    // A missing robots file is not a restriction.  An unreadable response is
    // handled fail-closed for this one temporary read; do not fetch the page
    // after an HTML/WAF/error replacement pretending to be robots.txt.
    if (!robotsMissing && !robotsUsable) throw new ProjectPreparationError('website_read_failed')
    const groups = robotsUsable ? parseRobots(robots.body) : []
    robotsGate = (url) => {
      if (robotsMissing) return true
      if (!robotsUsable) return false
      const evaluation = evaluateRobots(groups, 'geodesk', [`${url.pathname || '/'}${url.search}`])
      return evaluation?.results[0]?.allowed ?? true
    }

    pageRequestActive = true
    let pageResponse: SafeHttpResponse
    try {
      pageResponse = await client.get(root, 'text/html,application/xhtml+xml;q=0.9')
    } finally {
      pageRequestActive = false
    }
    if (pageResponse.status < 200 || pageResponse.status >= 300) throw new ProjectPreparationError('website_read_failed')
    const pageType = pageResponse.headers['content-type'] ?? ''
    if (pageType && !/html|xhtml/i.test(pageType)) throw new ProjectPreparationError('website_read_failed')
    const html = pageResponse.body.toString('utf8')
    const anonymous = analyzeAnonymousPage({
      html,
      requestedUrl: root.toString(),
      finalUrl: lastAuthorizedPageUrl,
    })
    if (!anonymous.readable || anonymous.blocked || anonymous.challenge) {
      throw new ProjectPreparationError('website_read_failed')
    }
    return temporaryPageFromHtml(lastAuthorizedPageUrl, html)
  } catch (error) {
    if (error instanceof ProjectPreparationError) throw error
    // Do not expose transport, DNS, redirect, robots or body details to the
    // question-generation task.  The task boundary records one safe failure.
    throw new ProjectPreparationError('website_read_failed')
  }
}

function preparationError(error: unknown): ProjectPreparationError | null {
  const reason = error instanceof Error ? error.message : ''
  if (reason === 'questions_locked'
    || reason === 'questions_generation_in_progress'
    || reason === 'all_questions_locked'
    || reason === 'project_changed'
    || reason === 'question_categories_required'
    || reason === 'question_source_required'
    || reason === 'project_tasks_in_progress'
    || reason === 'website_read_failed'
    || reason === 'question_source_insufficient'
    || reason === 'website_url_invalid') {
    return new ProjectPreparationError(reason)
  }
  return null
}

/**
 * Generate questions from the current saved profile.  Business information is
 * sufficient on its own; only the website-only branch performs one bounded,
 * task-scoped HTML read.  No website page is persisted as a question input.
 * The token passed to saveQuestions/saveQuestionGenerationError prevents an
 * in-flight response from reviving questions invalidated by a later profile
 * or URL change.
 */
export async function generateProjectQuestions(
  projectId: string,
  expectedUpdatedAt: string,
  options: GenerateProjectQuestionsOptions = {},
): Promise<Awaited<ReturnType<typeof getProjectDetail>>> {
  let preparation
  try {
    preparation = await beginQuestionGeneration(projectId, expectedUpdatedAt, options.taskId)
  } catch (error) {
    const known = preparationError(error)
    if (known) throw known
    throw error
  }
  if (!preparation) return null

  try {
    let pages = preparation.pages ?? []
    const hasBusinessSource = Boolean(
      preparation.project.optimizationTarget?.trim() || preparation.project.supplementalInfo?.trim(),
    )
    if (!hasBusinessSource && preparation.project.websiteUrl) {
      pages = [await readTemporaryWebsitePage(preparation.project.websiteUrl, options.websiteFetch ?? fetch, options.signal)]
    }
    // The generator intentionally accepts only the public question/category
    // pair. Do not pass persistence metadata such as id, position, or lock
    // state into its strict input validator.
    const lockedQuestions = (preparation.lockedQuestions ?? []).map(({ question, category }) => {
      if (!category) throw new ProjectPreparationError('question_categories_required')
      return { question, category }
    })
    const questions = await generateQuestions(
      projectQuestionInput(preparation.project, pages, lockedQuestions),
      {
        ...configuration(),
        timeoutMs: 0,
        signal: options.signal,
        ...(options.stream || options.onProgress
          ? {
              stream: options.stream,
              onProgress: async (progress: QuestionGenerationProgress) => {
                if (!options.onProgress) return
                try {
                  await options.onProgress(progress)
                } catch {
                  // A closed HTTP response must not fail the database-backed task.
                }
              },
            }
          : {}),
      },
    )
    await saveQuestions(projectId, questions, preparation.generationToken)
  } catch (error) {
    const rawMessage = error instanceof QuestionGenerationError || error instanceof Error ? error.message : '问题生成失败'
    const message = rawMessage === 'website_read_failed' || rawMessage === 'question_source_insufficient'
      ? QUESTION_SOURCE_INSUFFICIENT_MESSAGE
      : rawMessage
    await saveQuestionGenerationError(projectId, message, preparation.generationToken)
  }
  return getProjectDetail(projectId)
}
