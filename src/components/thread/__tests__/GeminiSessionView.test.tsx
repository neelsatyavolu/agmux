/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, screen } from "@testing-library/react";

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

const { threadStoreState } = vi.hoisted(() => {
  const setThreadProviderSessionId = vi.fn();
  return {
    threadStoreState: {
      threads: {} as Record<string, Array<{ id: string; sdk_session_id?: string | null }>>,
      setThreadProviderSessionId,
      setThreadModel: vi.fn(),
    },
  };
});
vi.mock("../../../stores/threadStore", () => ({
  useThreadStore: {
    getState: () => threadStoreState,
  },
}));
vi.mock("../../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      pendingGrokConfigs: {},
      consumePendingGrokConfig: () => null,
    }),
  },
}));

const geminiSdkEnsureServer = vi.fn();
const geminiSdkSignIn = vi.fn();
vi.mock("../../../lib/commands", () => ({
  geminiSdkEnsureServer: (...args: unknown[]) => geminiSdkEnsureServer(...args),
  geminiSdkRestart: vi.fn(),
  geminiSdkSendPrompt: vi.fn(),
  geminiSdkCancel: vi.fn(),
  geminiSdkRespondApproval: vi.fn(),
  geminiSdkSetPermissionMode: vi.fn(),
  geminiSdkSignIn: (...args: unknown[]) => geminiSdkSignIn(...args),
}));

const authListeners: Array<(event: { payload: { url?: string; threadId?: string } }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((channel: string, cb: (event: { payload: { url?: string; threadId?: string } }) => void) => {
    if (channel === "gemini-auth-url") authListeners.push(cb);
    return Promise.resolve(() => {
      const i = authListeners.indexOf(cb);
      if (i >= 0) authListeners.splice(i, 1);
    });
  }),
}));

import { GeminiSessionView } from "../GeminiSessionView";

afterEach(() => {
  cleanup();
  authListeners.length = 0;
});

beforeEach(() => {
  vi.clearAllMocks();
  authListeners.length = 0;
  geminiSdkEnsureServer.mockReset();
  threadStoreState.threads = {};
});

describe("GeminiSessionView", () => {
  it("keeps sign-in recovery available when authentication has not completed", async () => {
    geminiSdkEnsureServer.mockRejectedValueOnce(new Error("Authentication required"));
    geminiSdkSignIn.mockResolvedValue({ signedIn: false, authUrl: "https://accounts.google.com/signin" });
    render(<GeminiSessionView sessionId="thread-1" cwd="/tmp/repo" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(screen.getByRole("link").getAttribute("href"))
      .toBe("https://accounts.google.com/signin"));
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("initializes the chat again after signing in following a startup failure", async () => {
    geminiSdkEnsureServer.mockRejectedValueOnce(new Error("Authentication required"))
      .mockResolvedValueOnce("acp-recovered");
    geminiSdkSignIn.mockResolvedValue({ signedIn: true });
    render(<GeminiSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));

    await waitFor(() => expect(geminiSdkEnsureServer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(threadStoreState.setThreadProviderSessionId)
      .toHaveBeenCalledWith("thread-1", "acp-recovered"));
    expect(claudeSdkSessionViewSpy.mock.lastCall?.[0].externalSessionReady).toBe(true);
  });

  it("shows a Google sign-in card when the ACP server opens the browser", async () => {
    let resolveEnsure: (value: string) => void = () => {};
    geminiSdkEnsureServer.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        }),
    );

    render(<GeminiSessionView sessionId="thread-1" cwd="/tmp/repo" />);

    await waitFor(() => {
      expect(authListeners.length).toBeGreaterThan(0);
    });

    act(() => {
      for (const cb of authListeners) {
        cb({
          payload: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?response_type=code",
            threadId: "thread-1",
          },
        });
      }
    });

    expect(screen.getByTestId("gemini-google-signin")).toBeTruthy();
    expect(screen.getByText("Sign in with Google")).toBeTruthy();
    expect(screen.getByText(/browser window opened/i)).toBeTruthy();

    await act(async () => {
      resolveEnsure("acp-session-1");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("gemini-google-signin")).toBeNull();
    });
  });

  it("ignores auth URLs for other threads", async () => {
    geminiSdkEnsureServer.mockImplementation(() => new Promise(() => {}));
    render(<GeminiSessionView sessionId="thread-1" cwd="/tmp/repo" />);
    await waitFor(() => {
      expect(authListeners.length).toBeGreaterThan(0);
    });
    act(() => {
      for (const cb of authListeners) {
        cb({
          payload: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?response_type=code",
            threadId: "other-thread",
          },
        });
      }
    });
    expect(screen.queryByTestId("gemini-google-signin")).toBeNull();
  });

  it("seeds ACP session id from the thread so the composer is ready on first paint", async () => {
    geminiSdkEnsureServer.mockImplementation(() => new Promise(() => {}));
    threadStoreState.threads = {
      p1: [{ id: "thread-live", sdk_session_id: "acp-live" }],
    };
    render(<GeminiSessionView sessionId="thread-live" cwd="/tmp/repo" />);
    await waitFor(() => {
      expect(claudeSdkSessionViewSpy).toHaveBeenCalled();
    });
    const calls = claudeSdkSessionViewSpy.mock.calls;
    const props = calls[calls.length - 1]?.[0] as {
      externalSessionReady?: boolean;
    };
    expect(props.externalSessionReady).toBe(true);
  });
});
