import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider, applyDocumentLocale, browserLocale, messages, persistLocalePreference, readLocalePreference, resolveLocale, translate } from './i18n'

function placeholderSet(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

function storageFixture(initial: string | null = null): Storage {
  let value = initial
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next },
    removeItem: () => { value = null },
    clear: () => { value = null },
    key: () => null,
    get length() { return value === null ? 0 : 1 },
  } as Storage
}

describe('locale selection and persistence', () => {
  it('maps Chinese regional browser preferences to Simplified Chinese and uses the first preferred language', () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    try {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-CN'], language: 'en-US' } })
      expect(browserLocale()).toBe('zh-CN')

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-TW'], language: 'en-US' } })
      expect(browserLocale()).toBe('zh-CN')
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-HK'], language: 'en-US' } })
      expect(browserLocale()).toBe('zh-CN')

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en-US', 'zh-CN'], language: 'zh-CN' } })
      expect(browserLocale()).toBe('en')

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: [], language: 'zh-HK' } })
      expect(browserLocale()).toBe('zh-CN')

      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
      expect(browserLocale()).toBe('en')
    } finally {
      if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator
      else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
    }
  })

  it('falls back to English when reading navigator language throws', () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          languages: [],
          get language() {
            throw new Error('blocked language getter')
          },
        },
      })
      expect(browserLocale()).toBe('en')
    } finally {
      if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator
      else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
    }
  })

  it('persists manual choices and restores automatic mode', () => {
    const storage = storageFixture()
    persistLocalePreference(storage, 'en')
    expect(readLocalePreference(storage)).toBe('en')
    expect(resolveLocale(readLocalePreference(storage), 'zh-CN')).toBe('en')
    persistLocalePreference(storage, 'auto')
    expect(readLocalePreference(storage)).toBe('auto')
    expect(resolveLocale(readLocalePreference(storage), 'zh-CN')).toBe('zh-CN')
  })

  it('treats unsupported stored locale values as automatic mode', () => {
    for (const value of ['', 'zh-TW', 'zh-HK', 'ZH-CN', 'null', 'true']) {
      expect(readLocalePreference(storageFixture(value))).toBe('auto')
    }
  })

  it('survives localStorage getter, read, and write failures without throwing', () => {
    const throwingStorage = {
      getItem() { throw new Error('blocked read') },
      setItem() { throw new Error('blocked write') },
    } as unknown as Storage
    expect(readLocalePreference(throwingStorage)).toBe('auto')
    expect(() => persistLocalePreference(throwingStorage, 'en')).not.toThrow()

    const originalWindow = (globalThis as { window?: unknown }).window
    try {
      const blockedWindow = {}
      Object.defineProperty(blockedWindow, 'localStorage', { configurable: true, get() { throw new Error('blocked getter') } })
      Object.defineProperty(globalThis, 'window', { configurable: true, value: blockedWindow })
      const html = renderToStaticMarkup(<I18nProvider><span>input preserved</span></I18nProvider>)
      expect(html).toContain('input preserved')
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    }
  })

  it('keeps both dictionaries key-complete with matching interpolation placeholders', () => {
    const zhKeys = Object.keys(messages['zh-CN']).sort()
    const enKeys = Object.keys(messages.en).sort()
    expect(enKeys).toEqual(zhKeys)
    for (const key of zhKeys as Array<keyof typeof messages['zh-CN']>) {
      expect(placeholderSet(messages['zh-CN'][key])).toEqual(placeholderSet(messages.en[key]))
    }
    expect(translate('en', 'content.progress', { read: 2, total: 4, failed: 1, pending: 1, scope: '' })).toContain('2/4')
    expect(translate('zh-CN', 'content.progress', { read: 2, total: 4, failed: 1, pending: 1, scope: '' })).toContain('2/4')
  })

  it('sets the initial document language before rendering', () => {
    const originalDocument = (globalThis as { document?: unknown }).document
    const documentStub = { documentElement: { lang: '' } }
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
      applyDocumentLocale(resolveLocale('auto', 'en'))
      expect(documentStub.documentElement.lang).toBe('en')
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })

  it('does not use locale as an App remount key', () => {
    const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    expect(appSource).not.toMatch(/key=\{locale\}/)
  })
})
