/**
 * Process-local cancellation handles for accepted AI tasks.
 *
 * The database row is the source of truth for validity.  This registry only
 * lets a profile reset or project deletion stop provider requests promptly;
 * callers must still guard every persistence write with the task/input token.
 */
const controllersByProject = new Map<string, Map<string, AbortController>>()

export function registerAiTaskController(projectId: string, taskId: string, controller: AbortController): void {
  const tasks = controllersByProject.get(projectId) ?? new Map<string, AbortController>()
  tasks.set(taskId, controller)
  controllersByProject.set(projectId, tasks)
}

export function unregisterAiTaskController(projectId: string, taskId: string): void {
  const tasks = controllersByProject.get(projectId)
  if (!tasks) return
  tasks.delete(taskId)
  if (tasks.size === 0) controllersByProject.delete(projectId)
}

export function abortAiTaskControllers(projectId: string): number {
  const tasks = controllersByProject.get(projectId)
  if (!tasks) return 0
  let count = 0
  for (const controller of tasks.values()) {
    if (!controller.signal.aborted) {
      controller.abort()
      count += 1
    }
  }
  controllersByProject.delete(projectId)
  return count
}

export function abortAiTaskControllersById(projectId: string, taskIds: readonly string[]): number {
  const tasks = controllersByProject.get(projectId)
  if (!tasks) return 0
  let count = 0
  for (const taskId of taskIds) {
    const controller = tasks.get(taskId)
    if (!controller) continue
    if (!controller.signal.aborted) {
      controller.abort()
      count += 1
    }
    tasks.delete(taskId)
  }
  if (tasks.size === 0) controllersByProject.delete(projectId)
  return count
}

export function abortAllAiTaskControllers(): number {
  let count = 0
  for (const projectId of controllersByProject.keys()) count += abortAiTaskControllers(projectId)
  return count
}
