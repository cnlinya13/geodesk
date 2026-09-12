import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { apiErrorMessage, localizeApiError, localizeServerMessage, resolveUiMessage, taskErrorMessage, uiMessage } from './i18n'

describe('deferred UI error messages', () => {
  it('uses a real API error code before the server message text', () => {
    const cause = new ApiError(409, 'company_name_exists', '服务端的中文详情')
    const message = apiErrorMessage(cause, 'error.server.project_unavailable')

    expect(resolveUiMessage(message, 'zh-CN')).toBe('公司名称已存在，请勿重复使用')
    expect(resolveUiMessage(message, 'en')).toBe('A project with this company name already exists')
  })

  it('keeps details carried by the generic AI task failure envelope', () => {
    const detail = '豆包请求超时：供应商返回的原始详情'
    const message = apiErrorMessage(new ApiError(502, 'ai_task_failed', detail), 'error.server.request_failed')

    expect(resolveUiMessage(message, 'en')).toBe(`The AI task failed. Please retry Original error: ${detail}`)
  })

  it('keeps unknown API details explicitly labeled instead of guessing from Chinese prefixes', () => {
    const original = '豆包请求超时：供应商返回的原始详情'
    const cause = new ApiError(502, 'provider_message_not_mapped', original)

    expect(localizeServerMessage(original, 'en')).toBe(original)
    expect(localizeApiError(cause, 'en', 'error.server.request_failed')).toBe(`The request failed. Please retry Original error: ${original}`)
    expect(resolveUiMessage(apiErrorMessage(cause, 'error.server.request_failed'), 'zh-CN')).toContain(`原始错误：${original}`)
  })

  it('resolves the same deferred API error in the current locale after a switch', () => {
    const message = apiErrorMessage(new ApiError(503, 'database_unavailable', '数据库原始详情'), 'error.server.request_failed')

    const zh = resolveUiMessage(message, 'zh-CN')
    const en = resolveUiMessage(message, 'en')
    expect(zh).toBe('服务暂时不可用，请稍后重试')
    expect(en).toBe('The service is temporarily unavailable. Please retry')
    expect(en).not.toBe(zh)
  })

  it('gives legacy failed tasks a kind-specific title and preserves their raw detail', () => {
    const message = taskErrorMessage('content_audit', 'failed', '后台任务失败原因')

    expect(resolveUiMessage(message, 'zh-CN')).toBe('官网内容检查失败，请重试。 原始错误：后台任务失败原因')
    expect(resolveUiMessage(message, 'en')).toBe('Website content check failed. Please retry. Original error: 后台任务失败原因')
    expect(resolveUiMessage(taskErrorMessage('monitoring', 'failed', '监测任务失败原因'), 'en')).toBe('This monitoring run failed. Click Start monitoring Original error: 监测任务失败原因')
    expect(resolveUiMessage(taskErrorMessage('content_audit', 'completed', '不应当翻译'), 'en')).toBe('不应当翻译')
  })

  it('preserves a nested API error reason in the question action message for both locales', () => {
    const detail = '问题保存失败的服务端详情'
    const message = uiMessage('scope.questionError', {
      position: 3,
      detail: apiErrorMessage(new ApiError(502, 'request_failed', detail), 'error.server.project_changed'),
    })

    expect(resolveUiMessage(message, 'zh-CN')).toBe(`第3题：请求失败，请稍后重试 原始错误：${detail}`)
    expect(resolveUiMessage(message, 'en')).toBe(`Question 3: The request failed. Please retry Original error: ${detail}`)
  })
})
