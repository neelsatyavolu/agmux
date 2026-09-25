import { act, cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ProjectGroup } from "../ProjectGroup";
import type { CodexThread } from "../CodexSessionsList";
import { useThreadDiffUpdates } from "../../../hooks/useThreadDiffUpdates";
import { useUiStore } from "../../../stores/uiStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useShellDiffStore, type ShellDiffStats } from "../../../stores/shellDiffStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useSessionNameStore } from "../../../stores/sessionNameStore";
import { resetAllStores } from "../../../test-helpers/resetStores";
import { setCodexSessionMode } from "../../../lib/codexSessionMode";
import type { Project } from "../../../lib/types";

const project: Project = {
  id: "diff-project",
  name: "Diff pipeline",
  repo_path: "/tmp/codex-diff-pipeline",
  conventions: "[]",
  created_at: "2026-09-08T00:00:00Z",
};
const backgroundId = "native-background";
const selectedId = "native-selected";
const backendPayloadPath = process.env.AGMUX_CODEX_DIFF_PAYLOAD;
const shellHookPayloadPath = process.env.AGMUX_SHELL_HOOK_PAYLOAD;
const recoveryPayloadPath = process.env.AGMUX_SHELL_RECOVERY_PAYLOAD;
const paRecoveryPayloadPath = process.env.AGMUX_PA_RECOVERY_PAYLOAD;
const mcpStatusRecoveryPayloadPath = process.env.AGMUX_MCP_STATUS_RECOVERY_PAYLOAD;
const transferOrderRecoveryPayloadPath = process.env.AGMUX_TRANSFER_ORDER_RECOVERY_PAYLOAD;
const lifecyclePayloadPath = process.env.AGMUX_LIFECYCLE_PAYLOAD;
const mixedCapturePath = process.env.AGMUX_MIXED_CODEX_CAPTURE;
const codexThreads: CodexThread[] = [backgroundId, selectedId].map((id) => ({
  id,
  cwd: project.repo_path,
  preview: id === backgroundId ? "Background edits" : "Selected conversation",
  createdAt: project.created_at,
  updatedAt: project.created_at,
  status: { type: "idle" },
}));
const eventNames = ["thread-diff-updated", "codex-session-diff-updated", "shell-diff-updated"];
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();
const pendingListeners = new Map<string, () => void>();
let delayListeners = false;

// Same ownership as App: the global hook lives above the sidebar, with no
// CodexSessionView mounted. Only invoke/listen transport is mocked.
function AppSidebar({ threads = codexThreads }: { threads?: CodexThread[] }) {
  useThreadDiffUpdates();
  return <ProjectGroup project={project} codexThreads={threads}
    claudeSessions={[]} kimiSessions={[]} piSessions={[]} grokSessions={[]} />;
}

function emit(name: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(name) ?? []) handler(payload);
  });
}

function nativeTotals(sessionId: string, linesAdded: number, linesRemoved: number, filesChanged = 4) {
  emit("codex-session-diff-updated", { sessionId, linesAdded, linesRemoved, filesChanged });
}

function row(id: string) {
  const title = id === selectedId ? "Selected conversation" : "Background edits";
  const button = screen.getByRole("button", { name: new RegExp(title) });
  expect(button.getAttribute("data-session-nav")).toBe(id);
  expect(button.getAttribute("data-session-kind")).toBe("codex");
  return button;
}

function expectBadge(id: string, added: number, removed: number, title = "4 files changed") {
  const queries = within(row(id));
  const badge = queries.getByTitle(title);
  expect(badge.textContent).toBe(`+${added} −${removed}`);
  expect(queries.getAllByText(`+${added}`)).toHaveLength(1);
  expect(queries.getAllByText(`−${removed}`)).toHaveLength(1);
  // Check DOM visibility through the actual parent chain (including motion).
  for (let element: HTMLElement | null = badge; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    expect(element.hidden).toBe(false);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toBe("hidden");
    expect(style.opacity).not.toBe("0");
  }
}

async function mountSidebar() {
  const view = render(<AppSidebar />);
  await act(async () => {});
  for (const name of eventNames) {
    expect(vi.mocked(listen).mock.calls.filter(([event]) => event === name)).toHaveLength(1);
  }
  return view;
}

