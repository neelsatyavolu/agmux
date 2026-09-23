/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const claudeSdkSessionViewSpy = vi.fn();
vi.mock("../ClaudeSdkSessionView", () => ({
  ClaudeSdkSessionView: (props: unknown) => {
    claudeSdkSessionViewSpy(props);
    return <div data-testid="claude-sdk-session-view" />;
  },
}));
vi.mock("../OpenCodeThinkingIndicator", () => ({
  OpenCodeThinkingIndicator: () => <div data-testid="thinking-indicator" />,
}));
const setThreadProviderSessionId = vi.fn();
vi.mock("../../../stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (state: { threads: Record<string, never[]> }) => unknown) => selector({ threads: {} }),
    { getState: () => ({ setThreadProviderSessionId }) },
  ),
}));
vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  grokSdkEnsureServer: vi.fn().mockResolvedValue("grok-session-1"),
  grokSdkRestart: vi.fn().mockResolvedValue("grok-session-2"),
  grokSdkSendPrompt: vi.fn(),
  grokSdkCancel: vi.fn(),
  grokSdkRespondApproval: vi.fn(),
  grokSdkSetPermissionMode: vi.fn(),
  grokSdkReadChatHistory: vi
    .fn()
    .mockResolvedValue({ historyLines: [], failedToolCallIds: [] }),
  getGrokPtySessionUsage: vi.fn().mockResolvedValue({
    model: "grok-build",
    context_tokens_used: 22_254,
    context_window_tokens: 512_000,
  }),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));

