import {
  acceptAiTask,
  completeAiTask,
  failAiTask,
  getAiTask,
  updateAiTaskResult,
  type AiTask,
  type AiTaskKind,
} from './ai-task-db.ts'
import {
  registerAiTaskController,
  unregisterAiTaskController,
} from './ai-task-runtime.ts'
import { publishAiTaskEvent } from './ai-task-events.ts'

export type AiTaskExecution = {
  completed: boolean
  result?: Record<string, unknown>
  error?: unknown
}

export type AiTaskOperation = (signal: AbortSignal, task: AiTask) => Promise<AiTaskExecution | void>

function taskProgress(result: Record<string, unknown>): Record<string, unknown> | null {
  const progress = result.progress
  return progress && typeof progress === 'object' && !Array.isArray(progress)
    ? progress as Record<string, unknown>
    : null
}

async function publishTaskFailure(projectId: string, taskId: string): Promise<void> {
  // Read the sanitized value produced by ai-task-db rather than putting the
  // provider's raw error into a process-local HTTP event.
  let error = 'AI任务执行失败'
  try {
    error = (await getAiTask(projectId, taskId))?.error || error
  } catch {
    // The task row is already persisted; a best-effort notification may use
    // the fixed fallback without leaking a provider error.
  }
  await publishAiTaskEvent({ taskId, type: 'failed', error })
}

export async function acceptAndRunAiTask(
  projectId: string,
  kind: AiTaskKind,
  targetId: string | null,
  operation: AiTaskOperation,
): Promise<AiTask> {
  const accepted = await acceptAiTask(projectId, kind, targetId)
  if (!accepted.created) return accepted.task

  const controller = new AbortController()
  registerAiTaskController(projectId, accepted.task.id, controller)
  void (async () => {
    try {
      // Acceptance commits before this process-local controller can be
      // registered.  A reset/delete may therefore have removed the task in
      // that window.  Re-read the database row before invoking any provider
      // operation; an aborted controller alone cannot prevent a callback
      // that has not yet observed its signal.
      if (controller.signal.aborted) return
      const current = await getAiTask(projectId, accepted.task.id)
      if (!current || current.status !== 'running') {
        controller.abort()
        return
      }
      if (controller.signal.aborted) return
      const outcome = await operation(controller.signal, accepted.task)
      if (outcome?.completed === false) {
        const persisted = await failAiTask(accepted.task.id, outcome.error ?? 'AI任务未完成', outcome.result)
        if (persisted) await publishTaskFailure(accepted.task.projectId, accepted.task.id)
      } else {
        const persisted = await completeAiTask(accepted.task.id, outcome?.result ?? {})
        if (persisted) await publishAiTaskEvent({ taskId: accepted.task.id, type: 'complete' })
      }
    } catch (error) {
      try {
        const persisted = await failAiTask(accepted.task.id, error)
        if (persisted) await publishTaskFailure(accepted.task.projectId, accepted.task.id)
      } catch {
        // A reset or project delete may have removed the task row already.
      }
    } finally {
      unregisterAiTaskController(projectId, accepted.task.id)
    }
  })()
  return accepted.task
}

/** Mark a task failed without starting a provider request (used by preflight). */
export async function failAcceptedAiTask(taskId: string, error: unknown): Promise<void> {
  const persisted = await failAiTask(taskId, error)
  // This helper is retained for preflight callers that already have a task
  // id.  Its persisted error is still safely observable through the normal
  // task detail route; use a fixed message here because the project id is not
  // part of this legacy helper's signature.
  if (persisted) await publishAiTaskEvent({ taskId, type: 'failed', error: 'AI任务执行失败' })
}

export async function updateAcceptedAiTaskResult(taskId: string, result: Record<string, unknown>): Promise<boolean> {
  const persisted = await updateAiTaskResult(taskId, result)
  const progress = taskProgress(result)
  if (persisted && progress) {
    await publishAiTaskEvent({ taskId, type: 'progress', progress })
  }
  return persisted
}
