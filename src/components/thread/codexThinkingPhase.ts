/**
 * Codex turn-footer phase helpers.
 *
 * Codex can sit on `turn/started` for a long time while MCP servers finish
 * listing tools. Before the turn produces model activity, we map
 * `mcpServer/startupStatus/updated` into a clearer footer label than the
 * default "thinking" so a stuck MCP is obvious.
 */

export type McpStartupStatus = "starting" | "ready" | "failed" | "cancelled";

export interface McpStartupStatusEvent {
  threadId: string | null;
  name: string;
  status: McpStartupStatus;
  error: string | null;
  failureReason: string | null;
}

const TERMINAL_MCP_STATUSES = new Set<McpStartupStatus>([
  "ready",
  "failed",
  "cancelled",
]);

/** Parse a `mcpServer/startupStatus/updated` params object. */
export function parseMcpStartupStatusEvent(
  params: Record<string, unknown> | null | undefined,
): McpStartupStatusEvent | null {
  if (!params || typeof params !== "object") return null;

  const rawName = params.name ?? params.serverName ?? params.server;
  if (typeof rawName !== "string" || !rawName.trim()) return null;

  const rawStatus = params.status;
  let statusStr: string | null = null;
  if (typeof rawStatus === "string") {
    statusStr = rawStatus;
  } else if (rawStatus && typeof rawStatus === "object") {
    const typed = rawStatus as { type?: unknown; status?: unknown };
    if (typeof typed.type === "string") statusStr = typed.type;
    else if (typeof typed.status === "string") statusStr = typed.status;
  }
  if (!statusStr) return null;

  const normalized = statusStr.trim().toLowerCase();
  if (
    normalized !== "starting" &&
    normalized !== "ready" &&
    normalized !== "failed" &&
    normalized !== "cancelled"
  ) {
    return null;
  }

  const threadRaw = params.threadId ?? params.thread_id;
  const threadId =
    typeof threadRaw === "string" && threadRaw.length > 0 ? threadRaw : null;

  const error =
    typeof params.error === "string"
      ? params.error
      : params.error &&
          typeof params.error === "object" &&
          typeof (params.error as { message?: unknown }).message === "string"
        ? ((params.error as { message: string }).message)
        : null;

  const failureReason =
    typeof params.failureReason === "string"
      ? params.failureReason
      : typeof params.failure_reason === "string"
        ? params.failure_reason
        : null;

  return {
    threadId,
    name: rawName.trim(),
    status: normalized,
    error,
    failureReason,
  };
}

/**
 * Keep an ordered list of MCP servers still starting. Insertion order is
 * preserved so the footer shows the oldest waiter first.
 */
export function reduceMcpStartingServers(
  prev: readonly string[],
  event: McpStartupStatusEvent,
): string[] {
  if (event.status === "starting") {
    if (prev.includes(event.name)) return prev as string[];
    return [...prev, event.name];
  }
  if (TERMINAL_MCP_STATUSES.has(event.status)) {
    if (!prev.includes(event.name)) return prev as string[];
    return prev.filter((n) => n !== event.name);
  }
  return prev as string[];
}

/** Compact label for the right side of the thinking row. */
export function formatMcpStartupDetail(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const pretty = names.map(prettifyMcpServerName);
  if (pretty.length === 1) return pretty[0]!;
  if (pretty.length === 2) return `${pretty[0]}, ${pretty[1]}`;
  return `${pretty[0]} +${pretty.length - 1}`;
}

export function prettifyMcpServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  // Keep identifiers readable; truncate extreme plugin ids.
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 26)}…`;
}

/** Phase label next to the Braille spinner. Codex-only. */
export function codexThinkingPhase(mcpStarting: readonly string[]): string {
  return mcpStarting.length > 0 ? "starting MCP" : "thinking";
}
