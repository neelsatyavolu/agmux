import type { PushAlert } from "./push";
import type { WireMessage } from "./protocol";

/** Which Settings switch on the phone controls an alert. */
export type PushKind = "approvals" | "finished";

export interface PushEvent {
  kind: PushKind;
  alert: PushAlert;
}

interface ThreadState {
  title: string;
  processing: boolean;
}

const MAX_TITLE = 120;

function titleOf(thread: { title?: unknown } | undefined): string {
  const t = typeof thread?.title === "string" ? thread.title.trim() : "";
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

/**
 * Watches desktop → phone traffic and turns the moments a person cares about
 * into alerts: an agent waiting for approval or an answer, and a run that just
 * finished. Session titles are kept in memory only (never stored).
 */
export class PushEvents {
  private threads = new Map<string, ThreadState>();

  observe(msg: WireMessage): PushEvent | null {
    switch (msg.type) {
      case "threads.snapshot":
        for (const t of msg.threads ?? []) {
          if (t?.id) this.threads.set(t.id, { title: titleOf(t), processing: Boolean(t.processing) });
        }
        return null;
      case "threads.upsert": {
        const t = msg.thread;
        if (!t?.id) return null;
        const prev = this.threads.get(t.id);
        const next = { title: titleOf(t) || prev?.title || "", processing: Boolean(t.processing) };
        this.threads.set(t.id, next);
        if (!prev?.processing || next.processing) return null;
        return {
          kind: "finished",
          alert: { title: "Agent finished", body: next.title || "Your session is ready.", threadId: t.id, collapseId: `done-${t.id}` },
        };
      }
      case "approval.requested": {
        const session = this.threads.get(msg.threadId ?? "")?.title;
        const tool = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "";
        const body = [tool, session].filter(Boolean).join(" · ") || "An agent on your Mac is waiting for you.";
        return {
          kind: "approvals",
          alert: { title: "Approval needed", body, threadId: msg.threadId, collapseId: `ask-${msg.requestId}` },
        };
      }
      case "userInput.requested": {
        const session = this.threads.get(msg.threadId ?? "")?.title;
        return {
          kind: "approvals",
          alert: {
            title: "Agent needs your answer",
            body: session || "An agent on your Mac has a question.",
            threadId: msg.threadId,
            collapseId: `ask-${msg.requestId}`,
          },
        };
      }
      default:
        return null;
    }
  }
}
