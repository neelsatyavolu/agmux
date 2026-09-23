import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { cursorSdk } from "../cursorSdkCommands";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("cursorSdk wrapper", () => {
  it("startSession forwards Cursor mode", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("agent-1");
    await cursorSdk.startSession({
      threadId: "t1",
      directory: "/repo",
      model: "composer-2.5",
      mode: "plan",
      resumeAgentId: null,
    });

    expect(invoke).toHaveBeenCalledWith("cursor_sdk_start_session", {
      args: {
        threadId: "t1",
        directory: "/repo",
        model: "composer-2.5",
        mode: "plan",
        resumeAgentId: null,
      },
    });
  });

  it("sendMessage forwards Cursor mode", async () => {
    await cursorSdk.sendMessage(
      "t1",
      "hello",
      [{ data: "abc", mimeType: "image/png" }],
      { mode: "plan" },
    );

    expect(invoke).toHaveBeenCalledWith("cursor_sdk_send_message", {
      threadId: "t1",
      text: "hello",
      images: [{ data: "abc", mimeType: "image/png" }],
      mode: "plan",
    });
  });

  it("auth and permission helpers forward to Tauri commands", async () => {
    await cursorSdk.authStatus();
    await cursorSdk.authLogin();
    await cursorSdk.authLogout();
    await cursorSdk.setPermissionMode("t1", "auto");

    expect(invoke).toHaveBeenCalledWith("cursor_sdk_auth_status");
    expect(invoke).toHaveBeenCalledWith("cursor_sdk_auth_login");
    expect(invoke).toHaveBeenCalledWith("cursor_sdk_auth_logout");
    expect(invoke).toHaveBeenCalledWith("cursor_sdk_set_permission_mode", {
      threadId: "t1",
      mode: "auto",
    });
  });
});
