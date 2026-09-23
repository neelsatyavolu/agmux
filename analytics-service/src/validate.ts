const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRINTABLE = /^[\x20-\x7E]+$/;

export const EVENT_NAMES = new Set(["thread_created", "app_mode"]);

export const PROVIDERS = new Set([
  "ClaudeCode",
  "Codex",
  "Droid",
  "Kimi",
  "Pi",
  "OpenCode",
  "MLX",
  "Grok",
  "Cursor",
  "Cline",
  "Gemini",
  "Hermes",
]);

export const INTERACTION_MODES = new Set([
  "pty",
  "sdk",
  "opencode-sdk",
  "mlx",
  "grok-sdk",
  "cursor-sdk",
]);

export const APP_MODES = new Set(["agent", "cowork", "task", "ide"]);

export function isUuidV4(v: unknown): v is string {
  return typeof v === "string" && UUID_V4.test(v);
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max || !PRINTABLE.test(s)) return null;
  return s;
}

export function parseHeartbeat(body: Record<string, unknown>): {
  installId: string;
  appVersion: string;
  osName: string;
  osVersion: string;
  arch: string;
  channel: "release" | "dev";
} {
  const installId = body.install_id ?? body.installId;
  if (!isUuidV4(installId)) {
    throw new Error("install_id must be a UUID v4");
  }
  const appVersion = clip(body.app_version ?? body.appVersion, 32);
  if (!appVersion) throw new Error("app_version is required");
  const osName = clip(body.os_name ?? body.osName, 16) ?? "macos";
  const osVersion = clip(body.os_version ?? body.osVersion, 32) ?? "unknown";
  const arch = clip(body.arch, 16) ?? "unknown";
  const rawChannel = clip(body.channel, 16) ?? "release";
  const channel = rawChannel === "dev" ? "dev" : "release";
  return { installId, appVersion, osName, osVersion, arch, channel };
}

export type EventDims = Record<string, string>;

export function parseEvent(body: Record<string, unknown>): {
  installId: string;
  name: string;
  dims: EventDims;
} {
  const installId = body.install_id ?? body.installId;
  if (!isUuidV4(installId)) {
    throw new Error("install_id must be a UUID v4");
  }
  const name = clip(body.name, 32);
  if (!name || !EVENT_NAMES.has(name)) throw new Error("unknown event");
  const rawProps =
    body.props && typeof body.props === "object" && !Array.isArray(body.props)
      ? (body.props as Record<string, unknown>)
      : {};
  return { installId, name, dims: sanitizeDims(name, rawProps) };
}

/** Keep only allowlisted enum props. Unknown keys/values are dropped. */
export function sanitizeDims(name: string, props: Record<string, unknown>): EventDims {
  const dims: EventDims = {};
  if (name === "thread_created") {
    const provider = clip(props.provider, 32);
    const mode = clip(props.interactionMode ?? props.interaction_mode, 32);
    if (provider && PROVIDERS.has(provider)) dims.provider = provider;
    if (mode && INTERACTION_MODES.has(mode)) dims.interactionMode = mode;
  }
  if (name === "app_mode") {
    const mode = clip(props.mode, 16);
    if (mode && APP_MODES.has(mode)) dims.mode = mode;
  }
  return dims;
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nowIso(d = new Date()): string {
  return d.toISOString();
}
