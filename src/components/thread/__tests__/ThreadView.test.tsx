/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, screen, act } from "@testing-library/react";

// Mock terminal-importing children so the test runner avoids xterm.js.
vi.mock("../TerminalView", () => ({
  TerminalView: ({ isActive }: { isActive?: boolean }) => <div data-testid="terminal-view" data-active={String(isActive)} />,
}));
vi.mock("../ClaudeTerminalView", () => ({
  ClaudeTerminalView: () => <div data-testid="claude-terminal-view" />,
}));
vi.mock("../TerminalPanel", () => ({
  default: () => <div data-testid="terminal-panel" />,
}));
vi.mock("../ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
}));
vi.mock("../InputBar", () => ({
  InputBar: () => <div data-testid="input-bar" />,
}));
vi.mock("../JournalPanel", () => ({
  JournalPanel: () => <div data-testid="journal-panel" />,
}));
const threadTopBarSpy = vi.fn();
vi.mock("../ThreadTopBar", () => ({
  ThreadTopBar: (props: unknown) => {
    threadTopBarSpy(props);
    return <div data-testid="thread-top-bar" />;
  },
}));
vi.mock("../GitSidebar", () => ({
  GitSidebar: () => <div data-testid="git-sidebar" />,
}));
vi.mock("../OpenCodeSdkSessionView", () => ({
  OpenCodeSdkSessionView: () => <div data-testid="opencode-sdk-session-view" />,
}));
const cursorSdkSessionViewSpy = vi.fn();
vi.mock("../CursorSdkSessionView", () => ({
  CursorSdkSessionView: (props: unknown) => {
    cursorSdkSessionViewSpy(props);
    return <div data-testid="cursor-sdk-session-view" />;
  },
}));
const grokSdkSessionViewSpy = vi.fn();
vi.mock("../GrokSdkSessionView", () => ({
  GrokSdkSessionView: (props: unknown) => {
    grokSdkSessionViewSpy(props);
    return <div data-testid="grok-sdk-session-view" />;
  },
}));
const geminiSdkSessionViewSpy = vi.fn();
vi.mock("../GeminiSessionView", () => ({
  GeminiSessionView: (props: unknown) => {
    geminiSdkSessionViewSpy(props);
    return <div data-testid="gemini-sdk-session-view" />;
  },
}));
vi.mock("../../layout/EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendPtyInput: vi.fn().mockResolvedValue(undefined),
    spawnThread: vi.fn().mockResolvedValue(undefined),
    stopThread: vi.fn().mockResolvedValue(undefined),
    getGrokPtySessionUsage: vi.fn().mockResolvedValue(null),
    getKimiPtySessionUsage: vi.fn().mockResolvedValue(null),
    getHermesPtySessionUsage: vi.fn().mockResolvedValue(null),
  };
});

import { ThreadView } from "../ThreadView";
import type { Thread } from "../../../lib/types";
import { useThreadStore } from "../../../stores/threadStore";
import { useProjectStore } from "../../../stores/projectStore";
import { useUiStore } from "../../../stores/uiStore";
import { SessionPresentationContext } from "../../../hooks/useIsSessionActive";
import {
  getGrokPtySessionUsage,
  getHermesPtySessionUsage,
  getKimiPtySessionUsage,
  sendPtyInput,
  spawnThread,
  stopThread,
} from "../../../lib/commands";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    project_id: "p1",
    provider: "ClaudeCode",
    interaction_mode: "pty",
    status: "Idle",
    name: "Test Thread",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    model: null,
    ...(overrides as Record<string, unknown>),
  } as unknown as Thread;
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.useRealTimers();
  threadTopBarSpy.mockClear();
  cursorSdkSessionViewSpy.mockClear();
  vi.mocked(sendPtyInput).mockClear();
  vi.mocked(spawnThread).mockClear().mockResolvedValue(undefined);
  vi.mocked(stopThread).mockClear().mockResolvedValue(undefined);
  useUiStore.setState({
    pendingFirstMessages: {},
    pendingFirstImages: {},
    threadViewMode: "terminal",
    sessionViewModeByKey: {},
    sidebarTab: "agents",
    selectedThreadId: null,
    claudeProcessingById: {},
    pendingApprovalsBySession: {},
  } as never);
  useThreadStore.setState({ threads: { p1: [] } } as never);
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "Test",
        repo_path: "/tmp/repo",
        conventions: null,
        created_at: new Date().toISOString(),
        last_opened_at: new Date().toISOString(),
      } as never,
    ],
    selectedProjectId: "p1",
  } as never);
});

