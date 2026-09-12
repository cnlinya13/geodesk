import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationBar, OperationFeedback } from './UI'

describe('operation feedback primitives', () => {
  it('keeps an empty center slot when no center content is supplied', () => {
    const html = renderToStaticMarkup(<OperationBar left="左侧" right="右侧" />)
    expect(html).toContain('<div class="operation-bar__left">左侧</div><div class="operation-bar__center"></div><div class="operation-bar__right">右侧</div>')
  })

  it('renders non-empty feedback with tone semantics and separate lines', () => {
    const html = renderToStaticMarkup(
      <OperationFeedback tone="error">
        <span>第一条错误</span>
        <span>第二条错误</span>
      </OperationFeedback>,
    )
    expect(html).toContain('class="operation-feedback operation-feedback--error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('<span>第一条错误</span><span>第二条错误</span>')
  })

  it('does not announce empty content', () => {
    expect(renderToStaticMarkup(<OperationFeedback>{'  '}</OperationFeedback>)).toBe('')
    expect(renderToStaticMarkup(<OperationFeedback />)).toBe('')
  })
})
