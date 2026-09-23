/**
 * Match Desktop Cowork / ChatGPT Work sessions onto agmux projects
 * and open them as resumable chats.
 */

import type { Project, Thread } from "./types";
import type { ClaudeDesktopCoworkSession, CodexWorkDesktopSession } from "./commands";
import {
  bindThreadSdkSessionId,
  listClaudeDesktopCoworkSessions,
  listCodexWorkDesktopSessions,
} from "./commands";
import { useProjectStore } from "../stores/projectStore";
import { useThreadStore } from "../stores/threadStore";
import { useUiStore } from "../stores/uiStore";
import { setCodexWorkProfile } from "./chatgptWorkProfile";
import { setCodexSessionMode } from "./codexSessionMode";
import { sessionBelongsToFolder } from "./coworkFolders";

const desktopFoldersByCliId = new Map<string, string[]>();
let cachedLists: { claude: ClaudeDesktopCoworkSession[]; codex: CodexWorkDesktopSession[] } | null = null;
let listsInflight: Promise<{ claude: ClaudeDesktopCoworkSession[]; codex: CodexWorkDesktopSession[] }> | null = null;

export function desktopFoldersForCli(cliSessionId: string | null | undefined): string[] {
  if (!cliSessionId) return [];
  return desktopFoldersByCliId.get(cliSessionId) ?? [];
}

export function folderMatchesProject(folder: string, project: Project): boolean {
  return sessionBelongsToFolder(folder, project.repo_path);
}

export function projectForClaudeDesktopSession(
  session: ClaudeDesktopCoworkSession,
  projects: Project[],
): Project | null {
  let best: Project | null = null;
  let bestLen = -1;
  for (const folder of session.folders) {
    for (const p of projects) {
      if (!sessionBelongsToFolder(folder, p.repo_path)) continue;
      if (p.repo_path.length > bestLen) {
        best = p;
        bestLen = p.repo_path.length;
      }
    }
  }
  return best;
}

export function projectForCodexWorkSession(
  session: CodexWorkDesktopSession,
  projects: Project[],
): Project | null {
  if (!session.cwd) return null;
  let best: Project | null = null;
  let bestLen = -1;
  for (const p of projects) {
    if (!sessionBelongsToFolder(session.cwd, p.repo_path)) continue;
    if (p.repo_path.length > bestLen) {
      best = p;
      bestLen = p.repo_path.length;
    }
  }
  return best;
}

export async function loadDesktopCoworkLists(): Promise<{
  claude: ClaudeDesktopCoworkSession[];
  codex: CodexWorkDesktopSession[];
}> {
  const [claude, codex] = await Promise.all([
    listClaudeDesktopCoworkSessions().catch(() => [] as ClaudeDesktopCoworkSession[]),
    listCodexWorkDesktopSessions().catch(() => [] as CodexWorkDesktopSession[]),
  ]);
  desktopFoldersByCliId.clear();
  for (const s of claude) {
    if (s.cliSessionId) desktopFoldersByCliId.set(s.cliSessionId, s.folders ?? []);
  }
  for (const s of codex) {
    setCodexWorkProfile(s.id);
    setCodexSessionMode(s.id, "chat");
  }
  return { claude, codex };
}

/** Shared scan so the briefcase overlay and sidebar share one load. */
export function prepareCoworkLists(opts?: { refresh?: boolean }): Promise<{
  claude: ClaudeDesktopCoworkSession[];
  codex: CodexWorkDesktopSession[];
}> {
  if (opts?.refresh) cachedLists = null;
  if (cachedLists) return Promise.resolve(cachedLists);
  if (listsInflight) return listsInflight;
  listsInflight = loadDesktopCoworkLists()
    .then((lists) => {
      cachedLists = lists;
      return lists;
    })
    .finally(() => {
      listsInflight = null;
    });
  return listsInflight;
}

export function clearCoworkListCache(): void {
  cachedLists = null;
}

function claimedClaudeIds(): Set<string> {
  const claimed = new Set<string>();
  for (const list of Object.values(useThreadStore.getState().threads)) {
    for (const t of list) {
      if (t.sdk_session_id) claimed.add(t.sdk_session_id);
      claimed.add(t.id);
    }
  }
  return claimed;
}

export function unclaimedClaudeDesktopForProject(
  sessions: ClaudeDesktopCoworkSession[],
  project: Project,
  allProjects: Project[],
  unmatchedOnly: boolean,
): ClaudeDesktopCoworkSession[] {
  const claimed = claimedClaudeIds();
  return sessions.filter((s) => {
    if (claimed.has(s.cliSessionId) || claimed.has(s.id)) return false;
    const match = projectForClaudeDesktopSession(s, allProjects);
    if (unmatchedOnly) return match == null;
    return match?.id === project.id;
  });
}

