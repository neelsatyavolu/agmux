/** Match a live Codex MCP permission form, using only the current screen. */
export function codexPermissionPrompt(screen: string): string | null {
  const plain = screen.toLowerCase().replace(/\s+/g, " ");
  if (!plain.includes("enter to submit") || !plain.includes("esc to cancel")
    || !plain.includes("allow for this session") || !plain.includes("always allow")) return null;
  const lines = screen.split("\n").map((line) => line.trim());
  const field = lines.findIndex((line) => /^Field \d+\/\d+$/i.test(line));
  if (field < 0) return null;
  const question = lines.slice(field + 1).find((line) => line.length > 0);
  return question ?? null;
}

const CHUNK_HINTS = ["allow for this session", "always allow", "esc to cancel", "enter to submit"];

/**
 * Cheap pre-check on raw output (not the screen): does this chunk paint part
 * of a permission form? Hidden terminals use it to decide whether a full
 * snapshot catch-up and screen scan is worth doing.
 */
export function codexPermissionChunkHint(text: string): boolean {
  const plain = text.toLowerCase().replace(/\s+/g, " ");
  return CHUNK_HINTS.some((hint) => plain.includes(hint));
}
