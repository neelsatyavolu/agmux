/**
 * Terminal input that means "user is stopping the agent turn".
 * - Escape (0x1b): Claude / Kimi / OpenCode / Codex interrupt
 * - Ctrl+C (0x03): Grok terminal stop (Grok does not use Escape to cancel)
 *
 * Provider-aware: clearing spinner / hook Running must only fire for the
 * key that actually stops that provider — Escape on Grok leaves the agent
 * running while the UI goes Idle (ghost-stop).
 */
export function isTerminalUserInterrupt(
  data: string,
  opts?: { provider?: string | null },
): boolean {
  const isGrok = (opts?.provider ?? "").toLowerCase() === "grok";
  if (isGrok) return data === "\x03";
  return data === "\x1b";
}

/** Keys that clear hook-driven Running marks in Rust (must match FE). */
export function isHookClearingInterrupt(
  data: string,
  provider?: string | null,
): boolean {
  return isTerminalUserInterrupt(data, { provider });
}
