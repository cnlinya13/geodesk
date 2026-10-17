/**
 * v0.3.0 模型设置页：admin 全局统一选择大模型 provider。
 * 本轮只出设置页 + 可替换架构；provider 下拉目前只有豆包（未来一家一家单独接）。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { getModelSettings, saveModelSettings, type ModelProviderInfo } from '../api'
import { apiErrorMessage, resolveUiMessage, useI18n, type UiMessage } from '../i18n'
import { Button, Field } from './UI'

export function ModelSettingsPage() {
  const { t, locale } = useI18n()
  const [providers, setProviders] = useState<ModelProviderInfo[]>([])
  const [provider, setProvider] = useState('doubao')
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { settings, providers: list } = await getModelSettings()
        if (cancelled) return
        setProviders(list)
        setProvider(settings.provider)
        setModelId(settings.modelId)
        setHasApiKey(settings.hasApiKey)
      } catch (cause) {
        if (!cancelled) setError(apiErrorMessage(cause, 'error.server.request_failed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await saveModelSettings({
        provider,
        // key 留空表示不改动已有 key
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        modelId: modelId.trim(),
      })
      setHasApiKey(updated.hasApiKey)
      setApiKey('')
      setSaved(true)
    } catch (cause) {
      setError(apiErrorMessage(cause, 'error.server.request_failed'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="page"><p role="status">{t('settings.model.loading')}</p></div>

  return (
    <div className="page">
      <h1 className="page__title">{t('settings.model.title')}</h1>
      <p className="page__desc">{t('settings.model.desc')}</p>
      <form className="form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="model-provider">{t('settings.model.provider')}</label>
          <select id="model-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
            {providers.map((p) => (
              <option key={p.providerId} value={p.providerId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>
        <Field
          id="model-id"
          label={t('settings.model.modelId')}
          required
          autoComplete="off"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        />
        <Field
          id="model-api-key"
          label={t('settings.model.apiKey')}
          type="password"
          autoComplete="new-password"
          placeholder={hasApiKey ? t('settings.model.apiKeyKept') : undefined}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {error ? <p role="alert" className="form-error">{resolveUiMessage(error, locale)}</p> : null}
        {saved ? <p role="status" className="form-success">{t('settings.model.saved')}</p> : null}
        <Button type="submit" disabled={saving || !modelId.trim()}>
          {t('settings.model.save')}
        </Button>
      </form>
    </div>
  )
}
