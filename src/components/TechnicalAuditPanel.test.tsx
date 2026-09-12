import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTechnicalAudit, runTechnicalAudit } from '../api'
import {
  TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS,
  TECHNICAL_AUDIT_RULE_VERSION,
  TECHNICAL_AUDIT_UNSUPPORTED_ITEM_IDS,
  TECHNICAL_GROUPS,
  technicalAuditMessage,
  type TechnicalAuditItem,
  type TechnicalAuditSnapshot,
} from '../technical-audit'
import { TECHNICAL_AUDIT_HELP } from '../technical-audit-help'
import {
  createTechnicalAuditRunGuard,
  TechnicalAuditPanel,
  technicalAuditScopeNote,
  technicalAuditItemDisplay,
} from './TechnicalAuditPanel'

const panelSource = readFileSync(fileURLToPath(new URL('./TechnicalAuditPanel.tsx', import.meta.url)), 'utf8')

function auditItem(overrides: Partial<TechnicalAuditItem>): TechnicalAuditItem {
  return {
    item_id: 'site.dns',
    status: 'pass',
    message_code: 'pass',
    facts: {},
    evidence: {},
    ...overrides,
  }
}

function auditSnapshot(checkedAt: string): TechnicalAuditSnapshot {
  return {
    checked_at: checkedAt,
    website_url: 'https://example.test/',
    scope: {
      pages: [],
      sampled_pages: [],
      skipped_pages: [],
      candidates: [],
      requests: 1,
      request_limit: 40,
      page_limit: 10,
      response_limit_bytes: 2 * 1024 * 1024,
      time_limit_ms: 45_000,
      limits: [],
    },
    items: [],
    rule_version: TECHNICAL_AUDIT_RULE_VERSION,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TechnicalAuditPanel', () => {
  it('renders the fixed seven groups and all 24 items, with the new item awaiting a first conclusion', () => {
    const html = renderToStaticMarkup(<TechnicalAuditPanel projectId="1" websiteUrl="https://example.test/" />)
    const itemCount = TECHNICAL_GROUPS.reduce((total, group) => total + group.items.length, 0)

    expect(TECHNICAL_GROUPS).toHaveLength(7)
    expect(itemCount).toBe(24)
    expect((html.match(/data-status="unchecked"/g) ?? [])).toHaveLength(24)
    expect(html).toContain('robots.txt抓取规则')
    expect(html).not.toContain('GPTBot访问规则')
    expect(html).toContain('llms.txt')
    expect(html).not.toContain('本轮请求失败')
    expect(html).not.toContain('第10组')
    for (const removedName of ['CMS搜索可见性', '重复网址', '迁移重定向', '孤立页面', '平台提交状态', '点击后正文加载', '滚动后正文加载']) {
      expect(html).not.toContain(removedName)
    }
    expect(html).not.toContain('technical-audit-item__message')
    expect(panelSource).not.toContain('technical-audit-item__message')
    expect(panelSource).toContain('technicalAuditItemDisplay(item, displayHasCompletedSnapshot, snapshotRuleVersion, definition.id, checking)')
  })

  it('renders exactly one help trigger and one help entry for every catalog item', () => {
    const html = renderToStaticMarkup(<TechnicalAuditPanel projectId="1" websiteUrl="https://example.test/" />)
    const itemDefinitions = TECHNICAL_GROUPS.flatMap((group) => group.items)
    const itemIds = itemDefinitions.map((definition) => definition.id)

    expect(itemIds).toHaveLength(24)
    expect(Object.keys(TECHNICAL_AUDIT_HELP).sort()).toEqual([...itemIds].sort())
    expect((html.match(/class="technical-audit-panel__info-button/g) ?? [])).toHaveLength(itemIds.length + 1)
    const benefitLevels: Record<'高' | '中' | '低', number> = { 高: 0, 中: 0, 低: 0 }
    for (const definition of itemDefinitions) {
      const help = TECHNICAL_AUDIT_HELP[definition.id]
      expect(help.geoBenefit).toBeTruthy()
      expect(help.passCriteria).toBeTruthy()
      expect(['高', '中', '低']).toContain(help.benefitLevel)
      benefitLevels[help.benefitLevel] += 1
      expect(html).toContain(`aria-label="查看${definition.name}检查说明"`)
    }
    expect(benefitLevels).toEqual({ 高: 10, 中: 11, 低: 3 })
    expect(TECHNICAL_AUDIT_HELP['discovery.llms_txt']?.passCriteria).toBe('可正常读取llms.txt，编码有效、内容非空、不是HTML页面，且包含Markdown一级标题。文件缺失、内容不符合上述条件，或超时、网络失败等无法确认时，均记为待修复；不以文件内链接检查结果作为通过条件。')
  })

  it('keeps the full-crawl scope behind an accessible info toggle', () => {
    const html = renderToStaticMarkup(<TechnicalAuditPanel projectId="1" websiteUrl="https://example.test/" />)
    expect(html).toContain('aria-label="查看技术检查信息"')
    expect(html).toContain('aria-controls="technical-audit-info"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('id="technical-audit-info"')
    expect(html).not.toContain('检查范围：首页＋最近一次采集成功的全部同站页面')
    expect(html).not.toContain('HTTP状态码和重定向仅首页')
  })

  it('wires close, outside-pointer, and focus-return behavior for the info panel', () => {
    expect(panelSource).toContain("aria-label={t('technical.closeInfo')}")
    expect(panelSource).toContain('className="technical-audit-panel__info-button technical-audit-panel__info-close"')
    expect(panelSource).toContain('document.addEventListener(\'pointerdown\', handlePointerDown, true)')
    expect(panelSource).toContain('infoPanelRef.current?.contains(target)')
    expect(panelSource).toContain('infoButtonRef.current?.contains(target)')
    expect(panelSource).toContain("targetElement?.closest('.technical-audit-panel__info-button')")
    expect(panelSource).toContain('infoButtonRef.current?.focus()')
    expect(panelSource).toContain('const [activeInfo, setActiveInfo]')
    expect(panelSource).toContain('current === definition.id ? null : definition.id')
    expect(panelSource).toContain("t('technical.benefit')")
    expect(panelSource).toContain('help.benefitLevel')
    expect(panelSource).toContain("t('technical.benefitAria'")
    expect(panelSource).toContain("t('technical.benefitTitle')")
    expect(panelSource).toContain("t('technical.criteria')")
    expect(panelSource).not.toContain('该项的作用')
    expect(panelSource).not.toContain('如何修改才能通过')
    expect(panelSource).toContain('useLayoutEffect(() => {')
    expect(panelSource).toContain("panel.style.position = 'fixed'")
    expect(panelSource).toContain('trigger.getBoundingClientRect()')
    expect(panelSource).toContain("window.addEventListener('scroll', reposition, true)")
  })

  it('reports current plan, valid-page, and incomplete-page counts', () => {
    const snapshot = auditSnapshot('2026-09-07T01:00:00.000Z')
    snapshot.rule_version = TECHNICAL_AUDIT_RULE_VERSION
    snapshot.scope.pages = Array.from({ length: 28 }, (_, index) => `https://example.test/page-${index}`)
    snapshot.scope.sampled_pages = [...snapshot.scope.pages]
    snapshot.scope.skipped_pages = []
    expect(technicalAuditScopeNote(snapshot)).toContain('计划28页，有效读取28页，未完成0页')

    snapshot.scope.sampled_pages = snapshot.scope.pages.slice(0, 27)
    snapshot.scope.skipped_pages = [snapshot.scope.pages.at(-1)!]
    expect(technicalAuditScopeNote(snapshot)).toContain('计划28页，有效读取27页，未完成1页')

    snapshot.scope.sampled_pages = []
    snapshot.scope.skipped_pages = [...snapshot.scope.pages]
    expect(technicalAuditScopeNote(snapshot)).toContain('计划28页，有效读取0页，未完成28页')
  })

  it('marks historical sampled scope as non-full and does not count old skipped pages as a new plan', () => {
    const snapshot = auditSnapshot('2026-09-07T01:00:00.000Z')
    snapshot.rule_version = 3
    snapshot.scope.pages = Array.from({ length: 10 }, (_, index) => `https://example.test/page-${index}`)
    snapshot.scope.sampled_pages = snapshot.scope.pages.slice(0, 8)
    snapshot.scope.skipped_pages = ['https://example.test/old-skipped-1', 'https://example.test/old-skipped-2']
    const note = technicalAuditScopeNote(snapshot)
    expect(note).toContain('历史抽样检查，非全量')
    expect(note).toContain('旧计划10页，有效读取8页，待按全部已采集页面重检')
    expect(note).not.toContain('计划12页')
  })

  it('does not invent full-crawl counts when a current snapshot omits scope arrays', () => {
    const snapshot = auditSnapshot('2026-09-07T01:00:00.000Z')
    snapshot.rule_version = TECHNICAL_AUDIT_RULE_VERSION
    const incomplete = {
      ...snapshot,
      scope: { ...snapshot.scope, sampled_pages: undefined },
    } as unknown as TechnicalAuditSnapshot
    expect(technicalAuditScopeNote(incomplete)).toContain('检查范围证据不完整，待重检')
    expect(technicalAuditScopeNote(incomplete)).not.toContain('计划0页，有效读取0页')
  })

  it('keeps the task header outside the white card while the 24 items stay inside it', () => {
    const html = renderToStaticMarkup(<TechnicalAuditPanel projectId="1" websiteUrl="https://example.test/" />)
    const headerIndex = html.indexOf('<header class="technical-audit-panel__header">')
    const cardIndex = html.indexOf('<div class="technical-audit-panel__card">')
    expect(headerIndex).toBeGreaterThan(-1)
    expect(cardIndex).toBeGreaterThan(headerIndex)
    expect(html.slice(cardIndex)).not.toContain('technical-audit-panel__meta')
    expect((html.slice(cardIndex).match(/data-status="unchecked"/g) ?? [])).toHaveLength(24)
  })

  it('maps every raw result to its five display states without turning review into a defect', () => {
    expect(technicalAuditItemDisplay(auditItem({ status: 'unchecked' }))).toMatchObject({
      status: 'unchecked', label: '未检查', tone: 'unchecked', message: '',
    })
    expect(technicalAuditItemDisplay(auditItem({ status: 'pass' }))).toMatchObject({
      status: 'pass', label: '通过', tone: 'pass', message: '',
    })
    expect(technicalAuditItemDisplay(auditItem({ status: 'fix', message_code: 'http_error' }))).toMatchObject({
      status: 'fix', label: '待修复', tone: 'fix', message: technicalAuditMessage('http_error'),
    })
    expect(technicalAuditItemDisplay(auditItem({ status: 'review', message_code: 'review' }))).toMatchObject({
      status: 'review', label: '待确认', tone: 'review',
    })
    expect(technicalAuditItemDisplay(auditItem({ status: 'not_applicable', message_code: 'not_applicable' }))).toMatchObject({
      status: 'not_applicable', label: '不适用', tone: 'not_applicable',
      message: '本次检查范围不适用或无需改造，不代表全站已完成配置。',
    })
  })

  it('states the evidence boundary for capability-limited passing checks', () => {
    const cases = [
      ['content.html_body', 'HTML正文仅验证HTML文本输出', '不证明正文完整'],
      ['content.javascript_render', '静态HTML有可读正文', '不证明无需JavaScript'],
      ['content.html_structure', 'HTML结构仅检查html、head、body是否存在'],
      ['content.metadata', '元数据仅检查title元素和description是否存在'],
      ['sitemap.lastmod', '更新时间仅检查lastmod日期是否可解析', '不证明真实更新时间'],
      ['content.structured_data', '结构化数据仅检查每页是否有JSON-LD、Microdata或RDFa中的至少一种实际标记'],
    ] as const
    for (const [itemId, ...fragments] of cases) {
      const display = technicalAuditItemDisplay(auditItem({ item_id: itemId, status: 'pass' }), false, TECHNICAL_AUDIT_RULE_VERSION)
      expect(display.status).toBe('pass')
      for (const fragment of fragments) expect(display.message).toContain(fragment)
    }
  })

  it('keeps generic robots policy facts in the detail instead of the status badge', () => {
    const policies = [
      ['allowed', 'robots_allowed'],
      ['restricted', 'robots_restricted'],
      ['mixed', 'robots_mixed'],
      ['not_declared', 'robots_not_declared'],
    ] as const
    for (const [policy, messageCode] of policies) {
      expect(technicalAuditItemDisplay(auditItem({ item_id: 'crawl.robots_txt', facts: { policy } }))).toMatchObject({
        status: 'pass',
        label: '通过',
        tone: 'pass',
        message: technicalAuditMessage(messageCode),
      })
    }
    const review = technicalAuditItemDisplay(auditItem({ item_id: 'crawl.robots_txt', status: 'review', message_code: 'robots_unreadable', facts: { policy: 'allowed' } }))
    expect(review).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(review.message).toContain(technicalAuditMessage('robots_unreadable').replace(/[。；]+$/u, ''))
    expect(review.message).toContain('检测未完成不等于已确认网站故障')
    expect(review.message).not.toContain('GPTBot')
    expect(review.message).not.toContain('豆包')
  })

  it('shows concrete generic robots restrictions and backend login blockers as safe evidence', () => {
    const robots = technicalAuditItemDisplay(auditItem({
      item_id: 'crawl.robots_txt',
      status: 'review',
      message_code: 'robots_restricted',
      facts: { policy: 'restricted' },
      evidence: {
        restricted_targets: [
          { path: '/private', rule: { allow: false, path: '/private' } },
          { path: '/private/report?token=hidden', rule: { allow: false, path: '/private' } },
        ],
      },
    })).message
    expect(robots).toContain('路径 /private，匹配 Disallow /private')
    expect(robots).not.toContain('token=hidden')

    const login = technicalAuditItemDisplay(auditItem({
      item_id: 'crawl.login',
      status: 'fix',
      message_code: 'login_required',
      facts: { blocked: true },
      evidence: { blocked_pages: ['https://example.test/private?token=hidden'] },
    })).message
    expect(login).toContain('https://example.test/private')
    expect(login).not.toContain('token=hidden')
  })

  it('isolates old scope results while retaining the four stable v2/v3 homepage checks', () => {
    expect(TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS).toHaveLength(4)
    for (const itemId of TECHNICAL_AUDIT_LEGACY_STABLE_ITEM_IDS) {
      expect(technicalAuditItemDisplay(auditItem({ item_id: itemId, status: 'pass' }), true, 2)).toMatchObject({
        status: 'pass', label: '通过', tone: 'pass',
      })
    }

    const legacyPass = technicalAuditItemDisplay(auditItem({ item_id: 'crawl.login', status: 'pass' }), true, 2)
    expect(legacyPass).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(legacyPass.message).toContain('历史抽样检查')
    expect(legacyPass.message).toContain('旧范围结果')
    expect(legacyPass.message).toContain('全部已采集页面')
    expect(legacyPass.message).toContain('重新检查')
    expect(legacyPass.message).toContain('不等于已确认网站故障')

    const legacyKeywordFailure = technicalAuditItemDisplay(auditItem({ item_id: 'crawl.login', status: 'fix', message_code: 'review', facts: { detected: true } }), true, 1)
    expect(legacyKeywordFailure.message).toContain('旧规则结果')
    expect(legacyKeywordFailure.message).not.toContain('登录限制，请核实')

    const currentFailure = technicalAuditItemDisplay(auditItem({ item_id: 'site.http_status', status: 'fix', message_code: 'http_error', evidence: { status: 503 } }), true, TECHNICAL_AUDIT_RULE_VERSION)
    expect(currentFailure.message).toContain('非成功HTTP状态')
    expect(currentFailure.message).not.toContain('旧版检查规则')

    const currentIncomplete = technicalAuditItemDisplay(auditItem({ item_id: 'site.redirect', status: 'review', message_code: 'review' }), true, TECHNICAL_AUDIT_RULE_VERSION)
    expect(currentIncomplete.message).toContain('检测未完成不等于已确认网站故障')

    const laterModule = technicalAuditItemDisplay(auditItem({ item_id: 'index.noindex', status: 'pass' }), true, 2)
    expect(laterModule).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(laterModule.message).toContain('旧范围结果')

    const legacyRobots = technicalAuditItemDisplay(auditItem({ item_id: 'crawl.robots_txt', status: 'pass' }), true, 3)
    expect(legacyRobots).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(legacyRobots.message).toContain('旧范围结果')

    const v1Stable = technicalAuditItemDisplay(auditItem({ item_id: 'site.dns', status: 'pass' }), true, 1)
    expect(v1Stable).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })

    const v1LaterModule = technicalAuditItemDisplay(auditItem({ item_id: 'index.noindex', status: 'pass' }), true, 1)
    expect(v1LaterModule).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(v1LaterModule.message).toContain('旧规则结果')

    const omittedVersion = technicalAuditItemDisplay(auditItem({ item_id: 'content.metadata', status: 'pass' }), true)
    expect(omittedVersion).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(omittedVersion.message).toContain('旧规则结果')

    const unknownVersion = technicalAuditItemDisplay(auditItem({ item_id: 'site.https', status: 'pass' }), true, 99)
    expect(unknownVersion).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(unknownVersion.message).toContain('旧规则结果')

    expect(TECHNICAL_AUDIT_UNSUPPORTED_ITEM_IDS).toHaveLength(0)
  })

  it('treats current llms.txt as required and shows stale historical results as unchecked', () => {
    const currentPass = technicalAuditItemDisplay(auditItem({ item_id: 'discovery.llms_txt', status: 'pass', message_code: 'llms_present' }), true, TECHNICAL_AUDIT_RULE_VERSION)
    expect(currentPass).toMatchObject({ status: 'pass', label: '通过', tone: 'pass' })
    expect(technicalAuditItemDisplay(auditItem({ item_id: 'discovery.llms_txt', status: 'fix', message_code: 'llms_missing' })).message).toBe(technicalAuditMessage('llms_missing'))
    expect(technicalAuditItemDisplay(auditItem({ item_id: 'discovery.llms_txt', status: 'fix', message_code: 'llms_unavailable' })).message).toBe(technicalAuditMessage('llms_unavailable'))

    const oldNotApplicable = technicalAuditItemDisplay(auditItem({ item_id: 'discovery.llms_txt', status: 'not_applicable', message_code: 'llms_optional_missing', facts: { presence: 'absent_in_scope' } }), true, 6)
    expect(oldNotApplicable).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked' })

    const snapshot = auditSnapshot('2026-09-08T01:00:00.000Z')
    snapshot.rule_version = 6
    expect(technicalAuditScopeNote(snapshot)).toContain('llms.txt规则已更新，请重新检查该项')
  })

  it('keeps missing or unchecked items visibly unchecked without claiming a confirmed fault', () => {
    const checkingMissing = technicalAuditItemDisplay(undefined, false, TECHNICAL_AUDIT_RULE_VERSION, 'site.dns', true)
    expect(checkingMissing).toMatchObject({ status: 'checking', label: '检查中', tone: 'unchecked', message: '' })

    const checkingReturned = technicalAuditItemDisplay(auditItem({ status: 'pass' }), false, TECHNICAL_AUDIT_RULE_VERSION, 'site.dns', true)
    expect(checkingReturned).toMatchObject({ status: 'pass', label: '通过', tone: 'pass' })

    const missing = technicalAuditItemDisplay(undefined, true)
    expect(missing).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked' })
    expect(missing.message).toBe('检测未完成：本轮未返回该项有效结果；检测未完成不等于已确认网站故障，请重新检查。')

    const unchecked = technicalAuditItemDisplay(auditItem({ status: 'unchecked' }), true, TECHNICAL_AUDIT_RULE_VERSION)
    expect(unchecked).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked' })
    expect(unchecked.message).toContain('本轮未返回该项有效结果')

    const notStarted = technicalAuditItemDisplay(undefined, false)
    expect(notStarted).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked', message: '' })

    const structuredNotStarted = technicalAuditItemDisplay(undefined, true, 4, 'content.structured_data')
    expect(structuredNotStarted).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked' })
    expect(structuredNotStarted.message).toContain('尚无本轮结构化数据检查结论')
  })

  it('keeps v4 results as historical evidence while the v5 item is absent and unchecked', () => {
    const currentV4 = technicalAuditItemDisplay(auditItem({ item_id: 'site.http_status', status: 'fix', message_code: 'http_error' }), true, 4)
    expect(currentV4).toMatchObject({ status: 'review', label: '待确认', tone: 'review' })
    expect(currentV4.message).toContain('旧规则结果')
    const oldStructured = technicalAuditItemDisplay(undefined, true, 4, 'content.structured_data')
    expect(oldStructured).toMatchObject({ status: 'unchecked', label: '未检查', tone: 'unchecked' })
  })

  it('shows structured-data stale or non-conclusive results as unchecked', () => {
    for (const status of ['review', 'not_applicable', 'unchecked'] as const) {
      expect(technicalAuditItemDisplay(auditItem({ item_id: 'content.structured_data', status }), true, TECHNICAL_AUDIT_RULE_VERSION)).toMatchObject({
        status: 'unchecked',
        label: '未检查',
      })
    }
    for (const version of [4, 99, undefined]) {
      for (const status of ['pass', 'fix'] as const) {
        expect(technicalAuditItemDisplay(auditItem({ item_id: 'content.structured_data', status }), true, version)).toMatchObject({
          status: 'unchecked',
          label: '未检查',
        })
      }
    }
    for (const status of ['pass', 'fix'] as const) {
      for (const version of [5, 6]) {
        expect(technicalAuditItemDisplay(auditItem({ item_id: 'content.structured_data', status }), true, version)).toMatchObject({
          status: 'unchecked',
          label: '未检查',
        })
      }
    }
    const currentPass = technicalAuditItemDisplay(auditItem({ item_id: 'content.structured_data', status: 'pass' }), true, TECHNICAL_AUDIT_RULE_VERSION)
    expect(currentPass.status).toBe('pass')
    expect(currentPass.showStatus).toBeUndefined()
  })

  it('shows bounded structured-data failure evidence without listing successful pages', () => {
    const message = technicalAuditItemDisplay(auditItem({
      item_id: 'content.structured_data',
      status: 'fix',
      message_code: 'structured_data_missing',
      facts: { incomplete_pages: 2 },
      evidence: {
        pages: [
          { url: 'https://example.test/ok?secret=hidden', formats: ['JSON-LD'], issues: [] },
          { url: 'https://example.test/missing', formats: [], issues: [] },
          { url: 'https://example.test/invalid', formats: ['JSON-LD'], issues: [{ format: 'JSON-LD', reason: 'invalid_syntax', location: 'script-2' }] },
          { url: 'https://example.test/parser', formats: [], issues: [{ format: 'Microdata', reason: 'parser_error', location: 'document' }] },
        ],
      },
    }), true, TECHNICAL_AUDIT_RULE_VERSION).message
    expect(message).toContain('https://example.test/missing')
    expect(message).toContain('format=JSON-LD')
    expect(message).toContain('reason=invalid_syntax')
    expect(message).toContain('位置=script-2')
    expect(message).toContain('还有2页执行未完成')
    expect(message).not.toContain('https://example.test/ok')
    expect(message).not.toContain('https://example.test/parser')
    expect(message).not.toContain('secret=hidden')
  })

  it('reserves one of three evidence lines for incomplete structured-data pages', () => {
    const message = technicalAuditItemDisplay(auditItem({
      item_id: 'content.structured_data',
      status: 'fix',
      message_code: 'structured_data_missing',
      facts: { incomplete_pages: 1 },
      evidence: {
        pages: [
          { url: 'https://example.test/missing-1', formats: [], issues: [] },
          { url: 'https://example.test/missing-2', formats: [], issues: [] },
          { url: 'https://example.test/missing-3', formats: [], issues: [] },
        ],
      },
    }), true, TECHNICAL_AUDIT_RULE_VERSION).message
    expect(message).toContain('https://example.test/missing-1')
    expect(message).toContain('https://example.test/missing-2')
    expect(message).not.toContain('https://example.test/missing-3')
    expect(message).toContain('还有1页执行未完成')
  })

  it('does not call a v4 snapshot with missing scope fields historical sampling', () => {
    const snapshot = auditSnapshot('2026-09-07T01:00:00.000Z')
    snapshot.rule_version = 4
    snapshot.scope.sampled_pages = undefined as unknown as string[]
    const note = technicalAuditScopeNote(snapshot)
    expect(note).toContain('检查范围证据不完整，待重检')
    expect(note).not.toContain('历史抽样检查')
  })

  it('keeps review evidence and a concrete recheck action in the detail', () => {
    const display = technicalAuditItemDisplay(auditItem({
      item_id: 'links.broken',
      status: 'review',
      message_code: 'broken_link',
      evidence: { broken_links: [{ url: 'https://example.test/missing?token=hidden', status: 404 }] },
    }))
    expect(display.status).toBe('review')
    expect(display.label).toBe('待确认')
    expect(display.message).not.toContain('检测未完成：')
    expect(display.message).toContain('https://example.test/missing')
    expect(display.message).toContain('状态 404')
    expect(display.message).toContain('检测未完成不等于已确认网站故障')
    expect(display.message).not.toContain('token=hidden')
  })

  it('uses item-specific explanations for missing evidence instead of a generic permission message', () => {
    expect(technicalAuditItemDisplay(auditItem({ item_id: 'content.javascript_render', status: 'review', message_code: 'limit_partial' })).message).toContain('静态HTML正文证据不足')
    expect(technicalAuditItemDisplay(auditItem({ item_id: 'structured.applicable_type', status: 'review', message_code: 'review' })).message).toContain('人工核实')
    expect(technicalAuditItemDisplay(auditItem({ item_id: 'site.dns', status: 'review', message_code: 'dns_failed' })).message).toContain('解析记录')
    const internalDeadline = technicalAuditItemDisplay(auditItem({ item_id: 'site.https', status: 'review', message_code: 'timeout' }))
    expect(internalDeadline.message).toContain('证书')
    expect(internalDeadline.message).not.toContain('超时')
    expect(internalDeadline.message).not.toContain('timeout')

    const firstModuleEvidence = technicalAuditItemDisplay(auditItem({
      item_id: 'site.http_status',
      status: 'fix',
      message_code: 'http_error',
      evidence: { error_code: 'total_budget_exhausted' },
    }))
    expect(firstModuleEvidence.message).not.toContain('total_budget_exhausted')

    const laterModuleEvidence = technicalAuditItemDisplay(auditItem({
      item_id: 'discovery.llms_txt',
      status: 'fix',
      message_code: 'llms_invalid',
      evidence: { error_code: 'total_budget_exhausted' },
    }))
    expect(laterModuleEvidence.message).toContain('错误 total_budget_exhausted')
  })

  it('uses only backend blocking evidence for login findings, not login keywords', () => {
    const keywordOnly = technicalAuditItemDisplay(auditItem({
      item_id: 'crawl.login',
      status: 'fix',
      message_code: 'login_required',
      facts: { detected: true, blocked: false },
    }))
    expect(keywordOnly.message).toContain('缺少足够的匿名正文证据')
    expect(keywordOnly.message).not.toContain('检测到明确的登录限制')

    const blocked = technicalAuditItemDisplay(auditItem({
      item_id: 'crawl.login',
      status: 'fix',
      message_code: 'login_required',
      facts: { blocked: true },
    }))
    expect(blocked.message).toContain('明确的登录限制')
  })

  it('renders sanitized URL/status evidence without query credentials or raw bodies', () => {
    const canonical = technicalAuditItemDisplay(auditItem({
      item_id: 'canonical.target',
      status: 'review',
      message_code: 'canonical_review',
      evidence: {
        target_check: [{ url: 'https://user:secret@example.test/canonical?token=hidden#fragment', status: 403 }],
        body: '<html>private response</html>',
      },
    })).message
    expect(canonical).toContain('https://example.test/canonical')
    expect(canonical).toContain('状态 403')
    expect(canonical).not.toContain('secret')
    expect(canonical).not.toContain('token=hidden')
    expect(canonical).not.toContain('private response')

    const broken = technicalAuditItemDisplay(auditItem({
      item_id: 'links.broken',
      status: 'fix',
      message_code: 'broken_link',
      evidence: { broken_links: [{ url: 'https://example.test/missing?api_key=hidden', status: 404 }] },
    })).message
    expect(broken).toContain('https://example.test/missing')
    expect(broken).toContain('状态 404')
    expect(broken).not.toContain('api_key=hidden')
  })

  it('prioritizes page-level HTTP failures over a successful root response', () => {
    const message = technicalAuditItemDisplay(auditItem({
      item_id: 'site.http_status',
      status: 'review',
      message_code: 'http_error',
      evidence: {
        requested_url: 'https://example.test/?root_token=hidden',
        final_url: 'https://example.test/',
        status: 200,
        page_failures: [{ url: 'https://example.test/private?token=hidden', status: 503 }],
      },
    })).message
    expect(message).toContain('https://example.test/private')
    expect(message).toContain('状态 503')
    expect(message.indexOf('https://example.test/private')).toBeLessThan(message.indexOf('状态 200'))
    expect(message).not.toContain('root_token=hidden')
    expect(message).not.toContain('token=hidden')
  })

  it('keeps specific sitemap evidence gaps actionable', () => {
    expect(technicalAuditItemDisplay(auditItem({
      item_id: 'sitemap.coverage',
      status: 'review',
      message_code: 'limit_partial',
    })).message).toContain('本次页面清单未被已读取Sitemap完整覆盖')
  })

  it('prevents duplicate runs and invalidates stale project responses', () => {
    const guard = createTechnicalAuditRunGuard()
    const first = guard.begin('1', 'https://one.test/')
    expect(first).not.toBeNull()
    expect(guard.begin('1', 'https://one.test/')).toBeNull()
    expect(guard.isCurrent(first!)).toBe(true)

    guard.invalidate()
    expect(guard.isCurrent(first!)).toBe(false)
    const second = guard.begin('2', 'https://two.test/')
    expect(second).not.toBeNull()
    expect(guard.isCurrent(second!)).toBe(true)
    guard.finish(second!.token)
    expect(guard.isCurrent(second!)).toBe(false)
  })

  it('keeps streamed draft rows after an execution failure and shows the run error banner', () => {
    expect(panelSource).toContain('const items = useMemo(() => draftItems ?? snapshotItems(snapshot)')
    expect(panelSource).toContain("setError(apiErrorMessage(cause, 'error.server.technical_audit_execution_failed'))")
    expect(panelSource).toContain('A failed run is not an item conclusion')
    expect(panelSource).toContain('setChecking(false)')
  })

  it('uses the technical-audit GET snapshot and supports repeated POST snapshots', async () => {
    const first = auditSnapshot('2026-09-06T08:00:00.000Z')
    const second = auditSnapshot('2026-09-06T08:01:00.000Z')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ audit: first }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ audit: second }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ audit: first }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchTechnicalAudit('42')).toEqual(first)
    expect(await runTechnicalAudit('42')).toEqual(second)
    expect(await runTechnicalAudit('42')).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/42/technical-audit')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' })
  })
})
