/**
 * Process-local notifications for accepted AI tasks.
 *
 * The database remains the source of truth.  Subscribers use the persisted
 * task snapshot to recover after a page reload or a short connection race;
 * this module only wakes an already-connected observer and never owns task
 * execution or cancellation.
 */
export type AiTaskEvent =
  | {
      taskId: string
      type: 'progress'
      progress: Record<string, unknown>
    }
  | {
      taskId: string
      type: 'complete'
    }
  | {
      taskId: string
      type: 'failed'
      error: string
    }

export type AiTaskEventListener = (event: AiTaskEvent) => void | Promise<void>

const listenersByTask = new Map<string, Set<AiTaskEventListener>>()

/** Subscribe to one task only. Returns an idempotent cleanup function. */
export function subscribeAiTask(taskId: string, listener: AiTaskEventListener): () => void {
  const listeners = listenersByTask.get(taskId) ?? new Set<AiTaskEventListener>()
  listeners.add(listener)
  listenersByTask.set(taskId, listeners)

  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    const current = listenersByTask.get(taskId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByTask.delete(taskId)
  }
}

/**
 * Notify a stable listener snapshot.  A disconnected HTTP response must not
 * make the background task fail, so listener failures are intentionally
 * isolated from the publisher and from one another.
 */
export async function publishAiTaskEvent(event: AiTaskEvent): Promise<void> {
  const listeners = [...(listenersByTask.get(event.taskId) ?? [])]
  await Promise.allSettled(listeners.map(async (listener) => {
    try {
      await listener(event)
    } catch {
      // Observers are best-effort and cannot change persisted task state.
    }
  }))
}
