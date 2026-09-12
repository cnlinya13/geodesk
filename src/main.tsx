import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/noto-sans-sc/chinese-simplified-400.css'
import App from './App'
import { I18nProvider, applyDocumentLocale, browserLocale, readLocalePreference, resolveLocale } from './i18n'

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Resolve the first document language before React paints, so an English
// browser never flashes the Chinese shell on initial load.
const initialPreference = readLocalePreference(browserStorage())
const initialLocale = resolveLocale(initialPreference, browserLocale())
applyDocumentLocale(initialLocale)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {window.location.port === '5174' ? (
        <>
          <div className="demo-mode-banner" role="status">
            合成数据演示 · 不调用真实模型 · 重启重置
          </div>
          <App />
        </>
      ) : <App />}
    </I18nProvider>
  </StrictMode>,
)