export function isClaudeDesktopCatchallProject(project: Project): boolean {
  return /\/local-agent-mode-sessions\/?$/.test(project.repo_path);
}

export function claudeDesktopSessionsRoot(
  sessions: ClaudeDesktopCoworkSession[],
): string | null {
  for (const s of sessions) {
    const dir = s.sessionDir || "";
    const marker = "/local-agent-mode-sessions";
    const i = dir.indexOf(marker);
    if (i >= 0) return dir.slice(0, i + marker.length);
  }
  return null;
}

export function desktopClaudeForProject(
  sessions: ClaudeDesktopCoworkSession[],
  project: Project,
  allProjects: Project[],
): ClaudeDesktopCoworkSession[] {
  return unclaimedClaudeDesktopForProject(sessions, project, allProjects, false);
}

export function desktopCodexForProject(
  sessions: CodexWorkDesktopSession[],
  project: Project,
  allProjects: Project[] = [project],
): CodexWorkDesktopSession[] {
  return sessions.filter((s) => projectForCodexWorkSession(s, allProjects)?.id === project.id);
}

/** Prefer Desktop sandbox `outputs` so CLAUDE_CONFIG_DIR resolves. */
export function desktopSessionCwd(session: ClaudeDesktopCoworkSession, project: Project): string {
  const cwd = (session.cwd || "").replace(/\/+$/, "");
  if (cwd) return cwd;
  const dir = (session.sessionDir || "").replace(/\/+$/, "");
  if (dir) return `${dir}/outputs`;
  const folder = (session.folders[0] || project.repo_path).replace(/\/+$/, "");
  return folder || project.repo_path;
}

export async function ensureClaudeDesktopCatchall(
  sessions: ClaudeDesktopCoworkSession[],
): Promise<void> {
  const unmatched = sessions.filter(
    (s) => projectForClaudeDesktopSession(s, useProjectStore.getState().projects) == null,
  );
  if (unmatched.length === 0) return;
  const root = claudeDesktopSessionsRoot(sessions);
  if (!root) return;
  const exact = useProjectStore.getState().projects.find(
    (p) => p.repo_path.replace(/\/+$/, "") === root,
  );
  if (exact) return;
  try {
    await useProjectStore.getState().addProject("Claude Desktop", root);
  } catch (err) {
    console.error("Failed to add Claude Desktop project:", err);
  }
}

export async function ensureProjectForPath(repoPath: string, name?: string): Promise<Project | null> {
  const trimmed = repoPath.replace(/\/+$/, "");
  if (!trimmed) return null;
  const existing = useProjectStore.getState().projects.find((p) =>
    folderMatchesProject(trimmed, p),
  );
  if (existing) return existing;
  const label = name || trimmed.split("/").filter(Boolean).pop() || "Desktop";
  try {
    return await useProjectStore.getState().addProject(label, trimmed);
  } catch (err) {
    console.error("Failed to add project for desktop cowork cwd:", err);
    return null;
  }
}

export async function openClaudeDesktopCowork(
  session: ClaudeDesktopCoworkSession,
  project: Project,
): Promise<Thread> {
  const cwd = desktopSessionCwd(session, project);
  const existing = (useThreadStore.getState().threads[project.id] ?? []).find(
    (t) => t.sdk_session_id === session.cliSessionId || t.id === session.cliSessionId,
  );
  if (existing) {
    if (existing.work_dir !== cwd) {
      await bindThreadSdkSessionId(existing.id, session.cliSessionId, cwd);
      useThreadStore.getState().patchThreadWorkDir(existing.id, cwd);
    }
    useUiStore.getState().selectClaudeSession(existing.id, cwd, false, existing.name);
    return { ...existing, work_dir: cwd };
  }
  const thread = await useThreadStore.getState().addThread({
    projectId: project.id,
    name: session.title || "Cowork",
    provider: "ClaudeCode",
    model: session.model ?? null,
    interactionMode: "sdk",
    agentProfile: "cowork",
  });
  await bindThreadSdkSessionId(thread.id, session.cliSessionId, cwd);
  useThreadStore.getState().setThreadProviderSessionId(thread.id, session.cliSessionId);
  useThreadStore.getState().patchThreadWorkDir(thread.id, cwd);
  useUiStore.getState().selectClaudeSession(thread.id, cwd, false, session.title);
  return { ...thread, work_dir: cwd };
}

export async function openCodexWorkDesktop(
  session: CodexWorkDesktopSession,
): Promise<void> {
  setCodexWorkProfile(session.id);
  setCodexSessionMode(session.id, "chat");
  useUiStore.getState().registerOptimisticCodexSession(session.id, session.cwd);
  useUiStore.getState().selectCodexSession(session.id, session.cwd, session.title);
}
