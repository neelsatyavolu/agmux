import { useSettingsStore } from "../../stores/settingsStore";

/** Resolve the effective initial bypass / full-permissions state for a new
 *  session, given the global master toggle and per-provider defaults.
 *
 *  When `defaultBypassPermissions` is on, every new session opts in regardless
 *  of provider-specific settings — that's the "I trust this machine" master
 *  switch. Otherwise we fall back to per-provider defaults stored in
 *  AppSettings (claudeSkipPermissions, sdkPermissionMode, codexPermissionMode). */

export function resolveInitialClaudePtyBypass(): boolean {
  const { defaultBypassPermissions, claudeSkipPermissions } =
    useSettingsStore.getState().settings;
  return defaultBypassPermissions || !!claudeSkipPermissions;
}

export function resolveInitialClaudeSdkPermissionMode(): "default" | "full" | "auto" {
  const { defaultBypassPermissions, sdkPermissionMode } =
    useSettingsStore.getState().settings;
  if (defaultBypassPermissions) return "full";
  return sdkPermissionMode ?? "default";
}

/** Codex chat permission mode. Maps to turn/start accessMode:
 *  default → supervised (user reviews approvals)
 *  auto    → auto_review (guardian subagent reviews)
 *  full    → full-access (never ask + dangerFullAccess) */
export type CodexPermissionMode = "default" | "full" | "auto";

export function resolveInitialCodexPermissionMode(): CodexPermissionMode {
  const { defaultBypassPermissions, codexPermissionMode } =
    useSettingsStore.getState().settings;
  if (defaultBypassPermissions) return "full";
  return codexPermissionMode ?? "default";
}

/** Wire value for `codex_send_message` accessMode from a UI permission mode. */
export function codexAccessModeForPermission(
  mode: CodexPermissionMode,
): "full-access" | "auto" | null {
  if (mode === "full") return "full-access";
  if (mode === "auto") return "auto";
  return null;
}

/** OpenCode SDK permission mode is currently expressed as boolean bypass on
 *  the input bar; expose the resolved boolean so its DraftChatView default
 *  honors the master toggle. */
export function resolveInitialOpenCodeBypass(): boolean {
  return useSettingsStore.getState().settings.defaultBypassPermissions;
}

/** MLX agent loop's bypass — mutating actions auto-approve when this is on. */
export function resolveInitialMlxBypass(): boolean {
  return useSettingsStore.getState().settings.defaultBypassPermissions;
}

/** Whether new Claude PTY sessions should suppress the CLI's built-in
 *  statusline plugin (via `--settings statusLine` injection). True when the
 *  user has opted into agmux rendering the same info on its own topbar Row 2;
 *  false (default) leaves the user's globally-configured Claude statusline
 *  running normally inside the PTY. */
export function resolveSuppressStatusLine(): boolean {
  return useSettingsStore.getState().settings.moveStatusLineToTopBar ?? false;
}

/** Spawn-time settings bundle. Carries every flag the Rust spawn commands
 *  need at session start, so adding a new flag means adding one field here
 *  and one read in Rust — not threading a new positional argument through
 *  every call site. All fields are optional; Rust defaults `None`/`false`. */
export interface SpawnPreferences {
  /** Pass `--dangerously-skip-permissions` to Claude PTY / set Codex
   *  accessMode to full / equivalent on other providers. */
  dangerouslySkipPermissions?: boolean;
  /** Pass `--permission-mode auto` to Claude Code (available to everyone). */
  enableAutoMode?: boolean;
  /** Inject `--settings statusLine: {command: ""}` to suppress the user's
   *  globally-configured Claude statusline plugin for this subprocess. */
  suppressStatusLine?: boolean;
}

/** Build a SpawnPreferences object from the current Zustand settings.
 *  Callers pass this directly to spawn commands; per-call overrides are an
 *  object spread (e.g. `{ ...currentSpawnPreferences(), enableAutoMode: false }`). */
export function currentSpawnPreferences(): SpawnPreferences {
  return {
    dangerouslySkipPermissions: resolveInitialClaudePtyBypass(),
    enableAutoMode: useSettingsStore.getState().settings.claudeAutoMode,
    suppressStatusLine: resolveSuppressStatusLine(),
  };
}