import { GrokSdkSessionView } from "../GrokSdkSessionView";
import {
  getGrokPtySessionUsage,
  grokSdkEnsureServer,
  grokSdkReadChatHistory,
  grokSdkRespondApproval,
  grokSdkRestart,
  grokSdkSendPrompt,
  grokSdkSetPermissionMode,
} from "../../../lib/commands";
import type { ChatTransport } from "../ClaudeSdkSessionView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GrokSdkSessionView", () => {
  it("claims the ACP session id on the thread so sidebar can hide the terminal twin", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    await waitFor(() => {
      expect(grokSdkEnsureServer).toHaveBeenCalledWith("thread-1", "/tmp/repo", undefined);
      expect(setThreadProviderSessionId).toHaveBeenCalledWith("thread-1", "grok-session-1");
    });
  });

  it("passes real Grok disk context usage into the shared SDK chrome", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    await waitFor(() => {
      expect(getGrokPtySessionUsage).toHaveBeenCalledWith("grok-session-1", "/tmp/repo");
      expect(claudeSdkSessionViewSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerOverride: "Grok",
          externalContextUsage: expect.objectContaining({
            usedTokens: 22_254,
            maxTokens: 512_000,
          }),
        }),
      );
    });
  });

  it("uses the Grok model context window when signals has not written one yet", async () => {
    vi.mocked(getGrokPtySessionUsage).mockResolvedValueOnce({
      model: "grok-build",
      context_tokens_used: 18_432,
      context_window_tokens: 0,
    });

    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    await waitFor(() => {
      expect(claudeSdkSessionViewSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          externalContextUsage: expect.objectContaining({
            usedTokens: 18_432,
            maxTokens: 512_000,
          }),
        }),
      );
    });
  });

  it("forwards the approval decision verbatim — the Rust ACP client resolves the optionId", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { transport?: ChatTransport };
      transport = props?.transport;
      expect(transport).toBeDefined();
    });

    // requestId is a stringified ACP u64 — must be parsed back to a number.
    await transport!.respondApproval("thread-1", "42", "allow");
    expect(grokSdkRespondApproval).toHaveBeenCalledWith("thread-1", 42, "allow");

    await transport!.respondApproval("thread-1", "7", "deny");
    expect(grokSdkRespondApproval).toHaveBeenCalledWith("thread-1", 7, "deny");
  });

  it("forwards attached images as vision blocks instead of dropping them", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as {
        transport?: ChatTransport;
        externalSessionReady?: boolean;
      };
      expect(props?.externalSessionReady).toBe(true);
      transport = props?.transport;
    });

    await transport!.send("thread-1", "what is this?", [
      { data: "abc123", mediaType: "image/png" },
    ]);
    expect(grokSdkSendPrompt).toHaveBeenCalledWith("thread-1", "grok-session-1", "what is this?", [
      { data: "abc123", mediaType: "image/png" },
    ]);
  });

  it("treats thinking-only Grok transcripts as empty so agent_logs can restore", async () => {
    vi.mocked(grokSdkReadChatHistory).mockResolvedValueOnce({
      historyLines: [
        JSON.stringify({ type: "system", content: "You are Grok." }),
        JSON.stringify({
          type: "reasoning",
          summary: [{ type: "summary_text", text: "planning" }],
        }),
      ],
      failedToolCallIds: [],
    });
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { transport?: ChatTransport };
      transport = props?.transport;
      expect(transport?.loadHistory).toBeDefined();
    });

    await expect(transport!.loadHistory!("thread-1")).resolves.toEqual([]);
  });

  it("restores Grok history that includes a real user turn", async () => {
    vi.mocked(grokSdkReadChatHistory).mockResolvedValueOnce({
      historyLines: [
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: "<user_query>hello</user_query>" }],
        }),
        JSON.stringify({ type: "assistant", content: "hi" }),
      ],
      failedToolCallIds: [],
    });
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { transport?: ChatTransport };
      transport = props?.transport;
      expect(transport?.loadHistory).toBeDefined();
    });

    const items = await transport!.loadHistory!("thread-1");
    expect(items.some((item) => item.itemType === "UserMessage")).toBe(true);
  });

  it("changes permission mode at runtime without restarting the process", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { transport?: ChatTransport };
      transport = props?.transport;
      expect(transport).toBeDefined();
    });

    await transport!.setPermissionMode!("thread-1", "bypassPermissions");
    // `grok agent stdio` ignores `--permission-mode`, so a mode change is a
    // runtime update — never a process restart (which would drop the session).
    expect(grokSdkSetPermissionMode).toHaveBeenCalledWith("thread-1", "bypassPermissions");
    expect(grokSdkRestart).not.toHaveBeenCalled();
  });

  it("keeps the same context-usage object reference across polls when values are unchanged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    await waitFor(() => expect(getGrokPtySessionUsage).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(claudeSdkSessionViewSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          externalContextUsage: expect.objectContaining({ usedTokens: 22_254 }),
        }),
      );
    });
    const calls1 = claudeSdkSessionViewSpy.mock.calls;
    const lastCall = calls1[calls1.length - 1]?.[0] as {
      externalContextUsage: unknown;
    };
    const usageRef1 = lastCall.externalContextUsage;

    // Next 2.5s poll tick resolves with the exact same values — the
    // shallow-compare guard in GrokSdkSessionView should bail out of the
    // setState call, so the externalContextUsage object reference passed
    // down must stay identical (no needless re-render of the chat chrome).
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() => expect(getGrokPtySessionUsage).toHaveBeenCalledTimes(2));
    // Give the resolved promise's .then callback a turn to run.
    await act(async () => {
      await Promise.resolve();
    });
    const calls2 = claudeSdkSessionViewSpy.mock.calls;
    const lastCallAfterPoll = calls2[calls2.length - 1]?.[0] as {
      externalContextUsage: unknown;
    };
    expect(lastCallAfterPoll.externalContextUsage).toBe(usageRef1);

    // A genuinely different snapshot should still flow through with a new object.
    vi.mocked(getGrokPtySessionUsage).mockResolvedValueOnce({
      model: "grok-build",
      context_tokens_used: 30_000,
      context_window_tokens: 512_000,
    });
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() => {
      expect(claudeSdkSessionViewSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          externalContextUsage: expect.objectContaining({ usedTokens: 30_000 }),
        }),
      );
    });
  });

  it("applies a new effort by respawning the grok process", async () => {
    render(<GrokSdkSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    let transport: ChatTransport | undefined;
    await waitFor(() => {
      const calls = claudeSdkSessionViewSpy.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { transport?: ChatTransport };
      transport = props?.transport;
      expect(transport).toBeDefined();
    });

    // Effort is a spawn flag — restart takes the bare effort string.
    await transport!.setEffort!("thread-1", "high");
    expect(grokSdkRestart).toHaveBeenCalledWith("thread-1", "/tmp/repo", "high");
  });
});