function deferShellSnapshot() {
  let resolveSnapshot!: (rows: ShellDiffStats[]) => void;
  const snapshot = new Promise<ShellDiffStats[]>((resolve) => { resolveSnapshot = resolve; });
  const defaultInvoke = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args, options) => command === "list_shell_diff_stats"
    ? snapshot : defaultInvoke(command, args, options));
  return resolveSnapshot;
}

beforeEach(() => {
  localStorage.clear();
  resetAllStores();
  useShellDiffStore.setState({ rows: {} });
  useProjectStore.setState({ projects: [project] });
  useSessionNameStore.setState({ names: {
    [backgroundId]: "Background edits", [selectedId]: "Selected conversation",
  } });
  useUiStore.setState({
    selectedCodexSessionId: selectedId,
    selectedCodexSessionCwd: project.repo_path,
    optimisticCodexSessionIds: {},
  });
  useSettingsStore.setState((state) => ({ settings: {
    ...state.settings, defaultThreadsVisible: 5, projectThreadsVisible: {}, projectShowOnlyRunning: {},
  } }));
  handlers.clear();
  unlisteners.clear();
  pendingListeners.clear();
  delayListeners = false;
  vi.mocked(invoke).mockReset().mockImplementation(async (command) => {
    if (command === "check_is_git_repo") return false;
    if (command === "mlx_capability") return { supported: false };
    return [];
  });
  vi.mocked(listen).mockReset().mockImplementation((name, callback) => {
    const handler: Handler = (payload) => callback({ event: name, id: 0, payload });
    const listeners = handlers.get(name) ?? new Set<Handler>();
    handlers.set(name, listeners);
    const unlisten = vi.fn(() => { listeners.delete(handler); });
    unlisteners.set(name, unlisten);
    const register = () => { listeners.add(handler); return unlisten; };
    if (!delayListeners) return Promise.resolve(register());
    return new Promise((resolve) => { pendingListeners.set(name, () => resolve(register())); });
  });
});

afterEach(async () => {
  cleanup();
  // The shared shell subscription releases in a microtask.
  await act(async () => {});
  useShellDiffStore.setState({ rows: {} });
  resetAllStores();
  localStorage.clear();
});

