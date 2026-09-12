import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  contentAuditConclusionLabel,
  contentAuditConclusionTone,
  contentAuditIssueTypeLabel,
  safeContentAuditUrl,
  type ContentAuditItem,
  type ContentAuditRecord,
  type ContentAuditResult,
} from '../content-audit'
import { contentAuditRunKey, ContentAuditEvidenceModal, ContentAuditPanel, mergeContentAuditItems } from './ContentAuditPanel'

const panelCss = readFileSync(fileURLToPath(new URL('./ContentAuditPanel.css', import.meta.url)), 'utf8')
const panelSource = readFileSync(fileURLToPath(new URL('./ContentAuditPanel.tsx', import.meta.url)), 'utf8')

function cssRulesForClass(css: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`[^{}]*\\.${escaped}(?![a-zA-Z0-9_-])[^{}]*\\{[\\s\\S]*?\\n\\}`, 'g')) ?? []
}

function auditItem(overrides: Partial<ContentAuditItem> = {}): ContentAuditItem {
  return {
    id: 'statement-1',
    statement: '服务覆盖华东地区企业客户',
    explanation: '需核对服务范围',
    page: '服务介绍',
    conclusion: 'insufficient',
    evidence: {
      statement: '服务覆盖华东地区企业客户',
      page: '服务介绍',
      pageUrl: 'https://example.test/services',
      checkedAt: '2026-09-07 15:00',
      pageExcerpt: { location: '页面原文第 2 段', context: '服务覆盖华东地区企业客户。' },
      sources: [{ name: '客户资料', origin: '资料包／服务范围', versionAt: '2026-09-06', sourceText: '服务范围为华东地区。' }],
      judgment: '页面表述超出了当前可核对的资料范围。',
      suggestion: '补充服务范围依据，或收窄表述。',
    },
    ...overrides,
  }
}

function auditResult(items: readonly ContentAuditItem[] = [auditItem()]): ContentAuditResult {
  return { checkedAt: '2026-09-07 15:00', items }
}

function internalAuditItem(overrides: Partial<ContentAuditItem> & { section?: string } = {}): ContentAuditItem & { section?: string } {
  const legacy = auditItem()
  const { conclusion: _conclusion, risk: _risk, ...base } = legacy
  const { sources: _sources, sourceIssues: _sourceIssues, ...evidence } = legacy.evidence
  return {
    ...base,
    evidence,
    issues: [{ type: 'conflict', reason: '官网不同页面的同一表述不一致。', suggestion: '统一页面原句后再使用。' }],
    ...overrides,
  }
}

function internalAuditResult(items: readonly ContentAuditItem[] = [internalAuditItem()]): ContentAuditResult {
  return { scope: 'website_internal', checkedAt: '2026-09-07 15:00', items }
}

