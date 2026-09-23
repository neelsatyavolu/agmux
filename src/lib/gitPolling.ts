import { getGitInfo, gitStatusSummary } from "./commands";

const infoReads = new Map<string, ReturnType<typeof getGitInfo>>();
const statusReads = new Map<string, ReturnType<typeof gitStatusSummary>>();

// Share only pending presentation reads. Never cache settled data: branch/commit
// actions and the next poll must observe fresh state. Exact paths isolate worktrees.
function share<T>(pending: Map<string, Promise<T>>, path: string, read: () => Promise<T>): Promise<T> {
  const existing = pending.get(path);
  if (existing) return existing;
  const request = read().finally(() => { pending.delete(path); });
  pending.set(path, request);
  return request;
}

export function pollGitInfo(path: string) {
  return share(infoReads, path, () => getGitInfo(path));
}
export function pollGitStatus(path: string) {
  return share(statusReads, path, () => gitStatusSummary(path));
}
