/**
 * Quick Open — what the sidebar compose (pencil) button and ⌘N create.
 * Settings stores a single action; both entry points call `runQuickOpenAction`.
 */

import type { Provider } from "./types";
import { defaultThreadName } from "./types";

export type QuickOpenAction =
  | "chat"
  | "claude-chat"
  | "claude-terminal"
  | "codex-chat"
  | "codex-terminal"
  | "grok-chat"
  | "grok-terminal"
  | "opencode-chat"
  | "opencode-terminal"
  | "kimi-terminal"
  | "pi-terminal"
  | "cline-terminal"
  | "gemini-chat"
  | "gemini-terminal"
  | "hermes-terminal"
  | "local-terminal"
  | "mlx-chat"
  | "cursor-chat"
  | "shell-terminal";

export const QUICK_OPEN_OPTIONS: readonly { value: QuickOpenAction; label: string }[] = [
  { value: "chat", label: "Chat (default provider)" },
  { value: "claude-chat", label: "Claude Chat" },
  { value: "claude-terminal", label: "Claude Terminal" },
  { value: "codex-chat", label: "Codex Chat" },
  { value: "codex-terminal", label: "Codex Terminal" },
  { value: "grok-chat", label: "Grok Chat" },
  { value: "grok-terminal", label: "Grok Terminal" },
  { value: "opencode-chat", label: "OpenCode Chat" },
  { value: "opencode-terminal", label: "OpenCode Terminal" },
  { value: "kimi-terminal", label: "Kimi Terminal" },
  { value: "pi-terminal", label: "Pi Terminal" },
  { value: "cline-terminal", label: "Cline Terminal" },
  { value: "gemini-chat", label: "Gemini Chat" },
  { value: "gemini-terminal", label: "Gemini Terminal" },
  { value: "hermes-terminal", label: "Hermes Terminal" },
  { value: "local-terminal", label: "Local Terminal" },
  { value: "mlx-chat", label: "MLX Chat" },
  { value: "cursor-chat", label: "Cursor Chat" },
  { value: "shell-terminal", label: "Shell" },
] as const;

const VALID_ACTIONS = new Set<string>(QUICK_OPEN_OPTIONS.map((o) => o.value));

export function isQuickOpenAction(value: unknown): value is QuickOpenAction {
  return typeof value === "string" && VALID_ACTIONS.has(value);
}

export function quickOpenLabel(action: QuickOpenAction): string {
  return QUICK_OPEN_OPTIONS.find((o) => o.value === action)?.label ?? "Chat (default provider)";
}

/** Map a chat-style action to the draft-chat provider. */
export function chatProviderForAction(
  action: QuickOpenAction,
  defaultProvider: Provider,
): Provider | null {
  switch (action) {
    case "chat":
      return defaultProvider;
    case "claude-chat":
      return "ClaudeCode";
    case "codex-chat":
      return "Codex";
    case "grok-chat":
      return "Grok";
    case "opencode-chat":
      return "OpenCode";
    case "mlx-chat":
      return "MLX";
    case "cursor-chat":
      return "Cursor";
    case "gemini-chat":
      return "Gemini";
    default:
      return null;
  }
}

export interface QuickOpenProject {
  id: string;
  repo_path: string;
}

/**
 * Run the configured quick-open action for a project.
 * Used by the sidebar pencil button and global ⌘N.
 */