describe('ContentAuditPanel', () => {
  it('renders the unconnected empty state and keeps its primary action disabled', () => {
    const html = renderToStaticMarkup(<ContentAuditPanel status="unavailable" result={null} />)
    expect(html).toContain('官网内容检查')
    expect(html).toContain('内容检查')
    expect(html).toContain('disabled=""')
    expect(html).toContain('暂无检查结果。')
    expect(html).not.toContain('请点击“内容检查”开始检查。')
    expect(html).toContain('文章标题')
    expect(html).toContain('所在板块')
    expect(html).toContain('问题类型')
  })

  it('keeps the first-run action prompt only in the card', () => {
    const idle = renderToStaticMarkup(<ContentAuditPanel status="idle" result={null} onCheck={() => undefined} />)
    expect(idle).toContain('暂无检查结果，请点击“内容检查”。')
    expect(idle).not.toContain('暂无检查结果，请点击“内容检查”开始检查。')
    expect(idle.match(/暂无检查结果，请点击“内容检查”。/g)).toHaveLength(1)
    expect(idle).toContain('content-audit-panel__empty')
    const idleHeader = idle.slice(idle.indexOf('<header'), idle.indexOf('</header>') + '</header>'.length)
    expect(idleHeader).not.toContain('请点击“内容检查”')
    expect(idle).not.toContain('disabled=""')

    const loading = renderToStaticMarkup(<ContentAuditPanel status="idle" result={null} loading onCheck={() => undefined} />)
    expect(loading).toContain('正在读取官网内容检查状态…')
    expect(loading).not.toContain('暂无检查结果，请点击“内容检查”。')
    expect(loading).toContain('disabled=""')

    const checking = renderToStaticMarkup(<ContentAuditPanel status="checking" result={null} onCheck={() => undefined} />)
    expect(checking).toContain('检查中…')
    expect(checking).toContain('content-audit-panel__header-status')
    expect(checking.match(/正在检查官网内容…/g)).toHaveLength(1)
    expect(checking).toContain('role="progressbar"')
    expect(checking).not.toContain('content-audit-panel__checking-indicator')
    expect(checking).toContain('暂无检查结果，请点击“内容检查”。')
    expect(checking.match(/暂无检查结果，请点击“内容检查”。/g)).toHaveLength(1)
    expect(checking).not.toContain('清洗')
    expect(checking).not.toContain('检查关键表述')
    expect(checking).toContain('disabled=""')

    const failed = renderToStaticMarkup(<ContentAuditPanel status="failed" result={null} onCheck={() => undefined} />)
    expect(failed).toContain('官网内容检查失败，请重试。')
    expect(failed).toContain('暂无检查结果，请点击“内容检查”。')
    expect(failed.match(/暂无检查结果，请点击“内容检查”。/g)).toHaveLength(1)
    const failedHeader = failed.slice(failed.indexOf('<header'), failed.indexOf('</header>') + '</header>'.length)
    expect(failedHeader).not.toContain('请点击“内容检查”')
    expect(failed).not.toContain('content-audit-panel__error')
  })

  it('keeps read, progress, completion, and execution feedback inside the header column', () => {
    const readFailure = renderToStaticMarkup(<ContentAuditPanel record={null} loadError="状态接口超时" onCheck={() => undefined} />)
    const readFailureHeader = readFailure.slice(readFailure.indexOf('<header'), readFailure.indexOf('</header>') + '</header>'.length)
    const readFailureCard = readFailure.slice(readFailure.indexOf('content-audit-panel__card'), readFailure.indexOf('</section>'))
    expect(readFailureHeader).toContain('状态接口超时')
    expect(readFailureCard).not.toContain('状态接口超时')
    expect(readFailureCard).not.toContain('请刷新重试')

    const progressRecord = {
      status: 'checking' as const,
      startedAt: '2026-09-07T15:00:00.000Z',
      completedAt: null,
      progress: { stage: 'checking' as const, totalPages: 4, processedPages: 2, totalClaims: 3, processedClaims: 1 },
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    const progress = renderToStaticMarkup(<ContentAuditPanel record={progressRecord} loadError="进度接口暂时无法读取" onCheck={() => undefined} />)
    const progressHeader = progress.slice(progress.indexOf('<header'), progress.indexOf('</header>') + '</header>'.length)
    const progressCard = progress.slice(progress.indexOf('content-audit-panel__card'), progress.indexOf('</section>'))
    expect(progressHeader).toContain('进度接口暂时无法读取')
    expect(progressHeader).toContain('正在检查官网内容…')
    expect(progressHeader).toContain('role="progressbar"')
    expect(progressHeader).not.toContain('content-audit-panel__checking-indicator')
    expect(progressHeader).not.toContain('2 / 4 页')
    expect(progressCard).not.toContain('进度接口暂时无法读取')
    expect(progressCard).not.toContain('正在检查官网内容')
    expect(progressCard).not.toContain('检查结果将在完成后显示')

    const completed = renderToStaticMarkup(<ContentAuditPanel record={{ ...progressRecord, status: 'completed', completedAt: '2026-09-07T15:01:00.000Z', result: { scope: 'website_internal', items: [] } }} onCheck={() => undefined} />)
    const completedHeader = completed.slice(completed.indexOf('<header'), completed.indexOf('</header>') + '</header>'.length)
    const completedCard = completed.slice(completed.indexOf('content-audit-panel__card'), completed.indexOf('</section>'))
    expect(completedHeader).toContain('官网内容检查已完成，当前没有可展示的问题。')
    expect(completedHeader).toContain('operation-feedback--success')
    expect(completedCard).not.toContain('content-audit-panel__empty')
    expect(completedCard).not.toContain('暂无检查结果')

    const partial = renderToStaticMarkup(<ContentAuditPanel record={{ ...progressRecord, status: 'completed', completedAt: '2026-09-07T15:01:00.000Z', result: { scope: 'website_internal', items: [] }, executionErrors: [{ stage: 'source_fetch', message: '来源读取超时' }] }} onCheck={() => undefined} />)
    const partialHeader = partial.slice(partial.indexOf('<header'), partial.indexOf('</header>') + '</header>'.length)
    const partialCard = partial.slice(partial.indexOf('content-audit-panel__card'), partial.indexOf('</section>'))
    expect(partialHeader).toContain('官网内容检查已完成，当前没有可展示的问题。')
    expect(partialHeader).toContain('部分内容处理失败：官网内容检查在执行阶段失败：来源读取超时。')
    expect(partialCard).not.toContain('来源读取超时')

    const longCause = '长错误原因'.repeat(80)
    const longFailure = renderToStaticMarkup(<ContentAuditPanel record={null} loadError={longCause} />)
    const longHeader = longFailure.slice(longFailure.indexOf('<header'), longFailure.indexOf('</header>') + '</header>'.length)
    expect(longHeader).toContain(longCause)
  })

  it('uses one checking feedback and progress bar regardless of persisted progress details', () => {
    const base = {
      status: 'checking' as const,
      startedAt: '2026-09-07T15:00:00.000Z',
      completedAt: null,
      progress: { stage: 'extracting' as const, totalPages: 29, processedPages: 0, totalClaims: 0, processedClaims: 0 },
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    for (const record of [
      base,
      { ...base, progress: { ...base.progress, stage: 'cleaning' as const, cleanedPages: 7, processedPages: 0 } },
      { ...base, progress: { ...base.progress, processedPages: 3 } },
    ]) {
      const html = renderToStaticMarkup(<ContentAuditPanel record={record} onCheck={() => undefined} />)
      const header = html.slice(html.indexOf('<header'), html.indexOf('</header>') + '</header>'.length)
      expect(header).toContain('正在检查官网内容…')
      expect(header).toContain('role="progressbar"')
      expect(header).not.toContain('content-audit-panel__checking-indicator')
      expect(header).not.toContain(' / ')
      expect(header).not.toContain('清洗')
      expect(header).not.toContain('检查关键表述')
    }

    const completed = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'completed', completedAt: '2026-09-07T15:01:00.000Z', result: { scope: 'website_internal', items: [] } }} onCheck={() => undefined} />)
    expect(completed).not.toContain('content-audit-panel__checking-indicator')
  })

  it('shows balanced page coverage counts and labels links fallback as a discovered range', () => {
    const html = renderToStaticMarkup(<ContentAuditPanel record={{
      status: 'checking',
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: null,
      progress: {
        stage: 'checking',
        totalPages: 29,
        processedPages: 8,
        failedPages: 2,
        pendingPages: 19,
        baselineReady: true,
        baselineSource: 'sitemap',
        totalClaims: 0,
        processedClaims: 0,
      },
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }} onCheck={() => undefined} />)
    expect(html).toContain('正在检查官网内容，已读取 8/29 页，失败 2 页，待读取 19 页')

    const linksFallback = renderToStaticMarkup(<ContentAuditPanel record={{
      status: 'checking',
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: null,
      progress: {
        stage: 'checking',
        totalPages: 3,
        processedPages: 1,
        failedPages: 0,
        pendingPages: 2,
        baselineReady: true,
        baselineSource: 'links',
        totalClaims: 0,
        processedClaims: 0,
      },
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }} onCheck={() => undefined} />)
    expect(linksFallback).toContain('本次已发现范围，非全站总数')
    expect(linksFallback).not.toContain('Sitemap')

    const building = renderToStaticMarkup(<ContentAuditPanel record={{
      status: 'checking',
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: null,
      progress: { stage: 'checking', totalPages: 1, processedPages: 0, baselineReady: false, totalClaims: 0, processedClaims: 0 },
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }} onCheck={() => undefined} />)
    expect(building).toContain('正在建立页面清单…')
  })

  it('shows the current checking progress before one determinate or indeterminate bar', () => {
    const baseRecord = {
      status: 'checking' as const,
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: null,
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 1, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    const progress = renderToStaticMarkup(<ContentAuditPanel record={{
      ...baseRecord,
      progress: { stage: 'checking', totalPages: 30, processedPages: 27, failedPages: 0, pendingPages: 3, baselineReady: true, baselineSource: 'sitemap', totalClaims: 0, processedClaims: 0 },
    }} onCheck={() => undefined} />)
    const progressTextIndex = progress.indexOf('正在检查官网内容，已读取 27/30 页，失败 0 页，待读取 3 页')
    const progressBarIndex = progress.indexOf('role="progressbar"')
    expect(progressTextIndex).toBeGreaterThan(-1)
    expect(progressBarIndex).toBeGreaterThan(progressTextIndex)
    expect(progress).toContain('aria-label="官网页面读取进度"')
    expect(progress).toContain('aria-valuemax="30"')
    expect(progress).toContain('aria-valuenow="27"')
    expect(progress).toContain('style="width:90%"')
    expect(progress.match(/正在检查官网内容，已读取 /g)).toHaveLength(1)
    expect(progress).not.toContain('官网内容检查已完成')
    expect(progress).toContain('aria-busy="true"')
    expect(progress).toContain('disabled=""')

    const completeRead = renderToStaticMarkup(<ContentAuditPanel record={{
      ...baseRecord,
      progress: { stage: 'checking', totalPages: 30, processedPages: 30, failedPages: 0, pendingPages: 0, baselineReady: true, baselineSource: 'sitemap', totalClaims: 0, processedClaims: 0 },
    }} onCheck={() => undefined} />)
    expect(completeRead).toContain('已读取 30/30 页，失败 0 页，待读取 0 页')
    expect(completeRead).toContain('aria-valuenow="30"')
    expect(completeRead).not.toContain('官网内容检查已完成')

    const building = renderToStaticMarkup(<ContentAuditPanel record={{
      ...baseRecord,
      progress: { stage: 'checking', totalPages: 0, processedPages: 0, baselineReady: false, totalClaims: 0, processedClaims: 0 },
    }} onCheck={() => undefined} />)
    expect(building).toContain('正在建立页面清单…')
    expect(building).toContain('role="progressbar"')
    expect(building).not.toContain('aria-valuenow=')

    const oldCompleted = renderToStaticMarkup(<ContentAuditPanel
      record={{ ...baseRecord, status: 'completed', completedAt: '2026-09-10T00:01:00.000Z', progress: { stage: 'checking', totalPages: 30, processedPages: 30, failedPages: 0, pendingPages: 0, baselineReady: true, baselineSource: 'sitemap', totalClaims: 0, processedClaims: 0 } } as ContentAuditRecord}
      taskActive
      loading
      loadError="状态读取暂时失败"
      onCheck={() => undefined}
    />)
    expect(oldCompleted).toContain('正在检查官网内容…')
    expect(oldCompleted).not.toContain('已读取 30/30 页')
    expect(oldCompleted).not.toContain('官网内容检查已完成')
    expect(oldCompleted).not.toContain('正在读取官网内容检查状态…')
    expect(oldCompleted).toContain('状态读取暂时失败')
    expect(oldCompleted).toContain('aria-busy="true"')
    expect(oldCompleted).toContain('disabled=""')
    expect(oldCompleted).not.toContain('aria-valuenow=')
  })

  it('uses the same running state for submission, background tasks, status, and button guards', () => {
    expect(panelSource).toContain("const runningState = taskActive || checkInFlight || status === 'checking'")
    expect(panelSource).toContain('setCheckInFlight(true)')
    expect(panelSource).toContain('const canCheck = Boolean(onCheck) && !loadingState && !unavailableState && !runningState')
    expect(panelSource).toContain('aria-busy={loadingState || runningState}')
    expect(panelSource).toContain('disabled={!canCheck}')
  })

  it('keeps the result list to three rows until the accessible toggle is activated', () => {
    const items = Array.from({ length: 5 }, (_, index) => internalAuditItem({ id: `statement-${index + 1}`, page: `文章${index + 1}`, section: index === 0 ? '服务介绍' : undefined, statement: `表述${index + 1}` }))
    const html = renderToStaticMarkup(<ContentAuditPanel status="completed" result={internalAuditResult(items)} onCheck={() => undefined} />)
    expect(html).toContain('文章标题')
    expect(html).toContain('所在板块')
    expect(html).toContain('问题类型')
    expect(html).toContain('文章1')
    expect(html).toContain('文章3')
    expect(html).not.toContain('文章4')
    expect(html).toContain('官网内容检查已完成，共 5 项检查结果。')
    expect(html).not.toContain('已展示 5 条需要关注的问题')
    expect(html).toContain('服务介绍')
    expect(html).toContain('未标注')
    expect(html).toContain('aria-label="展开核查结果"')
    expect(html).toContain('aria-controls="content-audit-results"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('检查问题')
    expect(html).not.toContain('查看全部')
    expect(panelSource).toContain('setExpanded((current) => !current)')
    expect(panelSource).toContain('onKeyDown={handleKeyDown}')
    expect(panelSource).toContain("event.key !== 'Enter' && event.key !== ' '")
  })

  it('renders all internal issue types and preserves multiple types on one row', () => {
    const types = ['conflict', 'incomplete', 'risk'] as const
    const items = types.map((type, index) => internalAuditItem({
      id: `issue-${index}`,
      issues: [{ type, reason: `${type}原因`, suggestion: `${type}建议` }],
    }))
    const combined = internalAuditItem({
      id: 'issue-combined',
      issues: types.map((type) => ({ type, reason: `${type}原因`, suggestion: `${type}建议` })),
    })
    const html = renderToStaticMarkup(<ContentAuditPanel status="completed" result={internalAuditResult([...items, combined])} onCheck={() => undefined} />)
    expect(html).toContain('数据冲突')
    expect(html).toContain('信息缺项')
    expect(html).toContain('表述风险')
    expect(contentAuditIssueTypeLabel('conflict')).toBe('数据冲突')
    expect(contentAuditIssueTypeLabel('incomplete')).toBe('信息缺项')
    expect(contentAuditIssueTypeLabel('risk')).toBe('表述风险')
  })

  it('renders complete evidence, long text, and an empty source list in the read-only modal', () => {
    const longText = '长文本'.repeat(160)
    const item = auditItem({
      statement: longText,
      evidence: {
        ...auditItem().evidence,
        statement: longText,
        pageUrl: 'javascript:alert(1)',
        pageExcerpt: { location: '正文位置', context: longText },
        sources: [],
        judgment: '判断内容',
        suggestion: '建议内容',
      },
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} onClose={() => undefined} />)
    expect(html).toContain('内容核查证据')
    expect(html).toContain('长文本')
    expect(html).toContain('所在页面')
    expect(html).toContain('核查时间')
    expect(html).toContain('页面原文')
    expect(html).toContain('依据来源')
    expect(html).toContain('核查判断')
    expect(html).toContain('修改建议')
    expect(html).toContain('未提供')
    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).not.toContain('dangerouslySetInnerHTML')
    expect(panelSource).toContain('closeOnBackdrop')
    expect(panelSource).toContain('focusManagement')
    expect(panelSource).toContain('target="_blank"')
    expect(panelSource).toContain('rel="noopener noreferrer"')
    expect(panelSource).toContain('statusLabel(status, false)')
    expect(panelSource).toContain("event.key !== 'Escape'")
  })

  it('renders internal issue details and cached comparisons without third-party source sections', () => {
    const item = internalAuditItem({
      id: 'internal-detail',
      issues: [
        { type: 'conflict', reason: '同一服务在两页中的条件不一致。', suggestion: '统一两页原句并保留适用条件。' },
        { type: 'risk', reason: '承诺未说明适用边界。', suggestion: '改写为带条件的服务描述。' },
      ],
      evidence: {
        ...internalAuditItem().evidence,
        comparisons: [{
          page: '价格说明',
          pageUrl: 'https://example.test/pricing',
          statement: '价格按项目范围评估。',
          location: '正文第 3 段',
          context: '价格会根据项目范围和服务条件评估。',
        }],
      },
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} internal onClose={() => undefined} />)
    expect(html).toContain('官网内容检查详情')
    expect(html).toContain('检查问题')
    expect(html).toContain('数据冲突')
    expect(html).toContain('表述风险')
    expect(html).toContain('同一服务在两页中的条件不一致。')
    expect(html).toContain('改写为带条件的服务描述。')
    expect(html).toContain('官网内部对照（1）')
    expect(html).toContain('价格按项目范围评估。')
    expect(html).not.toContain('依据来源')
    expect(html).not.toContain('来源原文')
    expect(html).not.toContain('来源读取情况')
  })

  it('marks retained review outcomes in the existing result column and evidence detail', () => {
    const statuses = ['passed', 'persists', 'unverified'] as const
    const reviews = statuses.map((status, index) => ({
      issueId: `review-${index}`,
      status,
      statement: `复查表述${index}`,
      page: `复查页面${index}`,
      pageUrl: `https://example.test/review-${index}`,
      checkedAt: '2026-09-08 15:00',
      reason: `${status}复查原因`,
      suggestion: `${status}复查建议`,
      evidence: status === 'unverified' ? null : {
        statement: `复查表述${index}`,
        page: `复查页面${index}`,
        pageUrl: `https://example.test/review-${index}`,
        pageExcerpt: { location: '正文第1段', context: `复查表述${index}的页面原文` },
        judgment: `${status}判断`,
        suggestion: `${status}建议`,
      },
    }))
    const items = statuses.map((_, index) => internalAuditItem({ id: `review-${index}`, page: `问题页面${index}` }))
    const result = { ...internalAuditResult(items), reviews }
    const html = renderToStaticMarkup(<ContentAuditPanel status="completed" result={result} onCheck={() => undefined} />)
    expect(html).toContain('已通过')
    expect(html).toContain('仍存在')
    expect(html).toContain('未验证')

    const detail = renderToStaticMarkup(<ContentAuditEvidenceModal item={items[0]!} internal reviews={reviews} onClose={() => undefined} />)
    const detailText = detail.replace(/<[^>]+>/g, '')
    expect(detail).toContain('复查结果')
    expect(detailText).toContain('复查原因：passed复查原因')
    expect(detailText).toContain('复查建议：passed复查建议')
    expect(detailText).toContain('复查证据：')
    expect(detailText).toContain('复查表述0的页面原文')
  })

  it('merges one reciprocal conflict pair without duplicating locations or borrowing the second section', () => {
    const firstPrimary = { page: '页面A', pageUrl: 'https://example.test/a', statement: '页面A原句', location: '正文第1段', context: '页面A上下文' }
    const firstRepeat = { page: '页面A', pageUrl: 'https://example.test/a', statement: '页面A原句', location: '正文第4段', context: '页面A重复上下文' }
    const secondPrimary = { page: '页面B', pageUrl: 'https://example.test/b', statement: '页面B原句', location: '正文第2段', context: '页面B上下文' }
    const secondRepeat = { page: '页面B', pageUrl: 'https://example.test/b', statement: '页面B原句', location: '正文第5段', context: '页面B重复上下文' }
    const sharedConflict = { type: 'conflict' as const, reason: '两页的条件不一致。', suggestion: '统一两页原句并保留适用条件。' }
    const first = internalAuditItem({
      id: 'claim-a',
      page: '页面A',
      statement: firstPrimary.statement,
      locations: [firstPrimary, firstRepeat],
      issues: [sharedConflict, { type: 'incomplete', reason: '页面A缺少计费周期。', suggestion: '补充计费周期。' }],
      evidence: { ...internalAuditItem().evidence, statement: firstPrimary.statement, page: firstPrimary.page, pageUrl: firstPrimary.pageUrl, pageExcerpt: { location: firstPrimary.location, context: firstPrimary.context }, comparisons: [secondPrimary, secondRepeat, secondPrimary] },
    })
    const second = internalAuditItem({
      id: 'claim-b',
      page: '页面B',
      section: '价格说明',
      statement: secondPrimary.statement,
      locations: [secondPrimary, secondRepeat],
      review: { issueId: 'claim-b', status: 'persists', statement: secondPrimary.statement, page: secondPrimary.page, pageUrl: secondPrimary.pageUrl, reason: '复查仍存在。', suggestion: '继续修订。' },
      issues: [sharedConflict, { type: 'risk', reason: '页面B承诺缺少边界。', suggestion: '改为带条件的表述。' }],
      evidence: { ...internalAuditItem().evidence, statement: secondPrimary.statement, page: secondPrimary.page, pageUrl: secondPrimary.pageUrl, pageExcerpt: { location: secondPrimary.location, context: secondPrimary.context }, comparisons: [firstPrimary, firstRepeat, firstPrimary] },
    })
    const firstSnapshot = structuredClone(first)
    const secondSnapshot = structuredClone(second)

    const merged = mergeContentAuditItems([first, second])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(first.id)
    expect(merged[0].page).toBe('页面A')
    expect(merged[0].section).toBeUndefined()
    expect(merged[0].locations).toEqual([firstPrimary, firstRepeat])
    expect(merged[0].evidence.comparisons).toEqual([secondPrimary, secondRepeat])
    expect(merged[0].evidence.comparisons).not.toEqual(expect.arrayContaining([firstPrimary, firstRepeat]))
    expect(merged[0].issues?.map((issue) => issue.type)).toEqual(['conflict', 'incomplete', 'risk'])
    expect(merged[0].review).toMatchObject({ issueId: 'claim-b', status: 'persists' })
    expect(first).toEqual(firstSnapshot)
    expect(second).toEqual(secondSnapshot)
  })

  it('highlights only the cached statement in internal evidence and repeated locations', () => {
    const statement = '缓存原句 <em>可重复</em>'
    const locationStatement = '位置原句'
    const comparisonStatement = '对照原句'
    const item = internalAuditItem({
      statement,
      evidence: {
        ...internalAuditItem().evidence,
        statement,
        pageExcerpt: { location: '正文', context: `前文 ${statement} 后文 ${statement}` },
        comparisons: [{
          page: '价格说明',
          pageUrl: 'https://example.test/pricing',
          statement: comparisonStatement,
          location: '正文第 3 段',
          context: `对照上下文 ${comparisonStatement}，${comparisonStatement}`,
        }],
      },
      locations: [
        { page: '服务介绍', pageUrl: 'https://example.test/services', statement: locationStatement, location: '正文第 2 段', context: `位置前 ${locationStatement} 后 ${locationStatement}` },
        { page: '常见问题', pageUrl: 'https://example.test/faq', statement: '未出现原句', location: 'FAQ第 1 问', context: '这里没有相关表述。' },
      ],
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} internal onClose={() => undefined} />)
    const mark = '<mark class="content-audit-evidence__highlight">'
    expect(html.match(new RegExp(`${mark}缓存原句 &lt;em&gt;可重复&lt;/em&gt;</mark>`, 'g'))).toHaveLength(3)
    expect(html.match(new RegExp(`${mark}${locationStatement}</mark>`, 'g'))).toHaveLength(2)
    expect(html.match(new RegExp(`${mark}${comparisonStatement}</mark>`, 'g'))).toHaveLength(3)
    expect(html).not.toContain(`${mark}同一服务在两页中的条件不一致。`)
    expect(html).toContain('&lt;em&gt;可重复&lt;/em&gt;')
    expect(html).not.toContain('<em>可重复</em>')
  })

  it('uses the small NFKC and whitespace fallback without altering displayed context', () => {
    const statement = '服务说明？ 价格，按条件'
    const context = `前文 服务说明? 价格,按条件 后文 服务说明? 价格,按条件`
    const item = internalAuditItem({
      statement,
      evidence: {
        ...internalAuditItem().evidence,
        statement,
        pageExcerpt: { location: '正文', context },
      },
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} internal onClose={() => undefined} />)
    const mark = '<mark class="content-audit-evidence__highlight">'
    expect(html.match(new RegExp(`${mark}服务说明\\? 价格,按条件</mark>`, 'g'))).toHaveLength(2)
    expect(html.replace(/<[^>]+>/g, '')).toContain(context)
  })

  it('does not highlight an unrelated context or infer a range from the issue reason', () => {
    const item = internalAuditItem({
      statement: '未出现的原句',
      evidence: {
        ...internalAuditItem().evidence,
        statement: '未出现的原句',
        pageExcerpt: { location: '正文', context: '这是一整段没有目标的上下文。' },
      },
      issues: [{ type: 'conflict', reason: '这是一整段没有目标的上下文。', suggestion: '仅用于测试。' }],
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} internal onClose={() => undefined} />)
    const mark = '<mark class="content-audit-evidence__highlight">'
    expect(html.match(new RegExp(mark, 'g'))).toHaveLength(1)
    expect(html).not.toContain(`${mark}这是一整段没有目标的上下文。</mark>`)
  })

  it('uses the live audit scope and generation-linkage wording in the info popover', () => {
    expect(panelSource).toContain("t('content.infoText')")
    expect(panelSource).not.toContain('结果仅供编辑核对')
  })

  it('hides legacy results and preserves the ordinary neutral empty state', () => {
    const html = renderToStaticMarkup(<ContentAuditPanel status="completed" result={auditResult([auditItem()])} onCheck={() => undefined} />)
    const failedHtml = renderToStaticMarkup(<ContentAuditPanel record={{ status: 'failed', error: '旧版来源读取失败', result: auditResult([auditItem()]) } as ContentAuditRecord} onCheck={() => undefined} />)
    expect(html.match(/暂无检查结果。/g)).toHaveLength(1)
    expect(html).toContain('content-audit-panel__empty')
    expect(html).not.toContain('服务覆盖华东地区企业客户')
    expect(html).not.toContain('有依据')
    expect(html).not.toContain('来源原文')
    expect(failedHtml.match(/暂无检查结果。/g)).toHaveLength(1)
    expect(failedHtml).toContain('content-audit-panel__empty')
    expect(failedHtml).not.toContain('旧版来源读取失败')
    expect(failedHtml).not.toContain('role="alert"')
  })

  it('maps API records to idle, running progress, and failed execution states', () => {
    const progress = {
      stage: 'checking' as const,
      totalPages: 4,
      processedPages: 2,
      totalClaims: 3,
      processedClaims: 1,
    }
    const base = {
      startedAt: '2026-09-07T15:00:00.000Z',
      completedAt: null,
      progress,
      result: null,
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    const idle = renderToStaticMarkup(<ContentAuditPanel record={null} onCheck={() => undefined} />)
    const checking = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'checking' } as ContentAuditRecord} onCheck={() => undefined} />)
    const completedEmpty = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'completed', result: { scope: 'website_internal', items: [] } } as ContentAuditRecord} onCheck={() => undefined} />)
    const failed = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'failed', error: '来源读取失败', executionErrors: [{ stage: 'source_fetch', message: '超时', pageUrl: 'https://example.test/page' }], result: { scope: 'website_internal', items: [] } } as ContentAuditRecord} onCheck={() => undefined} />)

    expect(idle).toContain('暂无检查结果，请点击“内容检查”。')
    expect(idle).not.toContain('暂无检查结果，请点击“内容检查”开始检查。')
    expect(idle.match(/暂无检查结果，请点击“内容检查”。/g)).toHaveLength(1)
    expect(idle).not.toContain('disabled=""')
    expect(checking).toContain('content-audit-panel__header-status')
    expect(checking).toContain('正在检查官网内容…')
    expect(checking).not.toContain('2 / 4 页')
    expect(checking).not.toContain('条表述')
    expect(checking).toContain('暂无检查结果，请点击“内容检查”。')
    expect(checking.match(/暂无检查结果，请点击“内容检查”。/g)).toHaveLength(1)
    expect(checking).not.toContain('请点击“内容检查”开始检查。')
    expect(checking).toContain('disabled=""')
    expect(completedEmpty).not.toContain('暂无检查结果。')
    expect(completedEmpty).not.toContain('content-audit-panel__empty')
    expect(completedEmpty).toContain('官网内容检查已完成，当前没有可展示的问题。')
    expect(failed).toContain('官网内容检查在执行阶段失败：超时。')
    expect(failed.match(/官网内容检查在执行阶段失败：超时。/g)).toHaveLength(1)
    expect(failed).not.toContain('暂无检查结果，请点击“内容检查”。')
    expect(failed).not.toContain('执行情况（未完成）')
  })

  it('keeps the last valid result data while hiding the previous-result banner', () => {
    const previous = internalAuditResult([internalAuditItem({ id: 'previous-item', page: '上一轮服务介绍' })])
    const base = {
      startedAt: '2026-09-08T15:00:00.000Z',
      completedAt: null,
      progress: { stage: 'checking' as const, totalPages: 2, processedPages: 1, totalClaims: 1, processedClaims: 0 },
      result: null,
      previousResult: previous,
      previousCompletedAt: '2026-09-07T15:01:00.000Z',
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    const checking = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'checking' } as ContentAuditRecord} onCheck={() => undefined} />)
    const failed = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'failed', error: '本轮检查失败' } as ContentAuditRecord} onCheck={() => undefined} />)

    for (const html of [checking, failed]) {
      expect(html).not.toContain('上一轮有效结果')
      expect(html).not.toContain('完成时间：2026-09-07T15:01:00.000Z')
      expect(html).toContain('上一轮服务介绍')
      expect(html).not.toContain('本轮检查完成前仅供查看，不作为本轮方案设计依据。')
    }
    expect(checking).toContain('正在检查官网内容…')
    expect(checking).not.toContain('暂无检查结果，请点击“内容检查”。')
    expect(failed).toContain('官网内容检查失败')
    expect(failed).not.toContain('暂无检查结果，请点击“内容检查”。')
  })

  it('renders internal risk issues without relabeling them as external conclusions', () => {
    const supportedWithRisk = internalAuditItem({
      id: 'supported-risk',
      issues: [{ type: 'risk', reason: '承诺缺少适用条件', suggestion: '补充适用条件并收窄承诺。' }],
    })
    const riskOnly = internalAuditItem({
      id: 'risk-only',
      issues: [{ type: 'risk', reason: '表述暗示无条件结果', suggestion: '改为条件化表述。' }],
    })
    const combined = renderToStaticMarkup(<ContentAuditPanel status="completed" result={internalAuditResult([supportedWithRisk, riskOnly])} onCheck={() => undefined} />)
    expect(combined).toContain('表述风险')
    expect(combined).not.toContain('有依据')
    expect(combined).not.toContain('无法核实')

    const riskOnlyHtml = renderToStaticMarkup(<ContentAuditPanel status="completed" result={internalAuditResult([riskOnly])} onCheck={() => undefined} />)
    expect(riskOnlyHtml).toContain('表述风险')
    expect(riskOnlyHtml).not.toContain('有依据')
    expect(riskOnlyHtml).not.toContain('无法核实')
  })

  it('shows risk, internal comparisons, and source issues in the evidence modal', () => {
    const item = auditItem({
      id: 'internal-conflict',
      conclusion: 'conflict',
      risk: { reason: '当前承诺未说明适用条件', suggestion: '补充条件后再使用该表述。' },
      evidence: {
        ...auditItem().evidence,
        sources: [],
        comparisons: [{
          page: '价格说明',
          pageUrl: 'https://example.test/pricing',
          statement: '价格按项目范围评估。',
          location: '正文第 3 段',
          context: '价格会根据项目范围和服务条件评估。',
        }],
        sourceIssues: [{
          stage: 'source_fetch',
          message: '公开来源读取超时',
          sourceUrl: 'https://source.example/rule?token=secret',
          attempts: 2,
          resolution: '已重试一次，仍无法读取。',
        }],
      },
    })
    const html = renderToStaticMarkup(<ContentAuditEvidenceModal item={item} onClose={() => undefined} />)
    const visibleText = html.replace(/<[^>]+>/g, '')
    expect(html).toContain('表述风险')
    expect(html).toContain('当前承诺未说明适用条件')
    expect(html).toContain('补充条件后再使用该表述。')
    expect(html).toContain('官网内部对照（1）')
    expect(html).toContain('打开已采集页面')
    expect(html).toContain('https://example.test/pricing')
    expect(html).toContain('价格按项目范围评估。')
    expect(html).toContain('价格会根据项目范围和服务条件评估。')
    expect(html).toContain('<h3>来源读取情况</h3>')
    expect(html).not.toContain('<h3>无法核实原因</h3>')
    expect(visibleText).toContain('来源读取情况：公开来源读取超时')
    expect(html).toContain('https://source.example/rule')
    expect(html).not.toContain('token=secret')
    expect(visibleText).toContain('尝试次数：2 次')
    expect(visibleText).toContain('处理结果：已重试一次，仍无法读取。')

    const insufficientHtml = renderToStaticMarkup(<ContentAuditEvidenceModal item={{ ...item, conclusion: 'insufficient' }} onClose={() => undefined} />)
    expect(insufficientHtml).toContain('<h3>无法核实原因</h3>')

    const supportedHtml = renderToStaticMarkup(<ContentAuditEvidenceModal item={{ ...item, conclusion: 'supported' }} onClose={() => undefined} />)
    expect(supportedHtml).toContain('<h3>来源读取情况</h3>')
    expect(supportedHtml).not.toContain('<h3>无法核实原因</h3>')
  })

  it('keeps a failed record as one brief header error and no card error wall', () => {
    const item = internalAuditItem({
      id: 'partial-item',
      issues: [{ type: 'incomplete', reason: '关键条件缺少计费周期。', suggestion: '补充计费周期或删去确定性承诺。' }],
    })
    const failedRecord = {
      status: 'failed' as const,
      startedAt: '2026-09-07T15:00:00.000Z',
      completedAt: '2026-09-07T15:01:00.000Z',
      progress: { stage: 'checking' as const, totalPages: 2, processedPages: 1, totalClaims: 2, processedClaims: 1 },
      result: { scope: 'website_internal', items: [item] },
      error: '模型执行失败，请重试。',
      executionErrors: [{ stage: 'search', message: '内部原始错误细节不应直接铺开' }],
      usage: { modelCalls: 1, searchCalls: 1, sourceFetches: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, elapsedMs: 1 },
    } as unknown as ContentAuditRecord
    const html = renderToStaticMarkup(<ContentAuditPanel record={failedRecord} onCheck={() => undefined} />)
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('官网内容检查在执行阶段失败：内部原始错误细节不应直接铺开。')
    expect(html).not.toContain('模型执行失败，请重试。')
    expect(html).not.toContain('执行情况（未完成）')
    expect(html).not.toContain('content-audit-panel__error')
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>') + '</header>'.length)
    const card = html.slice(html.indexOf('content-audit-panel__card'), html.indexOf('</section>'))
    expect(header).toContain('官网内容检查在执行阶段失败：内部原始错误细节不应直接铺开。')
    expect(card).not.toContain('内部原始错误细节不应直接铺开')
  })

  it('keeps task failures separate from status-read failures and applies one execution-error priority', () => {
    expect(panelSource).toContain("const terminalFailureMessage = checkFailureMessage || persistedFailureMessage || taskFailureMessage || t('content.failure')")
    const persisted = renderToStaticMarkup(<ContentAuditPanel
      record={{ status: 'failed', error: '持久化失败原因', executionErrors: [], result: null } as unknown as ContentAuditRecord}
      taskError="后台任务失败原因"
      onCheck={() => undefined}
    />)
    expect(persisted.match(/role="alert"/g)).toHaveLength(1)
    expect(persisted).toContain('官网内容检查失败：持久化失败原因。请重试。')
    expect(persisted).not.toContain('后台任务失败原因')

    const taskOnly = renderToStaticMarkup(<ContentAuditPanel
      record={null}
      taskError="后台任务失败原因"
      onCheck={() => undefined}
    />)
    expect(taskOnly.match(/role="alert"/g)).toHaveLength(1)
    expect(taskOnly).toContain('后台任务失败原因')
    expect(taskOnly).not.toContain('状态读取失败')

    const independentReadFailure = renderToStaticMarkup(<ContentAuditPanel
      record={{ status: 'failed', error: '持久化失败原因', executionErrors: [], result: null } as unknown as ContentAuditRecord}
      loadError="状态接口暂时无法读取"
      taskError="后台任务失败原因"
      onCheck={() => undefined}
    />)
    expect(independentReadFailure.match(/role="alert"/g)).toHaveLength(2)
    expect(independentReadFailure).toContain('状态接口暂时无法读取')
    expect(independentReadFailure).toContain('官网内容检查失败：持久化失败原因。请重试。')
    expect(independentReadFailure).not.toContain('后台任务失败原因')
  })

  it('shows only the confirmed items available during a running audit', () => {
    const first = internalAuditItem({ id: 'statement-1', page: '首篇文章', statement: '首条已确认表述' })
    const second = internalAuditItem({ id: 'statement-2', page: '第二篇文章', statement: '第二条已确认表述' })
    const base = {
      startedAt: '2026-09-07T15:00:00.000Z',
      completedAt: null,
      progress: { stage: 'checking' as const, totalPages: 2, processedPages: 2, totalClaims: 2, processedClaims: 1 },
      error: null,
      executionErrors: [],
      usage: { modelCalls: 0, searchCalls: 0, sourceFetches: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    }
    const one = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'checking', result: { scope: 'website_internal', items: [first] } } as ContentAuditRecord} onCheck={() => undefined} />)
    const two = renderToStaticMarkup(<ContentAuditPanel record={{ ...base, status: 'checking', result: { scope: 'website_internal', items: [first, second] } } as ContentAuditRecord} onCheck={() => undefined} />)

    expect(one).toContain('首篇文章')
    expect(one).not.toContain('第二篇文章')
    expect(one).not.toContain('暂无检查结果')
    expect(two).toContain('首篇文章')
    expect(two).toContain('第二篇文章')
    expect(two).toContain('disabled=""')
  })

  it('keeps the same-run reset and latest-item contracts explicit without claiming static SSR interaction coverage', () => {
    const sameRun = { startedAt: 'run-1', status: 'checking' } as ContentAuditRecord
    const sameRunUpdate = { ...sameRun, progress: { stage: 'checking' as const, totalPages: 2, processedPages: 1, totalClaims: 2, processedClaims: 1 } }
    const newRun = { ...sameRun, startedAt: 'run-2' }
    expect(contentAuditRunKey(sameRun, null)).toBe(contentAuditRunKey(sameRunUpdate, { items: [auditItem()] }))
    expect(contentAuditRunKey(sameRun, null)).not.toBe(contentAuditRunKey(newRun, null))
    const staticFirst = auditResult([auditItem({ id: 'static-1' })])
    const staticAppend = { ...staticFirst, items: [...staticFirst.items, auditItem({ id: 'static-2' })] }
    const staticNewBatch = auditResult([auditItem({ id: 'static-new' })])
    expect(contentAuditRunKey(undefined, staticFirst)).toBe(contentAuditRunKey(undefined, staticAppend))
    expect(contentAuditRunKey(undefined, staticFirst)).not.toBe(contentAuditRunKey(undefined, staticNewBatch))
    expect(panelSource).toContain('const [selectedItemId, setSelectedItemId]')
    expect(panelSource).toContain('selectedItemRunKey === runKey')
    expect(panelSource).toContain('}, [runKey])')
    expect(panelSource).toContain("if (status === 'failed' && !checkInFlight)")
    expect(panelSource).not.toContain('}, [result, statusProp, record, loadError, loading])')
  })

  it('shows repeated claim locations only when the API returns more than one', () => {
    const single = renderToStaticMarkup(<ContentAuditEvidenceModal item={auditItem({ locations: [{ page: '服务介绍', pageUrl: 'https://example.test/services', statement: '服务覆盖华东地区企业客户', location: '正文第2段', context: '页面上下文' }] })} onClose={() => undefined} />)
    const multiple = renderToStaticMarkup(<ContentAuditEvidenceModal item={auditItem({ locations: [
      { page: '服务介绍', pageUrl: 'https://example.test/services', statement: '服务覆盖华东地区企业客户', location: '正文第2段', context: '页面上下文' },
      { page: '常见问题', pageUrl: 'https://example.test/faq', statement: '服务覆盖华东地区企业客户', location: 'FAQ第1问', context: 'FAQ上下文' },
    ] })} onClose={() => undefined} />)
    expect(single).not.toContain('全部出现位置')
    expect(multiple).toContain('全部出现位置（2）')
    expect(multiple).toContain('常见问题')
  })
})

