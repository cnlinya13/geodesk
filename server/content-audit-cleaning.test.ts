import { describe, expect, it } from 'vitest'
import { cleanContentAuditPage, cleanContentAuditPages } from './content-audit-cleaning.ts'
import type { WebsitePageResult } from './site-crawler.ts'

function page(url: string, bodyText: string, title = '文章标题'): WebsitePageResult {
  return { url, title, bodyText, status: 'success', error: null }
}

describe('content audit deterministic cleaning', () => {
  it('removes explicit operation noise and a confirmed table of contents while preserving the repeated heading', () => {
    const input = page('https://example.test/a', [
      '跳到内容 (page#main)',
      '首页 (https://example.test/)',
      '关于我们',
      '联系我们',
      '文章目录',
      '服务范围 (https://example.test/a#article-section-1)',
      '价格说明 (https://example.test/a#article-section-2)',
      '服务范围',
      '服务范围说明：材料齐备后3个工作日完成资料整理。',
      '价格说明',
      '价格为1000元。',
      '阅读更多 其他文章 (https://example.test/b)',
      '返回顶部',
    ].join('\n'))
    const cleaned = cleanContentAuditPage(input)
    expect(cleaned.bodyText).not.toContain('跳到内容')
    expect(cleaned.bodyText).not.toContain('文章目录')
    expect(cleaned.bodyText).not.toContain('#article-section-1')
    expect(cleaned.bodyText).toContain('服务范围说明：材料齐备后3个工作日完成资料整理。')
    expect(cleaned.bodyText).not.toContain('阅读更多 其他文章')
    expect(cleaned.bodyText).not.toContain('返回顶部')
  })

  it('removes only the duplicate header identity adjacent to a confirmed menu run', () => {
    const identity = '示例企业有限公司 (https://example.test/)'
    const cleaned = cleanContentAuditPage(page('https://example.test/article', [
      '跳到内容 (https://example.test/article#main)',
      identity,
      '首页 (https://example.test/)',
      '公司介绍 (https://example.test/about)',
      '联系我们 (https://example.test/contact)',
      identity,
      '正文中的公司介绍说明。',
    ].join('\n')))
    expect(cleaned.bodyText.split('\n').filter((line) => line === identity)).toHaveLength(1)
    expect(cleaned.bodyText).toContain('正文中的公司介绍说明。')
  })

  it('keeps ordinary prose, conditions, negative wording, tables and links', () => {
    const body = [
      '本网站使用 Cookie 的隐私说明：我们仅为登录服务保存必要信息。',
      '材料齐备后3个工作日完成资料整理，不保证审批通过。',
      '价格 | 计费周期 | 1000元 | 每年',
      '政策出处 (https://gov.example.test/policy)',
      '正文中的证书地址：满足前置条件后提交。',
    ].join('\n')
    expect(cleanContentAuditPage(page('https://example.test/a', body)).bodyText).toBe(body)
  })

  it('keeps HTML-looking text because the crawler already returns plain text', () => {
    const snippet = '代码示例：<script>不应被清洗</script>\n利润 < 3%'
    expect(cleanContentAuditPage(page('https://example.test/a', snippet)).bodyText).toBe(snippet)
    const html = '<!doctype html><html><body><h1>正文</h1><script>secret()</script><p>材料齐备后3日完成。</p></body></html>'
    const cleaned = cleanContentAuditPage(page('https://example.test/b', html))
    expect(cleaned.bodyText).toBe(html)
  })

  it('removes only safe zero-width noise while preserving raw offsets', () => {
    const body = '服务\u200B价格：1000\uFEFF元。'
    const cleaned = cleanContentAuditPage(page('https://example.test/a', body))
    expect(cleaned.bodyText).toBe('服务价格：1000元。')
    expect(cleaned.lines[0]?.rawStart).toBe(0)
    expect(cleaned.lines[0]?.rawEnd).toBe(body.length)
    expect(cleaned.bodyCharMap).toHaveLength('服务价格：1000元。'.length)
  })

  it('keeps different public contact versions and maps an exact shared public block to every source page', async () => {
    const first = page('https://example.test/a', '公司地址：上海市浦东新区\n公司邮箱：a@example.test\n服务价格1000元。')
    const second = page('https://example.test/b', '公司地址：上海市浦东新区\n公司邮箱：a@example.test\n服务价格1200元。')
    const third = page('https://example.test/c', '公司地址：北京市朝阳区\n公司邮箱：c@example.test\n服务价格1500元。')
    const progress: number[] = []
    const cleaned = await cleanContentAuditPages([first, second, third], { onProgress: ({ cleanedPages }) => { progress.push(cleanedPages) } })
    expect(progress.at(-1)).toBe(3)
    expect(cleaned[0]?.bodyText).toContain('公司地址：上海市浦东新区')
    expect(cleaned[1]?.bodyText).not.toContain('公司地址：上海市浦东新区')
    expect(cleaned[2]?.bodyText).toContain('公司地址：北京市朝阳区')
    const locations = cleaned[0]?.sharedLocations.get('公司地址：上海市浦东新区')
    expect(locations?.map((location) => location.pageUrl)).toEqual(['https://example.test/a', 'https://example.test/b'])
    expect(cleaned[1]?.rawBodyText.slice(locations?.[1]?.rawStart, locations?.[1]?.rawEnd).replace(/\r?\n$/u, '')).toBe('公司地址：上海市浦东新区')
  })

  it('does not remove a repeated ordinary body sentence or merge similar pages', async () => {
    const body = '这是正文中的证书说明，需满足材料齐备条件后提交。\n服务价格1000元。'
    const cleaned = await cleanContentAuditPages([
      page('https://example.test/a', body),
      page('https://example.test/b', body.replace('1000', '1200')),
    ])
    expect(cleaned[0]?.bodyText).toContain('这是正文中的证书说明')
    expect(cleaned[1]?.bodyText).toContain('这是正文中的证书说明')
    expect(cleaned[1]?.duplicateOf).toBeUndefined()
  })

  it('keeps an unlabelled business sentence outside a shared footer block', async () => {
    const footer = [
      '测试有限公司',
      '地址路9号室',
      '业务邮箱：a@example.test',
      '版权所有 2026',
    ].join('\n')
    const pages = await cleanContentAuditPages([
      page('https://example.test/a', `套餐A适用条件\n本公司负责整理材料\n${footer}`),
      page('https://example.test/b', `套餐B适用条件\n本公司负责整理材料\n${footer}`),
    ])
    expect(pages[0]?.bodyText).toBe(`套餐A适用条件\n本公司负责整理材料\n${footer}`)
    expect(pages[1]?.bodyText).toBe('套餐B适用条件\n本公司负责整理材料')
    expect(pages[0]?.sharedLocations.get('测试有限公司')?.map((location) => location.pageUrl)).toEqual([
      'https://example.test/a',
      'https://example.test/b',
    ])
  })

  it('keeps body prose that merely mentions contact or address words', () => {
    const body = [
      '业务正文含邮箱和联系电话提示，但这不是联系字段。',
      '业务正文包含地址路9号室等示例，不是办公地址。',
      '材料齐备后3个工作日完成整理，价格为1000元。',
    ].join('\n')
    expect(cleanContentAuditPage(page('https://example.test/body', body)).bodyText).toBe(body)
  })

  it('deduplicates a complete ICP footer block while preserving the source mapping for every row', async () => {
    const footer = [
      '示例测试有限公司',
      '地址路9-1号8777室',
      '业务邮箱：a@x.test',
      '辽ICP备2026019176号 (https://beian.miit.gov.cn/)',
    ].join('\n')
    const pages = await cleanContentAuditPages([
      page('https://example.test/a', `${footer}\n首页 (https://example.test/)\n关于我们 (https://example.test/about)\n合规账 (https://example.test/compliance)\n政策解读 (https://example.test/policy)\n财税合规 (https://example.test/tax-compliance)\n联系我们 (https://example.test/contact)\n政策来源 (https://gov.example.test/policy)\n服务价格1000元。`),
      page('https://example.test/b', `${footer}\n首页 (https://example.test/)\n关于我们 (https://example.test/about)\n合规账 (https://example.test/compliance)\n政策解读 (https://example.test/policy)\n财税合规 (https://example.test/tax-compliance)\n联系我们 (https://example.test/contact)\n政策来源 (https://gov.example.test/policy)\n服务价格1200元。`),
    ])
    expect(pages[0]?.bodyText).toContain(footer)
    expect(pages[1]?.bodyText).toBe('政策来源 (https://gov.example.test/policy)\n服务价格1200元。')
    for (const line of ['示例测试有限公司', '地址路9-1号8777室', '业务邮箱：a@x.test', '辽ICP备2026019176号 (https://beian.miit.gov.cn/)']) {
      const locations = pages[0]?.sharedLocations.get(line)
      expect(locations?.map((location) => location.pageUrl)).toEqual([
        'https://example.test/a',
        'https://example.test/b',
      ])
    }
  })

  it('includes an exact duplicate page in shared public-block locations', async () => {
    const footer = [
      '示例测试有限公司',
      '地址路9-1号8777室',
      '业务邮箱：a@x.test',
      '辽ICP备2026019176号 (https://beian.miit.gov.cn/)',
    ].join('\n')
    const pages = await cleanContentAuditPages([
      page('https://example.test/public', `${footer}\n公共页正文。`),
      page('https://example.test/article', `${footer}\n文章页正文。`),
      page('https://example.test/article-copy', `${footer}\n文章页正文。`),
    ])
    expect(pages[2]?.duplicateOf).toBe(1)
    const locations = pages[0]?.sharedLocations.get('示例测试有限公司')
    expect(locations?.map((location) => location.pageUrl)).toEqual([
      'https://example.test/public',
      'https://example.test/article',
      'https://example.test/article-copy',
    ])
  })

  it('does not share a common address when the surrounding footer belongs to different companies', async () => {
    const pages = await cleanContentAuditPages([
      page('https://example.test/a', '甲方示例有限公司\n地址路9-1号8777室\n业务邮箱：a@x.test\n辽ICP备2026019176号 (https://beian.miit.gov.cn/)\n甲方示例有限公司正文。'),
      page('https://example.test/b', '乙方示例有限公司\n地址路9-1号8777室\n业务邮箱：b@x.test\n辽ICP备2026019176号 (https://beian.miit.gov.cn/)\n乙方示例有限公司正文。'),
    ])
    expect(pages[0]?.bodyText).toContain('甲方示例有限公司\n地址路9-1号8777室')
    expect(pages[1]?.bodyText).toContain('乙方示例有限公司\n地址路9-1号8777室')
    expect(pages[0]?.sharedLocations.size).toBe(0)
    expect(pages[1]?.sharedLocations.size).toBe(0)
  })

  it('removes a clearly bounded recommendation-card group but keeps policy text and the public footer', () => {
    const lines = [
      '正文政策来源 (https://gov.example.test/policy)',
      '免责声明：仅供参考。',
      '文章导航',
      '上一页标题 (https://example.test/previous)',
      '下一页标题 (https://example.test/next)',
      '类似文章',
    ]
    for (let index = 1; index <= 5; index += 1) {
      lines.push(
        `栏目${index} (https://example.test/category-${index})`,
        `标题${index} (https://example.test/article-${index})`,
        `作者admin (https://example.test/author-${index}) 2026-09-0${index}`,
        `摘要${index}内容。`,
        `阅读更多 标题${index} (https://example.test/article-${index})`,
      )
    }
    lines.push(
      '示例测试有限公司',
      '地址路9-1号8777室',
      '业务邮箱：a@x.test',
      '辽ICP备2026019176号 (https://beian.miit.gov.cn/)',
      '首页 (https://example.test/)',
      '关于我们 (https://example.test/about)',
      '联系我们 (https://example.test/contact)',
      '正文保留。',
    )
    const cleaned = cleanContentAuditPage(page('https://example.test/article', lines.join('\n')))
    expect(cleaned.bodyText).not.toContain('文章导航')
    expect(cleaned.bodyText).not.toContain('类似文章')
    expect(cleaned.bodyText).not.toContain('阅读更多 标题1')
    expect(cleaned.bodyText).toContain('正文政策来源')
    expect(cleaned.bodyText).toContain('免责声明：仅供参考。')
    expect(cleaned.bodyText).toContain('示例测试有限公司\n地址路9-1号8777室')
    expect(cleaned.bodyText).toContain('正文保留。')
  })

  it('reuses only completely identical title/body pages and preserves failed or truncated pages', async () => {
    const one = page('https://example.test/a', '正文')
    const same = page('https://example.test/b', '正文')
    const truncated = page('https://example.test/c', '正文[正文因长度限制未完整保存]')
    const failed = { ...page('https://example.test/d', '正文'), status: 'failed' as const, error: '读取失败' }
    const cleaned = await cleanContentAuditPages([one, same, truncated, failed])
    expect(cleaned[1]?.duplicateOf).toBe(0)
    expect(cleaned[2]?.duplicateOf).toBeUndefined()
    expect(cleaned[3]?.duplicateOf).toBeUndefined()
  })

  it('keeps raw input objects unchanged and refuses to expose a cleaned gap as one raw span', () => {
    const original = page('https://example.test/a', '公司地址：上海市\n首页\n联系我们\n关于我们\n服务价格1000元。')
    const snapshot = JSON.stringify(original)
    const cleaned = cleanContentAuditPage(original)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(cleaned.bodyText).not.toContain('首页')
    const bodyStart = cleaned.lines.find((line) => line.text.includes('公司地址'))?.cleanStart ?? 0
    const bodyEnd = cleaned.lines.find((line) => line.text.includes('服务价格'))?.cleanEnd ?? cleaned.bodyText.length
    const selected = cleaned.bodyCharMap.slice(bodyStart, bodyEnd)
    expect(selected.some((span) => span === null)).toBe(true)
  })
})
