import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { databasePool } from './db.ts'
import { QUESTION_TOTAL } from '../src/business-rules.ts'

export const AI_TASK_KINDS = ['questions', 'diagnosis', 'diagnosis_report', 'monitoring', 'article_titles', 'article_body', 'content_audit'] as const
export type AiTaskKind = typeof AI_TASK_KINDS[number]
export type AiTaskStatus = 'running' | 'completed' | 'failed'

export type AiTask = {
  id: string
  projectId: string
  kind: AiTaskKind
  targetId: string | null
  status: AiTaskStatus
  error: string | null
  startedAt: string
  completedAt: string | null
  result: Record<string, unknown> | null
}

type TaskRow = Record<string, unknown>

function safeError(value: unknown): string {
  let raw = value instanceof Error ? value.message : String(value ?? '')
  raw = raw
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|token|secret|password|cookie)\b\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 4 || !/(?:KEY|TOKEN|PASSWORD|SECRET|COOKIE)/i.test(key)) continue
    raw = raw.replaceAll(secret, '[REDACTED]')
  }
  return raw.slice(0, 500) || 'AI任务执行失败'
}

function taskFromRow(row: TaskRow): AiTask {
  const rawResult = row.result
  const result = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
    ? rawResult as Record<string, unknown>
    : null
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as AiTaskKind,
    targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
    status: String(row.status) as AiTaskStatus,
    error: row.error === null || row.error === undefined ? null : safeError(row.error),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : new Date(String(row.started_at)).toISOString(),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? null
      : row.completed_at instanceof Date ? row.completed_at.toISOString() : new Date(String(row.completed_at)).toISOString(),
    result,
  }
}

function validateKind(kind: AiTaskKind): void {
  if (!AI_TASK_KINDS.includes(kind)) throw new Error('ai_task_kind_invalid')
}

export async function acceptAiTask(
  projectId: string,
  kind: AiTaskKind,
  targetId: string | null = null,
): Promise<{ task: AiTask; created: boolean }> {
  validateKind(kind)
  const id = randomUUID()
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const project = await client.query('select id from geo_projects where id = $1 for update', [projectId])
    if (!project.rows[0]) throw new Error('project_not_found')
    const inserted = await client.query(
      `insert into geo_ai_tasks (id, project_id, kind, target_id, status)
       values ($1, $2, $3, $4, 'running')
       on conflict do nothing
       returning id, project_id, kind, target_id, status, error, started_at, completed_at, result`,
      [id, projectId, kind, targetId],
    )
    if (inserted.rows[0]) {
      await client.query('COMMIT')
      return { task: taskFromRow(inserted.rows[0]), created: true }
    }

    const existing = await client.query(
      `select id, project_id, kind, target_id, status, error, started_at, completed_at, result
       from geo_ai_tasks
       where project_id = $1 and kind = $2 and coalesce(target_id, '') = coalesce($3, '') and status = 'running'
       order by started_at desc
       limit 1`,
      [projectId, kind, targetId],
    )
    if (!existing.rows[0]) throw new Error('ai_task_duplicate_race')
    await client.query('COMMIT')
    return { task: taskFromRow(existing.rows[0]), created: false }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    client.release()
  }
}

export async function getAiTask(projectId: string, taskId: string): Promise<AiTask | null> {
  const result = await databasePool().query(
    `select id, project_id, kind, target_id, status, error, started_at, completed_at, result
     from geo_ai_tasks where id = $1 and project_id = $2`,
    [taskId, projectId],
  )
  return result.rows[0] ? taskFromRow(result.rows[0]) : null
}

/** Return the current task for one business operation, if any. */
export async function getRunningAiTask(
  projectId: string,
  kind: AiTaskKind,
  targetId: string | null = null,
): Promise<AiTask | null> {
  validateKind(kind)
  const result = await databasePool().query(
    `select id, project_id, kind, target_id, status, error, started_at, completed_at, result
     from geo_ai_tasks
     where project_id = $1 and kind = $2
       and coalesce(target_id, '') = coalesce($3, '')
       and status = 'running'
     order by started_at desc
     limit 1`,
    [projectId, kind, targetId],
  )
  return result.rows[0] ? taskFromRow(result.rows[0]) : null
}

