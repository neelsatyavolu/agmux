export function extractClaudeHookRealSessionId(
  payload: unknown,
  xanomSessionId: string,
): string | null {
  const p = payload as Record<string, unknown> | null;
  const realId = typeof p?.session_id === "string" ? p.session_id.trim() : "";
  if (!realId || realId === xanomSessionId) return null;
  // A CLI run from inside a Claude terminal (e.g. `grok -p`) inherits its
  // agmux session env, so its hooks arrive as this terminal's. Claude's own
  // transcript is `…/projects/<dir>/<session_id>.jsonl`; Grok's is its
  // `updates.jsonl`. Adopting such an id pointed the sidebar row's diff
  // stats at a transcript that doesn't exist.
  const transcript = p?.transcript_path ?? p?.transcriptPath;
  if (typeof transcript === "string" && transcript) {
    const parts = transcript.split("/");
    const n = parts.length;
    if (parts[n - 1] !== `${realId}.jsonl` || parts[n - 3] !== "projects") return null;
  }
  return realId;
}
