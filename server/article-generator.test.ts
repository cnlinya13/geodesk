import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildArticleTitlePrompt,
  buildArticleBodyPrompt,
  generateArticleBody,
  generateArticleTitles,
  generateArticles,
  sanitizeArticleHtml,
  contentAuditIssueRows,
  validateAndSanitizeArticleTitles,
  validateAndSanitizeArticles,
  type ArticleGenerationInput,
} from './article-generator.ts'

const testEndpoint = 'https://article-test-endpoint.example.test/api/v3/responses'
const originalEndpoint = process.env.DOUBAO_API_ENDPOINT

beforeEach(() => {
  process.env.DOUBAO_API_ENDPOINT = testEndpoint
})

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
  else process.env.DOUBAO_API_ENDPOINT = originalEndpoint
})

const input: ArticleGenerationInput = {
  project: {
    companyName: '示例科技有限公司',
    websiteUrl: 'https://example.test',
    optimizationTarget: '企业数字化服务',
    supplementalInfo: '面向制造业客户',
  },
  questions: Array.from({ length: 20 }, (_, index) => ({ position: index + 1, question: `企业选择数字化服务时应关注哪些方面${index + 1}？` })),
  diagnosisAnswers: Array.from({ length: 20 }, (_, index) => ({
    position: index + 1,
    question: `企业选择数字化服务时应关注哪些方面${index + 1}？`,
    answerText: `回答${index + 1}`,
    citationUrls: [],
    recommended: index % 2 === 0,
    officialCitation: index % 3 === 0,
  })),
  existingTitles: ['已有文章'],
  confirmedArticles: [{ title: '已发布文章', contentHtml: '<p>已发布正文</p>', confirmedAt: '2026-09-04T00:00:00.000Z' }],
  contentAudit: {
    checkedAt: '2026-09-06T05:03:31.000Z',
    scope: 'website_internal' as const,
    items: [{
      id: 'audit-1',
      statement: '服务覆盖制造业客户。',
      explanation: '服务范围事实',
      page: '服务',
      issues: [{ type: 'risk' as const, reason: '缺少适用条件。', suggestion: '保留主体并补充适用范围。' }],
      evidence: {
        statement: '服务覆盖制造业客户。',
        page: '服务',
        pageUrl: 'https://example.test/services',
        checkedAt: '2026-09-06T05:03:31.000Z',
        pageExcerpt: { location: '正文第1段', context: '服务覆盖制造业客户。' },
        judgment: '缓存正文原句定位成功。',
        suggestion: '保留主体和条件。',
      },
      locations: [{ page: '服务', pageUrl: 'https://example.test/services', statement: '服务覆盖制造业客户。', location: '正文第1段', context: '服务覆盖制造业客户。' }],
      subject: '示例科技有限公司',
      timeScope: '当前',
      conditions: '制造业客户',
    }],
  },
}

function articleResponse() {
  return responseForArticles([
    { title: '企业数字化服务选择指南', questionPositions: [1, 2, 4], contentHtml: '<h2>选择前先明确目标</h2><p>先梳理业务目标。</p>' },
    { title: '数字化项目落地的准备事项', questionPositions: [5], contentHtml: '<p>准备必要的业务资料。</p>' },
    { title: '企业服务商沟通要点', questionPositions: [8, 9], contentHtml: '<ul><li>确认沟通机制</li></ul>' },
  ], { model: 'article-response-model' })
}

