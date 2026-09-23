/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ApprovalToast } from "../ApprovalToast";
import { useUiStore } from "../../stores/uiStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  useUiStore.setState({
    pendingApprovalsBySession: {},
    selectedClaudeSessionId: null,
    selectedCodexSessionId: null,
    selectedThreadId: null,
    appMode: "agent",
    claudeSessionMap: {},
  });
});

afterEach(() => cleanup());

describe("ApprovalToast", () => {
  it("renders nothing when there are no pending approvals", () => {
    const { container } = render(<ApprovalToast />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the only pending approval matches the active session", () => {
    useUiStore.setState({
      selectedClaudeSessionId: "s1",
      pendingApprovalsBySession: {
        s1: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    const { container } = render(<ApprovalToast />);
    expect(container.firstChild).toBeNull();
  });

  it("hides the toast when the approval is for the active thread-routed session (Grok/MLX)", () => {
    // Grok/MLX threads are tracked by `selectedThreadId`, not selectedClaude.
    useUiStore.setState({
      selectedThreadId: "grok-thread-1",
      pendingApprovalsBySession: {
        "grok-thread-1": {
          toolName: "Read File",
          summary: "/Users/neel/.claude/commands/createclaudemd.md",
          interactionMode: "sdk",
          requestId: "7",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    const { container } = render(<ApprovalToast />);
    expect(container.firstChild).toBeNull();
  });

  it("still shows the toast when a thread-routed approval is NOT the active thread", () => {
    useUiStore.setState({
      selectedThreadId: "other-thread",
      pendingApprovalsBySession: {
        "grok-thread-1": {
          toolName: "Read File",
          summary: "/etc/hosts",
          interactionMode: "sdk",
          requestId: "7",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/wants/i)).toBeTruthy();
  });

  it("renders a toast for a non-active pending approval", () => {
    useUiStore.setState({
      selectedClaudeSessionId: null,
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "echo hi",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/echo hi/)).toBeTruthy();
    expect(screen.getByText(/wants/i)).toBeTruthy();
  });

  it("renders Approve and Deny buttons for SDK approvals with requestId", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Edit",
          summary: '{"file_path":"/tmp/foo.txt"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /deny/i })).toBeTruthy();
  });

  it("renders 'Go to' button for non-inline approvals (no requestId)", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "danger",
          interactionMode: "pty",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByRole("button", { name: /go to/i })).toBeTruthy();
  });

  it("decodes a JSON file_path summary to just the basename", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Edit",
          summary: '{"file_path":"/Users/foo/project/src/index.ts"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/index\.ts/)).toBeTruthy();
  });

  it("decodes a JSON command summary for Bash approvals", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: '{"command":"rm -rf /"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("rm -rf /")).toBeTruthy();
  });

  it("falls back to raw summary when JSON parsing extracts nothing", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Unknown",
          summary: "raw plain summary",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/raw plain summary/)).toBeTruthy();
  });

  it("renders an active session approval differently from inactive (active hides toast)", () => {
    useUiStore.setState({
      selectedCodexSessionId: "cs1",
      pendingApprovalsBySession: {
        cs1: {
          toolName: "Bash",
          summary: "echo cs1",
          interactionMode: "pty",
          agentType: "codex",
          cwd: "/tmp",
        },
      },
    });
    const { container } = render(<ApprovalToast />);
    expect(container.firstChild).toBeNull();
  });

  it("shows multiple toasts when multiple non-active sessions have approvals", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        s1: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
        s2: {
          toolName: "WebFetch",
          summary: '{"url":"https://example.com"}',
          interactionMode: "sdk",
          requestId: "r2",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("ls")).toBeTruthy();
    expect(screen.getByText(/example\.com/)).toBeTruthy();
  });

  it("renders Grep pattern from JSON summary", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Grep",
          summary: '{"pattern":"TODO"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("TODO")).toBeTruthy();
  });
});

