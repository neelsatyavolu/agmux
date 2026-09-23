/**
 * Pure helpers extracted from claude-sdk-bridge.mjs for unit testability.
 *
 * IMPORTANT: These helpers are imported back into the bridge so production
 * behavior is unchanged. None of them perform I/O, mutate module-level state,
 * or interact with the JSON-RPC protocol — they are pure functions over their
 * inputs.
 */

/** Content-heavy keys whose values should be replaced with a length summary. */
export const LARGE_CONTENT_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "code",
  "notebook_content",
]);

/**
 * Classify a tool by its name into one of the approval request categories the
 * frontend recognizes.
 */
export function classifyTool(name) {
  const lower = String(name ?? "").toLowerCase();
  if (["bash", "execute_command"].includes(lower)) return "command_execution";
  if (
    ["edit", "write", "applypatch", "notebookedit", "multiedit"].includes(lower)
  ) {
    return "file_change";
  }
  if (["read", "glob", "grep", "view"].includes(lower)) return "file_read";
  return "dynamic_tool_call";
}

/**
 * Build a JSON summary of tool input that stays valid JSON even for tools
 * with large payloads (e.g. Write with full file content).
 *
 * Individual values are truncated rather than slicing the whole JSON string,
 * so the result always parses cleanly in the frontend's ToolDetail component.
 */
export function summarizeToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return JSON.stringify(toolInput ?? {}).slice(0, 500);
  }

  const summary = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === "string") {
      if (LARGE_CONTENT_KEYS.has(key) && value.length > 120) {
        // Show a short preview + length so the user knows what's being written
        const preview = value.slice(0, 80).replace(/\n/g, "\\n");
        summary[key] = `${preview}… (${value.length} chars)`;
      } else if (value.length > 300) {
        summary[key] = value.slice(0, 300) + "…";
      } else {
        summary[key] = value;
      }
    } else {
      summary[key] = value;
    }
  }
  return JSON.stringify(summary);
}

/**
 * Build query options for a resume call. Strips `sessionId` from the spread
 * because the claude CLI rejects `--session-id` together with `--resume`
 * unless `--fork-session` is also passed.
 *
 * Pure function — the bridge passes its `lastQueryOptions` as the second arg.
 */
export function buildResumeOptions(resumeId, lastQueryOptions) {
  if (!lastQueryOptions) return { resume: resumeId };
  const { sessionId: _drop, ...rest } = lastQueryOptions;
  return { ...rest, resume: resumeId };
}

/**
 * The set of effort values the SDK accepts. Exposed as a helper so the bridge
 * and its tests share a single source of truth.
 */
export const ALLOWED_EFFORT = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function isAllowedEffort(value) {
  return ALLOWED_EFFORT.has(value);
}
