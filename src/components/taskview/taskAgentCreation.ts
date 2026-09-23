import { useSettingsStore, type AppSettings } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { updateThreadSettings } from "../../lib/commands";
import {
  CURSOR_MODELS, GROK_MODELS, applyGeminiEffort, geminiEffortFromSlug,
  clampCodexEffort, normalizeCodexEffort, supportsGrokEffort, supportsXHighEffort,
  type ClaudeEffort, type InteractionMode, type Provider,
} from "../../lib/types";
import {
  resolveInitialClaudeSdkPermissionMode, resolveInitialCodexPermissionMode,
  resolveInitialOpenCodeBypass,
} from "../../lib/providers/initialPermissions";

export const TASK_GEMINI_MODELS = [
  { slug: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { slug: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
];

/** Defaults shared by the task dialog and quick-add menu. Never use a model
 * from another provider merely because it was the last model selected. */
export function taskAgentDefaultModel(
  provider: Provider,
  mode: InteractionMode,
  settings: AppSettings = useSettingsStore.getState().settings,
): string | null {
  const last = settings.lastUsedModel?.trim();
  if (mode === "pty") return provider === "Grok" ? GROK_MODELS[0].slug : null;
  switch (provider) {
    case "ClaudeCode":
      return last && /^(sonnet|opus|haiku|claude-)/i.test(last) ? last : "sonnet";
    case "Codex":
      // A missing override lets the app server honor its own config.
      return settings.codexModel || (last && /^(gpt|codex|o[134])-/.test(last) ? last : null);
    case "Cursor":
      return last && (settings.defaultProvider === "Cursor" || last.startsWith("composer-"))
        ? last : CURSOR_MODELS[0].slug;
    case "OpenCode":
      return settings.opencodeRecentModels?.find((m) => m.includes("/"))
        || (last?.includes("/") ? last : "anthropic/claude-sonnet-4-5");
    case "Grok":
      return last?.startsWith("grok-") ? last : GROK_MODELS[0].slug;
    case "Gemini":
      return applyGeminiEffort(last?.startsWith("gemini-") ? last : TASK_GEMINI_MODELS[0].slug,
        taskAgentEffort(provider, last || null, settings) || "high");
    default:
      return null;
  }
}

export function taskAgentEffort(provider: Provider, model: string | null, settings: AppSettings): ClaudeEffort | null {
  if (!["ClaudeCode", "Grok", "Gemini"].includes(provider)) return null;
  const saved = settings.lastUsedEffort;
  const effort: ClaudeEffort = ["low", "medium", "high", "xhigh", "max"].includes(saved)
    ? saved as ClaudeEffort : "high";
  if (provider === "Gemini") return geminiEffortFromSlug(model) ?? (effort === "xhigh" || effort === "max" ? "high" : effort);
  if (provider === "Grok" && !supportsGrokEffort(model || GROK_MODELS[0].slug, effort)) return "high";
  if (provider === "ClaudeCode" && effort === "xhigh" && !supportsXHighEffort(model)) return "high";
  return effort;
}

/** Validate local choices before creating a task/thread, and start the same
 * gateway used by agent-mode Local chat. An explicit missing choice must fail. */
export async function prepareTaskLocalModel(preferred: string | null, terminal = false): Promise<string> {
  const { mlxCapability, mlxListModels, mlxGatewayStatus, localModelSlug, resolveLocalModelId } = await import("../../lib/mlx");
  const [cap, models] = await Promise.all([mlxCapability().catch(() => null), mlxListModels()]);
  const resolved = resolveLocalModelId(models, preferred);
  if (!resolved || (cap && !cap.available)) {
    useSettingsStore.getState().openSettings("localModels");
    throw new Error("Set up an installed model in Settings → Local Models before creating a local agent.");
  }
  const slug = localModelSlug(resolved);
  if (preferred && localModelSlug(preferred) !== slug) {
    throw new Error("The selected local model is unavailable. Choose an installed model.");
  }
  await mlxGatewayStatus();
  if (terminal) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("mlx_sync_pi_config");
  }
  return slug;
}

/** Seed the existing session handoff slots before the new task tab mounts. */
export async function configureTaskAgent(threadId: string, provider: Provider, mode: InteractionMode, model: string | null): Promise<void> {
  const ui = useUiStore.getState();
  if (mode === "pty") {
    // Preserve the existing Grok terminal configuration; other CLIs own theirs.
    if (provider === "Grok") ui.setPendingGrokConfig(threadId, { permissionMode: "default", model: model ?? undefined });
    return;
  }
  const settings = useSettingsStore.getState().settings;
  const permission = resolveInitialClaudeSdkPermissionMode();
  const sdkPermission = permission === "full" ? "bypassPermissions" : permission;
  useSettingsStore.getState().updateSettings({
    defaultProvider: provider,
    lastUsedModel: model ?? "",
    ...(provider === "Codex" ? { codexModel: model ?? "" } : {}),
  });
  if (provider === "Codex") {
    ui.setPendingCodexPermissionMode(threadId, resolveInitialCodexPermissionMode());
    ui.setPendingCodexFastMode(threadId, settings.codexFastMode);
    const effort = normalizeCodexEffort(settings.codexEffort);
    if (effort && (settings.codexEffortExplicit || effort !== "medium")) {
      ui.setPendingCodexEffort(threadId, clampCodexEffort(model, effort));
    }
    return;
  }
  if (provider === "OpenCode") {
    ui.setPendingOpencodePermissionMode(threadId, resolveInitialOpenCodeBypass() ? "full-access" : "normal");
    return;
  }
  ui.setPendingSdkPermissionMode(threadId, sdkPermission);
  const effort = taskAgentEffort(provider, model, settings);
  if (effort) await updateThreadSettings(threadId, model, effort, false);
  if (provider === "Grok" || provider === "Gemini") {
    ui.setPendingGrokConfig(threadId, { permissionMode: sdkPermission, model: model ?? undefined, effort: effort ?? undefined });
  }
}
