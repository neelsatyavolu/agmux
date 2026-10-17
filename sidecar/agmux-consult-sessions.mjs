/**
 * agmux-backed live sessions for the bundled consult server.
 *
 * consult normally finds sessions with ps/lsof and delivers messages through
 * per-CLI hooks. Inside agmux the app already knows every session (all
 * providers, with working / needs-you / idle status) and can deliver to any of
 * them, so these call the room socket instead:
 *   sessions.list {callerThreadId?, callerPid, cwd, projectId?}
 *   sessions.send {..., to, text}
 */

import { AdvisorError } from "consult-mcp/dist/types.js";

// Building the list scans provider history on the Mac; allow more than the
// room client's 10s default.
const LIST_TIMEOUT_MS = 30_000;

/** Who this server speaks for, as far as its own process can tell. */
export function callerParams(env = process.env, ppid = process.ppid, cwd = process.cwd()) {
  const threadId = String(env.AGMUX_THREAD_ID || "").trim();
  const projectId = String(env.AGMUX_PROJECT_ID || "").trim();
  return {
    ...(threadId ? { callerThreadId: threadId } : {}),
    ...(projectId ? { projectId } : {}),
    // A shared config (Grok terminal) carries no thread id; the app matches
    // the agent process that started this server.
    callerPid: ppid,
    cwd,
  };
}

/** What list_sessions shows: drops the fork details agents don't need. */
export function toView(row) {
  const { fork, ...rest } = row;
  return { ...rest, can_ask: Boolean(fork) };
}

const FORKABLE = "Claude, Codex and Grok";

export function createAgmuxSessions({ request, caller, askFork }) {
  async function rows() {
    const result = await request("sessions.list", caller, { timeoutMs: LIST_TIMEOUT_MS });
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  async function find(sessionId) {
    const row = (await rows()).find((r) => r.session_id === sessionId);
    if (!row) {
      throw new AdvisorError(`no session ${sessionId} in this project; call list_sessions to see the current ones`);
    }
    return row;
  }

  async function list() {
    return (await rows()).map(toView);
  }

  async function ask(sessionId, question, effort, signal) {
    const row = await find(sessionId);
    if (!row.fork) {
      throw new AdvisorError(
        `consult can only copy ${FORKABLE} sessions, and ${sessionId} is a ${row.agent} session. Use send_message to ask it directly.`,
      );
    }
    const target = { agent: row.fork.agent, sessionId: row.fork.session_id, cwd: row.fork.cwd };
    const result = await askFork(target, question, effort, signal);
    return { ...result, cwd: target.cwd, source: row.session_id };
  }

  async function send(sessionId, message) {
    try {
      return await request("sessions.send", { ...caller, to: sessionId, text: message }, { timeoutMs: LIST_TIMEOUT_MS });
    } catch (err) {
      throw new AdvisorError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Resuming a live session in place would write its transcript; ask_session forks instead. */
  async function assertNotLive(sessionId) {
    let live;
    try {
      live = await rows();
    } catch {
      // App unreachable: nothing to protect against beyond consult's own checks.
      return;
    }
    if (live.some((r) => r.status !== "not_running" && (r.session_id === sessionId || r.fork?.session_id === sessionId))) {
      throw new AdvisorError(`${sessionId} is a live agmux session; use ask_session to ask a read-only copy of it`);
    }
  }

  return { list, ask, send, assertNotLive };
}
