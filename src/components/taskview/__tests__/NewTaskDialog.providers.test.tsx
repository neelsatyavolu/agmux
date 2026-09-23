/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewTaskDialog } from "../NewTaskDialog";
import { useProjectStore } from "../../../stores/projectStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useTaskViewStore } from "../../../stores/taskViewStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useUiStore } from "../../../stores/uiStore";
import { useComposerDraftStore } from "../../../stores/composerDraftStore";
import { createTask, createTaskAgent } from "../../../lib/taskCommands";
import { codexStartThread } from "../../../lib/commands";
import { setCodexSessionMode } from "../../../lib/codexSessionMode";
import { cursorSdk } from "../../../lib/cursorSdkCommands";
import { mlxListModels } from "../../../lib/mlx";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn().mockResolvedValue("/home/test/") }));
vi.mock("../../../lib/taskCommands", () => ({
  createTask: vi.fn().mockResolvedValue({ id: "task", project_id: "p", branch_name: "feature", worktree_path: "/tasks/feature/repo" }),
  createTaskAgent: vi.fn().mockResolvedValue({ id: "agent" }),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
}));
vi.mock("../../../lib/commands", () => ({
  codexEnsureServer: vi.fn().mockResolvedValue(undefined),
  codexListModels: vi.fn().mockResolvedValue({ data: [] }),
  codexStartThread: vi.fn().mockResolvedValue({ thread: { id: "native-codex" } }),
  listClaudeModels: vi.fn().mockResolvedValue([]),
  updateThreadSettings: vi.fn().mockResolvedValue(undefined),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/codexSessionMode", () => ({ setCodexSessionMode: vi.fn() }));
vi.mock("../../../lib/cursorSdkCommands", () => ({ cursorSdk: { listModels: vi.fn().mockResolvedValue({ models: [{ slug: "account-cursor", name: "Account Cursor Model" }] }) } }));
vi.mock("../../../lib/opencodeSdkCommands", () => ({ opencodeSdk: {
  initializeBridge: vi.fn().mockResolvedValue(undefined),
  listModels: vi.fn().mockResolvedValue({ models: [{ slug: "custom/current", name: "Current OpenCode Model", connected: true }] }),
} }));
vi.mock("../../../lib/mlx", async (original) => ({
  ...await original<typeof import("../../../lib/mlx")>(),
  mlxCapability: vi.fn().mockResolvedValue({ available: true }),
  mlxListModels: vi.fn().mockResolvedValue([{ id: "installed", displayName: "Installed Local" }]),
  mlxGatewayStatus: vi.fn().mockResolvedValue({}),
}));

const initialSettings = useSettingsStore.getState().settings;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useProjectStore.setState({ projects: [{ id: "p", name: "Repo", repo_path: "/main/repo", conventions: "", created_at: "" }] });
  useTaskViewStore.setState({ tasks: {}, fetchTasks: vi.fn().mockResolvedValue(undefined), addTaskToStore: vi.fn(), selectTask: vi.fn(), setActiveAgent: vi.fn() });
  useThreadStore.setState({ threads: {}, fetchThreads: vi.fn().mockResolvedValue(undefined) });
  useSettingsStore.setState({ settings: { ...initialSettings, defaultProvider: "ClaudeCode", lastUsedModel: "sonnet", lastUsedEffort: "high", worktreeRoot: "/tasks", worktreeBranchFirst: true } });
  useUiStore.setState({ pendingGrokConfigs: {}, pendingSdkPermissionModes: {} });
  useComposerDraftStore.setState({ drafts: {} });
});
afterEach(cleanup);

async function fillTask() {
  fireEvent.change(screen.getByPlaceholderText("task/feature-name"), { target: { value: "feature" } });
  fireEvent.change(screen.getByPlaceholderText(/What do you want to do/), { target: { value: "Implement the feature" } });
  await waitFor(() => expect(screen.getByText("/tasks/feature/repo")).toBeTruthy());
}
function submit() { fireEvent.click(screen.getByRole("button", { name: /Create & start/ })); }

describe("NewTaskDialog provider parity", () => {
  it.each([
    ["cursor-chat", "Cursor", "cursor-sdk", "composer-2.5"],
    ["gemini-chat", "Gemini", "gemini-sdk", "gemini-3.8-flash-high"],
    ["local-chat", "OpenCode", "opencode-sdk", "local/installed"],
    ["local-term", "Pi", "pty", "local/installed"],
    ["pi-term", "Pi", "pty", null],
    ["droid-term", "Droid", "pty", null],
    ["kimi-term", "Kimi", "pty", null],
    ["cline-term", "Cline", "pty", null],
    ["gemini-term", "Gemini", "pty", null],
    ["hermes-term", "Hermes", "pty", null],
  ] as const)("creates %s in the task and forwards its prompt", async (key, provider, mode, model) => {
    localStorage.setItem("agmux-new-task-last-agent", key);
    const onClose = vi.fn();
    render(<NewTaskDialog projectId="p" onClose={onClose} />);
    await fillTask();
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(createTaskAgent).toHaveBeenCalledWith("task", provider, expect.any(String), model, mode, null);
    expect(createTask).toHaveBeenCalledWith("p", "feature", "feature", "main", "/main/repo", "/tasks/feature/repo", "Implement the feature", null, null, null, false);
    expect(useComposerDraftStore.getState().drafts.agent).toMatchObject({ text: "Implement the feature", autoSubmit: true });
  });

  it.each([["codex-chat", "chat", "sdk"], ["codex-term", "terminal", "pty"]] as const)("persists %s and uses the parent cwd for multi-repo tasks", async (key, viewMode, mode) => {
    localStorage.setItem("agmux-new-task-last-agent", key);
    render(<NewTaskDialog projectId="p" onClose={() => {}} />);
    await fillTask();
    fireEvent.click(screen.getByTitle(/agent runs inside/));
    submit();
    await waitFor(() => expect(createTaskAgent).toHaveBeenCalledWith("task", "Codex", expect.any(String), null, mode, "native-codex"));
    expect(codexStartThread).toHaveBeenCalledWith("/tasks/feature", undefined);
    expect(setCodexSessionMode).toHaveBeenCalledWith("native-codex", viewMode);
  });

  it("offers live Cursor account models and creates the selected one", async () => {
    localStorage.setItem("agmux-new-task-last-agent", "cursor-chat");
    render(<NewTaskDialog projectId="p" onClose={() => {}} />);
    await fillTask();
    await waitFor(() => expect(cursorSdk.listModels).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Cursor.*composer/i }));
    fireEvent.mouseEnter(screen.getAllByText("Cursor").slice(-1)[0].closest("button")!.parentElement!);
    fireEvent.click(await screen.findByText("Account Cursor Model"));
    submit();
    await waitFor(() => expect(createTaskAgent).toHaveBeenCalledWith("task", "Cursor", "Cursor Chat #1", "account-cursor", "cursor-sdk", null));
  });

  it("offers every current provider in the picker, including Local and Droid", () => {
    render(<NewTaskDialog projectId="p" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude.*Sonnet/ }));
    for (const label of ["Claude", "Codex", "Cursor", "OpenCode", "Grok", "Gemini", "Local", "Pi", "Kimi", "Cline", "Hermes", "Droid"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("does not create a task when the selected local model is unavailable", async () => {
    localStorage.setItem("agmux-new-task-last-agent", "local-chat");
    vi.mocked(mlxListModels).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    render(<NewTaskDialog projectId="p" onClose={() => {}} />);
    await fillTask();
    submit();
    expect(await screen.findByText(/Set up an installed model/)).toBeTruthy();
    expect(createTask).not.toHaveBeenCalled();
    expect(createTaskAgent).not.toHaveBeenCalled();
  });
});
