import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { opencodeSdk } from "../opencodeSdkCommands";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("opencodeSdk wrapper", () => {
  it("checkAvailable forwards binaryPath", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await opencodeSdk.checkAvailable("/usr/local/bin/opencode");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_check_available", {
      binaryPath: "/usr/local/bin/opencode",
    });
  });

  it("autoDetectBinary calls without args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await opencodeSdk.autoDetectBinary();
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_auto_detect_binary");
  });

  it("bridgeLogTail forwards lines", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await opencodeSdk.bridgeLogTail(50);
    expect(invoke).toHaveBeenCalledWith("opencode_bridge_log_tail", {
      lines: 50,
    });
  });

  it("initializeBridge forwards args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ serverUrl: "http://x" });
    const args = { binaryPath: "oc" };
    await opencodeSdk.initializeBridge(args);
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_initialize_bridge", {
      args,
    });
  });

  it("startSession forwards session args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("session-1");
    const args = {
      threadId: "t1",
      directory: "/cwd",
      model: "anthropic/claude-3.5",
    };
    await opencodeSdk.startSession(args);
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_start_session", { args });
  });

  it("sendMessage forwards threadId/text/attachments", async () => {
    await opencodeSdk.sendMessage("t1", "hello", [{ kind: "image" }]);
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_send_message", {
      threadId: "t1",
      text: "hello",
      attachments: [{ kind: "image" }],
    });
  });

  it("respondPermission forwards permissionId/decision", async () => {
    await opencodeSdk.respondPermission("t1", "p1", "accept");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_respond_permission", {
      threadId: "t1",
      permissionId: "p1",
      decision: "accept",
    });
  });

  it("respondQuestion forwards answers array", async () => {
    await opencodeSdk.respondQuestion("t1", "q1", [["yes"]]);
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_respond_question", {
      threadId: "t1",
      questionId: "q1",
      answers: [["yes"]],
    });
  });

  it("interrupt forwards threadId", async () => {
    await opencodeSdk.interrupt("t1");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_interrupt", {
      threadId: "t1",
    });
  });

  it("setModel and setAgent forward params", async () => {
    await opencodeSdk.setModel("t1", "anthropic/claude-3.5");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_set_model", {
      threadId: "t1",
      model: "anthropic/claude-3.5",
    });
    await opencodeSdk.setAgent("t1", "build");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_set_agent", {
      threadId: "t1",
      agent: "build",
    });
    await opencodeSdk.setPermissionMode("t1", "full-access");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_set_permission_mode", {
      threadId: "t1",
      mode: "full-access",
    });
  });

  it("stopSession and shutdownBridge forward correctly", async () => {
    await opencodeSdk.stopSession("t1");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_stop_session", {
      threadId: "t1",
    });
    await opencodeSdk.shutdownBridge();
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_shutdown_bridge");
  });

  it("listAuthMethods forwards directory", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await opencodeSdk.listAuthMethods("/cwd");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_list_auth_methods", {
      directory: "/cwd",
    });
  });

  it("setApiKey forwards providerId/apiKey", async () => {
    await opencodeSdk.setApiKey("anthropic", "sk-key");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_set_api_key", {
      providerId: "anthropic",
      apiKey: "sk-key",
    });
  });

  it("removeAuth forwards providerId", async () => {
    await opencodeSdk.removeAuth("anthropic");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_remove_auth", {
      providerId: "anthropic",
    });
  });

  it("oauthAuthorize forwards optional args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ url: "https://" });
    await opencodeSdk.oauthAuthorize("anthropic", 0, { foo: "bar" });
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_oauth_authorize", {
      providerId: "anthropic",
      method: 0,
      inputs: { foo: "bar" },
    });
  });

  it("oauthCallback forwards code", async () => {
    await opencodeSdk.oauthCallback("anthropic", 0, "auth-code");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_oauth_callback", {
      providerId: "anthropic",
      method: 0,
      code: "auth-code",
    });
  });

  it("listModels and listAgents forward directory", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      models: [],
      agents: [],
      directory: "/cwd",
    });
    await opencodeSdk.listModels("/cwd");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_list_models", {
      directory: "/cwd",
    });
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await opencodeSdk.listAgents("/cwd");
    expect(invoke).toHaveBeenCalledWith("opencode_sdk_list_agents", {
      directory: "/cwd",
    });
  });
});