function responseForArticles(articles: Array<{ title: string; questionPositions: number[]; contentHtml: string }>, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    ...extra,
    model: 'article-response-model',
    output_text: JSON.stringify({ articles }),
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseForTitles(articles: Array<{ title: string; questionPositions: number[]; optimizationType: string; optimizationDirection?: string }>, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    ...extra,
    model: 'title-response-model',
    output_text: JSON.stringify({ articles: articles.map((article) => ({ optimizationDirection: '主题内容补充', ...article })) }),
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('article generation', () => {
  it('de-duplicates current issue facts even when audit row IDs or spacing differ', () => {
    const rows = contentAuditIssueRows({
      scope: 'website_internal',
      items: [
        {
          ...input.contentAudit!.items[0],
          id: 'audit-1',
          statement: '服务覆盖制造业客户。',
        },
        {
          ...input.contentAudit!.items[0],
          id: 'audit-2',
          statement: '  服务覆盖制造业客户。 ',
          issues: [{ type: 'risk', reason: '  缺少适用条件。 ', suggestion: '保留主体并补充适用范围。' }],
        },
      ],
    })
    expect(rows).toHaveLength(1)
  })

  it('generates title metadata only and permits a zero-title result', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const timing: Array<{ event: string; timeoutMs: number }> = []
    const result = await generateArticleTitles(input, {
      apiKey: 'test-key',
      modelId: 'test-model',
      onTiming: (event) => timing.push({ event: event.event, timeoutMs: event.timeoutMs }),
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return responseForTitles([{ title: '新的专题标题', questionPositions: [2, 4], optimizationType: '新增文章', optimizationDirection: '主题内容补充' }])
      },
    })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(String(body.input)).toContain('本次只生成文章标题')
    expect(String(body.input)).toContain('当前已确认官网内容问题')
    expect(String(body.input)).toContain('数据冲突')
    expect(String(body.input)).toContain('信息缺项')
    expect(String(body.input)).toContain('表述风险')
    expect(String(body.input)).toContain('不联网')
    expect(String(body.input)).toContain('只能是“主题内容补充”“补充 FAQ”或“补充权威来源”')
    expect(String(body.input)).toContain('补充 FAQ”：必须围绕具体目标问题补充完整的针对性问答')
    expect(String(body.input)).toContain('补充权威来源”：只能使用客户资料、当前问题行、诊断结果或已有文章中明确给出的当前可核验来源及明确出处')
    expect(String(body.input)).toContain('选题阶段不要生成纯“补充权威来源”任务')
    expect(String(body.input)).not.toContain('生成完整文章')
    expect(String(body.input)).toContain('新增文章不能与任何已有内容任务标题重复')
    expect(String(body.input)).toContain('合并相近问题，不硬凑数量')
    expect(String(body.input)).toContain('当前已确认官网内容问题')
    const titleSchema = (body.text as { format: { schema: { properties: Record<string, unknown> } } }).format.schema
    const titleItemSchema = ((titleSchema.properties.articles as Record<string, unknown>).items) as Record<string, unknown>
    expect(titleItemSchema.required).toEqual(['title', 'questionPositions', 'optimizationType', 'optimizationDirection', 'targetPageUrl'])
    expect(result).toMatchObject({ responseModel: 'title-response-model' })
    expect(result.articles).toEqual([{ title: '新的专题标题', questionPositions: [2, 4], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null }])
    expect(timing[0]).toEqual({ event: 'request_start', timeoutMs: 0 })

    const empty = validateAndSanitizeArticleTitles({ articles: [] }, input)
    expect(empty).toEqual([])
  })

  it('uses saved article bodies only as bounded planning de-duplication material', () => {
    const prompt = buildArticleTitlePrompt({
      ...input,
      existingArticles: [{
        title: '已有文章',
        contentHtml: '<p>已保存的主题正文</p>',
        confirmedAt: '2026-09-04T00:00:00.000Z',
        writingStatus: 'ready',
      }],
    })
    expect(prompt).toContain('已保存的主题正文')
    expect(prompt).toContain('仅用于识别重复主题和重复内容')
  })

  it('honors an explicitly supplied title timeout', async () => {
    const timing: Array<{ event: string; timeoutMs: number }> = []
    await generateArticleTitles(input, {
      apiKey: 'test-key',
      modelId: 'test-model',
      timeoutMs: 123_456,
      onTiming: (event) => timing.push({ event: event.event, timeoutMs: event.timeoutMs }),
      fetch: async () => responseForTitles([{ title: '显式超时标题', questionPositions: [1], optimizationType: '新增文章', optimizationDirection: '主题内容补充' }]),
    })
    expect(timing[0]).toEqual({ event: 'request_start', timeoutMs: 123_456 })
  })

  it('drops exact duplicate title candidates but fails closed on invalid duplicate structure', () => {
    const result = validateAndSanitizeArticleTitles({ articles: [
      { title: '新标题', questionPositions: [1], optimizationType: '新增文章', optimizationDirection: '主题内容补充' },
      { title: ' 新标题 ', questionPositions: [2], optimizationType: '新增文章', optimizationDirection: '主题内容补充' },
    ] }, input)
    expect(result).toHaveLength(1)
    expect(() => validateAndSanitizeArticleTitles({ articles: [
      { title: '新标题', questionPositions: [1], optimizationType: '新增文章', optimizationDirection: '主题内容补充' },
      { title: ' 新标题 ', questionPositions: [21], optimizationType: '新增文章', optimizationDirection: '主题内容补充' },
    ] }, input)).toThrow('无效关联问题')
  })

  it('keeps content-audit-only tasks unlinked and validates update targets against current issue URLs', () => {
    const generated = validateAndSanitizeArticleTitles({ articles: [
      { title: '更新服务说明', questionPositions: [], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
      { title: '重复更新服务说明', questionPositions: [1], optimizationType: '更新已有文章', optimizationDirection: '补充权威来源', targetPageUrl: 'https://example.test/services' },
      { title: '新的内容检查文章', questionPositions: [], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null },
      { title: '无效目标按新增', questionPositions: [2], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://outside.test/article' },
    ] }, input)
    expect(generated).toEqual([
      { title: '更新服务说明', questionPositions: [], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
      { title: '新的内容检查文章', questionPositions: [], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null },
      { title: '无效目标按新增', questionPositions: [2], optimizationType: '新增文章', optimizationDirection: '补充 FAQ', targetPageUrl: null },
    ])
  })

  it('skips an unfinished update target while retaining an independent new task', () => {
    const generated = validateAndSanitizeArticleTitles({ articles: [
      { title: '待更新原文', questionPositions: [1], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
      { title: '另一个新标题', questionPositions: [2], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null },
    ] }, {
      ...input,
      existingArticles: [{ title: '旧更新任务', contentHtml: null, confirmedAt: null, writingStatus: 'pending', targetPageUrl: 'https://example.test/services', targetPageTitle: '服务' }],
    })
    expect(generated).toEqual([{ title: '另一个新标题', questionPositions: [2], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null }])
  })

  it('does not consume an update target when its first candidate title is already pending', () => {
    const generated = validateAndSanitizeArticleTitles({ articles: [
      { title: '待更新原文', questionPositions: [1], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
      { title: '新的服务更新标题', questionPositions: [2], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
    ] }, {
      ...input,
      existingArticles: [{ title: '待更新原文', contentHtml: null, confirmedAt: null, writingStatus: 'pending', targetPageUrl: 'https://example.test/other', targetPageTitle: '其他' }],
    })
    expect(generated).toEqual([{ title: '新的服务更新标题', questionPositions: [2], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' }])
  })

  it('allows a published same-title task to update the same original again', () => {
    const generated = validateAndSanitizeArticleTitles({ articles: [
      { title: '已有文章', questionPositions: [1], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
    ] }, {
      ...input,
      existingArticles: [{ title: '已有文章', contentHtml: '<p>已发布正文</p>', confirmedAt: '2026-09-04T00:00:00.000Z', writingStatus: 'ready', targetPageUrl: 'https://example.test/services', targetPageTitle: '服务' }],
    })
    expect(generated).toEqual([{ title: '已有文章', questionPositions: [1], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' }])
  })

  it('returns no candidates when every new or update candidate is already covered', () => {
    const generated = validateAndSanitizeArticleTitles({ articles: [
      { title: '已有文章', questionPositions: [1], optimizationType: '新增文章', optimizationDirection: '主题内容补充', targetPageUrl: null },
      { title: '待更新服务', questionPositions: [2], optimizationType: '更新已有文章', optimizationDirection: '补充 FAQ', targetPageUrl: 'https://example.test/services' },
    ] }, {
      ...input,
      existingArticles: [{ title: '待更新任务', contentHtml: null, confirmedAt: null, writingStatus: 'pending', targetPageUrl: 'https://example.test/services', targetPageTitle: '服务' }],
    })
    expect(generated).toEqual([])
  })

  it('rejects removed optimization categories from a new model response', () => {
    expect(() => validateAndSanitizeArticleTitles({ articles: [
      { title: '旧分类', questionPositions: [1], optimizationType: '补充 FAQ', optimizationDirection: '主题内容补充' },
    ] }, input)).toThrow('无效优化方式')
  })

  it('requires one of the independent optimization directions', () => {
    expect(() => validateAndSanitizeArticleTitles({ articles: [
      { title: '缺少方向', questionPositions: [1], optimizationType: '新增文章', targetPageUrl: null },
    ] }, input)).toThrow('无效优化方向')
    expect(() => validateAndSanitizeArticleTitles({ articles: [
      { title: '未知方向', questionPositions: [1], optimizationType: '新增文章', optimizationDirection: '补充外部链接', targetPageUrl: null },
    ] }, input)).toThrow('无效优化方向')
  })

  it('uses only the one temporary target body for an update prompt', () => {
    const original = '原文完整段落。'.repeat(100)
    const prompt = buildArticleTitlePrompt(input)
    expect(prompt).toContain('targetPageUrl')
    const bodyPrompt = buildArticleBodyPrompt(input, '更新服务说明', [], '更新已有文章', '主题内容补充', 100_000, { url: 'https://example.test/services', title: '服务原文', bodyText: original })
    expect(bodyPrompt).toContain(original)
    expect(() => buildArticleBodyPrompt(input, '更新服务说明', [], '更新已有文章', '主题内容补充', 100_000)).toThrow('指定更新原文不可用')
  })

  it('keeps old rows with a null direction on the original body-writing rule', () => {
    const prompt = buildArticleBodyPrompt(input, '历史文章', [1], '新增文章', null)
    expect(prompt).toContain('优化方向（仅作为写作方向，不执行网站修改）：未分类')
    expect(prompt).toContain('如果已保存方向为“未分类”或为空（旧记录），沿用主题内容补充的原规则')
    expect(prompt).toContain('不自行写回或补分类')
  })

  it('writes one selected article body with an immutable title/association schema', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const timing: Array<{ event: string; timeoutMs: number }> = []
    const result = await generateArticleBody(input, '选定文章标题', [1, 3], '新增文章', '补充 FAQ', {
      apiKey: 'test-key',
      modelId: 'test-model',
      onTiming: (event) => timing.push({ event: event.event, timeoutMs: event.timeoutMs }),
      fetch: async (_url, init) => {
        calls.push({ init: init ?? {} })
        return new Response(JSON.stringify({ model: 'body-response-model', output_text: JSON.stringify({ contentHtml: '<h2>正文</h2><p>内容</p>' }) }), { status: 200 })
      },
    })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const format = (body.text as { format: { schema: { properties: Record<string, unknown> } } }).format
    expect(Object.keys(format.schema.properties)).toEqual(['contentHtml'])
    expect(String(body.input)).toContain('选定文章标题')
    expect(String(body.input)).toContain('补充 FAQ')
    expect(String(body.input)).toContain('当前已确认官网内容问题')
    expect(String(body.input)).toContain('普通服务范围或服务项目介绍')
    expect(String(body.input)).toContain('表述风险：')
    expect(String(body.input)).toContain('不要声称企业陈述已经被证明真实、合法或适用于所有情形')
    expect(String(body.input)).toContain('写稿以该主要方向为主，不要求每篇同时补齐全部方向，也不禁止为解决同一内容缺口同时包含问答与可靠依据')
    expect(String(body.input)).toContain('如果已保存方向为“未分类”或为空（旧记录），沿用主题内容补充的原规则')
    expect(String(body.input)).not.toContain('web_search')
    expect(String(body.input)).not.toContain('依据不足')
    expect(result).toEqual({ contentHtml: '<h2>正文</h2><p>内容</p>', responseModel: 'body-response-model' })
    expect(timing[0]).toEqual({ event: 'request_start', timeoutMs: 0 })
  })

  it('calls Responses API exactly once without web_search and validates three articles', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const result = await generateArticles(input, {
      apiKey: 'test-key',
      modelId: 'test-model',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return articleResponse()
      },
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.tools).toBeUndefined()
    expect((body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: 'json_schema', strict: true })
    expect(String(body.input)).toContain('https://example.test/services')
    expect(String(body.input)).toContain('禁止虚构价格')
    expect(String(body.input)).toContain('最近一轮完整成功的问答诊断')
    expect(String(body.input)).toContain('已有文章标题')
    expect(String(body.input)).toContain('合并相近问题')
    expect(String(body.input)).not.toContain('生成3篇')
    const format = (body.text as { format: { schema: { properties: Record<string, unknown> } } }).format
    const schema = format.schema
    const articlesSchema = schema.properties.articles as Record<string, unknown>
    expect(articlesSchema.minItems).toBeUndefined()
    expect(articlesSchema.maxItems).toBeUndefined()
    expect(result.responseModel).toBe('article-response-model')
    expect(result.articles).toHaveLength(3)
  })

  it('accepts one, five, and more than twenty useful articles in one call each', async () => {
    for (const count of [1, 5, 21]) {
      const generated = Array.from({ length: count }, (_, index) => ({
        title: `按需选题${count}-${index + 1}`,
        questionPositions: [(index % 20) + 1],
        contentHtml: `<p>资料支撑的正文${index + 1}</p>`,
      }))
      const result = await generateArticles(input, {
        apiKey: 'test-key',
        modelId: 'test-model',
        fetch: async () => responseForArticles(generated),
      })
      expect(result.articles).toHaveLength(count)
    }
  })

  it('does not pass a legacy external-check result into a new generation prompt', () => {
    const legacy = {
      ...input,
      contentAudit: {
        checkedAt: '2026-09-06T05:03:31.000Z',
        items: [{
          id: 'legacy-audit',
          statement: '旧外部证据不应进入生成。',
          explanation: '旧规则',
          page: '旧页面',
          conclusion: 'supported' as const,
          evidence: { statement: '旧外部证据不应进入生成。', page: '旧页面', judgment: '旧证据', suggestion: '旧建议' },
        }],
      },
    }
    const prompt = buildArticleTitlePrompt(legacy)
    expect(prompt).not.toContain('旧外部证据不应进入生成')
    expect(prompt).toContain('本轮没有可用的已确认官网内容问题')
  })

  it('sanitizes dangerous HTML and adds safe attributes to links', () => {
    const html = sanitizeArticleHtml('<h2>标题</h2><p onclick="bad()" style="color:red">正文<script>alert(1)</script></p><iframe src="https://bad.test"></iframe><a href="https://safe.test" onclick="bad()">链接</a><a href="javascript:alert(1)">危险</a>')
    expect(html).toContain('<h2>标题</h2>')
    expect(html).toContain('<p>正文</p>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('javascript:')
  })

  it('rejects duplicate titles against existing and generated articles', () => {
    expect(() => validateAndSanitizeArticles({ articles: [
      { title: '已有文章', questionPositions: [1], contentHtml: '<p>一</p>' },
      { title: '新文章', questionPositions: [2], contentHtml: '<p>二</p>' },
      { title: '另一篇', questionPositions: [3], contentHtml: '<p>三</p>' },
    ] }, input)).toThrow('重复文章标题')
  })

  it('rejects an empty batch without asking for filler articles', () => {
    expect(() => validateAndSanitizeArticles({ articles: [] }, input)).toThrow('本轮没有可新增的有效文章')
  })

  it('rejects provider responses explicitly marked incomplete even when JSON text is present', async () => {
    for (const payload of [
      { status: 'incomplete', output_text: JSON.stringify({ articles: [{ title: '未完成', questionPositions: [1], contentHtml: '<p>正文</p>' }] }) },
      { status: 'failed', error: { code: 'provider_failed' }, output_text: JSON.stringify({ articles: [{ title: '失败', questionPositions: [1], contentHtml: '<p>正文</p>' }] }) },
      { status: 'completed', output: [{ type: 'message', status: 'incomplete', content: [{ type: 'output_text', text: JSON.stringify({ articles: [{ title: '截断', questionPositions: [1], contentHtml: '<p>正文</p>' }] }) }] }] },
    ]) {
      await expect(generateArticles(input, {
        apiKey: 'test-key',
        modelId: 'test-model',
        fetch: async () => responseForArticles([], payload),
      })).rejects.toThrow('豆包文章生成未完成')
    }
  })

  it('validates non-empty, unique question positions for each article', () => {
    expect(() => validateAndSanitizeArticles({ articles: [
      { title: '文章一', questionPositions: [1, 1], contentHtml: '<p>正文</p>' },
      { title: '文章二', questionPositions: [2], contentHtml: '<p>正文</p>' },
      { title: '文章三', questionPositions: [3], contentHtml: '<p>正文</p>' },
    ] }, input)).toThrow('无效关联问题')
    expect(validateAndSanitizeArticles({ articles: [
      { title: '内容检查文章', questionPositions: [], contentHtml: '<p>正文</p>' },
      { title: '文章二', questionPositions: [2], contentHtml: '<p>正文</p>' },
      { title: '文章三', questionPositions: [3], contentHtml: '<p>正文</p>' },
    ] }, input)).toHaveLength(3)
  })
})
