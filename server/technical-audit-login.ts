import { parse, type HTMLElement } from 'node-html-parser'

/** Evidence produced from a fresh parse of one anonymous HTML response.  The
 * helper deliberately returns lengths and stable signal names instead of raw
 * page text so a response body is never copied into a technical-audit
 * snapshot. */
export type LoginPageAnalysis = {
  readable: boolean
  blocked: boolean
  challenge: boolean
  redirected_to_login: boolean
  candidate: string
  visible_text_length: number
  substantive_text_length: number
  login_signals: string[]
  challenge_signals: string[]
}

export type LoginPageAnalysisInput = {
  html: string
  requestedUrl: string
  finalUrl?: string | null
}

const preferredCandidates: Array<{ selector: string; priority: number }> = [
  { selector: '.entry-content', priority: 60 },
  { selector: '.post-content', priority: 60 },
  { selector: '.article-content', priority: 60 },
  { selector: '[itemprop="articleBody"]', priority: 60 },
  { selector: '[role="main"]', priority: 50 },
  { selector: 'article', priority: 40 },
  { selector: 'main', priority: 40 },
  { selector: '.content', priority: 30 },
  { selector: '.main-content', priority: 30 },
]

const loginPathPart = /^(?:login|log-in|signin|sign-in|auth|account|wp-login(?:\.php)?)$/i

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function substantiveLength(value: string): number {
  // Punctuation and decorative symbols alone do not constitute readable
  // article content, while short Chinese or Latin copy remains valid.
  return [...value].filter((character) => !/[\s\p{P}\p{S}]/u.test(character)).length
}

function hasHiddenStyle(value: string): boolean {
  return /(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)/i.test(value)
}

function hasHiddenMarker(node: HTMLElement): boolean {
  if (node.hasAttribute('hidden')) return true
  const ariaHidden = (node.getAttribute('aria-hidden') ?? '').trim().toLowerCase()
  if (ariaHidden === 'true' || ariaHidden === '1') return true
  if (hasHiddenStyle(node.getAttribute('style') ?? '')) return true
  const marker = `${node.getAttribute('id') ?? ''} ${node.getAttribute('class') ?? ''}`
  return /(?:^|[\s_-])(?:hidden|d-none|display-none|visually-hidden|sr-only)(?:$|[\s_-])/i.test(marker)
}

function removeHiddenNodes(root: HTMLElement): void {
  // node-html-parser supports the attribute selectors used here, but the
  // explicit traversal also covers style/class conventions consistently.
  for (const node of root.querySelectorAll('*')) {
    if (hasHiddenMarker(node)) node.remove()
  }
}

function removeNoise(root: HTMLElement, includeHeader: boolean): void {
  const selectors = ['script', 'style', 'template', 'noscript', 'svg', 'nav', 'footer', 'aside', 'form', 'menu']
  if (includeHeader) selectors.push('header')
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) node.remove()
  }
}

function candidateText(source: string, includeHeader: boolean): string {
  let root: HTMLElement
  try { root = parse(source) } catch { return '' }
  removeHiddenNodes(root)
  removeNoise(root, includeHeader)
  return compactText(root.textContent)
}

function isLoginPath(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const pathname = new URL(value).pathname
    return pathname.split('/').filter(Boolean).some((part) => loginPathPart.test(part))
  } catch {
    return false
  }
}

function wasRedirectedToLogin(requestedUrl: string, finalUrl: string | null | undefined): boolean {
  if (!finalUrl || !isLoginPath(finalUrl) || isLoginPath(requestedUrl)) return false
  try {
    return new URL(requestedUrl).pathname !== new URL(finalUrl).pathname
  } catch {
    return true
  }
}

function uniqueSignals(matches: Array<[string, RegExp]>, text: string): string[] {
  return matches.filter(([, expression]) => expression.test(text)).map(([name]) => name)
}

