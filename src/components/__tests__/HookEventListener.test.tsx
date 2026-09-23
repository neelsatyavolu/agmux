/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/commands", () => ({
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  refreshClaudePtyThreadModel: vi.fn().mockResolvedValue(null),
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/notifications", () => ({
  sendNotification: vi.fn(),
  providerizeNotification: vi.fn((_sessionId: string, title: string, body: string) => ({
    title,
    body,
  })),
}));

vi.mock("../../lib/agentToast", () => ({
  markTurnStart: vi.fn(),
}));

vi.mock("../../lib/geminiPermissionPrompt", () => ({
  waitForGeminiPermissionPrompt: vi.fn().mockResolvedValue(false),
  waitForGeminiPermissionMenuGone: vi.fn().mockResolvedValue(false),
}));

import { HookEventListener, areHooksGloballyRegistered } from "../HookEventListener";
import { useUiStore } from "../../stores/uiStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { useThreadStore } from "../../stores/threadStore";
import {
  waitForGeminiPermissionMenuGone,
  waitForGeminiPermissionPrompt,
} from "../../lib/geminiPermissionPrompt";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HookEventListener", () => {
  it("renders nothing visible (returns null)", () => {
    const { container } = render(<HookEventListener />);
    expect(container.firstChild).toBeNull();
  });

  it("registers hooks globally while mounted", () => {
    const { unmount } = render(<HookEventListener />);
    expect(areHooksGloballyRegistered()).toBe(true);
    unmount();
    expect(areHooksGloballyRegistered()).toBe(false);
  });

  it("supports multiple mounts (refcount)", () => {
    const a = render(<HookEventListener />);
    const b = render(<HookEventListener />);
    expect(areHooksGloballyRegistered()).toBe(true);
    a.unmount();
    expect(areHooksGloballyRegistered()).toBe(true);
    b.unmount();
    expect(areHooksGloballyRegistered()).toBe(false);
  });

  it("starts unregistered before any mount", () => {
    expect(areHooksGloballyRegistered()).toBe(false);
  });

  it("does not double-mount when same component is rerendered", () => {
    const { rerender } = render(<HookEventListener />);
    expect(areHooksGloballyRegistered()).toBe(true);
    rerender(<HookEventListener />);
    expect(areHooksGloballyRegistered()).toBe(true);
  });

  it("returns null repeatedly on remount", () => {
    const a = render(<HookEventListener />);
    expect(a.container.firstChild).toBeNull();
    a.unmount();
    const b = render(<HookEventListener />);
    expect(b.container.firstChild).toBeNull();
    b.unmount();
  });
});

/**
 * Capture the registered listen callbacks per channel so we can fire synthetic
 * events through them and observe store/effect side-effects.
 */
function captureListeners(): Record<string, (e: any) => void> {
  const cbs: Record<string, (e: any) => void> = {};
  vi.mocked(listen).mockImplementation(((channel: string, cb: any) => {
    cbs[channel] = cb;
    return Promise.resolve(() => {});
  }) as never);
  return cbs;
}

