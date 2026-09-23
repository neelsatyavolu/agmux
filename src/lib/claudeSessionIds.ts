export function extractClaudeHookRealSessionId(
  payload: unknown,
  xanomSessionId: string,
): string | null {
  const p = payload as Record<string, unknown> | null;
  const realId = typeof p?.session_id === "string" ? p.session_id.trim() : "";
  if (!realId || realId === xanomSessionId) return null;
  return realId;
}
