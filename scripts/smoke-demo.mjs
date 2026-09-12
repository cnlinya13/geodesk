import { spawn } from 'node:child_process'
import process from 'node:process'

const API = 'http://127.0.0.1:8788'
const WEB = 'http://127.0.0.1:5174'
let child = null
let ownsProcess = false
let output = ''

async function probe(url) {
  try {
    const response = await fetch(url)
    return response
  } catch {
    return null
  }
}

async function waitFor(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await probe(url)
    if (response?.ok) return response
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function json(url, init = {}) {
  const response = await fetch(url, init)
  let body = null
  try { body = await response.json() } catch { /* report the HTTP status below */ }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} returned ${response.status}: ${body?.error ?? 'invalid response'}`)
  return body
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function countBy(questions, key, value) {
  return questions.filter((question) => question[key] === value).length
}

async function startDemoIfNeeded() {
  const existing = await probe(`${API}/api/demo/status`)
  if (existing?.ok) return

  ownsProcess = true
  child = spawn('npm', ['run', 'demo'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-6000) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.once('exit', (code, signal) => {
    if (code !== 0 && code !== null) output = `${output}\nprocess exited ${code} (${signal ?? 'no signal'})`
  })
  await waitFor(`${API}/api/demo/status`)
}

async function main() {
  await startDemoIfNeeded()
  const status = await json(`${API}/api/demo/status`)
  assert(status.mode === 'synthetic' && status.externalRequests === false && status.resetOnRestart === true, 'demo status does not declare synthetic reset-only mode')

  const web = await waitFor(WEB)
  const html = await web.text()
  assert(html.includes('GEO Desk'), 'demo web did not serve the actual UI shell')

  const created = await json(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: 'Synthetic Demo Company',
      websiteUrl: 'https://demo.example.invalid',
      optimizationTarget: '示例服务',
      supplementalInfo: '固定脱敏输入',
    }),
  })
  const projectId = created.project.id
  assert(projectId === '1', 'demo project did not start from a clean fixture')

  const acceptedQuestions = await json(`${API}/api/projects/${projectId}/questions/generate`, { method: 'POST', body: JSON.stringify({ expectedUpdatedAt: created.project.updatedAt }) })
  assert(acceptedQuestions.task.kind === 'questions' && acceptedQuestions.task.status === 'running', 'question generation was not accepted as a task')
  const questionStream = await fetch(`${API}/api/projects/${projectId}/ai-tasks/${acceptedQuestions.task.id}`, { headers: { accept: 'application/x-ndjson' } })
  const questionEvents = (await questionStream.text()).trim().split('\n').map((line) => JSON.parse(line))
  const finalQuestionProject = questionEvents.at(-1)?.project
  assert(finalQuestionProject?.questions?.length === 20, 'demo did not produce exactly 20 questions')
  assert(countBy(finalQuestionProject.questions, 'category', 'recommendation') === 10, 'demo recommendation quota is not 10')
  assert(countBy(finalQuestionProject.questions, 'category', 'selection') === 6, 'demo selection quota is not 6')
  assert(countBy(finalQuestionProject.questions, 'category', 'decision') === 4, 'demo decision quota is not 4')

  const confirmed = await json(`${API}/api/projects/${projectId}/questions/confirm`, { method: 'POST', body: JSON.stringify({ expectedUpdatedAt: finalQuestionProject.updatedAt }) })
  assert(confirmed.project.questionsLockedAt && confirmed.project.questions.every((question) => question.isLocked), 'question set was not confirmed and locked')

  const diagnosisAccepted = await json(`${API}/api/projects/${projectId}/diagnosis/start-or-resume`, { method: 'POST' })
  assert(diagnosisAccepted.task.kind === 'diagnosis' && diagnosisAccepted.task.status === 'running', 'diagnosis was not accepted as a task')
  const diagnosed = await json(`${API}/api/projects/${projectId}/ai-tasks/${diagnosisAccepted.task.id}`)
  assert(diagnosed.project.initialDiagnosisStatus === 'completed', 'synthetic diagnosis did not complete')
  assert(diagnosed.project.initialDiagnosis.answers.length === 20, 'synthetic diagnosis did not produce 20 evidence answers')
  assert(diagnosed.project.initialDiagnosis.answers.every((answer) => answer.responseModel === 'synthetic-demo-model' && answer.citationUrls[0].includes('demo.example.invalid')), 'diagnosis evidence is not synthetic')

  const articleAccepted = await json(`${API}/api/projects/${projectId}/articles/generate`, { method: 'POST' })
  const articleTask = await json(`${API}/api/projects/${projectId}/ai-tasks/${articleAccepted.task.id}`)
  const article = articleTask.project.articleBatches[0].articles[0]
  assert(articleAccepted.task.kind === 'article_titles' && articleTask.project.articleBatches.length === 1 && article.publishStatus === 'pending', 'one synthetic optimization task was not created')

  const writingAccepted = await json(`${API}/api/articles/${article.id}/write`, { method: 'POST' })
  const written = await json(`${API}/api/projects/${projectId}/ai-tasks/${writingAccepted.task.id}`)
  const writtenArticle = written.project.articleBatches[0].articles[0]
  assert(writtenArticle.writingStatus === 'ready' && writtenArticle.contentHtml?.includes('合成优化正文'), 'synthetic article body was not generated')

  const published = await json(`${API}/api/articles/${article.id}/confirm-published`, { method: 'POST' })
  assert(published.project.articleBatches[0].articles[0].publishStatus === 'published', 'manual publish confirmation did not persist')

  const monitoringAccepted = await json(`${API}/api/projects/${projectId}/monitoring/start-or-resume`, { method: 'POST' })
  const monitored = await json(`${API}/api/projects/${projectId}/ai-tasks/${monitoringAccepted.task.id}`)
  assert(monitored.project.monitoringRuns.length === 1 && monitored.project.monitoringRuns[0].answers.length === 20, 'synthetic monitoring round did not complete')
  assert(monitored.project.monitoringRuns[0].roundNumber === 1 && monitored.project.monitoringRuns[0].summaryAnalysis.mode === 'synthetic', 'monitoring round is not the expected synthetic first round')

  const pdf = await fetch(`${API}/api/projects/${projectId}/diagnosis/report-pdf`)
  const pdfBody = await pdf.json()
  assert(pdf.status === 404 && pdfBody.error === 'demo_pdf_unavailable', 'demo PDF endpoint must remain disabled')
  console.log('smoke:demo passed: web shell, 20-question 10/6/4 quotas, locked scope, synthetic diagnosis/evidence, one article, manual publish, and monitoring round 1')
}

try {
  await main()
} catch (error) {
  console.error(`smoke:demo failed: ${error instanceof Error ? error.message : String(error)}`)
  if (output.trim()) console.error(output)
  process.exitCode = 1
} finally {
  if (ownsProcess && child && !child.killed) {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