describe('content-audit helpers', () => {
  it('allows only HTTP(S) evidence URLs and removes credentials', () => {
    expect(safeContentAuditUrl('https://user:secret@example.test/path?q=1#section')).toBe('https://example.test/path?q=1#section')
    expect(safeContentAuditUrl('http://example.test/path')).toBe('http://example.test/path')
    expect(safeContentAuditUrl('javascript:alert(1)')).toBeNull()
    expect(safeContentAuditUrl('not-a-url')).toBeNull()
  })
})

describe('content-audit layout contract', () => {
  it('keeps the designed table geometry, fixed action width, and constrained evidence viewport', () => {
    expect(panelCss).toContain('width: 118px;')
    expect(panelCss).toContain('min-width: 118px;')
    expect(panelCss).toContain('width: 160px;')
    expect(panelCss).toContain('width: 128px;')
    expect(panelCss).toContain('height: 52px;')
    expect(panelCss).toContain('height: 64px;')
    expect(panelCss).toContain('padding: 0 16px;')
    expect(panelCss).toContain('width: 880px;')
    expect(panelCss).toContain('height: 840px;')
    expect(panelCss).toContain('max-height: calc(100vh - 40px);')
    expect(panelCss).toContain('height: 14px;')
    expect(panelCss).toContain('width: 56px;')
    expect(panelCss).toContain('grid-template-columns: max-content minmax(0, 1fr) 118px;')
    expect(panelCss).toContain('.content-audit-panel__header-status {')
    expect(panelCss).toContain('overflow-wrap: anywhere;')
    expect(panelSource).toContain('size={11}')
  })

  it('keeps the content-audit title and card spacing aligned with section styles', () => {
    expect(panelCss).toContain('.content-audit-panel__title h2 {')
    expect(panelCss).toContain('font-size: 18px;')
    expect(panelCss).toContain('line-height: 26px;')
    expect(panelCss).toContain('.content-audit-panel__card {')
    expect(panelCss).toContain('margin-top: 16px;')
  })

  it('stacks content-audit progress copy above a full-width fixed-height bar', () => {
    const contentRules = cssRulesForClass(panelCss, 'content-audit-panel__progress-content')
    const contentLayoutOverride = contentRules.find((rule) => (rule.match(/\.[a-zA-Z0-9_-]+/g)?.length ?? 0) >= 2 && rule.includes('display: flex;')) ?? ''
    const textRules = cssRulesForClass(panelCss, 'content-audit-panel__progress-text').join('\n')
    const barRules = cssRulesForClass(panelCss, 'content-audit-panel__progress-bar').join('\n')
    const hasFixedFlex = /flex:\s*(?:none|0\s+0(?:\s+[^;]+)?);/.test(barRules)

    expect(contentLayoutOverride).toContain('display: flex;')
    expect(contentLayoutOverride).toContain('flex-direction: column;')
    expect(contentLayoutOverride).toContain('align-items: center;')
    expect(contentLayoutOverride).toContain('justify-content: center;')
    expect(contentLayoutOverride).toContain('width: 100%;')
    expect(textRules).toContain('overflow-wrap: anywhere;')
    expect(textRules).toContain('text-align: center;')
    expect(textRules).toContain('white-space: normal;')
    expect(barRules).toMatch(/width:\s*100%;/)
    expect(barRules).toContain('height: 6px;')
    expect(hasFixedFlex).toBe(true)
  })

  it('bottom-aligns the content-audit operation row while keeping feedback horizontally centered', () => {
    expect(panelCss).toContain('.content-audit-panel__header {')
    expect(panelCss).toContain('align-items: end;')
    expect(panelCss).toContain('.content-audit-panel__title {')
    expect(panelCss).toContain('align-items: flex-end;')
    expect(panelCss).toContain('.content-audit-panel__header-status {')
    expect(panelCss).toContain('min-height: 40px;')
    expect(panelCss).toContain('align-items: center;')
    expect(panelCss).toContain('justify-content: flex-end;')
    expect(panelCss).toContain('.content-audit-panel__check {')
    expect(panelCss).toContain('align-self: flex-end;')
  })

  it('anchors the info popover to the info trigger instead of the whole header', () => {
    expect(panelCss).toContain('.content-audit-panel__info-trigger {')
    expect(panelCss).toContain('width: 22px;')
    expect(panelCss).toContain('height: 22px;')
    expect(panelCss).toContain('position: relative;')
    expect(panelCss).toContain('top: calc(100% + 8px);')
    expect(panelCss).toContain('left: 0;')
    expect(panelCss).toContain('right: auto;')
    expect(panelCss).toContain('width: 320px;')
    expect(panelCss).toContain('max-width: calc(100vw - 40px);')
    expect(panelSource).toContain('<span className="content-audit-panel__info-trigger">')
    expect(panelSource).toContain('{infoOpen ? <InfoPopover')
  })
})
