/**
 * Mirror DraftChatView last-used provider / model / effort / permission to
 * ~/.agmux/remote-draft-prefs.json so the phone new-chat picker seeds the
 * same defaults the desktop draft uses (Claude / Codex / Grok / Gemini / OpenCode / Cursor).
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";

const REMOTE_PROVIDERS = new Set(["ClaudeCode", "Codex", "Grok", "Gemini", "OpenCode", "Cursor"]);
const DEFAULT_REMOTE_CLAUDE = "claude-opus-5[1m]";

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced push of desktop last-used draft defaults to the remote bridge. */
export function syncRemoteDraftPrefs(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const s = useSettingsStore.getState().settings;
    let provider = s.defaultProvider || "ClaudeCode";
    let model = (s.lastUsedModel || "").trim();
    const effort = (s.lastUsedEffort || "").trim() || undefined;

    // Phone draft offers Claude / Codex / Grok / OpenCode / Cursor.
    if (!REMOTE_PROVIDERS.has(provider)) {
      provider = "ClaudeCode";
      // Kimi / MLX / unknown slugs must not ride along as a Claude model.
      model = DEFAULT_REMOTE_CLAUDE;
    }
    if (provider === "Codex" && s.codexModel?.trim()) {
      model = s.codexModel.trim();
    }
    if (!model) {
      model =
        provider === "Codex"
          ? "gpt-5.6-sol"
          : provider === "Grok"
            ? "grok-4.7"
            : provider === "Gemini"
              ? "gemini-3.8-flash-high"
              : provider === "OpenCode"
              ? "anthropic/claude-sonnet-4-5"
              : provider === "Cursor"
                ? "composer-2.5"
                : DEFAULT_REMOTE_CLAUDE;
    }

    const permissionMode =
      provider === "Codex"
        ? s.codexPermissionMode || "default"
        : s.sdkPermissionMode || "default";

    invoke<void>("remote_sync_draft_prefs", {
      provider,
      model,
      reasoningEffort: effort,
      permissionMode,
    }).catch(() => {
      /* remote optional */
    });
  }, 400);
}
