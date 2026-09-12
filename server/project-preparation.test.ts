import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginQuestionGeneration: vi.fn(),
  getProjectDetail: vi.fn(),
  projectQuestionInput: vi.fn((project: unknown, pages: unknown) => ({ project, pages })),
  saveQuestionGenerationError: vi.fn(),
  saveQuestions: vi.fn(),
  generateQuestions: vi.fn(),
  QuestionGenerationError: class extends Error {},
}))

vi.mock('./db.ts', () => mocks)
vi.mock('./site-crawler.ts', () => ({}))
vi.mock('./question-generator.ts', () => ({
  generateQuestions: mocks.generateQuestions,
  QuestionGenerationError: mocks.QuestionGenerationError,
  QUESTION_SOURCE_INSUFFICIENT_MESSAGE: '当前资料不足以识别主营业务，请补充优化对象或业务信息后，再生成诊断提纲。',
}))

const { ProjectPreparationError, generateProjectQuestions, readTemporaryWebsitePage } = await import('./project-preparation.ts')

const project = {
  id: '1',
  companyName: '示例公司',
  websiteUrl: 'https://example.test',
  optimizationTarget: '服务',
  supplementalInfo: '补充资料',
  questionsLockedAt: null,
  questionsGenerationStatus: 'not_started',
  updatedAt: '2026-09-06T05:00:01.000Z',
}

function generatedQuestions(prefix: string): Array<{ question: string; category: 'recommendation' | 'selection' | 'decision' }> {
  return Array.from({ length: 20 }, (_, index) => ({
    question: `${prefix}${index + 1}`,
    category: index < 10 ? 'recommendation' : index < 16 ? 'selection' : 'decision',
  }))
}

