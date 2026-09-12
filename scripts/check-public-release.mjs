import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const findings = []
const binaryExtensions = new Set(['.ttf', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.pdf', '.zip'])
const allowedPlaceholderValues = new Set([
  '', 'change-me', 'change-me-local', 'replace-me', 'placeholder', 'example',
  'test-key', 'test-model', 'fake-provider-value', 'not-a-url',
  'synthetic-demo-model', 'geodesk-local-only', 'demo.example.invalid',
  // Exact non-secret fixture values used by redaction tests.
  'api-secret', 'another-secret', 'statement-secret', 'read-api-secret',
])

const fragment = (...parts) => parts.join('')
const forbiddenPersonalPathPatterns = [
  new RegExp(fragment('/', 'Users', '/'), 'i'),
  new RegExp(fragment('/', 'home', '/'), 'i'),
  /[A-Z]:\\/,
  new RegExp(fragment('cn', 'linya'), 'i'),
  new RegExp(fragment('Cogni', 'Reso'), 'i'),
  new RegExp(fragment('Ob', 'sidian'), 'i'),
]
const credentialPatterns = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i },
  { name: 'access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  {
    name: 'credential-assignment',
    // Only inspect quoted literals or simple token-like values. References
    // such as options.apiKey and process.env.PGPASSWORD are not credentials.
    pattern: /\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*(?:"([^"]{8,})"|'([^']{8,})'|([A-Za-z0-9_+\/-]{8,}))/i,
  },
]
const packageLockRules = [
  { name: 'local-file-dependency', pattern: /["'](?:resolved|version)["']\s*:\s*["'](?:file:|link:|workspace:)/i },
  { name: 'private-registry', pattern: /https?:\/\/(?:[^/]*\.)?(?:internal|private|corp|local)(?:[./:]|$)/i },
]

function rel(file) {
  return relative(ROOT, file).split('\\').join('/') || '.'
}

function add(file, line, rule) {
  findings.push(`${rel(file)}:${line}:${rule}`)
}

function isAllowedPlaceholder(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').replace(/[;,]$/, '')
  if (allowedPlaceholderValues.has(normalized)) return true
  return /^(?:<[^>]+>|\$\{[^}]+\}|your[-_ ]|replace[-_ ]|example[-_ ]|demo[-_ ]|test[-_ ])/i.test(normalized)
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const file = resolve(directory, entry.name)
    const relativePath = rel(file)
    const info = await lstat(file)
    if (info.isSymbolicLink()) {
      add(file, 0, 'symlink')
      continue
    }
    if (info.isDirectory()) {
      if (/^(?:node_modules|dist|coverage|\.vitest|\.git|evidence)$/i.test(entry.name) || /(?:^|\/)evidence(?:\/|$)/i.test(relativePath)) {
        add(file, 0, 'forbidden-directory')
        continue
      }
      await walk(file)
      continue
    }
    if (!info.isFile()) continue
    if (/^\.env(?:\..+)?$/i.test(entry.name) && entry.name !== '.env.example') add(file, 0, 'environment-file')
    if (/(?:^|\/)(?:scripts\/evidence|evidence)(?:\/|$)/i.test(relativePath)) add(file, 0, 'evidence-path')
    if (/(?:\.dump(?:\.gz)?|\.sql\.gz|\.sqlite3?|\.bak)$/i.test(entry.name)) add(file, 0, 'database-dump')
    if (entry.name === '.DS_Store') add(file, 0, 'editor-artifact')
    if (binaryExtensions.has(relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase())) continue
    if (info.size > 5 * 1024 * 1024) {
      add(file, 0, 'oversized-public-file')
      continue
    }
    let text
    try { text = await readFile(file, 'utf8') } catch { add(file, 0, 'unreadable-file'); continue }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1
      const line = lines[index] ?? ''
      for (const pattern of forbiddenPersonalPathPatterns) {
        if (pattern.test(line)) add(file, lineNumber, 'personal-or-internal-path')
      }
      for (const rule of credentialPatterns) {
        const match = line.match(rule.pattern)
        if (!match) continue
        if (rule.name === 'credential-assignment') {
          const candidate = match[1] ?? match[2] ?? match[3] ?? ''
          if (isAllowedPlaceholder(candidate)) continue
        }
        add(file, lineNumber, rule.name)
      }
      if (relativePath === 'package-lock.json') {
        for (const rule of packageLockRules) if (rule.pattern.test(line)) add(file, lineNumber, rule.name)
      }
    }
  }
}

await walk(ROOT)
const uniqueFindings = [...new Set(findings)].sort()
for (const finding of uniqueFindings) console.error(finding)

let gitleaksAvailable = false
try {
  execFileSync('gitleaks', ['version'], { stdio: 'ignore' })
  gitleaksAvailable = true
} catch {
  gitleaksAvailable = false
}
if (!gitleaksAvailable) console.log('gitleaks: unavailable; public-tree scan only, not a complete history audit')
else console.log('gitleaks: available; history audit requires a repository checkout and is not run on this uncommitted directory')

if (uniqueFindings.length > 0) {
  console.error(`public scan failed: ${uniqueFindings.length} finding(s)`)
  process.exitCode = 1
} else {
  console.log('public scan passed: no forbidden files, paths, credential patterns, symlinks, or lockfile links found')
}