function chooseCandidate(root: HTMLElement): { source: string; name: string; includeHeader: boolean } {
  const candidates: Array<{ source: string; name: string; priority: number; length: number }> = []
  for (const entry of preferredCandidates) {
    for (const node of root.querySelectorAll(entry.selector)) {
      const source = node.toString()
      const text = candidateText(source, false)
      candidates.push({ source, name: entry.selector, priority: entry.priority, length: substantiveLength(text) })
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || right.length - left.length)
  const preferred = candidates[0]
  if (preferred) return { source: preferred.source, name: preferred.name, includeHeader: false }

  const body = root.querySelector('body')
  if (body) return { source: body.toString(), name: 'body', includeHeader: true }
  return { source: root.toString(), name: 'document', includeHeader: true }
}

/**
 * These expressions describe an instruction that the current content is
 * unavailable until authentication, rather than merely mentioning a login
 * workflow.  In particular, "请登录电子税务局后查看申报结果" does not match:
 * it explains a different service and does not say that this page's full
 * content is locked.
 */
const loginGateSignals: Array<[string, RegExp]> = [
  ['login_full_content_gate', /(?:请|需要|必须|需|先)?\s*(?:登录|登陆)\s*(?:后|之后)\s*(?:才(?:能|可以)?|方可)?\s*(?:查看|阅读|访问|继续|解锁|获取|显示)\s*(?:全文|全部(?:内容)?|完整(?:内容|文章|正文)?|剩余(?:内容)?|隐藏(?:内容)?|此页|该页)/i],
  ['login_full_content_gate', /(?:登录|登陆)\s*(?:后|之后)\s*(?:才(?:能|可以)?|方可)?\s*(?:继续|解锁)\b/i],
  ['sign_in_full_content_gate', /(?:sign\s*in|log\s*in)\s+(?:to\s+)?(?:view|read|access)\s+(?:the\s+)?(?:full|complete|rest|article|content)/i],
  ['member_only_gate', /(?:仅限会员|会员专享|members?\s+only|authentication\s+required|login\s+required)/i],
]

const challengeSignals: Array<[string, RegExp]> = [
  ['human_verification', /(?:verify\s+you(?:'re|\s+are)\s+human|人机验证|请完成(?:人机)?验证(?:码)?|确认您不是机器人)/i],
  ['browser_check', /(?:checking\s+your\s+browser|just\s+a\s+moment|enable\s+javascript(?:\s+to\s+continue)?|正在检查浏览器|浏览器检查)/i],
  ['captcha_prompt', /(?:请输入|请填写|enter|type)\s*(?:.{0,20})?(?:验证码|captcha)/i],
  ['captcha_gate', /(?:captcha|recaptcha|hcaptcha)\s*(?:challenge|required|verification)?/i],
]

const lockMarker = /(?:login[-_ ]?(?:wall|required|only|gate)|auth[-_ ]?(?:wall|required)|member[-_ ]?only|members[-_ ]?only|paywall|premium[-_ ]?content|requires?[-_ ]?login|content[-_ ]?lock|access[-_ ]?restricted|protected[-_ ]?content)/i
const challengeMarker = /(?:challenge|captcha|recaptcha|hcaptcha|cf[-_ ]?chl|bot[-_ ]?check|human[-_ ]?check|verify[-_ ]?human)/i

function markerText(node: HTMLElement): string {
  const attributes = node.attributes
  return Object.entries(attributes)
    .filter(([key]) => key !== 'style')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

function hasMarker(root: HTMLElement, expression: RegExp): boolean {
  return root.querySelectorAll('*').some((node) => expression.test(markerText(node)))
}

function hasPasswordOrLoginForm(root: HTMLElement): boolean {
  return root.querySelectorAll('form').some((form) => {
    const text = compactText(`${form.toString()} ${form.textContent}`)
    const hasPassword = form.querySelectorAll('input').some((input) => (input.getAttribute('type') ?? '').toLowerCase() === 'password')
    const formMarker = `${markerText(form)} ${text}`
    return hasPassword || /(?:login|log-in|signin|sign-in|登录|登陆|用户名|密码|account|authentication)/i.test(formMarker)
  })
}

function hasPublicText(text: string): boolean {
  // A login page can contain labels such as "用户名" and "密码".  Remove
  // those operational labels before deciding whether anonymous page content
  // remains.  This is not used to identify a gate; it only distinguishes a
  // redirected login form from a page that still contains public prose.
  const withoutUi = text
    .replace(/(?:sign\s*in|log\s*in|login|登陆|登录|authentication|authenticate|password|用户名|密码|账号|帐号|user\s*name|email|remember\s*me|forgot\s+password|忘记密码|注册|提交|submit|验证码|人机验证|安全验证|访问验证)/gi, ' ')
  return substantiveLength(withoutUi) > 0
}

function removeSignalText(text: string, expressions: RegExp[]): string {
  return expressions.reduce((value, expression) => {
    // The signal definitions are intentionally single-match expressions for
    // detection; use a global clone when removing challenge/login boilerplate
    // so a page containing two adjacent prompts is still recognised as a
    // replacement rather than public prose.
    const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`
    return value.replace(new RegExp(expression.source, flags), ' ')
  }, text)
}

function isErrorReplacement(text: string): boolean {
  const normalized = compactText(text)
    .replace(/[：:]/g, ':')
    .replace(/(?:请|please)\s*(?:返回|重试|刷新|稍后再试|try again|go back)[^。！？.!?]*/gi, ' ')
    .trim()
  if (!normalized) return false
  if (/^[45]\d\d$/.test(normalized)) return true
  return /^(?:(?:4\d\d|5\d\d)\s*)?(?:not\s+found|page\s+not\s+found|forbidden|access\s+denied|server\s+error|service\s+unavailable|bad\s+gateway|error|页面不存在|找不到页面|无法访问|访问出错|服务器错误|服务不可用|请求失败)(?:[。.!?：:\s]*)$/i.test(normalized)
}

function emptyAnalysis(overrides: Partial<LoginPageAnalysis>): LoginPageAnalysis {
  return {
    readable: false,
    blocked: false,
    challenge: false,
    redirected_to_login: false,
    candidate: 'none',
    visible_text_length: 0,
    substantive_text_length: 0,
    login_signals: [],
    challenge_signals: [],
    ...overrides,
  }
}

/**
 * Analyze anonymous readability without mutating the document used by the
 * other technical-audit modules.  A login button, form, URL, or incidental
 * keyword is not a block; only a clear gate or a redirected login page whose
 * body is not public content is one.
 */
export function analyzeAnonymousPage(input: LoginPageAnalysisInput): LoginPageAnalysis {
  const redirectedToLogin = wasRedirectedToLogin(input.requestedUrl, input.finalUrl)
  const base = { redirected_to_login: redirectedToLogin }
  if (!input.html.trim()) return emptyAnalysis({ ...base, blocked: redirectedToLogin })

  let root: HTMLElement
  try { root = parse(input.html) } catch {
    return emptyAnalysis({ ...base, candidate: 'parse_failed', blocked: redirectedToLogin })
  }

  // Work on this fresh tree only.  The caller's page document remains intact
  // for the other technical audit modules.
  removeHiddenNodes(root)
  const selected = chooseCandidate(root)
  const visibleText = candidateText(selected.source, selected.includeHeader)
  const visibleTextLength = visibleText.length
  const substantiveTextLength = substantiveLength(visibleText)

  // Inspect the selected DOM before removing forms: a password form by itself
  // is not a finding, but it becomes useful structural evidence alongside a
  // narrow full-content gate.
  let candidateRoot: HTMLElement
  try { candidateRoot = parse(selected.source) } catch { candidateRoot = parse('') }
  removeHiddenNodes(candidateRoot)
  const candidateHasLock = hasMarker(candidateRoot, lockMarker)
  const candidateHasChallenge = hasMarker(candidateRoot, challengeMarker)
  const candidateHasLoginForm = hasPasswordOrLoginForm(candidateRoot)

  const foundLoginSignals = uniqueSignals(loginGateSignals, visibleText)
  const foundChallengeSignals = uniqueSignals(challengeSignals, visibleText)
  const loginGateText = foundLoginSignals.length > 0
  const gateOnlyText = loginGateText && substantiveLength(removeSignalText(visibleText, loginGateSignals.map(([, expression]) => expression))) === 0
  // A matching sentence inside an otherwise readable article can be an
  // explanation of login configuration.  Require either a gate/lock element,
  // a login form, or a candidate made up only of the gate text before treating
  // it as a restriction on this page's正文.
  const explicitGate = loginGateText && (candidateHasLock || candidateHasLoginForm || gateOnlyText)

  const challengeOnlyText = foundChallengeSignals.length > 0
    && substantiveLength(removeSignalText(visibleText, challengeSignals.map(([, expression]) => expression))) === 0
  const challenge = foundChallengeSignals.length > 0 && (
    candidateHasChallenge && !hasPublicText(visibleText)
    || challengeOnlyText
  )

  const errorReplacement = isErrorReplacement(visibleText)
  const publicBody = hasPublicText(visibleText) && !errorReplacement && !(explicitGate && gateOnlyText)
  const readable = publicBody && !challenge
  // If the selected candidate consists only of an authentication form (the
  // form itself is removed before visible-text extraction), the anonymous
  // response is still a login replacement rather than an unknown empty page.
  // Keep ordinary forms on pages with public prose readable; this branch only
  // applies when no public text survives the form removal.
  const loginFormOnly = candidateHasLoginForm && !hasPublicText(visibleText) && substantiveTextLength === 0
  // A final /login URL is evidence about what was returned, not a finding by
  // itself.  Public prose wins; a login form or login-only replacement page
  // remains blocked when no anonymous body was readable.
  const blocked = explicitGate || loginFormOnly || (redirectedToLogin && !readable)

  return {
    ...base,
    readable,
    blocked,
    challenge,
    candidate: selected.name,
    visible_text_length: visibleTextLength,
    substantive_text_length: substantiveTextLength,
    login_signals: foundLoginSignals,
    challenge_signals: foundChallengeSignals,
  }
}