describe("ThreadView", () => {
  it("honors retained presentation visibility over a stale main-panel selection", async () => {
    useUiStore.setState({ appMode: "agent", selectedThreadId: "t1" });
    vi.mocked(getGrokPtySessionUsage).mockClear();
    const thread = makeThread({ provider: "Grok", status: "Running", sdk_session_id: "native-grok", work_dir: "/tmp/repo" });
    const view = (active: boolean) => (
      <SessionPresentationContext.Provider value={{ id: "t1", active }}>
        <ThreadView thread={thread} />
      </SessionPresentationContext.Provider>
    );
    const { rerender } = render(view(false));
    expect(screen.getByTestId("terminal-view").getAttribute("data-active")).toBe("false");
    expect(getGrokPtySessionUsage).not.toHaveBeenCalled();
    rerender(view(true));
    expect(screen.getByTestId("terminal-view").getAttribute("data-active")).toBe("true");
    await waitFor(() => expect(getGrokPtySessionUsage).toHaveBeenCalledWith("native-grok", "/tmp/repo"));
  });

  it("renders without crashing with an Idle ClaudeCode thread", () => {
    const { container } = render(<ThreadView thread={makeThread()} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders some content for an idle thread", () => {
    const { container } = render(<ThreadView thread={makeThread()} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders OpenCode SDK session view for opencode-sdk threads", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({
          provider: "OpenCode" as never,
          interaction_mode: "opencode-sdk" as never,
        })}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it.each(["Idle", "Done", "Error"] as const)("does not auto-spawn a PTY for an %s OpenCode SDK thread", (status) => {
    render(<ThreadView thread={makeThread({ provider: "OpenCode", interaction_mode: "opencode-sdk", status })} />);
    expect(screen.getByTestId("opencode-sdk-session-view")).toBeTruthy();
    expect(spawnThread).not.toHaveBeenCalled();
  });

  it("still auto-spawns an idle OpenCode PTY thread", () => {
    render(<ThreadView thread={makeThread({ provider: "OpenCode", interaction_mode: "pty", status: "Idle" })} />);
    expect(spawnThread).toHaveBeenCalledWith("t1", expect.any(Object));
  });

  it("marks persisted Grok chat threads as reopen sessions instead of new sessions", () => {
    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "grok-sdk" as never,
          sdk_session_id: "grok-acp-1" as never,
        })}
      />
    );

    expect(grokSdkSessionViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "t1",
        isNew: false,
      }),
    );
  });

  it("renders Gemini chat threads in GeminiSessionView", () => {
    render(
      <ThreadView
        thread={makeThread({
          provider: "Gemini" as never,
          interaction_mode: "gemini-sdk" as never,
          sdk_session_id: "agy-acp-1" as never,
        })}
      />
    );
    expect(geminiSdkSessionViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "t1",
        isNew: false,
      }),
    );
  });

  it("passes Grok terminal model and context metadata into ThreadTopBar", async () => {
    vi.mocked(getGrokPtySessionUsage).mockResolvedValueOnce({
      model: "grok-build",
      context_tokens_used: 39_450,
      context_window_tokens: 512_000,
    });

    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          sdk_session_id: "grok-pty-1" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await waitFor(() => {
      expect(threadTopBarSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSlug: "grok-build",
          contextUsage: expect.objectContaining({
            usedTokens: 39_450,
            maxTokens: 512_000,
          }),
        }),
      );
    });
  });

  it("passes Kimi terminal model and context metadata into ThreadTopBar", async () => {
    vi.mocked(getKimiPtySessionUsage).mockResolvedValueOnce({
      model: "kimi-code/kimi-for-coding",
      context_tokens_used: 28_286,
      context_window_tokens: 262_144,
    });

    render(
      <ThreadView
        thread={makeThread({
          provider: "Kimi" as never,
          interaction_mode: "pty" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await waitFor(() => {
      expect(getKimiPtySessionUsage).toHaveBeenCalledWith("t1");
      expect(threadTopBarSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSlug: "kimi-code/kimi-for-coding",
          contextUsage: expect.objectContaining({
            usedTokens: 28_286,
            maxTokens: 262_144,
          }),
        }),
      );
    });
  });

  it("wires Grok terminal top-bar refresh to claude-terminal-refresh with thread id", async () => {
    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await waitFor(() => {
      expect(threadTopBarSpy).toHaveBeenCalled();
    });

    const lastCall = threadTopBarSpy.mock.calls[threadTopBarSpy.mock.calls.length - 1];
    const lastProps = lastCall?.[0] as {
      onRefreshTerminal?: () => void;
    };
    expect(typeof lastProps.onRefreshTerminal).toBe("function");

    const seen: string[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<{ threadId?: string }>).detail;
      seen.push(detail?.threadId ?? "");
    };
    window.addEventListener("claude-terminal-refresh", listener);
    try {
      lastProps.onRefreshTerminal?.();
      expect(seen).toEqual(["t1"]);
    } finally {
      window.removeEventListener("claude-terminal-refresh", listener);
    }
  });

  it("shows Hermes model and context in the top bar from session usage", async () => {
    vi.mocked(getHermesPtySessionUsage).mockResolvedValueOnce({
      model: "gpt-5.4-mini",
      context_tokens_used: 20_375,
      context_window_tokens: 0,
      lines_added: 0,
      lines_removed: 0,
      files_changed: 0,
    });

    render(
      <ThreadView
        thread={makeThread({
          provider: "Hermes" as never,
          interaction_mode: "pty" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await waitFor(() => {
      expect(threadTopBarSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSlug: "gpt-5.4-mini",
          contextUsage: expect.objectContaining({
            usedTokens: 20_375,
            maxTokens: 272_000,
          }),
        }),
      );
    });
  });

  it("shows mid-turn Grok context using model window when signals are missing", async () => {
    // During a turn, updates.jsonl has totalTokens but signals.json (and thus
    // context_window_tokens) often does not exist yet.
    vi.mocked(getGrokPtySessionUsage).mockResolvedValueOnce({
      model: "grok-4.5",
      context_tokens_used: 79_339,
      context_window_tokens: 0,
    });

    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          sdk_session_id: "grok-pty-mid" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await waitFor(() => {
      expect(threadTopBarSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSlug: "grok-4.5",
          contextUsage: expect.objectContaining({
            usedTokens: 79_339,
            maxTokens: 500_000, // getModelContextWindow("grok-4.5")
          }),
        }),
      );
    });
  });

  it("unloads an inactive idle Grok terminal after 2 minutes and kills PTY+MCP", async () => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: "other-thread",
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
    } as never);

    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    expect(screen.getByTestId("terminal-view")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(screen.getByText("Terminal unloaded to save memory")).toBeTruthy();
    // Aggressive Grok offload: stop the process group so MCP children die.
    expect(stopThread).toHaveBeenCalledWith("t1");
  });

  it("respawns Grok with resume when the offloaded terminal becomes visible again", async () => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: "other-thread",
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
    } as never);

    const { rerender } = render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
          sdk_session_id: "grok-sess-1" as never,
        })}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
    });
    expect(stopThread).toHaveBeenCalledWith("t1");
    expect(screen.queryByTestId("terminal-view")).toBeNull();

    // User focuses the thread again — remount + resume spawn.
    useUiStore.setState({ selectedThreadId: "t1" } as never);
    rerender(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Idle" as never,
          work_dir: "/tmp/repo" as never,
          sdk_session_id: "grok-sess-1" as never,
        })}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    expect(spawnThread).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ enableAutoMode: false }),
    );
  });

  it("does not kill Kimi PTY on terminal unload (xterm-only offload)", async () => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: "other-thread",
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
    } as never);

    render(
      <ThreadView
        thread={makeThread({
          provider: "Kimi" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000);
      await Promise.resolve();
    });

    expect(screen.getByText("Terminal unloaded to save memory")).toBeTruthy();
    expect(stopThread).not.toHaveBeenCalled();
  });

  it("keeps a backgrounded Grok terminal loaded while a permission prompt is pending", () => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: "other-thread",
      claudeProcessingById: {},
      pendingApprovalsBySession: {
        t1: {
          sessionId: "t1",
          toolName: "bash",
          summary: "Permission",
        },
      },
    } as never);

    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    expect(screen.queryByText("Terminal unloaded to save memory")).toBeNull();
  });

  it("keeps a visible idle Grok terminal loaded", () => {
    vi.useFakeTimers();
    useUiStore.setState({
      sidebarTab: "agents",
      selectedThreadId: "t1",
      claudeProcessingById: {},
      pendingApprovalsBySession: {},
    } as never);

    render(
      <ThreadView
        thread={makeThread({
          provider: "Grok" as never,
          interaction_mode: "pty" as never,
          status: "Running" as never,
          work_dir: "/tmp/repo" as never,
        })}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(screen.getByTestId("terminal-view")).toBeTruthy();
  });

  it("renders for a Codex provider thread", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ provider: "Codex" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a Kimi (terminal-only) thread", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ provider: "Kimi" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a Running thread", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ status: "Running" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for an Error thread", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ status: "Error" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a Stopped thread", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ status: "Stopped" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a thread with a sonnet model", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ model: "sonnet" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a thread with an opus model", () => {
    const { container } = render(
      <ThreadView thread={makeThread({ model: "opus" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for a thread with a worktree branch", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({ worktree_branch: "feature/x" as never })}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for ClaudeCode SDK-mode thread", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({
          provider: "ClaudeCode" as never,
          interaction_mode: "sdk" as never,
        })}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders for OpenCode in PTY mode", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({
          provider: "OpenCode" as never,
          interaction_mode: "pty" as never,
        })}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with provider change", () => {
    const { container, rerender } = render(
      <ThreadView thread={makeThread()} />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ThreadView thread={makeThread({ provider: "Codex" as never })} />);
    expect(container.firstChild).toBeTruthy();
    rerender(<ThreadView thread={makeThread({ provider: "Kimi" as never })} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with status change", () => {
    const { container, rerender } = render(
      <ThreadView thread={makeThread({ status: "Idle" as never })} />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ThreadView thread={makeThread({ status: "Running" as never })} />);
    expect(container.firstChild).toBeTruthy();
    rerender(<ThreadView thread={makeThread({ status: "Error" as never })} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("rerenders with thread id change", () => {
    const { container, rerender } = render(
      <ThreadView thread={makeThread({ id: "t1" })} />
    );
    expect(container.firstChild).toBeTruthy();
    rerender(<ThreadView thread={makeThread({ id: "t2" })} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders even with empty project list in store", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
    const { container } = render(<ThreadView thread={makeThread()} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders when threads are populated for the project", () => {
    useThreadStore.setState({
      threads: {
        p1: [
          makeThread({ id: "t1" }) as never,
          makeThread({ id: "t2" }) as never,
        ],
      },
    } as never);
    const { container } = render(<ThreadView thread={makeThread()} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders multiple sequential mounts cleanly", () => {
    const r1 = render(<ThreadView thread={makeThread()} />);
    expect(r1.container.firstChild).toBeTruthy();
    cleanup();
    const r2 = render(
      <ThreadView thread={makeThread({ provider: "Codex" as never })} />
    );
    expect(r2.container.firstChild).toBeTruthy();
    cleanup();
    const r3 = render(
      <ThreadView thread={makeThread({ provider: "Kimi" as never })} />
    );
    expect(r3.container.firstChild).toBeTruthy();
  });

  it("renders for a Codex thread with PTY mode", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({
          provider: "Codex" as never,
          interaction_mode: "pty" as never,
        })}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("renders OpenCode SDK view tag for opencode-sdk threads", () => {
    const { container } = render(
      <ThreadView
        thread={makeThread({
          provider: "OpenCode" as never,
          interaction_mode: "opencode-sdk" as never,
        })}
      />
    );
    // Expect the OpenCode SDK session view stub to be rendered
    expect(
      container.querySelector("[data-testid='opencode-sdk-session-view']")
    ).toBeTruthy();
  });

  it("renders Cursor SDK view without consuming pending first message or terminal fallback", async () => {
    useUiStore.getState().setPendingFirstMessage("t1", "hello cursor");

    const { container } = render(
      <ThreadView
        compact
        thread={makeThread({
          provider: "Cursor" as never,
          interaction_mode: "cursor-sdk" as never,
          work_dir: "/tmp/cursor-repo" as never,
        })}
      />
    );

    await waitFor(() => {
      expect(useUiStore.getState().pendingFirstMessages.t1).toBe("hello cursor");
    });
    expect(cursorSdkSessionViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "t1",
        cwd: "/tmp/cursor-repo",
        model: "composer-2.5",
        isNew: true,
        compact: true,
      }),
    );
    expect(sendPtyInput).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='cursor-sdk-session-view']")).toBeTruthy();
    expect(container.querySelector("[data-testid='terminal-view']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-view']")).toBeNull();
  });
});