describe("Codex native event → real stores → ProjectGroup → ShellDiffBadge", () => {
  it.skipIf(!mixedCapturePath).each(["terminal", "chat"] as const)("renders the real mixed patch and shell session once on a %s row", async (mode) => {
    const { native, shell } = JSON.parse(readFileSync(mixedCapturePath!, "utf8"));
    expect(native).toMatchObject({ linesAdded: 3, linesRemoved: 3, filesChanged: 3 });
    expect(shell).toMatchObject({ ownerId: native.sessionId, linesAdded: 11, linesRemoved: 6, filesChanged: 7 });
    setCodexSessionMode(native.sessionId, mode);
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [shell] : []);
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [native.sessionId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: native.sessionId }, codexThreads[1]]} />);
    await act(async () => {});
    expectBadge(native.sessionId, 11, 6, "Includes verified shell changes");
    emit("codex-session-diff-updated", native);
    expectBadge(native.sessionId, 14, 9, "Includes verified shell changes");
    emit("shell-diff-updated", shell);
    emit("codex-session-diff-updated", native);
    expectBadge(native.sessionId, 14, 9, "Includes verified shell changes");
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
  });
  it.skipIf(!lifecyclePayloadPath)("renders the real unpolled native-command receipt once", async () => {
    const payload = JSON.parse(readFileSync(lifecyclePayloadPath!, "utf8"));
    expect(payload).toMatchObject({ linesAdded: 1, linesRemoved: 0, filesChanged: 1 });
    setCodexSessionMode(payload.ownerId, "terminal");
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [payload] : []);
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expectBadge(payload.ownerId, 1, 0, "Includes verified shell changes");
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 1, 0, "Includes verified shell changes");
  });
  it.skipIf(!transferOrderRecoveryPayloadPath)("hydrates transfer-order counts without including the later drive-link edits", async () => {
    const payload = JSON.parse(readFileSync(transferOrderRecoveryPayloadPath!, "utf8"));
    expect(payload.ownerId).toBe("01a08cd1-fd22-7bc0-b2c8-b19881904ce4");
    expect(payload).toMatchObject({ linesAdded: 21, linesRemoved: 14, filesChanged: 2 });
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [payload] : []);
    setCodexSessionMode(payload.ownerId, "chat");
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expect(row(payload.ownerId).getAttribute("data-active")).toBe("false");
    expectBadge(payload.ownerId, 21, 14, "Includes verified shell changes");
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 21, 14, "Includes verified shell changes");
  });

  it.skipIf(!mcpStatusRecoveryPayloadPath)("hydrates the repaired MCP-status chat from its real database totals", async () => {
    const payload = JSON.parse(readFileSync(mcpStatusRecoveryPayloadPath!, "utf8"));
    expect(payload.ownerId).toBe("01a08c60-efd0-72b0-8ec6-0c082f4eef4b");
    expect(payload).toMatchObject({ linesAdded: 63, linesRemoved: 7, filesChanged: 4 });
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [payload] : []);
    setCodexSessionMode(payload.ownerId, "chat");
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expect(row(payload.ownerId).getAttribute("data-active")).toBe("false");
    expectBadge(payload.ownerId, 63, 7, "Includes verified shell changes");
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 63, 7, "Includes verified shell changes");
  });

  it.skipIf(!paRecoveryPayloadPath)("hydrates the repaired PA chat from its real database totals", async () => {
    const payload = JSON.parse(readFileSync(paRecoveryPayloadPath!, "utf8"));
    expect(payload.ownerId).toBe("01a08992-9195-70f1-a587-a6a294873bb7");
    expect(payload).toMatchObject({ linesAdded: 101, linesRemoved: 16, filesChanged: 9 });
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [payload] : []);
    setCodexSessionMode(payload.ownerId, "chat");
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expect(row(payload.ownerId).getAttribute("data-active")).toBe("false");
    expectBadge(payload.ownerId, 101, 16, "Includes verified shell changes");
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 101, 16, "Includes verified shell changes");
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
  });

  it.skipIf(!recoveryPayloadPath)("hydrates the repaired session from the real database snapshot", async () => {
    const payload = JSON.parse(readFileSync(recoveryPayloadPath!, "utf8"));
    expect(payload.linesAdded).toBe(88);
    expect(payload.linesRemoved).toBe(25);
    expect(payload.filesChanged).toBe(6);
    vi.mocked(invoke).mockImplementation(async (name) => name === "list_shell_diff_stats" ? [payload] : []);
    setCodexSessionMode(payload.ownerId, "terminal");
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expect(row(payload.ownerId).getAttribute("data-active")).toBe("false");
    expectBadge(payload.ownerId,88,25,"Includes verified shell changes");
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
  });

  it.skipIf(!shellHookPayloadPath).each(["terminal", "chat"] as const)("renders an actual synchronous Python hook capture on a background %s row", async (mode) => {
    const payload = JSON.parse(readFileSync(shellHookPayloadPath!, "utf8"));
    expect(payload.linesAdded).toBe(3);
    expect(payload.linesRemoved).toBe(1);
    expect(payload.filesChanged).toBe(1);
    setCodexSessionMode(payload.ownerId, mode);
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.ownerId]: "Background edits" } }));
    render(<AppSidebar threads={[{ ...codexThreads[0], id: payload.ownerId }, codexThreads[1]]} />);
    await act(async () => {});
    expect(row(payload.ownerId).getAttribute("data-active")).toBe("false");
    expect(within(row(payload.ownerId)).queryByText(/^\+\d+$/)).toBeNull();
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 3, 1, "Includes verified shell changes");
    emit("shell-diff-updated", payload);
    expectBadge(payload.ownerId, 3, 1, "Includes verified shell changes");
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
  });

  it.skipIf(!backendPayloadPath).each(["chat", "terminal"] as const)("renders the exact backend-produced AGMUX_CODEX_DIFF_PAYLOAD on an unselected %s row", async (mode) => {
    // Parent exports the native Rust event after terminal observe_record.
    // Keep the payload intact: wrong casing, missing fields, or invalid totals
    // must fail here instead of being repaired by a frontend fixture adapter.
    const payload = JSON.parse(readFileSync(backendPayloadPath!, "utf8"));
    expect(typeof payload.sessionId).toBe("string");
    expect(payload.sessionId.length).toBeGreaterThan(0);
    expect(payload.sessionId).not.toBe(selectedId);
    for (const field of ["linesAdded", "linesRemoved", "filesChanged"]) {
      expect(Number.isInteger(payload[field])).toBe(true);
      expect(payload[field]).toBeGreaterThanOrEqual(0);
    }
    expect(payload.linesAdded + payload.linesRemoved).toBeGreaterThan(0);
    setCodexSessionMode(payload.sessionId, mode);
    useSessionNameStore.setState((state) => ({ names: { ...state.names, [payload.sessionId]: "Background edits" } }));
    render(<AppSidebar threads={[
      { ...codexThreads[0], id: payload.sessionId }, codexThreads[1],
    ]} />);
    await act(async () => {});
    expect(handlers.get("codex-session-diff-updated")?.size).toBe(1);
    expect(row(payload.sessionId).getAttribute("data-active")).toBe("false");
    expect(row(selectedId).getAttribute("data-active")).toBe("true");
    if (mode === "terminal") expect(within(row(payload.sessionId)).getByText(/Terminal/)).toBeTruthy();
    expect(within(row(payload.sessionId)).queryByText(/^\+\d+$/)).toBeNull();
    nativeTotals(selectedId, 7, 2, 1);
    const otherStats = useUiStore.getState().codexDiffStatsById[selectedId];
    const title = `${payload.filesChanged} file${payload.filesChanged === 1 ? "" : "s"} changed`;
    emit("codex-session-diff-updated", payload);
    expectBadge(payload.sessionId, payload.linesAdded, payload.linesRemoved, title);
    emit("codex-session-diff-updated", payload);
    expectBadge(payload.sessionId, payload.linesAdded, payload.linesRemoved, title);
    expectBadge(selectedId, 7, 2, "1 file changed");
    expect(useUiStore.getState().codexDiffStatsById[selectedId]).toBe(otherStats);
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
    expect(useUiStore.getState().codexDiffStatsById[payload.sessionId]).toEqual({
      linesAdded: payload.linesAdded, linesRemoved: payload.linesRemoved, filesChanged: payload.filesChanged,
    });
    expect(useThreadStore.getState().threads[project.id]).toEqual([]);
  });

  it.each(["terminal", "chat"] as const)("updates a background %s row with absolute native totals and one shell overlay", async (mode) => {
    setCodexSessionMode(backgroundId, mode);
    await mountSidebar();
    expect(row(backgroundId).getAttribute("data-active")).toBe("false");
    expect(row(selectedId).getAttribute("data-active")).toBe("true");
    expect(within(row(backgroundId)).getByText(new RegExp(mode === "terminal" ? "Terminal" : "Chat"))).toBeTruthy();
    expect(within(row(backgroundId)).queryByText(/^\+\d+$/)).toBeNull();
    expect(useThreadStore.getState().threads[project.id]).toEqual([]);

    nativeTotals(selectedId, 7, 2, 1);
    const otherStats = useUiStore.getState().codexDiffStatsById[selectedId];
    nativeTotals(backgroundId, 372, 23);
    expectBadge(backgroundId, 372, 23);
    nativeTotals(backgroundId, 388, 29);
    expectBadge(backgroundId, 388, 29);
    nativeTotals(backgroundId, 388, 29);
    expectBadge(backgroundId, 388, 29);

    // The shell owner is an agmux ID, while the row and native payload use
    // the provider ID. Matching that alias must contribute only once.
    const shell: ShellDiffStats = {
      ownerId: "agmux-background", sessionId: backgroundId,
      linesAdded: 11, linesRemoved: 3, filesChanged: 2,
    };
    emit("shell-diff-updated", shell);
    expectBadge(backgroundId, 399, 32, "Includes verified shell changes");
    emit("shell-diff-updated", shell);
    nativeTotals(backgroundId, 388, 29);
    expectBadge(backgroundId, 399, 32, "Includes verified shell changes");
    expect(useUiStore.getState().codexDiffStatsById[backgroundId]).toEqual({ linesAdded: 388, linesRemoved: 29, filesChanged: 4 });
    expect(useShellDiffStore.getState().rows).toEqual({ "agmux-background": shell });

    // A smaller absolute refresh must replace, not accumulate or max-merge.
    nativeTotals(backgroundId, 372, 23);
    expectBadge(backgroundId, 383, 26, "Includes verified shell changes");
    emit("shell-diff-updated", { ...shell, linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    expectBadge(backgroundId, 372, 23);
    nativeTotals(backgroundId, 0, 0, 0);
    expect(within(row(backgroundId)).queryByText(/^\+\d+$/)).toBeNull();
    expectBadge(selectedId, 7, 2, "1 file changed");
    expect(useUiStore.getState().codexDiffStatsById[selectedId]).toBe(otherStats);
    expect(useUiStore.getState().selectedCodexSessionId).toBe(selectedId);
  });

  it("unsubscribes every transport on unmount and ignores subsequent events", async () => {
    const view = await mountSidebar();
    nativeTotals(backgroundId, 372, 23);
    expectBadge(backgroundId, 372, 23);
    view.unmount();
    await act(async () => {});
    const nativeBefore = useUiStore.getState().codexDiffStatsById;
    const shellBefore = useShellDiffStore.getState().rows;
    for (const name of eventNames) {
      expect(unlisteners.get(name)).toHaveBeenCalledTimes(1);
      expect(handlers.get(name)?.size).toBe(0);
    }
    nativeTotals(backgroundId, 999, 99);
    emit("shell-diff-updated", { ownerId: backgroundId, sessionId: null, linesAdded: 99, linesRemoved: 9, filesChanged: 1 });
    expect(useUiStore.getState().codexDiffStatsById).toBe(nativeBefore);
    expect(useShellDiffStore.getState().rows).toBe(shellBefore);
    expect(screen.queryByText("Background edits")).toBeNull();
  });

  it("keeps live shell totals over a stale initial snapshot without hiding either native row", async () => {
    const resolveSnapshot = deferShellSnapshot();
    await mountSidebar();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "list_shell_diff_stats")).toHaveLength(1);
    nativeTotals(backgroundId, 372, 23);
    nativeTotals(selectedId, 7, 2, 1);
    const shell: ShellDiffStats = {
      ownerId: "agmux-background", sessionId: backgroundId,
      linesAdded: 16, linesRemoved: 6, filesChanged: 2,
    };
    emit("shell-diff-updated", shell);
    expectBadge(backgroundId, 388, 29, "Includes verified shell changes");
    await act(async () => { resolveSnapshot([{ ...shell, linesAdded: 1, linesRemoved: 1 }]); });
    expectBadge(backgroundId, 388, 29, "Includes verified shell changes");
    expectBadge(selectedId, 7, 2, "1 file changed");
    expect(useShellDiffStore.getState().rows[shell.ownerId]).toEqual(shell);
  });

  it("ignores a pending shell snapshot after unmount and subscribes afresh on remount", async () => {
    const resolveSnapshot = deferShellSnapshot();
    const view = await mountSidebar();
    nativeTotals(backgroundId, 372, 23);
    view.unmount();
    await act(async () => {});
    await act(async () => { resolveSnapshot([{
      ownerId: backgroundId, sessionId: null, linesAdded: 99, linesRemoved: 9, filesChanged: 1,
    }]); });
    expect(useShellDiffStore.getState().rows).toEqual({});
    vi.mocked(invoke).mockResolvedValue([]);
    render(<AppSidebar />);
    await act(async () => {});
    for (const name of eventNames) {
      expect(vi.mocked(listen).mock.calls.filter(([event]) => event === name)).toHaveLength(2);
      expect(handlers.get(name)?.size).toBe(1);
    }
    expectBadge(backgroundId, 372, 23);
    nativeTotals(backgroundId, 388, 29);
    expectBadge(backgroundId, 388, 29);
  });

  it("cleans up listeners that register after the entire sidebar unmounts", async () => {
    delayListeners = true;
    const view = await mountSidebar();
    expect([...pendingListeners.keys()].sort()).toEqual([...eventNames].sort());
    view.unmount();
    await act(async () => {});
    for (const name of eventNames) {
      await act(async () => { pendingListeners.get(name)!(); });
      expect(unlisteners.get(name)).toHaveBeenCalledTimes(1);
      expect(handlers.get(name)?.size).toBe(0);
    }
    nativeTotals(backgroundId, 999, 99);
    expect(useUiStore.getState().codexDiffStatsById).toEqual({});
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "list_shell_diff_stats")).toBe(false);
  });
});
