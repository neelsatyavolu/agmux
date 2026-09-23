import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  localModelStatus: vi.fn(),
  downloadLocalModel: vi.fn(),
  deleteLocalModel: vi.fn(),
  setActiveLocalModel: vi.fn(),
  ensureLocalLlmServer: vi.fn(),
  stopLocalLlmServer: vi.fn(),
}));

import * as cmd from "../../lib/commands";
import { listen } from "@tauri-apps/api/event";
import { useLocalModelStore } from "../localModelStore";
import type { LocalModelStatus } from "../../lib/commands";
import { clearLocalStorage } from "./setup";

const mkStatus = (overrides: Partial<LocalModelStatus> = {}): LocalModelStatus => ({
  model_downloaded: false,
  server_downloaded: false,
  server_running: false,
  model_name: "Qwen2.5",
  model_size_bytes: null,
  active_variant: "small",
  variants: [],
  ...overrides,
});

describe("localModelStore", () => {
  beforeEach(() => {
    clearLocalStorage();
    useLocalModelStore.setState(
      {
        status: null,
        downloading: false,
        downloadProgress: null,
        error: null,
        hasSeenSetupPrompt: false,
      },
      false,
    );
    vi.clearAllMocks();
  });

  it("dismissSetupPrompt persists and updates state", () => {
    useLocalModelStore.getState().dismissSetupPrompt();
    expect(useLocalModelStore.getState().hasSeenSetupPrompt).toBe(true);
    expect(localStorage.getItem("agmux-local-model-setup-seen")).toBe("true");
  });

  it("fetchStatus stores the result and clears any prior error", async () => {
    const status = mkStatus({ model_downloaded: true });
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(status);
    useLocalModelStore.setState({ error: "stale" }, false);

    await useLocalModelStore.getState().fetchStatus();
    expect(useLocalModelStore.getState().status).toEqual(status);
    expect(useLocalModelStore.getState().error).toBeNull();
  });

  it("fetchStatus captures error message on failure", async () => {
    vi.mocked(cmd.localModelStatus).mockRejectedValueOnce(new Error("nope"));
    await useLocalModelStore.getState().fetchStatus();
    expect(useLocalModelStore.getState().error).toBe("nope");
  });

  it("startDownload toggles downloading flag and refreshes status", async () => {
    vi.mocked(cmd.downloadLocalModel).mockResolvedValueOnce(undefined);
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(mkStatus({ model_downloaded: true }));
    vi.mocked(listen).mockResolvedValueOnce(() => {});

    await useLocalModelStore.getState().startDownload();
    expect(cmd.downloadLocalModel).toHaveBeenCalled();
    expect(useLocalModelStore.getState().downloading).toBe(false);
    expect(useLocalModelStore.getState().status?.model_downloaded).toBe(true);
  });

  it("startDownload records error and still clears downloading flag", async () => {
    vi.mocked(listen).mockResolvedValueOnce(() => {});
    vi.mocked(cmd.downloadLocalModel).mockRejectedValueOnce(new Error("dl-fail"));

    await useLocalModelStore.getState().startDownload();
    expect(useLocalModelStore.getState().downloading).toBe(false);
    expect(useLocalModelStore.getState().error).toBe("dl-fail");
  });

  it("removeModel calls deleteLocalModel and refreshes status", async () => {
    vi.mocked(cmd.deleteLocalModel).mockResolvedValueOnce(undefined);
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(mkStatus());

    await useLocalModelStore.getState().removeModel();
    expect(cmd.deleteLocalModel).toHaveBeenCalled();
    expect(cmd.localModelStatus).toHaveBeenCalled();
  });

  it("removeModel records error on failure", async () => {
    vi.mocked(cmd.deleteLocalModel).mockRejectedValueOnce(new Error("rm-fail"));
    await useLocalModelStore.getState().removeModel();
    expect(useLocalModelStore.getState().error).toBe("rm-fail");
  });

  it("setActive forwards the variant and refreshes status", async () => {
    vi.mocked(cmd.setActiveLocalModel).mockResolvedValueOnce(undefined);
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(mkStatus());

    await useLocalModelStore.getState().setActive("small");
    expect(cmd.setActiveLocalModel).toHaveBeenCalledWith("small");
  });

  it("ensureServer returns the port and refreshes status", async () => {
    vi.mocked(cmd.ensureLocalLlmServer).mockResolvedValueOnce(8080);
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(mkStatus({ server_running: true }));

    const port = await useLocalModelStore.getState().ensureServer();
    expect(port).toBe(8080);
    expect(useLocalModelStore.getState().status?.server_running).toBe(true);
  });

  it("ensureServer rethrows after recording error", async () => {
    vi.mocked(cmd.ensureLocalLlmServer).mockRejectedValueOnce(new Error("ensure-fail"));
    await expect(useLocalModelStore.getState().ensureServer()).rejects.toThrow("ensure-fail");
    expect(useLocalModelStore.getState().error).toBe("ensure-fail");
  });

  it("stopServer calls the command and refreshes status", async () => {
    vi.mocked(cmd.stopLocalLlmServer).mockResolvedValueOnce(undefined);
    vi.mocked(cmd.localModelStatus).mockResolvedValueOnce(mkStatus());

    await useLocalModelStore.getState().stopServer();
    expect(cmd.stopLocalLlmServer).toHaveBeenCalled();
  });

  it("stopServer records error on failure", async () => {
    vi.mocked(cmd.stopLocalLlmServer).mockRejectedValueOnce(new Error("stop-fail"));
    await useLocalModelStore.getState().stopServer();
    expect(useLocalModelStore.getState().error).toBe("stop-fail");
  });
});