describe("HookEventListener — Deep coverage (event handling)", () => {
  beforeEach(() => {
    useUiStore.setState({ claudeSessionMap: {} } as never);
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "grok-thread-1",
            sdk_session_id: null,
            model: null,
          } as never,
        ],
      },
    } as never);
  });

  it("registers hook and session-bind event channels", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    expect(cbs["claude-hook"]).toBeTypeOf("function");
    expect(cbs["kimi-hook"]).toBeTypeOf("function");
    expect(cbs["droid-hook"]).toBeTypeOf("function");
    expect(cbs["cline-hook"]).toBeTypeOf("function");
    expect(cbs["gemini-hook"]).toBeTypeOf("function");
    expect(cbs["hermes-hook"]).toBeTypeOf("function");
    expect(cbs["pi-hook"]).toBeTypeOf("function");
    expect(cbs["opencode-hook"]).toBeTypeOf("function");
    expect(cbs["claude-session-diff-updated"]).toBeTypeOf("function");
    expect(cbs["session-title-prompt"]).toBeTypeOf("function");
    expect(cbs["session-processing"]).toBeTypeOf("function");
    expect(cbs["sdk-session-id-bound"]).toBeTypeOf("function");
    expect(cbs["thread-grok-updated"]).toBeTypeOf("function");
  });

  it("session-title-prompt summarizes remote chat sends into sessionNameStore", async () => {
    const summarize = vi.spyOn(useSessionNameStore.getState(), "summarize");
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["session-title-prompt"]({
      payload: { threadId: "remote-g1", text: "fix the remote title bug" },
    });
    expect(summarize).toHaveBeenCalledWith(
      "remote-g1",
      "fix the remote title bug",
      "sdk",
    );
    summarize.mockRestore();
  });

  it("session-processing drives the desktop sidebar spinner for headless chat", async () => {
    const setClaudeProcessing = vi.spyOn(useUiStore.getState(), "setClaudeProcessing");
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["session-processing"]({
      payload: { threadId: "remote-g1", processing: true },
    });
    expect(setClaudeProcessing).toHaveBeenCalledWith("remote-g1", true);
    cbs["session-processing"]({
      payload: { threadId: "remote-g1", processing: false },
    });
    expect(setClaudeProcessing).toHaveBeenCalledWith("remote-g1", false);
    setClaudeProcessing.mockRestore();
  });

  it("processes claude-session-diff-updated by writing diff stats to uiStore", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-session-diff-updated"]({
      payload: {
        repoPath: "/repo",
        sessionId: "real-1",
        linesAdded: 10,
        linesRemoved: 4,
        filesChanged: 2,
      },
    });
    const stats = useUiStore.getState().claudeSessionDiffStatsById?.["real-1"];
    expect(stats).toBeTruthy();
    expect(stats?.linesAdded).toBe(10);
    expect(stats?.linesRemoved).toBe(4);
    expect(stats?.filesChanged).toBe(2);
  });

  it("mirrors claude-session-diff-updated onto mapped ClaudeCode thread rows", async () => {
    useUiStore.setState({
      claudeSessionMap: { "claude-thread-1": ["real-1"] },
    } as never);
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "claude-thread-1",
            provider: "ClaudeCode",
            lines_added: 0,
            lines_removed: 0,
            files_changed: 0,
          } as never,
        ],
      },
    } as never);

    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-session-diff-updated"]({
      payload: {
        repoPath: "/repo",
        sessionId: "real-1",
        linesAdded: 12,
        linesRemoved: 3,
        filesChanged: 2,
      },
    });

    const thread = useThreadStore.getState().threads.p1[0];
    expect(thread.lines_added).toBe(12);
    expect(thread.lines_removed).toBe(3);
    expect(thread.files_changed).toBe(2);
  });

  it("hermes prompt-submit names the thread and turns the spinner on", async () => {
    const summarize = vi.spyOn(useSessionNameStore.getState(), "summarize");
    const setThreadModel = vi.spyOn(useThreadStore.getState(), "setThreadModel");
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["hermes-hook"]({
      payload: {
        event: "prompt-submit",
        session_id: "hermes-thread-1",
        payload: {
          hook_event_name: "pre_llm_call",
          session_id: "20260825_180938_5bc807",
          extra: { user_message: "fix the hermes title", model: "gpt-5.4-mini" },
        },
      },
    });
    expect(summarize).toHaveBeenCalledWith(
      "hermes-thread-1",
      "fix the hermes title",
      undefined,
    );
    expect(useUiStore.getState().claudeProcessingById["hermes-thread-1"]).toBe(true);
    expect(setThreadModel).toHaveBeenCalledWith("hermes-thread-1", "gpt-5.4-mini");
    summarize.mockRestore();
    setThreadModel.mockRestore();
  });

  it("hydrates Grok thread session id and model from thread-grok-updated", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();

    cbs["thread-grok-updated"]({
      payload: {
        thread_id: "grok-thread-1",
        session_id: "grok-session-1",
        model: "grok-build",
      },
    });

    const thread = useThreadStore.getState().threads.p1[0];
    expect(thread.sdk_session_id).toBe("grok-session-1");
    expect(thread.model).toBe("grok-build");
  });

  it("ignores thread-grok-updated without session_id so claim is not wiped", async () => {
    // Regression: grok_sdk used to emit thread_id + model only; writing
    // undefined into sdk_session_id left the chat's on-disk session visible
    // as a discovered terminal row forever.
    useThreadStore.getState().setThreadProviderSessionId("grok-thread-1", "already-claimed");
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();

    cbs["thread-grok-updated"]({
      payload: {
        thread_id: "grok-thread-1",
        model: "grok-build",
      },
    });

    const thread = useThreadStore.getState().threads.p1[0];
    expect(thread.sdk_session_id).toBe("already-claimed");
    expect(thread.model).toBe("grok-build");
  });

  it("hydrates Claude SDK thread session id from sdk-session-id-bound", async () => {
    // Remote Claude chat never mounts ClaudeSdkSessionView; without this
    // claim the auto-generated JSONL shows up as a discovered terminal twin.
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "claude-sdk-1",
            sdk_session_id: null,
            interaction_mode: "sdk",
            model: null,
          } as never,
        ],
      },
    } as never);
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();

    cbs["sdk-session-id-bound"]({
      payload: {
        threadId: "claude-sdk-1",
        sessionId: "claude-jsonl-uuid",
      },
    });

    const thread = useThreadStore.getState().threads.p1[0];
    expect(thread.sdk_session_id).toBe("claude-jsonl-uuid");
  });

  it("ignores sdk-session-id-bound without sessionId so claim is not wiped", async () => {
    useThreadStore.setState({
      threads: {
        p1: [
          {
            id: "claude-sdk-1",
            sdk_session_id: "already-claimed",
            interaction_mode: "sdk",
            model: null,
          } as never,
        ],
      },
    } as never);
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();

    cbs["sdk-session-id-bound"]({
      payload: { threadId: "claude-sdk-1" },
    });

    const thread = useThreadStore.getState().threads.p1[0];
    expect(thread.sdk_session_id).toBe("already-claimed");
  });

  it("ignores unknown event types (returns no SessionEvent)", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    expect(() =>
      cbs["claude-hook"]({
        payload: { event: "totally-unknown-event", session_id: "s1", payload: {} },
      })
    ).not.toThrow();
  });

  it("treats prompt-text as summarize-only (no state-machine transition)", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: { event: "prompt-text", session_id: "s1", payload: { text: "hello" } },
    });
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("calls summarize for prompt-submit events", async () => {
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "prompt-submit",
        session_id: "s1",
        payload: { message: "do the thing" },
      },
    });
    expect(summarizeSpy).toHaveBeenCalled();
  });

  it("Grok: passes mode=sdk for <user_query>/slash skill invokes", async () => {
    // Regression: Grok wraps `/checkagentsdk` in <user_query>, so a raw
    // startsWith("/") check never set mode=sdk and summarize skipped bare slash.
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    render(<HookEventListener />);
    await Promise.resolve();

    const prompt = [
      "<user_query>",
      "/checkagentsdk",
      "</user_query>",
      "<skill_information>",
      '<skill name="checkagentsdk">',
      "Check for Claude Agent SDK updates.",
      "</skill>",
      "</skill_information>",
    ].join("\n");

    cbs["claude-hook"]({
      payload: {
        event: "prompt-submit",
        session_id: "grok-thread-slash",
        provider: "grok",
        payload: { prompt },
      },
    });

    expect(summarizeSpy).toHaveBeenCalledWith(
      "grok-thread-slash",
      prompt,
      "sdk",
    );
  });

  it("Kimi: flattens content-block prompt for summarize + spinner (live shape)", async () => {
    // Regression: kimi UserPromptSubmit sends prompt as [{type,text}], and the
    // old string cast made promptText.trimStart throw — killing spinner + naming.
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([{ type: "set_processing", value: true } as never]);
    render(<HookEventListener />);
    await Promise.resolve();

    const threadId = "test-kimi-thread-uuid-0001";
    expect(() =>
      cbs["kimi-hook"]({
        payload: {
          event: "prompt-submit",
          session_id: threadId,
          payload: {
            hook_event_name: "UserPromptSubmit",
            session_id: "session_481c82c7-b515-4372-b8cc-027ac112acb1",
            cwd: "/private/tmp",
            client_type: "kimi_code_cli",
            prompt: [
              {
                type: "text",
                text: "Reply with exactly: KIMI_HOOK_TEST_OK. Do not use tools.",
              },
            ],
            is_steer: false,
          },
        },
      }),
    ).not.toThrow();

    expect(summarizeSpy).toHaveBeenCalledWith(
      threadId,
      "Reply with exactly: KIMI_HOOK_TEST_OK. Do not use tools.",
      undefined,
    );
    expect(transitionSpy).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        type: "prompt_submit",
        promptText: "Reply with exactly: KIMI_HOOK_TEST_OK. Do not use tools.",
        isSlashCommand: false,
      }),
    );
  });

  it("Kimi: stop + pre-tool-use drive state machine (completion + re-arm)", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();

    const threadId = "test-kimi-thread-uuid-0002";
    cbs["kimi-hook"]({
      payload: {
        event: "prompt-submit",
        session_id: threadId,
        payload: {
          prompt: [{ type: "text", text: "Run the shell command: echo PERM_TEST." }],
        },
      },
    });
    cbs["kimi-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: threadId,
        payload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo PERM_TEST" },
        },
      },
    });
    cbs["kimi-hook"]({
      payload: {
        event: "stop",
        session_id: threadId,
        payload: {
          hook_event_name: "Stop",
          stop_hook_active: false,
        },
      },
    });

    const events = transitionSpy.mock.calls.map(([, ev]) => (ev as { type: string }).type);
    expect(events).toEqual(["prompt_submit", "pre_tool_use", "stop"]);
  });

  it("Kimi: permission-request becomes awaiting-approval notification", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();

    cbs["kimi-hook"]({
      payload: {
        event: "permission-request",
        session_id: "kimi-perm",
        payload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        },
      },
    });

    expect(transitionSpy).toHaveBeenCalledWith(
      "kimi-perm",
      expect.objectContaining({
        type: "notification",
        category: "permission",
      }),
    );
  });

  it("does not summarize when prompt-submit text is empty", async () => {
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "prompt-submit",
        session_id: "s1",
        payload: {},
      },
    });
    expect(summarizeSpy).not.toHaveBeenCalled();
  });

  it("dispatches a transitionSessionBridged for stop events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: { event: "stop", session_id: "s1", payload: {} },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("dispatches a transitionSessionBridged for session-start events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["kimi-hook"]({
      payload: { event: "session-start", session_id: "s1", payload: {} },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("dispatches transitionSessionBridged for pre-tool-use events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: "s1",
        payload: { tool_name: "Bash" },
      },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("dispatches a transitionSessionBridged for notification events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["opencode-hook"]({
      payload: { event: "notification", session_id: "s1", payload: { msg: "hi" } },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("dispatches transitionSessionBridged for permission-request events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "permission-request",
        session_id: "s1",
        payload: { tool_name: "Bash" },
      },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("dispatches transitionSessionBridged for session-end events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["kimi-hook"]({
      payload: { event: "session-end", session_id: "s1", payload: {} },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("rewrites kimi notification 'waiting' to 'permission'", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["kimi-hook"]({
      payload: {
        event: "notification",
        session_id: "s1",
        payload: { type: "waiting", message: "x" },
      },
    });
    // Find the call with waiting → permission rewrite
    const call = transitionSpy.mock.calls.find(
      ([_sid, ev]: any) => ev?.type === "notification"
    );
    expect(call).toBeTruthy();
  });

  it("processes prompt-submit through different prompt fields", async () => {
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    render(<HookEventListener />);
    await Promise.resolve();
    // 'prompt' field
    cbs["claude-hook"]({
      payload: { event: "prompt-submit", session_id: "s1", payload: { prompt: "p1" } },
    });
    // 'body' field
    cbs["claude-hook"]({
      payload: { event: "prompt-submit", session_id: "s1", payload: { body: "p2" } },
    });
    // 'text' field
    cbs["claude-hook"]({
      payload: { event: "prompt-submit", session_id: "s1", payload: { text: "p3" } },
    });
    expect(summarizeSpy).toHaveBeenCalledTimes(3);
  });

  it("handles prompt-text events that summarize but don't transition", async () => {
    const cbs = captureListeners();
    const summarizeSpy = vi
      .spyOn(useSessionNameStore.getState(), "summarize")
      .mockImplementation(() => {});
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: { event: "prompt-text", session_id: "s1", payload: { text: "txt" } },
    });
    expect(summarizeSpy).toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("safely handles null payloads", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    expect(() =>
      cbs["claude-hook"]({
        payload: { event: "prompt-submit", session_id: "s1", payload: null },
      })
    ).not.toThrow();
  });

  it("processes stop event without crashing when claudeSessionMap empty", async () => {
    const cbs = captureListeners();
    render(<HookEventListener />);
    await Promise.resolve();
    expect(() =>
      cbs["claude-hook"]({
        payload: { event: "stop", session_id: "real-id", payload: {} },
      })
    ).not.toThrow();
  });

  it("listens on opencode-hook channel for opencode events", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["opencode-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: "oc1",
        payload: { tool_name: "Read" },
      },
    });
    expect(transitionSpy).toHaveBeenCalled();
  });

  it("cleans up timers on unmount", () => {
    const { unmount } = render(<HookEventListener />);
    expect(() => unmount()).not.toThrow();
  });

  it("does not finish a Grok terminal when a subagent Stop arrives", async () => {
    // Grok spawn_subagent workers inherit AGMUX_THREAD_ID. Their Stop must
    // not drive the parent session to idle (completion toast while the
    // primary agent is still working).
    useThreadStore.setState({
      threads: { p1: [{ id: "grok-thread-1", provider: "Grok" } as never] },
    } as never);
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "stop",
        session_id: "grok-thread-1",
        payload: {
          hookEventName: "stop",
          sessionId: "worker-sid",
          subagentType: "explore",
        },
      },
    });
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("still finishes a Grok terminal on the primary agent's Stop", async () => {
    useThreadStore.setState({
      threads: { p1: [{ id: "grok-thread-1", provider: "Grok" } as never] },
    } as never);
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "stop",
        session_id: "grok-thread-1",
        payload: { hookEventName: "stop", sessionId: "primary-sid" },
      },
    });
    expect(transitionSpy).toHaveBeenCalledWith("grok-thread-1", { type: "stop" });
  });

  it("clears the amber pulse on grok post-tool-use (dispatches user_accepted)", async () => {
    // Grok terminal fires no hook for permission prompts — the approval is
    // synthesized from a `notification` event. Grok DOES fire post-tool-use,
    // which we treat as user_accepted so the amber pulse clears once the
    // approved tool finishes.
    useThreadStore.setState({
      threads: { p1: [{ id: "grok-thread-1", provider: "Grok" } as never] },
    } as never);
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: {
        event: "post-tool-use",
        session_id: "grok-thread-1",
        payload: { toolName: "run_command" },
      },
    });
    const call = transitionSpy.mock.calls.find(
      ([sid]: any) => sid === "grok-thread-1"
    );
    expect(call?.[1]).toEqual({ type: "user_accepted" });
  });

  it("Gemini: pre-tool-use keeps the spinner without raising amber when no TUI card", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["gemini-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: "gem-1",
        payload: { toolCall: { name: "view_file", args: { Path: "a.ts" } } },
      },
    });
    await Promise.resolve();
    expect(transitionSpy).toHaveBeenCalledWith(
      "gem-1",
      expect.objectContaining({ type: "pre_tool_use", toolName: "view_file" }),
    );
    expect(
      transitionSpy.mock.calls.some(
        ([, ev]) => (ev as { type: string; category?: string }).category === "permission",
      ),
    ).toBe(false);
  });

  it("Gemini: live permission card raises a permission notification", async () => {
    vi.mocked(waitForGeminiPermissionPrompt).mockResolvedValueOnce(true);
    vi.mocked(waitForGeminiPermissionMenuGone).mockResolvedValueOnce(false);
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["gemini-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: "gem-1",
        payload: {
          toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
        },
      },
    });
    await vi.waitFor(() => {
      expect(transitionSpy).toHaveBeenCalledWith(
        "gem-1",
        expect.objectContaining({ type: "notification", category: "permission" }),
      );
    });
  });

  it("Gemini: ask_permission PreToolUse surfaces attention immediately", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["gemini-hook"]({
      payload: {
        event: "pre-tool-use",
        session_id: "gem-1",
        payload: { toolCall: { name: "ask_permission" } },
      },
    });
    expect(transitionSpy).toHaveBeenCalledWith(
      "gem-1",
      expect.objectContaining({
        type: "pre_tool_use",
        toolName: "ask_permission",
        question: "Permission needed",
      }),
    );
  });

  it("Gemini: post-tool-use clears amber (user_accepted)", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["gemini-hook"]({
      payload: {
        event: "post-tool-use",
        session_id: "gem-1",
        payload: { toolCall: { name: "run_command" } },
      },
    });
    expect(transitionSpy).toHaveBeenCalledWith("gem-1", { type: "user_accepted" });
  });

  it("ignores post-tool-use for non-grok threads (no transition)", async () => {
    useThreadStore.setState({
      threads: { p1: [{ id: "claude-thread-1", provider: "ClaudeCode" } as never] },
    } as never);
    const cbs = captureListeners();
    const transitionSpy = vi.spyOn(useUiStore.getState(), "transitionSessionBridged");
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: { event: "post-tool-use", session_id: "claude-thread-1", payload: {} },
    });
    expect(transitionSpy).not.toHaveBeenCalled();
  });

  it("transitionSessionBridged is called with the correct session_id", async () => {
    const cbs = captureListeners();
    const transitionSpy = vi
      .spyOn(useUiStore.getState(), "transitionSessionBridged")
      .mockReturnValue([]);
    render(<HookEventListener />);
    await Promise.resolve();
    cbs["claude-hook"]({
      payload: { event: "stop", session_id: "session-xyz", payload: {} },
    });
    expect(transitionSpy.mock.calls[0]?.[0]).toBe("session-xyz");
  });
});
