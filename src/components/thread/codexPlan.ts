// Derive the Codex plan list from Codex `update_plan` snapshots.
//
// Codex emits the full plan on every update — via the `turn/plan/updated`
// notification during a turn and as a `plan` item on thread resume. Each step
// is a `TurnPlanStep` ({ step, status }); the list is snapshot-replaced, never
// merged. Output reuses ChatTasksPanel's TodoBarItem so the Codex plan renders
// in the same right-side Tasks panel as Claude/Grok/OpenCode todos.

import type { TodoBarItem } from "./ChatTasksPanel";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizeStatus(s: unknown): TodoBarItem["status"] {
  return typeof s === "string" && STATUSES.has(s) ? (s as TodoBarItem["status"]) : "pending";
}

/** Parse a Codex plan-step array (TurnPlanStep[]) into ordered TodoBarItems. */
export function parseCodexPlanSteps(raw: unknown): TodoBarItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => s != null && typeof s === "object")
    .map((s) => ({
      content: String(s.step ?? s.content ?? s.text ?? "").trim(),
      status: normalizeStatus(s.status),
    }))
    .filter((s) => s.content.length > 0)
    .map((s, idx): TodoBarItem => ({ id: String(idx), content: s.content, status: s.status }));
}
