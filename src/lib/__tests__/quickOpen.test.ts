import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  QUICK_OPEN_OPTIONS,
  isQuickOpenAction,
  chatProviderForAction,
  quickOpenLabel,
  runQuickOpenAction,
} from "../quickOpen";

const mocks = vi.hoisted(() => ({
  addThread: vi.fn(), startThread: vi.fn(), updateThreadStatus: vi.fn(),
  selectThread: vi.fn(), setDraftChat: vi.fn(), openSettings: vi.fn(),
  mlxCapability: vi.fn(), mlxGatewayStatus: vi.fn(), mlxListModels: vi.fn(),
  invoke: vi.fn(), message: vi.fn(),
}));
vi.mock("../../stores/threadStore", () => ({ useThreadStore: { getState: () => mocks } }));
vi.mock("../../stores/uiStore", () => ({ useUiStore: { getState: () => mocks } }));
vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ ...mocks, settings: { lastUsedModel: "local/test-model" } }) },
}));
vi.mock("../mlx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mlx")>(),
  mlxCapability: mocks.mlxCapability, mlxGatewayStatus: mocks.mlxGatewayStatus,
  mlxListModels: mocks.mlxListModels,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.addThread.mockResolvedValue({ id: "thread", name: "New Thread" });
  mocks.startThread.mockResolvedValue(undefined);
  mocks.mlxCapability.mockResolvedValue({ available: true });
  mocks.mlxListModels.mockResolvedValue([{ id: "test-model" }]);
});

describe("quickOpen", () => {
  it("exposes chat + terminal options for each major agent", () => {
    const values = QUICK_OPEN_OPTIONS.map((o) => o.value);
    expect(values).toContain("claude-chat");
    expect(values).toContain("claude-terminal");
    expect(values).toContain("codex-chat");
    expect(values).toContain("codex-terminal");
    expect(values).toContain("grok-chat");
    expect(values).toContain("grok-terminal");
    expect(values).toContain("opencode-chat");
    expect(values).toContain("opencode-terminal");
    expect(values).toContain("kimi-terminal");
    for (const action of ["pi-terminal", "cline-terminal", "gemini-terminal", "hermes-terminal", "local-terminal", "gemini-chat"]) {
      expect(values).toContain(action);
      expect(isQuickOpenAction(action)).toBe(true);
    }
    expect(values).toContain("mlx-chat");
    expect(values).toContain("cursor-chat");
    expect(values).toContain("shell-terminal");
    expect(values).toContain("chat");
  });

  it("validates action strings", () => {
    expect(isQuickOpenAction("grok-chat")).toBe(true);
    expect(isQuickOpenAction("not-a-real-action")).toBe(false);
    expect(isQuickOpenAction(null)).toBe(false);
  });

  it("maps chat actions to providers", () => {
    expect(chatProviderForAction("chat", "Grok")).toBe("Grok");
    expect(chatProviderForAction("claude-chat", "Codex")).toBe("ClaudeCode");
    expect(chatProviderForAction("codex-chat", "ClaudeCode")).toBe("Codex");
    expect(chatProviderForAction("grok-chat", "ClaudeCode")).toBe("Grok");
    expect(chatProviderForAction("opencode-chat", "ClaudeCode")).toBe("OpenCode");
    expect(chatProviderForAction("mlx-chat", "ClaudeCode")).toBe("MLX");
    expect(chatProviderForAction("cursor-chat", "ClaudeCode")).toBe("Cursor");
    expect(chatProviderForAction("shell-terminal", "ClaudeCode")).toBeNull();
    expect(chatProviderForAction("claude-terminal", "ClaudeCode")).toBeNull();
  });

  it("returns human labels", () => {
    expect(quickOpenLabel("grok-terminal")).toBe("Grok Terminal");
    expect(quickOpenLabel("chat")).toBe("Chat (default provider)");
  });

  it.each([
    ["pi-terminal", "Pi"], ["cline-terminal", "Cline"],
    ["gemini-terminal", "Gemini"], ["hermes-terminal", "Hermes"],
  ] as const)("starts %s with the matching provider", async (action, provider) => {
    await runQuickOpenAction({ id: "project", repo_path: "/repo" }, action, "ClaudeCode");
    expect(mocks.addThread).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project", provider, workMode: "DirectRepo" }));
    expect(mocks.selectThread).toHaveBeenCalledWith("thread", "New Thread");
    expect(mocks.startThread).toHaveBeenCalledWith("thread", false);
  });

  it("opens a Gemini chat draft", async () => {
    await runQuickOpenAction({ id: "project", repo_path: "/repo" }, "gemini-chat", "ClaudeCode");
    expect(mocks.setDraftChat).toHaveBeenCalledWith({ projectId: "project", repoPath: "/repo", provider: "Gemini", model: null });
    expect(mocks.addThread).not.toHaveBeenCalled();
  });

  it("pins Local terminal to an installed model after syncing Pi", async () => {
    await runQuickOpenAction({ id: "project", repo_path: "/repo" }, "local-terminal", "ClaudeCode");
    expect(mocks.invoke).toHaveBeenCalledWith("mlx_sync_pi_config");
    expect(mocks.addThread).toHaveBeenCalledWith({ projectId: "project", provider: "Pi", name: "New Local Thread", model: "local/test-model", workMode: "DirectRepo" });
    expect(mocks.startThread).toHaveBeenCalledWith("thread", false);
  });

  it.each(["runtime", "models"])("opens Local Models settings when %s is missing", async (missing) => {
    if (missing === "runtime") mocks.mlxCapability.mockResolvedValue({ available: false });
    else mocks.mlxListModels.mockResolvedValue([]);
    await runQuickOpenAction({ id: "project", repo_path: "/repo" }, "local-terminal", "ClaudeCode");
    expect(mocks.openSettings).toHaveBeenCalledWith("localModels");
    expect(mocks.addThread).not.toHaveBeenCalled();
  });

  it("shows Local setup errors without starting a cloud session", async () => {
    mocks.invoke.mockRejectedValue("Config needs attention");
    await runQuickOpenAction({ id: "project", repo_path: "/repo" }, "local-terminal", "ClaudeCode");
    expect(mocks.message).toHaveBeenCalledWith("Config needs attention", expect.objectContaining({ kind: "error" }));
    expect(mocks.addThread).not.toHaveBeenCalled();
  });
});
