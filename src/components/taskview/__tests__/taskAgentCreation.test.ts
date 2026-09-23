/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskAgentDefaultModel, configureTaskAgent, prepareTaskLocalModel } from "../taskAgentCreation";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useUiStore } from "../../../stores/uiStore";
import { updateThreadSettings } from "../../../lib/commands";
import { mlxCapability, mlxListModels, mlxGatewayStatus } from "../../../lib/mlx";

vi.mock("../../../lib/commands", () => ({ updateThreadSettings: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/mlx", async (original) => ({
  ...await original<typeof import("../../../lib/mlx")>(),
  mlxCapability: vi.fn().mockResolvedValue({ available: true }),
  mlxListModels: vi.fn().mockResolvedValue([{ id: "installed", displayName: "Installed" }]),
  mlxGatewayStatus: vi.fn().mockResolvedValue({}),
}));
const settings = useSettingsStore.getState().settings;
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: { ...settings } });
  useUiStore.setState({ pendingSdkPermissionModes: {}, pendingGrokConfigs: {}, pendingCodexEfforts: {}, pendingCodexFastModes: {}, pendingCodexPermissionModes: {}, pendingOpencodePermissionModes: {} });
});

describe("task agent defaults", () => {
  it("restores provider-specific preferences without contaminating another provider", () => {
    const saved = { ...settings, lastUsedModel: "grok-4.5", codexModel: "gpt-5.4", opencodeRecentModels: ["google/gemini-3.1-pro"] };
    expect(taskAgentDefaultModel("Grok", "grok-sdk", saved)).toBe("grok-4.5");
    expect(taskAgentDefaultModel("Codex", "sdk", saved)).toBe("gpt-5.4");
    expect(taskAgentDefaultModel("OpenCode", "opencode-sdk", saved)).toBe("google/gemini-3.1-pro");
    expect(taskAgentDefaultModel("ClaudeCode", "sdk", saved)).toBe("sonnet");
    expect(taskAgentDefaultModel("Cursor", "cursor-sdk", saved)).toBe("composer-2.5");
    expect(taskAgentDefaultModel("ClaudeCode", "pty", saved)).toBeNull();
  });

  it("leaves an unchosen Codex model to native configuration", () => {
    expect(taskAgentDefaultModel("Codex", "sdk", { ...settings, codexModel: "", lastUsedModel: "sonnet" })).toBeNull();
  });

  it("preserves Gemini effort suffix and clamps incompatible Grok effort", async () => {
    useSettingsStore.setState({ settings: { ...settings, lastUsedModel: "gemini-3.1-pro-low", lastUsedEffort: "max" } });
    expect(taskAgentDefaultModel("Gemini", "gemini-sdk")).toBe("gemini-3.1-pro-low");
    await configureTaskAgent("g", "Grok", "grok-sdk", "grok-4.5");
    expect(updateThreadSettings).toHaveBeenCalledWith("g", "grok-4.5", "high", false);
    expect(useUiStore.getState().pendingGrokConfigs.g.effort).toBe("high");
  });

  it.each(["ClaudeCode", "Cursor", "Grok", "Gemini"] as const)("hands %s the saved SDK permission", async (provider) => {
    useSettingsStore.setState({ settings: { ...settings, sdkPermissionMode: "auto" } });
    await configureTaskAgent("new", provider, provider === "Gemini" ? "gemini-sdk" : provider === "Grok" ? "grok-sdk" : provider === "Cursor" ? "cursor-sdk" : "sdk", "model");
    expect(useUiStore.getState().pendingSdkPermissionModes.new).toBe("auto");
  });

  it("applies the master permission default and Codex fast/effort preferences", async () => {
    useSettingsStore.setState({ settings: { ...settings, defaultBypassPermissions: true, codexFastMode: true, codexEffort: "high", codexEffortExplicit: true } });
    await configureTaskAgent("codex", "Codex", "sdk", "gpt-5.4");
    await configureTaskAgent("oc", "OpenCode", "opencode-sdk", "anthropic/model");
    await configureTaskAgent("gemini", "Gemini", "gemini-sdk", "gemini-3.8-flash-high");
    const ui = useUiStore.getState();
    expect(ui.pendingCodexPermissionModes.codex).toBe("full");
    expect(ui.pendingCodexFastModes.codex).toBe(true);
    expect(ui.pendingCodexEfforts.codex).toBe("high");
    expect(ui.pendingOpencodePermissionModes.oc).toBe("full-access");
    expect(ui.pendingSdkPermissionModes.gemini).toBe("bypassPermissions");
  });

  it("does not synthesize a Codex effort override from the default medium setting", async () => {
    await configureTaskAgent("codex", "Codex", "sdk", null);
    expect(useUiStore.getState().pendingCodexEfforts.codex).toBeUndefined();
  });

  it("starts the gateway for an installed local model", async () => {
    expect(await prepareTaskLocalModel("local/installed")).toBe("local/installed");
    expect(mlxGatewayStatus).toHaveBeenCalledOnce();
  });

  it("rejects a missing explicit model instead of silently changing models", async () => {
    await expect(prepareTaskLocalModel("local/removed")).rejects.toThrow("unavailable");
    expect(mlxGatewayStatus).not.toHaveBeenCalled();
  });

  it("requires installed models and an available local runtime", async () => {
    vi.mocked(mlxListModels).mockResolvedValueOnce([]);
    await expect(prepareTaskLocalModel(null)).rejects.toThrow("Settings");
    vi.mocked(mlxCapability).mockResolvedValueOnce({ available: false } as never);
    await expect(prepareTaskLocalModel(null)).rejects.toThrow("Settings");
    expect(mlxGatewayStatus).not.toHaveBeenCalled();
  });
});