export async function runQuickOpenAction(
  project: QuickOpenProject,
  action: QuickOpenAction,
  defaultProvider: Provider,
): Promise<void> {
  const chatProvider = chatProviderForAction(action, defaultProvider);
  if (chatProvider) {
    const { useUiStore } = await import("../stores/uiStore");
    useUiStore.getState().setDraftChat({
      projectId: project.id,
      repoPath: project.repo_path,
      provider: chatProvider,
      model: null,
    });
    return;
  }

  if (action === "shell-terminal") {
    const { useUiStore } = await import("../stores/uiStore");
    const { useTerminalStore } = await import("../stores/terminalStore");
    const ui = useUiStore.getState();
    const session = useTerminalStore.getState().createSession(project.repo_path);
    ui.selectTerminalSession(session.id, project.repo_path, session.label);
    const { spawnShell } = await import("./commands");
    spawnShell(session.id, project.repo_path).catch(console.error);
    return;
  }

  if (action === "claude-terminal") {
    const { useUiStore } = await import("../stores/uiStore");
    const { useSettingsStore } = await import("../stores/settingsStore");
    const ui = useUiStore.getState();
    const { claudeAutoMode: autoMode } = useSettingsStore.getState().settings;
    const { spawnClaudeNew, listClaudeSessions } = await import("./commands");
    const { currentSpawnPreferences } = await import("./providers/initialPermissions");
    let existingIds: string[] = [];
    try {
      const existing = await listClaudeSessions(project.repo_path);
      existingIds = existing.map((s) => s.id);
    } catch { /* empty snapshot on error */ }
    const sessionId = await spawnClaudeNew(project.repo_path, {
      ...currentSpawnPreferences(),
      enableAutoMode: autoMode,
    });
    ui.setPreSpawnSessionIds(sessionId, existingIds);
    ui.selectClaudeSession(sessionId, project.repo_path, true);
    const { addCreatedClaudeSession } = await import("./createdSessions");
    addCreatedClaudeSession(project.id, sessionId);
    return;
  }

  if (action === "codex-terminal") {
    const { useUiStore } = await import("../stores/uiStore");
    const ui = useUiStore.getState();
    const { codexEnsureServer, codexStartThread, codexAccountRead } = await import("./commands");
    await codexEnsureServer(project.repo_path);
    const account = await codexAccountRead(project.repo_path);
    if (!account.authenticated) return;
    const result = (await codexStartThread(project.repo_path)) as { thread?: { id?: string } };
    const threadId = result?.thread?.id;
    if (!threadId) return;
    const { setCodexSessionMode } = await import("./codexSessionMode");
    setCodexSessionMode(threadId, "terminal");
    ui.registerOptimisticCodexSession(threadId, project.repo_path);
    ui.selectCodexSession(threadId, project.repo_path);
    return;
  }

  const terminalProviders: Partial<Record<QuickOpenAction, Provider>> = {
    "grok-terminal": "Grok",
    "opencode-terminal": "OpenCode",
    "kimi-terminal": "Kimi",
    "pi-terminal": "Pi",
    "cline-terminal": "Cline",
    "gemini-terminal": "Gemini",
    "hermes-terminal": "Hermes",
    "local-terminal": "Pi",
  };
  const terminalProvider = terminalProviders[action];

  if (!terminalProvider) return;

  const { useUiStore } = await import("../stores/uiStore");
  const { useThreadStore } = await import("../stores/threadStore");
  const ui = useUiStore.getState();
  const { addThread, startThread, updateThreadStatus } = useThreadStore.getState();

  let model: string | undefined;
  if (action === "local-terminal") {
    const { useSettingsStore } = await import("../stores/settingsStore");
    const { mlxCapability, mlxGatewayStatus, mlxListModels, resolveLocalModelId, localModelSlug } = await import("./mlx");
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      if (!(await mlxCapability()).available) {
        useSettingsStore.getState().openSettings("localModels");
        return;
      }
      await mlxGatewayStatus();
      await invoke("mlx_sync_pi_config");
      const resolved = resolveLocalModelId(
        await mlxListModels(),
        useSettingsStore.getState().settings.lastUsedModel,
      );
      if (!resolved) {
        useSettingsStore.getState().openSettings("localModels");
        return;
      }
      model = localModelSlug(resolved);
    } catch (err) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(String(err), { title: "Could not start Local Terminal", kind: "error" });
      return;
    }
  }

  let existingIds: string[] = [];
  if (terminalProvider === "Grok") {
    try {
      const { listGrokSessions } = await import("./commands");
      const existing = await listGrokSessions(project.repo_path);
      existingIds = existing.map((s) => s.id);
    } catch { /* empty snapshot on error */ }
  }

  const thread = await addThread({
    projectId: project.id,
    name: action === "local-terminal" ? "New Local Thread" : defaultThreadName(terminalProvider),
    provider: terminalProvider,
    ...(model ? { model } : {}),
    workMode: "DirectRepo",
  });

  if (terminalProvider === "Grok" && existingIds.length > 0) {
    ui.setPreSpawnSessionIds(thread.id, existingIds);
  }

  updateThreadStatus(thread.id, "Running");
  ui.selectThread(thread.id, thread.name);
  startThread(thread.id, false).catch((err) => {
    console.error(`Failed to start ${terminalProvider} thread:`, err);
    updateThreadStatus(thread.id, "Error");
  });
}