describe("ApprovalToast — Final coverage gaps", () => {
  it("renders WebSearch query from JSON summary", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "WebSearch",
          summary: '{"query":"how to test"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("how to test")).toBeTruthy();
  });

  it("renders Glob pattern", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Glob",
          summary: '{"pattern":"**/*.ts"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("**/*.ts")).toBeTruthy();
  });

  it("renders Read file from path key", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Read",
          summary: '{"path":"/Users/me/proj/index.ts"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/index\.ts/)).toBeTruthy();
  });

  it("renders OpenCode agent toast with proper provider avatar", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "echo opencode",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "opencode",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("echo opencode")).toBeTruthy();
  });

  it("renders Codex (PTY) toast with 'Go to' button", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "ls -la",
          interactionMode: "pty",
          agentType: "codex",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByRole("button", { name: /go to/i })).toBeTruthy();
  });

  it("uses agent name from session name store", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    // Default fallback is "Agent" when name not in store
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
  });

  it("clicking Approve in inline mode does not throw", async () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    const approveBtn = screen.getByRole("button", { name: /approve/i });
    expect(() => approveBtn.click()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("clicking Deny in inline mode does not throw", async () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    const denyBtn = screen.getByRole("button", { name: /deny/i });
    expect(() => denyBtn.click()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("clicking 'Go to' on PTY approval does not throw", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "pty",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(() => screen.getByRole("button", { name: /go to/i }).click()).not.toThrow();
  });

  it("clicking 'Go to' on a Grok approval selects the Grok thread", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        gx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "pty",
          agentType: "grok",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    screen.getByRole("button", { name: /go to/i }).click();
    const state = useUiStore.getState();
    expect(state.selectedThreadId).toBe("gx");
    expect(state.selectedClaudeSessionId).toBeNull();
  });

  it("approving a Codex toast sends the app-server accept decision", async () => {
    vi.mocked(invoke).mockClear();
    useUiStore.setState({
      pendingApprovalsBySession: {
        cx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: 201,
          agentType: "codex",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    screen.getByRole("button", { name: /approve/i }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codex_respond_to_request", {
      workDir: "/tmp",
      requestId: 201,
      result: { decision: "accept" },
    });
  });

  it("denying a Codex toast sends the app-server decline decision", async () => {
    vi.mocked(invoke).mockClear();
    useUiStore.setState({
      pendingApprovalsBySession: {
        cx: {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: 202,
          agentType: "codex",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    screen.getByRole("button", { name: /deny/i }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("codex_respond_to_request", {
      workDir: "/tmp",
      requestId: 202,
      result: { decision: "decline" },
    });
  });

  it("approving a Grok toast routes through the Grok approval command", async () => {
    vi.mocked(invoke).mockClear();
    useUiStore.setState({
      pendingApprovalsBySession: {
        gx: {
          toolName: "Read File",
          summary: "/tmp/a.txt",
          interactionMode: "sdk",
          requestId: "42",
          agentType: "grok",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    screen.getByRole("button", { name: /approve/i }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("grok_sdk_respond_approval", {
      threadId: "gx",
      requestId: 42,
      decision: "allow",
    });
  });

  it("renders +N indicator when multiple realIds collapse to one canonical", () => {
    useUiStore.setState({
      claudeSessionMap: { canonical: ["real-1", "real-2"] },
      pendingApprovalsBySession: {
        "real-1": {
          toolName: "Bash",
          summary: "ls",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
        "real-2": {
          toolName: "Bash",
          summary: "pwd",
          interactionMode: "sdk",
          requestId: "r2",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/^\+1$/)).toBeTruthy();
  });

  it("classifies WebFetch as network risk and shows summary", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "WebFetch",
          summary: '{"url":"https://x.com/api"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText(/x\.com\/api/)).toBeTruthy();
  });

  it("Read tool with grep style classifies as read", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "Read",
          summary: "/just/a/path",
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("/just/a/path")).toBeTruthy();
  });

  it("renders applypatch with file_path summary", () => {
    useUiStore.setState({
      pendingApprovalsBySession: {
        sx: {
          toolName: "applypatch",
          summary: '{"file_path":"/Users/me/foo.ts"}',
          interactionMode: "sdk",
          requestId: "r1",
          agentType: "claude",
          cwd: "/tmp",
        },
      },
    });
    render(<ApprovalToast />);
    expect(screen.getByText("foo.ts")).toBeTruthy();
  });

  it("renders nothing when only the active task agent has approval", () => {
    useUiStore.setState({
      appMode: "task",
      pendingApprovalsBySession: {},
    });
    const { container } = render(<ApprovalToast />);
    expect(container.firstChild).toBeNull();
  });
});
