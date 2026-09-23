/**
 * Bridge for "open New Task dialog" when Task mode is not yet mounted.
 *
 * Agent-mode "Worktree" in the project + menu switches to Task mode and
 * needs the dialog to open once TaskSidebar mounts. A window event alone
 * races the unmount/remount; this module holds one pending open that
 * TaskSidebar consumes on mount.
 *
 * Already-in-task-mode callers should dispatch `agmux-new-task` with
 * `{ detail: { projectId } }` instead (see `dispatchNewTaskEvent`).
 */

export type PendingNewTask = {
  projectId: string | null;
};

let pending: PendingNewTask | null = null;

export function setPendingNewTask(projectId: string | null): void {
  pending = { projectId };
}

/** Returns and clears any pending open. `null` means nothing pending. */
export function takePendingNewTask(): PendingNewTask | null {
  const next = pending;
  pending = null;
  return next;
}

/** Fire the live event TaskSidebar listens for (task mode must be mounted). */
export function dispatchNewTaskEvent(projectId: string | null): void {
  window.dispatchEvent(
    new CustomEvent("agmux-new-task", { detail: { projectId } }),
  );
}