export async function listAiTasks(projectId: string): Promise<AiTask[]> {
  const result = await databasePool().query(
    `select id, project_id, kind, target_id, status, error, started_at, completed_at, result
     from geo_ai_tasks where project_id = $1 order by started_at desc, id desc`,
    [projectId],
  )
  return result.rows.map(taskFromRow)
}

export async function updateAiTaskResult(taskId: string, result: Record<string, unknown>): Promise<boolean> {
  const updated = await databasePool().query(
    `update geo_ai_tasks set result = $2::jsonb where id = $1 and status = 'running'`,
    [taskId, JSON.stringify(result)],
  )
  return updated.rowCount === 1
}

export async function completeAiTask(taskId: string, result: Record<string, unknown> = {}): Promise<boolean> {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query<{ kind: AiTaskKind }>(
      `update geo_ai_tasks
       set status = 'completed', completed_at = clock_timestamp(), error = null, result = $2::jsonb
       where id = $1 and status = 'running'
       returning kind`,
      [taskId, JSON.stringify(result)],
    )
    if (!updated.rows[0]) {
      await client.query('COMMIT')
      return false
    }
    if (updated.rows[0].kind === 'content_audit') {
      // finishContentAudit() leaves a task marker on the current completed
      // record.  Move that validated record into history in the same
      // transaction as the task completion marker.  If the process dies
      // before this point, startup cleanup can discard the marked current
      // run without ever exposing it as historical output.
      await client.query(
        `update geo_projects
         set content_audit_history = case
               when jsonb_typeof(coalesce(content_audit_history, '[]'::jsonb)) = 'array'
                and content_audit->>'status' = 'completed'
                and content_audit->>'error' is null
                and case
                      when jsonb_typeof(content_audit->'executionErrors') = 'array'
                        then jsonb_array_length(content_audit->'executionErrors') = 0
                      else false
                    end
                and not exists (
                  select 1
                  from jsonb_array_elements(
                    case
                      when jsonb_typeof(coalesce(content_audit_history, '[]'::jsonb)) = 'array'
                        then coalesce(content_audit_history, '[]'::jsonb)
                      else '[]'::jsonb
                    end
                  ) as prior
                  where prior->>'startedAt' = content_audit->>'startedAt'
                )
                 then coalesce(content_audit_history, '[]'::jsonb) || jsonb_build_array(
                   content_audit - 'checkpoint' - 'previousResult' - 'previousCompletedAt'
                 )
               else coalesce(content_audit_history, '[]'::jsonb)
             end,
             content_audit_task_id = null,
             updated_at = clock_timestamp()
         where content_audit_task_id = $1`,
        [taskId],
      )
    }
    // Business output keeps its task marker until this transaction.  If the
    // process dies after saving output but before task completion, startup can
    // still remove that output by task id; once both are committed the marker
    // is no longer needed.
    await client.query('update geo_article_batches set ai_task_id = null where ai_task_id = $1', [taskId])
    await client.query('update geo_project_articles set writing_ai_task_id = null where writing_ai_task_id = $1', [taskId])
    await client.query('update geo_projects set content_audit_task_id = null where content_audit_task_id = $1', [taskId])
    await client.query('update geo_projects set questions_generation_task_id = null where questions_generation_task_id = $1', [taskId])
    await client.query('update geo_diagnosis_runs set diagnosis_ai_task_id = null where diagnosis_ai_task_id = $1', [taskId])
    await client.query('COMMIT')
    return true
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    client.release()
  }
}

export async function failAiTask(taskId: string, error: unknown, result?: Record<string, unknown>): Promise<boolean> {
  const updated = await databasePool().query(
    `update geo_ai_tasks
     set status = 'failed', completed_at = clock_timestamp(), error = $2, result = coalesce($3::jsonb, result)
     where id = $1 and status = 'running'`,
    [taskId, safeError(error), result === undefined ? null : JSON.stringify(result)],
  )
  return updated.rowCount === 1
}

