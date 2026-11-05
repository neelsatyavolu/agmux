/**
 * consult's Claude adapter with the permission mode pinned. A resumed or forked session
 * otherwise comes back in the mode it was saved in, and Claude Code refuses consult's
 * --restricted in bypassPermissions, so ask_session (and a teammate's ask) failed for any
 * session started without permission prompts. consult's own source now passes the same
 * flag; drop this once the pinned consult-mcp has it.
 */

const PIN = ["--permission-mode", "default"];

/** The invocation with the mode pinned, unless it already names one. The prompt stays last. */
export function pinPermissionMode(invocation) {
  const args = invocation.args;
  if (args.includes("--permission-mode")) return invocation;
  return { ...invocation, args: [...args.slice(0, -1), ...PIN, args.at(-1)] };
}

export function withPinnedPermissionMode(adapter) {
  return {
    ...adapter,
    build: (...a) => pinPermissionMode(adapter.build(...a)),
    ...(adapter.fork ? { fork: (...a) => pinPermissionMode(adapter.fork(...a)) } : {}),
  };
}
