/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkSessionView } from "../CursorSdkSessionView";
import type { ChatTransport } from "../ClaudeSdkSessionView";
import { useThreadStore } from "../../../stores/threadStore";

const mocks = vi.hoisted(() => ({
  startSession: vi.fn().mockResolvedValue("agent-1"),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn().mockResolvedValue(undefined),
  setPermissionMode: vi.fn().mockResolvedValue({ ok: true }),
  getHistory: vi.fn().mockResolvedValue([]),
  recordThreadLineDelta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/commands", () => ({
  recordThreadLineDelta: mocks.recordThreadLineDelta,
}));

vi.mock("../ClaudeSdkSessionView", () => ({
  ClaudeSdkSessionView: (props: {
    transport: ChatTransport;
    providerOverride?: string;
    externalSessionReady?: boolean;
    bypassActive?: boolean;
  }) => {
    (globalThis as { __cursorTransport?: ChatTransport }).__cursorTransport = props.transport;
    return (
      <div
        data-testid="shared-chat"
        data-provider={props.providerOverride}
        data-ready={String(props.externalSessionReady)}
        data-bypass={String(props.bypassActive)}
      />
    );
  },
}));

vi.mock("../OpenCodeThinkingIndicator", () => ({
  OpenCodeThinkingIndicator: () => <div data-testid="thinking-indicator" />,
}));

vi.mock("../../../lib/cursorSdkCommands", () => ({
  cursorSdk: mocks,
}));

afterEach(() => {
  cleanup();
  useThreadStore.setState({ threads: {} } as never);
});

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __cursorTransport?: ChatTransport }).__cursorTransport;
  useThreadStore.setState({ threads: {} } as never);
});

describe("CursorSdkSessionView", () => {
  it("backfills only completed successful file changes", async () => {
    useThreadStore.setState({ threads: { p1: [{ id: "t1", lines_added: 0, lines_removed: 0 } as never] } });
    const log = (id: string, log_type: string, content: unknown) => ({
      id, thread_id: "t1", direction: "Output", timestamp: "2026-09-09T00:00:00Z",
      log_type, content: JSON.stringify(content),
    });
    mocks.getHistory.mockResolvedValueOnce([
      log("1", "tool_use", { toolUseId: "failed", name: "Write", input: { file_path: "failed.txt", content: "never written" } }),
      log("2", "tool_result", { toolUseId: "failed", isError: true, content: "Permission denied" }),
      log("3", "tool_use", { toolUseId: "pending", name: "Write", input: { file_path: "pending.txt", content: "not yet written" } }),
      log("4", "tool_use", { toolUseId: "ok", name: "Write", input: { file_path: "ok.txt", content: "written" } }),
      log("5", "tool_result", { toolUseId: "ok", isError: false, content: "Success" }),
    ]);
    render(<CursorSdkSessionView sessionId="t1" cwd="/repo" model="composer-2.5" />);
    const transport = (globalThis as { __cursorTransport?: ChatTransport }).__cursorTransport!;
    await transport.loadHistory!("t1");
    expect(mocks.recordThreadLineDelta).toHaveBeenCalledExactlyOnceWith("t1", 1, 0, 1, true);
  });

  it("starts Cursor session and reuses shared chat view", async () => {
    const { getByTestId } = render(
      <CursorSdkSessionView sessionId="t1" cwd="/repo" model="composer-2.5" isNew />,
    );

    await waitFor(() => {
      expect(mocks.startSession).toHaveBeenCalledWith({
        threadId: "t1",
        directory: "/repo",
        model: "composer-2.5",
        mode: "agent",
        permissionMode: expect.stringMatching(/^(default|auto|full)$/),
        resumeAgentId: null,
      });
      expect(getByTestId("shared-chat").getAttribute("data-ready")).toBe("true");
    });
    expect(getByTestId("shared-chat").getAttribute("data-provider")).toBe("Cursor");
  });

  it("treats an existing Cursor sdk_session_id as ready on first paint", async () => {
    mocks.startSession.mockImplementation(() => new Promise(() => {}));
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "t-live",
            project_id: "p1",
            sdk_session_id: "agent-live",
          } as never,
        ],
      },
    } as never);
    const { getByTestId } = render(
      <CursorSdkSessionView sessionId="t-live" cwd="/repo" model="claude-fable-5-1" />,
    );
    expect(getByTestId("shared-chat").getAttribute("data-ready")).toBe("true");
  });

  it("maps image mediaType and current Cursor mode when sending", async () => {
    render(<CursorSdkSessionView sessionId="t1" cwd="/repo" model="composer-2.5" isNew />);

    await waitFor(() => expect(mocks.startSession).toHaveBeenCalled());
    const transport = (globalThis as { __cursorTransport?: ChatTransport }).__cursorTransport!;
    await transport.setPermissionMode!("t1", "plan");
    await transport.send("t1", "look", [{ data: "abc", mediaType: "image/png" }]);

    expect(mocks.setPermissionMode).toHaveBeenCalledWith("t1", "plan");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "t1",
      "look",
      [{ data: "abc", mimeType: "image/png" }],
      { mode: "plan", permissionMode: expect.any(String) },
    );
  });

  it("restores Cursor agent logs through the shared chat history adapter", async () => {
    mocks.getHistory.mockResolvedValueOnce([
      {
        id: "1",
        thread_id: "t1",
        direction: "Input",
        content: "hi",
        timestamp: "2026-06-02T00:00:00Z",
        log_type: "text",
      },
      {
        id: "2",
        thread_id: "t1",
        direction: "Output",
        content: "hello",
        timestamp: "2026-06-02T00:00:01Z",
        log_type: "text",
      },
    ]);
    render(<CursorSdkSessionView sessionId="t1" cwd="/repo" model="composer-2.5" />);

    await waitFor(() => expect(mocks.startSession).toHaveBeenCalled());
    const transport = (globalThis as { __cursorTransport?: ChatTransport }).__cursorTransport!;
    const restored = await transport.loadHistory!("t1");

    expect(restored.map((item) => item.itemType)).toEqual(["UserMessage", "AssistantText"]);
  });
});