/** Delete all task rows for a reset inside the caller's existing transaction. */
export async function deleteAiTasksForProject(projectId: string, client?: Pick<PoolClient, 'query'>): Promise<number> {
  const executor = client ?? databasePool()
  const result = await executor.query('delete from geo_ai_tasks where project_id = $1', [projectId])
  return result.rowCount ?? 0
}

type StartupCleanupCounts = {
  taskRows: number
  questionStates: number
  diagnosisRuns: number
  diagnosisAnswers: number
  diagnosisReports: number
  articleBatches: number
  articleBodies: number
  contentAudits: number
}

/** Reconcile project-level initial-diagnosis aggregates after deleting a run. */
async function reconcileInitialDiagnosis(projectId: string, client: Pick<PoolClient, 'query'>): Promise<void> {
  const completed = await client.query<{
    started_at: Date | string | null
    completed_at: Date | string | null
    recommendation_rate: number | string | null
    official_citation_rate: number | string | null
  }>(
    `select started_at, completed_at, recommendation_rate, official_citation_rate
     from geo_diagnosis_runs
     where project_id = $1 and run_type = 'initial' and status = 'completed'
     order by completed_at desc nulls last, id desc
     limit 1`,
    [projectId],
  )
  const row = completed.rows[0]
  if (!row) {
    await client.query(
      `update geo_projects
       set diagnosis_started_at = null,
           initial_diagnosis_completed_at = null,
           initial_diagnosis_status = 'not_started',
           initial_recommendation_rate = null,
           initial_official_citation_rate = null,
           initial_diagnosis_at = null,
           updated_at = clock_timestamp()
       where id = $1`,
      [projectId],
    )
    return
  }
  await client.query(
    `update geo_projects
     set diagnosis_started_at = $2,
         initial_diagnosis_completed_at = $3,
         initial_diagnosis_status = 'completed',
         initial_recommendation_rate = $4,
         initial_official_citation_rate = $5,
         initial_diagnosis_at = $3,
         updated_at = clock_timestamp()
     where id = $1`,
    [projectId, row.started_at, row.completed_at, row.recommendation_rate, row.official_citation_rate],
  )
}

/**
 * Remove incomplete AI work before the HTTP listener accepts requests.  The
 * task row is used to identify the business unit; no generic status sweep is
 * allowed to delete valid question/diagnosis inputs.
 */
