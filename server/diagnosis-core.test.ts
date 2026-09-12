import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractCitationUrls } from './doubao-client.ts'
import {
  computeOfficialCitation,
  isOfficialCitation,
  resolveRequestedModel,
  runDiagnosisCore,
  type DiagnosisAnswerState,
} from './diagnosis-core.ts'

const testEndpoint = 'https://diagnosis-test-endpoint.example.test/api/v3/responses'
const originalEndpoint = process.env.DOUBAO_API_ENDPOINT

beforeEach(() => {
  process.env.DOUBAO_API_ENDPOINT = testEndpoint
})

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
  else process.env.DOUBAO_API_ENDPOINT = originalEndpoint
})

const questions = Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `企业客户选择服务商时应关注什么${index + 1}？` }))
const project = {
  companyName: '示例科技有限公司',
  websiteUrl: 'https://example.test',
  optimizationTarget: '企业数字化服务',
  supplementalInfo: '面向制造业客户',
}

function pendingAnswers(): DiagnosisAnswerState[] {
  return questions.map((question) => ({
    ...question,
    status: 'pending',
    answerText: null,
    citationUrls: [],
    responseModel: null,
    recommended: null,
    officialCitation: null,
    error: null,
    startedAt: null,
    completedAt: null,
  }))
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function answerResponse(position: number): Response {
  return response({
    model: 'doubao-test-model',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: `回答${position}`,
        annotations: [{ type: 'url_citation', url: `https://www.example.test/answer/${position}` }],
      }],
    }],
  })
}

function analysisResponse(): Response {
  return response({
    model: 'doubao-analysis-model',
    output_text: JSON.stringify({ results: questions.map((question) => ({ position: question.position, recommended: question.position % 2 === 0 })) }),
  })
}

