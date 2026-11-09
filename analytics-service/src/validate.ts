const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRINTABLE = /^[\x20-\x7E]+$/;

export const EVENT_NAMES = new Set(["thread_created", "app_mode"]);

/** Apps that report here. A body without `app` is agmux (clients from before the field). */
export const APPS = new Set(["agmux", "agterm"]);
export type App = "agmux" | "agterm";

/** agterm (the macOS terminal for coding agents) events. Names never overlap agmux's. */
export const AGTERM_EVENT_NAMES = new Set(["agent_started", "feature_used"]);

export const EVENT_NAMES_BY_APP: Record<App, Set<string>> = {
  agmux: EVENT_NAMES,
  agterm: AGTERM_EVENT_NAMES,
};

/** agterm's AgentKind ids (agterm Sources/AgTermCore/AgentKind.swift). */
export const AGTERM_AGENTS = new Set([
  "claude", "codex", "grok", "agl", "gemini", "agy", "cursor-agent", "opencode", "kimi", "aider",
  "amp", "qwen", "crush", "copilot", "droid", "kilo", "cline", "goose", "auggie", "qodo", "kiro",
  "continue", "pi",
]);

/** agterm's AnalyticsFeature values (agterm Sources/AgTermCore/Analytics/AnalyticsEvent.swift). */
export const AGTERM_FEATURES = new Set([
  "split", "command_bar", "cloud_tab", "phone_paired", "update_installed",
]);

/** Most events one /v1/events request may carry. */
export const MAX_BATCH = 100;

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

export function parseApp(body: Record<string, unknown>): App {
  if (body.app === undefined || body.app === null) return "agmux";
  const app = clip(body.app, 16);
  if (!app || !APPS.has(app)) throw new Error("unknown app");
  return app as App;
}

export function parseHeartbeat(body: Record<string, unknown>): {
  installId: string;
  app: App;
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
  return { installId, app: parseApp(body), appVersion, osName, osVersion, arch, channel };
}

export type EventDims = Record<string, string>;

export function parseEvent(body: Record<string, unknown>): {
  installId: string;
  app: App;
  name: string;
  dims: EventDims;
} {
  const installId = body.install_id ?? body.installId;
  if (!isUuidV4(installId)) {
    throw new Error("install_id must be a UUID v4");
  }
  const app = parseApp(body);
  const event = parseOne(app, body);
  if (!event) throw new Error("unknown event");
  return { installId, app, ...event };
}

/**
 * `{install_id, app, events: [{name, props}]}`. Entries with unknown names are dropped, so a
 * newer client's extra events don't cost the rest of its batch.
 */
export function parseEventBatch(body: Record<string, unknown>): {
  installId: string;
  app: App;
  events: { name: string; dims: EventDims }[];
} {
  const installId = body.install_id ?? body.installId;
  if (!isUuidV4(installId)) {
    throw new Error("install_id must be a UUID v4");
  }
  const app = parseApp(body);
  if (!Array.isArray(body.events) || body.events.length === 0) throw new Error("events is required");
  if (body.events.length > MAX_BATCH) throw new Error("too many events");
  const events = body.events.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const event = parseOne(app, raw as Record<string, unknown>);
    return event ? [event] : [];
  });
  return { installId, app, events };
}

function parseOne(app: App, body: Record<string, unknown>): { name: string; dims: EventDims } | null {
  const name = clip(body.name, 32);
  if (!name || !EVENT_NAMES_BY_APP[app].has(name)) return null;
  const rawProps =
    body.props && typeof body.props === "object" && !Array.isArray(body.props)
      ? (body.props as Record<string, unknown>)
      : {};
  return { name, dims: sanitizeDims(name, rawProps) };
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
  if (name === "agent_started") {
    const agent = clip(props.agent, 32);
    if (agent && AGTERM_AGENTS.has(agent)) dims.agent = agent;
  }
  if (name === "feature_used") {
    const feature = clip(props.feature, 32);
    if (feature && AGTERM_FEATURES.has(feature)) dims.feature = feature;
  }
  return dims;
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nowIso(d = new Date()): string {
  return d.toISOString();
}