export async function clearIncompleteAiTasksOnStartup(): Promise<StartupCleanupCounts> {
  const client = await databasePool().connect()
  const counts: StartupCleanupCounts = {
    taskRows: 0,
    questionStates: 0,
    diagnosisRuns: 0,
    diagnosisAnswers: 0,
    diagnosisReports: 0,
    articleBatches: 0,
    articleBodies: 0,
    contentAudits: 0,
  }
  try {
    await client.query('BEGIN')
    const tasks = await client.query<{
      id: string
      project_id: string
      kind: AiTaskKind
      target_id: string | null
      status: AiTaskStatus
      started_at: Date
      result: Record<string, unknown> | null
    }>(
      `select id, project_id, kind, target_id, status, started_at, result
       from geo_ai_tasks where status <> 'completed' for update`,
    )

    for (const task of tasks.rows) {
      const projectId = String(task.project_id)
      const result = task.result && typeof task.result === 'object' ? task.result : {}
      const runId = typeof result.runId === 'string' && /^\d+$/.test(result.runId)
        ? result.runId
        : typeof result.runId === 'number' && Number.isSafeInteger(result.runId) && result.runId >= 0
          ? String(result.runId)
          : null
      if (task.kind === 'questions') {
        // Question generation writes the final set atomically, but task
        // completion is a separate transaction.  A process crash can
        // therefore leave a running task beside a completed generation.  In
        // that crash window clear only this generation's unlocked outputs;
        // locked questions are the user's inputs and must survive.  A stale
        // failed task must not clear a successful retry's completed output;
        // only a marker still pointing at that failed task owns the output.
        await client.query(
          `delete from geo_project_questions
           where project_id = $1 and is_locked = false
             and exists (
               select 1 from geo_projects
               where id = $1
                 and questions_generation_status = 'completed'
                 and questions_generation_task_id = $2
             )`,
          [projectId, task.id],
        )
        const updated = await client.query(
          `update geo_projects
           set questions_generation_status = case
                 when questions_generation_status = 'generating' then 'failed'
                 when questions_generation_status = 'completed'
                   and questions_generation_task_id = $2::text then 'failed'
                 else questions_generation_status
               end,
               questions_generation_completed_at = null,
               questions_generation_error = case
                 when questions_generation_status in ('generating', 'completed')
                   then '服务重启，未完成的问题生成已清理'
                 else questions_generation_error
               end,
               updated_at = clock_timestamp()
           where id = $1
             and (
               questions_generation_task_id = $2::text
               or (
                 questions_generation_task_id is null
                 and questions_generation_status = 'generating'
                 and not exists (
                   select 1 from geo_ai_tasks as other_task
                   where other_task.project_id = $1
                     and other_task.kind = 'questions'
                     and other_task.status = 'running'
                     and other_task.id <> $2::text
                 )
               )
             )
             and (questions_generation_status = 'generating'
               or (questions_generation_status = 'completed' and questions_generation_task_id = $2::text))`,
          [projectId, task.id],
        )
        counts.questionStates += updated.rowCount ?? 0
      } else if (task.kind === 'diagnosis' || task.kind === 'monitoring' || task.kind === 'diagnosis_report') {
        const runType = task.kind === 'monitoring' ? 'monitoring' : 'initial'
        const runResult = await client.query<{ id: string; status: string }>(
          `select id, status
             from geo_diagnosis_runs
             where project_id = $1 and run_type = $2
               and (
                 -- A run id or task marker recorded by the task is the only
                 -- allowed way to touch its diagnosis/report.  Unindexed
                 -- legacy runs are handled by the separate sweep below.
                 -- The marker wins over task status: a failed task can still
                 -- own output when completion failed after the output write.
                 ($4::text is not null and diagnosis_ai_task_id = $4::text)
                 or ($3::bigint is not null and id = $3::bigint
                   and ($5::text = 'running' or status <> 'completed'))
               )
             order by id desc
             limit 1`,
          [projectId, runType, runId, task.id, task.status],
        )
        const cleanupRunId = runResult.rows[0]?.id ?? null
        if (!cleanupRunId) continue
        const cleanupRunStatus = String(runResult.rows[0]?.status ?? '')
        const answerCount = await client.query<{ success_count: string }>(
          `select count(*)::int as success_count from geo_diagnosis_answers where run_id = $1`,
          [cleanupRunId],
        )
        const answerTotal = Number(answerCount.rows[0]?.success_count ?? 0)
        const successfulAnswerCount = await client.query<{ success_count: string }>(
          `select count(*)::int as success_count from geo_diagnosis_answers where run_id = $1 and status = 'success'`,
          [cleanupRunId],
        )
        const hasCompleteAnswers = Number(successfulAnswerCount.rows[0]?.success_count ?? 0) >= QUESTION_TOTAL
        if (!hasCompleteAnswers) {
          // A task that did not finish all independent answer requests owns
          // this run and its partial answers.  Delete only that run; unrelated
          // completed diagnosis/monitoring history remains untouched.
          const deleted = await client.query(
            'delete from geo_diagnosis_runs where id = $1 and run_type = $2',
            [cleanupRunId, runType],
          )
          counts.diagnosisRuns += deleted.rowCount ?? 0
          counts.diagnosisAnswers += answerTotal
          if ((deleted.rowCount ?? 0) > 0 && runType === 'initial') await reconcileInitialDiagnosis(projectId, client)
          continue
        }

        // A complete set of successful answers is a separately completed input.  Never
        // delete them just because the answer task or its independent summary
        // task was interrupted.  A completed summary is already valid; an
        // unfinished summary is made retryable without retaining partial
        // aggregate metrics.  The diagnosis_report task consumes exactly this
        // preserved input on its next attempt.
        if (cleanupRunStatus !== 'completed') {
          const updated = await client.query(
            `update geo_diagnosis_runs
             set status = 'failed', completed_at = null, summary_analysis = null,
                 summary_model = null, recommendation_rate = null,
                 official_citation_rate = null, summary_error = coalesce(summary_error, '服务重启，诊断汇总未完成')
             where id = $1 and run_type = $2 and status <> 'completed'`,
            [cleanupRunId, runType],
          )
          if (task.kind === 'diagnosis_report') counts.diagnosisReports += updated.rowCount ?? 0
          else counts.diagnosisRuns += updated.rowCount ?? 0
          if (runType === 'initial' && (updated.rowCount ?? 0) > 0) {
            await client.query(
              `update geo_projects
               set initial_diagnosis_status = 'failed', updated_at = clock_timestamp()
               where id = $1 and initial_diagnosis_status <> 'completed'`,
              [projectId],
            )
          }
        }
      } else if (task.kind === 'article_titles') {
        const batchId = typeof result.batchId === 'string' && /^\d+$/.test(result.batchId) ? result.batchId : null
        const deleted = await client.query(
          `delete from geo_article_batches
           where project_id = $1 and (ai_task_id = $2 or ($2 is null and id = $3))`,
          [projectId, task.id, batchId],
        )
        counts.articleBatches += deleted.rowCount ?? 0
      } else if (task.kind === 'article_body' && task.target_id && /^\d+$/.test(task.target_id)) {
        const updated = await client.query(
          `update geo_project_articles
           set content_html = case
                 when publish_status = 'published' then content_html
                 when length(btrim(coalesce(content_html, ''))) > 0 then content_html
                 else null
               end,
               writing_status = case
                 when publish_status = 'published' then writing_status
                 when length(btrim(coalesce(content_html, ''))) > 0 then 'ready'
                 else 'pending'
               end,
               writing_error = null,
               writing_attempt_token = null, writing_started_at = null, writing_lease_expires_at = null, updated_at = clock_timestamp()
           where id = $1 and project_id = $2 and writing_ai_task_id = $3`,
          [task.target_id, projectId, task.id],
        )
        counts.articleBodies += updated.rowCount ?? 0
      } else if (task.kind === 'content_audit') {
        const updated = await client.query(
          `update geo_projects
           set content_audit = (content_audit || jsonb_build_object(
                 'status', 'failed',
                 'completedAt', to_jsonb(clock_timestamp()),
                 'result', null,
                 'error', '服务重启，未完成的官网内容检查已清理',
                 'executionErrors', jsonb_build_array(jsonb_build_object(
                   'stage', 'restart',
                   'message', '服务重启，未完成的官网内容检查已清理'
                 ))
               )) - 'checkpoint',
               content_audit_task_id = null,
               updated_at = clock_timestamp()
           where id = $1 and content_audit_task_id = $2`,
          [projectId, task.id],
        )
        counts.contentAudits += updated.rowCount ?? 0
      }
    }

    // Task-bound cleanup above has now used every incomplete task row.  Remove
    // them before the legacy sweeps so an old run without a precise marker is
    // handled by those sweeps rather than guessed from a task's project.
    const deletedTasks = await client.query("delete from geo_ai_tasks where status <> 'completed'")
    counts.taskRows = deletedTasks.rowCount ?? 0

    const legacyAudits = await client.query(
      `update geo_projects
       set content_audit = (content_audit
             || jsonb_build_object(
                  'status', 'failed',
                  'completedAt', to_jsonb(clock_timestamp()),
                  'result', null,
                  'error', '服务重启，未完成的官网内容检查已清理',
                  'executionErrors', jsonb_build_array(jsonb_build_object('stage', 'restart', 'message', '服务重启，未完成的官网内容检查已清理'))
                )) - 'checkpoint',
           content_audit_task_id = null,
           updated_at = clock_timestamp()
       where content_audit_task_id is null and content_audit->>'status' = 'checking'`,
    )
    counts.contentAudits += legacyAudits.rowCount ?? 0
    const legacyBodies = await client.query(
      `update geo_project_articles
       set content_html = case
             when length(btrim(coalesce(content_html, ''))) > 0 then content_html
             else null
           end,
           writing_status = case
             when length(btrim(coalesce(content_html, ''))) > 0 then 'ready'
             else 'pending'
           end,
           writing_error = null,
           writing_attempt_token = null, writing_started_at = null, writing_lease_expires_at = null,
           updated_at = clock_timestamp()
       where writing_ai_task_id is null and writing_status in ('writing', 'failed')
         and publish_status <> 'published'`,
    )
    counts.articleBodies += legacyBodies.rowCount ?? 0
    const legacyQuestions = await client.query(
      `update geo_projects
       set questions_generation_status = 'failed', questions_generation_completed_at = null,
           questions_generation_error = '服务重启，未完成的问题生成已清理',
           questions_generation_task_id = null,
           updated_at = clock_timestamp()
       where questions_generation_status = 'generating'
         and not exists (
           select 1 from geo_ai_tasks as task
           where task.project_id = geo_projects.id
             and task.kind = 'questions'
             and task.status <> 'completed'
         )`,
    )
    counts.questionStates += legacyQuestions.rowCount ?? 0
    const legacyRuns = await client.query<{ id: string; project_id: string; run_type: 'initial' | 'monitoring'; status: string }>(
      `select id, project_id, run_type, status
       from geo_diagnosis_runs as run
       where run.status in ('running', 'analyzing', 'failed')
         and not exists (
           select 1 from geo_ai_tasks as task
           where task.project_id = run.project_id
             and task.status <> 'completed'
             and (
               (run.run_type = 'monitoring' and task.kind = 'monitoring')
               or (run.run_type = 'initial' and task.kind in ('diagnosis', 'diagnosis_report'))
             )
         )
       for update`,
    )
    for (const run of legacyRuns.rows) {
      const answerCount = await client.query<{ count: string }>(
        'select count(*)::int as count from geo_diagnosis_answers where run_id = $1',
        [run.id],
      )
      const successfulAnswerCount = await client.query<{ count: string }>(
        `select count(*)::int as count
         from geo_diagnosis_answers
         where run_id = $1 and status = 'success'`,
        [run.id],
      )
      if (Number(successfulAnswerCount.rows[0]?.count ?? 0) >= QUESTION_TOTAL) {
        // Legacy rows have no task marker, but a complete answer set is still
        // an independently valid input.  Keep it for the diagnosis summary
        // retry instead of treating a missing task as permission to delete.
        if (run.status !== 'failed') {
          await client.query(
            `update geo_diagnosis_runs
             set status = 'failed', completed_at = null, summary_analysis = null,
                 summary_model = null, recommendation_rate = null,
                 official_citation_rate = null, summary_error = '服务重启，诊断汇总未完成'
             where id = $1 and run_type = $2 and status <> 'completed'`,
            [run.id, run.run_type],
          )
        }
        if (run.run_type === 'initial') {
          await client.query(
            `update geo_projects
             set initial_diagnosis_status = 'failed', updated_at = clock_timestamp()
             where id = $1 and initial_diagnosis_status <> 'completed'`,
            [run.project_id],
          )
        }
        continue
      }
      const deleted = await client.query('delete from geo_diagnosis_runs where id = $1 and run_type = $2', [run.id, run.run_type])
      counts.diagnosisRuns += deleted.rowCount ?? 0
      if ((deleted.rowCount ?? 0) > 0) counts.diagnosisAnswers += Number(answerCount.rows[0]?.count ?? 0)
      if ((deleted.rowCount ?? 0) > 0 && run.run_type === 'initial') await reconcileInitialDiagnosis(String(run.project_id), client)
    }

    // Report refresh is deliberately not an AI task.  It can be left in the
    // running state by a process crash after the initial diagnosis answers
    // and/or an older PDF were already persisted.  Make only that lifecycle
    // retryable; never delete or replace the answer rows, website fields, or
    // existing report bytes here.
    const staleReportRefreshes = await client.query(
      `update geo_diagnosis_runs
       set report_refresh_status = 'failed',
           report_refresh_error = '服务重启，未完成的诊断报告刷新已清理'
       where run_type = 'initial' and report_refresh_status = 'running'`,
    )
    counts.diagnosisReports += staleReportRefreshes.rowCount ?? 0
    await client.query('COMMIT')
    return counts
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original failure */ }
    throw error
  } finally {
    client.release()
  }
}