describe('initial diagnosis core', () => {
  it('fixes the first usable requested model and keeps it across configuration changes', () => {
    expect(resolveRequestedModel(null, 'model-v1', 'key')).toBe('model-v1')
    expect(resolveRequestedModel('model-v1', 'model-v2', 'key')).toBe('model-v1')
    expect(resolveRequestedModel(null, 'model-v1', '')).toBeNull()
  })

  it('sends each raw question exactly once with web_search, parses citations, and batches once', async () => {
    const rawBodies: Array<Record<string, unknown>> = []
    const analysisBodies: Array<Record<string, unknown>> = []
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools) {
        rawBodies.push(body)
        const question = String(body.input)
        const position = Number(question.match(/(\d+)？$/)?.[1] ?? 0)
        return answerResponse(position)
      }
      analysisBodies.push(body)
      return analysisResponse()
    }

    const result = await runDiagnosisCore({ project, questions, answers: pendingAnswers(), apiKey: 'key', modelId: 'model', rawFetch: fakeFetch, analysisFetch: fakeFetch })

    expect(rawBodies).toHaveLength(20)
    for (const [index, body] of rawBodies.entries()) {
      expect(body.input).toBe(questions[index]?.question)
      expect(body.tools).toEqual([{ type: 'web_search' }])
      expect(body.text).toBeUndefined()
      expect(String(body.input)).not.toContain(project.companyName)
      expect(String(body.input)).not.toContain('example.test')
    }
    expect(analysisBodies).toHaveLength(1)
    expect(analysisBodies[0]?.tools).toBeUndefined()
    expect((analysisBodies[0]?.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: 'json_schema', strict: true })
    expect(String(analysisBodies[0]?.input)).toContain(project.companyName)
    expect(result.summary.status).toBe('completed')
    expect(result.summary.recommendationRate).toBe(0.5)
    expect(result.summary.officialCitationRate).toBe(1)
    expect(result.answers[0]?.citationUrls).toEqual(['https://www.example.test/answer/1'])
    expect(result.answers[0]?.responseModel).toBe('doubao-test-model')
    expect(result.answers[1]?.recommended).toBe(true)

    let extraBatchCalls = 0
    await runDiagnosisCore({ project, questions, answers: result.answers, apiKey: 'key', modelId: 'model', rawFetch: fakeFetch, analysisFetch: async () => { extraBatchCalls += 1; return analysisResponse() }, analysisCompleted: true })
    expect(extraBatchCalls).toBe(0)
  })

  it('can finish the twenty answers without starting aggregate analysis', async () => {
    const rawBodies: Array<Record<string, unknown>> = []
    const analysisBodies: Array<Record<string, unknown>> = []
    const progressAnswers: DiagnosisAnswerState[] = []
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools) {
        rawBodies.push(body)
        return answerResponse(Number(String(body.input).match(/(\d+)？$/)?.[1] ?? 0))
      }
      analysisBodies.push(body)
      return analysisResponse()
    }

    const result = await runDiagnosisCore({
      project,
      questions,
      answers: pendingAnswers(),
      apiKey: 'key',
      modelId: 'model',
      rawFetch: fakeFetch,
      analysisFetch: fakeFetch,
      deferAnalysis: true,
      onProgress: (progress) => { progressAnswers.push(progress.answer) },
    })

    expect(rawBodies).toHaveLength(20)
    expect(analysisBodies).toHaveLength(0)
    expect(progressAnswers).toHaveLength(20)
    expect(progressAnswers.every((answer) => answer.status === 'success' && answer.answerText)).toBe(true)
    expect(result.summary.status).toBe('not_started')
  })

  it('starts all unfinished question requests before any provider response resolves', async () => {
    let started = 0
    let releaseResponses!: () => void
    const allRequestsStarted = new Promise<void>((resolve) => {
      releaseResponses = resolve
    })
    let runningWrites = 0
    let releaseRunningWrites!: () => void
    const runningWritesComplete = new Promise<void>((resolve) => {
      releaseRunningWrites = resolve
    })
    let resolveAllRunningWrites!: () => void
    const allRunningWritesStarted = new Promise<void>((resolve) => {
      resolveAllRunningWrites = resolve
    })
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (!body.tools) return analysisResponse()
      started += 1
      if (started === 20) releaseResponses()
      await allRequestsStarted
      return answerResponse(Number(String(body.input).match(/(\d+)？$/)?.[1] ?? 0))
    }

    const run = runDiagnosisCore({
      project,
      questions,
      answers: pendingAnswers(),
      apiKey: 'key',
      modelId: 'model',
      rawFetch: fakeFetch,
      deferAnalysis: true,
      onAnswer: (answer) => {
        if (answer.status === 'running') {
          runningWrites += 1
          if (runningWrites === 20) resolveAllRunningWrites()
          return runningWritesComplete
        }
      },
    })

    await allRunningWritesStarted
    expect(started).toBe(20)
    await allRequestsStarted
    expect(started).toBe(20)
    releaseRunningWrites()
    const result = await run
    expect(result.answers.every((answer) => answer.status === 'success')).toBe(true)
  })

  it('rethrows a persistence callback failure after all question tasks settle', async () => {
    let started = 0
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools) started += 1
      return body.tools ? answerResponse(Number(String(body.input).match(/(\d+)？$/)?.[1] ?? 0)) : analysisResponse()
    }

    await expect(runDiagnosisCore({
      project,
      questions,
      answers: pendingAnswers(),
      apiKey: 'key',
      modelId: 'model',
      rawFetch: fakeFetch,
      deferAnalysis: true,
      onAnswer: (answer) => {
        if (answer.position === 1 && answer.status === 'running') throw new Error('answer persistence failed')
      },
    })).rejects.toThrow('answer persistence failed')
    expect(started).toBe(20)
  })

  it('continues after a failed question and retries only that question without replacing successes', async () => {
    let firstRun = true
    const firstBodies: string[] = []
    const firstFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (!body.tools) return analysisResponse()
      firstBodies.push(String(body.input))
      if (String(body.input) === questions[2]?.question && firstRun) return new Response('bad gateway', { status: 502 })
      return answerResponse(Number(String(body.input).match(/(\d+)？$/)?.[1] ?? 0))
    }
    const first = await runDiagnosisCore({ project, questions, answers: pendingAnswers(), apiKey: 'key', modelId: 'model', rawFetch: firstFetch, analysisFetch: firstFetch })
    expect(firstBodies).toHaveLength(20)
    expect(first.answers[2]?.status).toBe('failed')
    expect(first.answers[0]?.answerText).toBe('回答1')

    firstRun = false
    const retryBodies: string[] = []
    const retryFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.tools) {
        retryBodies.push(String(body.input))
        return answerResponse(3)
      }
      return analysisResponse()
    }
    const retried = await runDiagnosisCore({ project, questions, answers: first.answers, apiKey: 'key', modelId: 'model', rawFetch: retryFetch, analysisFetch: retryFetch })
    expect(retryBodies).toEqual([questions[2]?.question])
    expect(retried.answers[0]?.answerText).toBe('回答1')
    expect(retried.answers[2]?.status).toBe('success')
    expect(retried.summary.status).toBe('completed')
  })

  it('uses exact host/subdomain matching and leaves official citation unavailable without a website', () => {
    expect(isOfficialCitation('https://example.test/about', 'https://example.test')).toBe(true)
    expect(isOfficialCitation('https://docs.example.test/about', 'https://example.test')).toBe(true)
    expect(isOfficialCitation('https://example.test.evil.test/about', 'https://example.test')).toBe(false)
    expect(isOfficialCitation('https://notexample.test/about', 'https://example.test')).toBe(false)
    expect(computeOfficialCitation(null, ['https://example.test/about'])).toBeNull()
  })

  it('returns null official-citation values for a diagnosis without a website', async () => {
    const answers = pendingAnswers().map((answer) => ({
      ...answer,
      status: 'success' as const,
      answerText: '外部回答',
      citationUrls: ['https://other.test/source'],
      responseModel: 'test-model',
    }))
    const result = await runDiagnosisCore({
      project: { ...project, websiteUrl: null },
      questions,
      answers,
      apiKey: 'key',
      modelId: 'model',
      analysisFetch: async () => analysisResponse(),
    })
    expect(result.summary.officialCitationRate).toBeNull()
    expect(result.answers.every((answer) => answer.officialCitation === null)).toBe(true)
  })

  it('reads URLs only from response annotations', () => {
    expect(extractCitationUrls({ url: 'https://not-a-citation.test', output: [{ content: [{ annotations: [{ url: 'https://source.test/a' }, { source: { url: 'https://source.test/b' } }] }] }] })).toEqual([
      'https://source.test/a',
      'https://source.test/b',
    ])
  })
})
