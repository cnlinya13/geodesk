export type CopyArticle = {
  title: string
  contentHtml: string | null
}

type ClipboardWriter = {
  write?: (items: unknown[]) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

type ClipboardItemFactory = (parts: Record<string, Blob>) => unknown

export type ArticleCopyDependencies = {
  clipboard?: ClipboardWriter | null
  createItem?: ClipboardItemFactory | null
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function articlePlainText(article: CopyArticle): string {
  const contentHtml = article.contentHtml ?? ''
  const html = `<h1>${escapeHtml(article.title)}</h1>${contentHtml}`
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(contentHtml, 'text/html')
    const body = (document.body.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
    return [article.title.trim(), body].filter(Boolean).join('\n\n')
  }
  return html
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/p>|<\/(?:h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function defaultClipboard(): ClipboardWriter | null {
  if (typeof navigator === 'undefined') return null
  return navigator.clipboard as ClipboardWriter | undefined ?? null
}

function defaultCreateItem(): ClipboardItemFactory | null {
  if (typeof ClipboardItem === 'undefined' || typeof Blob === 'undefined') return null
  return (parts) => new ClipboardItem(parts)
}

export async function copyArticleContent(article: CopyArticle, dependencies: ArticleCopyDependencies = {}): Promise<'rich' | 'plain'> {
  const clipboard = dependencies.clipboard === undefined ? defaultClipboard() : dependencies.clipboard
  const createItem = dependencies.createItem === undefined ? defaultCreateItem() : dependencies.createItem
  const html = `<h1>${escapeHtml(article.title)}</h1>${article.contentHtml ?? ''}`
  const plain = articlePlainText(article)
  if (clipboard?.write && createItem) {
    const item = createItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    })
    await clipboard.write([item])
    return 'rich'
  }
  if (clipboard?.writeText) {
    await clipboard.writeText(plain)
    return 'plain'
  }
  throw new Error('当前浏览器不支持复制')
}
