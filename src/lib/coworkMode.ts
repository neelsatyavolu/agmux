/**
 * Cowork app mode: same agent layout, chats only.
 * Claude Cowork, ChatGPT Work (Codex + work profile), Grok Cowork.
 */

import { isCoworkProfile } from "./claudeCoworkProfile";
import { isCodexWorkProfile } from "./chatgptWorkProfile";
import { isGrokCoworkThread } from "./grokCoworkProfile";
import { getCodexSessionMode } from "./codexSessionMode";
import type { Project, Provider } from "./types";
import { useUiStore } from "../stores/uiStore";
import { useThreadStore } from "../stores/threadStore";
import { useProjectStore } from "../stores/projectStore";
import { filterProjectsForCowork, getCoworkFolders, sessionBelongsToFolder } from "./coworkFolders";

export const COWORK_DRAFT_PROVIDERS = ["ClaudeCode", "Codex", "Grok"] as const satisfies readonly Provider[];

export type CoworkDraftProvider = (typeof COWORK_DRAFT_PROVIDERS)[number];

export function isCoworkAppMode(mode: string | null | undefined): boolean {
  return mode === "cowork";
}

export function isCoworkDraftProvider(provider: string | null | undefined): provider is CoworkDraftProvider {
  return provider === "ClaudeCode" || provider === "Codex" || provider === "Grok";
}

/** Prefer last-used Claude/Codex/Grok; otherwise Claude Cowork. */
export function coworkDraftProvider(preferred: Provider | null | undefined): CoworkDraftProvider {
  if (preferred === "Codex" || preferred === "Grok") return preferred;
  return "ClaudeCode";
}

export function isClaudeCoworkThread(thread: {
  provider?: string | null;
  agent_profile?: string | null;
  interaction_mode?: string | null;
} | null | undefined): boolean {
  if (!thread) return false;
  if (thread.provider !== "ClaudeCode") return false;
  if (thread.interaction_mode && thread.interaction_mode !== "sdk") return false;
  return isCoworkProfile(thread.agent_profile);
}

/** Codex Work = chat session marked with the Work profile (not a terminal). */
export function isCodexWorkSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  if (!isCodexWorkProfile(sessionId)) return false;
  const mode = getCodexSessionMode(sessionId);
  return mode !== "terminal";
}

export type CoworkSidebarKind = "thread" | "codex" | "claude" | "kimi" | "grok" | "other";

export function isCoworkSidebarItem(item: {
  kind: CoworkSidebarKind;
  id?: string | null;
  provider?: string | null;
  agentProfile?: string | null;
  interactionMode?: string | null;
}): boolean {
  if (item.kind === "thread") {
    const thread = {
      provider: item.provider,
      agent_profile: item.agentProfile,
      interaction_mode: item.interactionMode,
    };
    return isClaudeCoworkThread(thread) || isGrokCoworkThread(thread);
  }
  if (item.kind === "codex") {
    return isCodexWorkSession(item.id);
  }
  return false;
}

export function intersectCoworkProviders(
  allowed: readonly Provider[] | null | undefined,
): Provider[] {
  if (!allowed) return [...COWORK_DRAFT_PROVIDERS];
  return COWORK_DRAFT_PROVIDERS.filter((p) => allowed.includes(p));
}

function deselectNonCoworkSelection(): void {
  const ui = useUiStore.getState();
  if (ui.draftChat) return;
  if (ui.selectedCodexSessionId && isCodexWorkSession(ui.selectedCodexSessionId)) return;
  const id = ui.selectedThreadId ?? ui.selectedClaudeSessionId;
  if (id) {
    for (const list of Object.values(useThreadStore.getState().threads)) {
      const t = list.find((th) => th.id === id);
      if (t && (isClaudeCoworkThread(t) || isGrokCoworkThread(t))) return;
    }
  }
  ui.selectThread(null);
}

/** Enter/leave cowork mode. Leaving returns to agent. Entering deselects coding threads. */
export function setCoworkAppMode(on: boolean): void {
  const ui = useUiStore.getState();
  if (!on) {
    ui.setCoworkLoading(false);
    void import("./desktopCowork").then((m) => m.clearCoworkListCache());
    if (ui.appMode === "cowork") ui.setAppMode("agent");
    return;
  }
  ui.setCoworkLoading(true);
  ui.setAppMode("cowork");
  deselectNonCoworkSelection();
}

/** First matching Cowork folder project for ⌘N / palette / Home. */
export function resolveCoworkDraftProject(): Project | null {
  const list = getCoworkFolders();
  if (list.length === 0) return null;
  const projects = useProjectStore.getState().projects;
  const cowork = filterProjectsForCowork(projects, list);
  if (cowork.length === 0) return null;
  const ui = useUiStore.getState();
  if (ui.selectedProjectId) {
    const hit = cowork.find((p) => p.id === ui.selectedProjectId);
    if (hit) return hit;
  }
  const cwd =
    ui.selectedClaudeSessionCwd ||
    ui.selectedCodexSessionCwd ||
    (ui.selectedThreadId ? ui.sessionCwdMap[ui.selectedThreadId] : null);
  if (cwd) {
    let best: Project | null = null;
    let bestLen = -1;
    for (const p of cowork) {
      if (!sessionBelongsToFolder(cwd, p.repo_path)) continue;
      if (p.repo_path.length > bestLen) {
        best = p;
        bestLen = p.repo_path.length;
      }
    }
    if (best) return best;
  }
  return cowork[0];
}

export function toggleCoworkAppMode(): void {
  const ui = useUiStore.getState();
  // Leave always works — even while the opening overlay is up.
  if (ui.appMode === "cowork") {
    setCoworkAppMode(false);
    return;
  }
  // A second enter during load used to toggle straight back to agent.
  if (ui.coworkLoading) return;
  setCoworkAppMode(true);
}