describe('project preparation flow', () => {
  it('generates manually from one snapshot and commits with its task token', async () => {
    mocks.beginQuestionGeneration.mockResolvedValue({
      project,
      pages: [],
      generationToken: '2026-09-06T05:00:00.123000+00',
    })
    mocks.generateQuestions.mockResolvedValue(generatedQuestions('问题'))
    mocks.getProjectDetail.mockResolvedValue({ ...project, questions: [] })

    await generateProjectQuestions('1', project.updatedAt)

    expect(mocks.generateQuestions).toHaveBeenCalledOnce()
    expect(mocks.saveQuestions).toHaveBeenCalledWith('1', expect.arrayContaining([{ question: '问题1', category: 'recommendation' }]), '2026-09-06T05:00:00.123000+00')
    expect(mocks.saveQuestionGenerationError).not.toHaveBeenCalled()
    expect(mocks.projectQuestionInput).toHaveBeenCalledWith(project, [], [])
  })

  it('reads one temporary page only for a website-only project', async () => {
    const websiteOnlyProject = { ...project, optimizationTarget: null, supplementalInfo: null }
    mocks.beginQuestionGeneration.mockResolvedValueOnce({
      project: websiteOnlyProject,
      pages: [],
      generationToken: 'website-only-token',
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(
        '<html><head><title>首页</title></head><body><script>secret()</script><p>业务正文</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ))
    mocks.generateQuestions.mockResolvedValueOnce(generatedQuestions('官网问题'))
    mocks.getProjectDetail.mockResolvedValueOnce({ ...websiteOnlyProject, questions: [] })

    await generateProjectQuestions('1', websiteOnlyProject.updatedAt, { websiteFetch: fetcher })

    expect(fetcher).toHaveBeenNthCalledWith(1, `${websiteOnlyProject.websiteUrl}/robots.txt`, expect.objectContaining({ redirect: 'manual' }))
    expect(fetcher).toHaveBeenNthCalledWith(2, `${websiteOnlyProject.websiteUrl}/`, expect.objectContaining({ redirect: 'manual' }))
    expect(mocks.projectQuestionInput).toHaveBeenCalledWith(
      websiteOnlyProject,
      [{ url: `${websiteOnlyProject.websiteUrl}/`, title: '首页', bodyText: '业务正文', status: 'success', error: null }],
      [],
    )
  })

  it('rejects generation while another generation is running', async () => {
    mocks.beginQuestionGeneration.mockRejectedValueOnce(new Error('questions_generation_in_progress'))
    await expect(generateProjectQuestions('1', project.updatedAt)).rejects.toMatchObject({
      constructor: ProjectPreparationError,
      message: 'questions_generation_in_progress',
    })
  })

  it('does not write a stale generation result after the task is invalidated', async () => {
    mocks.beginQuestionGeneration.mockResolvedValue({ project, pages: [], generationToken: 'old-token' })
    mocks.generateQuestions.mockResolvedValue(generatedQuestions('旧问题'))
    mocks.saveQuestions.mockResolvedValue(false)
    mocks.getProjectDetail.mockResolvedValue({ ...project, questions: [] })

    await generateProjectQuestions('1', project.updatedAt)

    expect(mocks.saveQuestions).toHaveBeenCalledWith('1', expect.any(Array), 'old-token')
    expect(mocks.saveQuestionGenerationError).not.toHaveBeenCalled()
  })

  it('passes streaming progress through without changing the transactional save boundary', async () => {
    mocks.beginQuestionGeneration.mockResolvedValue({ project, pages: [], generationToken: 'stream-token' })
    const generated = generatedQuestions('流式问题')
    mocks.generateQuestions.mockImplementationOnce(async (_input: unknown, options: { stream?: boolean; onProgress?: (event: unknown) => void }) => {
      expect(options.stream).toBe(true)
      options.onProgress?.({ completedCount: 1, total: 20, questions: [generated[0]] })
      return generated
    })
    mocks.saveQuestions.mockResolvedValueOnce(true)
    mocks.getProjectDetail.mockResolvedValueOnce({ ...project, questions: [] })
    const progress: unknown[] = []

    await generateProjectQuestions('1', project.updatedAt, {
      stream: true,
      onProgress: (event) => { progress.push(event) },
    })

    expect(progress).toHaveLength(1)
    expect(mocks.saveQuestions).toHaveBeenCalledWith('1', generated, 'stream-token')
  })

  it('never saves partial questions when the streaming generator rejects', async () => {
    mocks.beginQuestionGeneration.mockResolvedValueOnce({ project, pages: [], generationToken: 'failed-stream-token' })
    mocks.generateQuestions.mockRejectedValueOnce(new mocks.QuestionGenerationError('豆包流式响应未完成'))
    mocks.saveQuestionGenerationError.mockResolvedValueOnce(true)
    mocks.getProjectDetail.mockResolvedValueOnce({
      ...project,
      updatedAt: '2026-09-06T05:00:02.000Z',
      questionsGeneration: { status: 'failed', error: '豆包流式响应未完成' },
    })

    await generateProjectQuestions('1', project.updatedAt, { stream: true })

    expect(mocks.saveQuestions).not.toHaveBeenCalledWith('1', expect.anything(), 'failed-stream-token')
    expect(mocks.saveQuestionGenerationError).toHaveBeenCalledWith('1', '豆包流式响应未完成', 'failed-stream-token')
  })

  it('rejects a non-HTML temporary read and never sends it to the generator', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('not html', {
      headers: { 'content-type': 'application/json' },
    }))

    await expect(readTemporaryWebsitePage('https://example.test', fetcher)).rejects.toMatchObject({
      constructor: ProjectPreparationError,
      message: 'website_read_failed',
    })
  })

  it('honors robots denial before the one temporary page read', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('User-agent: *\nDisallow: /', { headers: { 'content-type': 'text/plain' } }))

    await expect(readTemporaryWebsitePage('https://example.test/about', fetcher)).rejects.toMatchObject({
      constructor: ProjectPreparationError,
      message: 'website_read_failed',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a redirect outside the submitted path scope', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/' } }))

    await expect(readTemporaryWebsitePage('https://example.test/about', fetcher)).rejects.toMatchObject({
      constructor: ProjectPreparationError,
      message: 'website_read_failed',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('resolves robots relative to a non-root entry path without falling back to origin root', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('<main><p>公开业务正文</p></main>', { headers: { 'content-type': 'text/html' } }))

    await expect(readTemporaryWebsitePage('https://example.test/about', fetcher)).resolves.toMatchObject({ status: 'success' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://example.test/about/robots.txt')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.test/about')
  })

  it('does not follow a relative robots redirect back to the origin root', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/robots.txt' } }))

    await expect(readTemporaryWebsitePage('https://example.test/about', fetcher)).rejects.toMatchObject({
      constructor: ProjectPreparationError,
      message: 'website_read_failed',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains the query on the final authorized page identity after a redirect', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/about/?view=public' } }))
      .mockResolvedValueOnce(new Response('<main><p>公开业务正文</p></main>', { headers: { 'content-type': 'text/html' } }))

    await expect(readTemporaryWebsitePage('https://example.test/about?tenant=acme', fetcher)).resolves.toMatchObject({
      url: 'https://example.test/about/?view=public',
      status: 'success',
    })
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.test/about?tenant=acme')
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://example.test/about/?view=public')
  })

  it('rejects anonymous login and challenge replacements without sending them to the model', async () => {
    for (const body of [
      '<main><h1>登录</h1><form><input type="password"><button>登录</button></form></main>',
      '<main><div id="challenge">Verify you are human</div></main>',
    ]) {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 404, headers: { 'content-type': 'text/plain' } }))
        .mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'text/html' } }))
      await expect(readTemporaryWebsitePage('https://example.test', fetcher)).rejects.toMatchObject({
        constructor: ProjectPreparationError,
        message: 'website_read_failed',
      })
    }
  })
})
