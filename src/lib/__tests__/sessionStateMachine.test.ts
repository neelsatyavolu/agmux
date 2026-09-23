import { describe, expect, it } from "vitest";
import {
  createSession,
  transition,
  type Effect,
  type SessionData,
  type SessionEvent,
  type TransitionContext,
} from "../sessionStateMachine";

// ─── Helpers ────────────────────────────────────────────────────────────────

const CTX = (overrides: Partial<TransitionContext> = {}): TransitionContext => ({
  now: 1_000_000,
  isViewingSession: false,
  ...overrides,
});

function apply(
  data: SessionData,
  event: SessionEvent,
  ctx: TransitionContext = CTX(),
): { data: SessionData; effects: Effect[] } {
  return transition(data, event, ctx);
}

function hasEffect<T extends Effect["type"]>(
  effects: Effect[],
  type: T,
): Extract<Effect, { type: T }> | undefined {
  return effects.find((e) => e.type === type) as
    | Extract<Effect, { type: T }>
    | undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createSession", () => {
  it("returns a fresh idle session", () => {
    const s = createSession();
    expect(s.state).toBe("idle");
    expect(s.toolStatus).toBeNull();
    expect(s.approvalInfo).toBeNull();
    expect(s.stashedQuestion).toBeNull();
    expect(s.hasActiveAgent).toBe(false);
    expect(s.promptSeen).toBe(false);
    expect(s.lastStopAt).toBe(0);
  });
});

describe("session_start", () => {
  it("from idle moves to initializing and clears effects", () => {
    const { data, effects } = apply(createSession(), { type: "session_start" });
    expect(data.state).toBe("initializing");
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "set_approval")?.info).toBeNull();
  });

  it("is ignored when a session is already active mid-turn", () => {
    // Simulate: user submitted a prompt and we're in processing
    const afterPrompt = apply(createSession(), {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    }).data;
    expect(afterPrompt.state).toBe("processing");
    expect(afterPrompt.promptSeen).toBe(true);

    // A duplicate session_start should not reset us
    const { data, effects } = apply(afterPrompt, { type: "session_start" });
    expect(data).toBe(afterPrompt); // noTransition returns same data reference
    expect(effects).toEqual([]);
  });
});

describe("prompt_submit", () => {
  it("moves idle → processing and emits set_processing=true for normal prompts", () => {
    const { data, effects } = apply(createSession(), {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "do the thing",
    });
    expect(data.state).toBe("processing");
    expect(data.promptSeen).toBe(true);
    expect(data.hasActiveAgent).toBe(false);
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "record_prompt")).toBeDefined();
    expect(hasEffect(effects, "summarize_prompt")).toBeDefined();
  });

  it("sets processing for PTY slash commands — custom commands do real LLM work", () => {
    // Claude Code only fires UserPromptSubmit when the slash command is
    // going to be sent to the LLM. Instant client-side built-ins like
    // /clear, /model, /help, /cost don't fire the hook at all, so they
    // never reach this code path. Every slash command that DOES fire the
    // hook is a real turn (custom commands, skills) and needs the spinner.
    const { data, effects } = apply(createSession(), {
      type: "prompt_submit",
      isSlashCommand: true,
      promptText: "/coderabbit",
      interactionMode: "pty",
    });
    expect(data.state).toBe("processing");
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    // No safety timer — custom commands can take many seconds before the
    // first pre_tool_use, and the spinner must stay on for the whole time.
    expect(hasEffect(effects, "start_timer")).toBeUndefined();
  });

  it("sets processing for SDK slash commands (they are real messages)", () => {
    const { effects } = apply(createSession(), {
      type: "prompt_submit",
      isSlashCommand: true,
      promptText: "/compact",
      interactionMode: "sdk",
    });
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "start_timer")).toBeUndefined();
  });
});

describe("pre_tool_use from idle", () => {
  it("re-arms processing when Claude resumes work after an idle blip", () => {
    const { data, effects } = apply(createSession(), {
      type: "pre_tool_use",
      toolName: "Edit",
      toolStatus: "Editing file.ts",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(data.toolStatus).toBe("Editing file.ts");
    expect(data.hasActiveAgent).toBe(false);
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "set_tool_status")?.status).toBe("Editing file.ts");
  });

  it("marks hasActiveAgent when the tool is a subagent (Task/Agent)", () => {
    const { data } = apply(createSession(), {
      type: "pre_tool_use",
      toolName: "Task",
      toolStatus: null,
      question: null,
    });
    expect(data.hasActiveAgent).toBe(true);
  });

  it("pre_tool_use clears any lingering approval slot (bridged stale-state path)", () => {
    // Simulate: bridged stale state — session_data is idle but a stale
    // approvalInfo lingers from a previous turn. When the next tool runs,
    // pre_tool_use must clear the slot so no stale approval toast shows.
    const stale: SessionData = {
      ...createSession(),
      approvalInfo: {
        agentType: "claude",
        toolName: "Bash",
        summary: "npm test",
        warnings: [],
      },
    };
    const { data, effects } = apply(stale, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Running",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(data.approvalInfo).toBeNull();
    expect(hasEffect(effects, "set_approval")?.info).toBeNull();
    // existing effects should still fire
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "set_tool_status")?.status).toBe("Running");
  });
});

describe("notifications from idle", () => {
  it("permission notification with no recent stop → awaiting_approval", () => {
    const { data, effects } = apply(
      createSession(),
      {
        type: "notification",
        category: "permission",
        subtitle: "needs permission",
        body: "Bash — run tests",
      },
      CTX({ now: 5_000_000 }),
    );
    expect(data.state).toBe("awaiting_approval");
    expect(data.approvalInfo).not.toBeNull();
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/approval/i);
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
  });

  it("approval notification title includes the tool name", () => {
    const base: SessionData = { ...createSession(), toolStatus: "Bash" };
    const { effects } = apply(
      base,
      {
        type: "notification",
        category: "permission",
        subtitle: "",
        body: '{"command": "npm test"}',
      },
      CTX({ now: 5_000_000 }),
    );
    const notif = hasEffect(effects, "send_notification");
    expect(notif?.title).toBe("agmux — Bash Approval");
    expect(notif?.body).toBe("npm test");
  });

  it("approval notification includes dangerous-command warnings", () => {
    const base: SessionData = { ...createSession(), toolStatus: "Bash" };
    const { data, effects } = apply(
      base,
      {
        type: "notification",
        category: "permission",
        subtitle: "",
        body: '{"command": "rm -rf /tmp/build"}',
      },
      CTX({ now: 5_000_000 }),
    );
    const notif = hasEffect(effects, "send_notification");
    expect(notif?.title).toBe("agmux — Bash Approval");
    expect(notif?.body).toContain("rm -rf /tmp/build");
    expect(notif?.body).toContain("⚠");
    expect(data.approvalInfo?.warnings).toBeDefined();
    expect(data.approvalInfo!.warnings!.length).toBeGreaterThan(0);
  });

  it("permission notification inside the 8s-60s stale window is ignored", () => {
    const base: SessionData = { ...createSession(), lastStopAt: 100_000 };
    // 30s after stop → stale window
    const { data, effects } = apply(
      base,
      {
        type: "notification",
        category: "permission",
        subtitle: "",
        body: "stale prompt",
      },
      CTX({ now: 130_000 }),
    );
    expect(data).toBe(base); // noTransition
    expect(effects).toEqual([]);
  });

  it("permission notification just after stop (≤8s) still surfaces approval", () => {
    const base: SessionData = { ...createSession(), lastStopAt: 100_000 };
    const { data } = apply(
      base,
      {
        type: "notification",
        category: "permission",
        subtitle: "",
        body: "approve me",
      },
      CTX({ now: 103_000 }),
    );
    expect(data.state).toBe("awaiting_approval");
  });

  it("non-permission notification while viewing the session → no-op", () => {
    const { data, effects } = apply(
      createSession(),
      {
        type: "notification",
        category: "completed",
        subtitle: "",
        body: "done",
      },
      CTX({ isViewingSession: true }),
    );
    expect(data.state).toBe("idle");
    expect(effects).toEqual([]);
  });

  it("non-permission notification when NOT viewing → mark_unread", () => {
    const { effects } = apply(
      createSession(),
      {
        type: "notification",
        category: "completed",
        subtitle: "",
        body: "done",
      },
      CTX({ isViewingSession: false }),
    );
    expect(hasEffect(effects, "mark_unread")).toBeDefined();
  });

  it("stale non-permission notification (e.g. Grok 5-min idle reminder) is ignored", () => {
    // Session stopped at t=100_000; idle reminder arrives 5 minutes later.
    // Without the guard, handlePassiveNotification would emit mark_unread and
    // the sidebar would paint a stale green-pulse "unread" dot.
    const base: SessionData = { ...createSession(), lastStopAt: 100_000 };
    const { data, effects } = apply(
      base,
      {
        type: "notification",
        category: "attention",
        subtitle: "Attention",
        body: "Grok is still here",
      },
      CTX({ now: 100_000 + 5 * 60_000 }),
    );
    expect(data).toBe(base);
    expect(effects).toEqual([]);
  });

  it("stale completed/error notifications past the stale window are also ignored", () => {
    const base: SessionData = { ...createSession(), lastStopAt: 100_000 };
    for (const category of ["completed", "error"] as const) {
      const { data, effects } = apply(
        base,
        { type: "notification", category, subtitle: "", body: "late" },
        CTX({ now: 100_000 + 90_000 }), // 90s post-stop, > IDLE_STALE_WINDOW
      );
      expect(data).toBe(base);
      expect(effects).toEqual([]);
    }
  });

  it("non-permission notification still surfaces inside the stale window", () => {
    const base: SessionData = { ...createSession(), lastStopAt: 100_000 };
    // 30s after stop is well within the 60s stale window — should still mark unread
    const { effects } = apply(
      base,
      {
        type: "notification",
        category: "attention",
        subtitle: "",
        body: "still relevant",
      },
      CTX({ now: 130_000 }),
    );
    expect(hasEffect(effects, "mark_unread")).toBeDefined();
  });
});

describe("processing → awaiting_stop", () => {
  it("stop from processing transitions to awaiting_stop with a phase1 timer", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    }).data;
    expect(state.state).toBe("processing");

    const { data, effects } = apply(state, { type: "stop" }, CTX({ now: 200_000 }));
    expect(data.state).toBe("awaiting_stop");
    expect(data.lastStopAt).toBe(200_000);
    const timer = hasEffect(effects, "start_timer");
    expect(timer?.id).toBe("phase1");
    expect(timer?.ms).toBe(1500); // non-agent delay
  });

  it("stop with an active agent uses the longer 2000ms phase1 timer", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Task",
      toolStatus: "spawning agent",
      question: null,
    }).data;
    expect(state.hasActiveAgent).toBe(true);

    const { effects } = apply(state, { type: "stop" });
    expect(hasEffect(effects, "start_timer")?.ms).toBe(2000);
  });

  it("stop uses the default 1.5s phase1 hold (Claude parity, including Grok)", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    }).data;
    const { data, effects } = apply(
      state,
      { type: "stop" },
      CTX({ now: 200_000, enableAgentPermissionHints: false }),
    );
    expect(data.state).toBe("awaiting_stop");
    expect(hasEffect(effects, "start_timer")?.ms).toBe(1500);
    expect(hasEffect(effects, "set_processing")).toBeUndefined();
  });

  it("phase1_timeout fully finishes once (spinner + toast + unread together)", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent: false,
      toolStatus: "Editing",
      capturedToolStatus: "Editing",
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(
      base,
      { type: "phase1_timeout" },
      CTX({ enableAgentPermissionHints: false }),
    );
    expect(data.state).toBe("idle");
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/finished/i);
    expect(hasEffect(effects, "mark_unread")).toBeDefined();
    expect(hasEffect(effects, "record_stop")).toBeDefined();
    // One finish step only — no phase2 arm.
    expect(effects.find((e) => e.type === "start_timer")).toBeUndefined();
  });

  it("pre_tool_use while awaiting_stop re-arms without a Finished notification", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent: false,
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(base, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Running",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
    expect(hasEffect(effects, "send_notification")).toBeUndefined();
  });

  it("agent_recheck is a no-op when enableAgentPermissionHints is false (Grok)", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Task",
      toolStatus: "spawning",
      question: null,
    }).data;
    expect(state.hasActiveAgent).toBe(true);
    const { data, effects } = apply(
      state,
      { type: "agent_recheck" },
      CTX({ enableAgentPermissionHints: false }),
    );
    expect(data.state).toBe("processing");
    expect(effects).toEqual([]);
  });

  it("phase1_timeout with active agent + enableAgentPermissionHints=false finishes (not preliminary approval)", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent: true,
      toolStatus: "Task",
      capturedToolStatus: "Task",
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(
      base,
      { type: "phase1_timeout" },
      CTX({ enableAgentPermissionHints: false }),
    );
    // No stopDebounceMs → immediate finish (no soft-clear phase2).
    expect(data.state).toBe("idle");
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/finished/i);
  });
});

describe("awaiting_stop → phase1_timeout", () => {
  it("non-agent phase1_timeout → idle with a Claude Finished notification", () => {
    // Manually set up awaiting_stop state (non-agent)
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent: false,
      toolStatus: "Editing",
      capturedToolStatus: "Editing",
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(base, { type: "phase1_timeout" });
    expect(data.state).toBe("idle");
    expect(data.toolStatus).toBeNull();
    expect(data.approvalInfo).toBeNull();
    expect(data.lastStopAt).toBe(500_000); // preserved
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/finished/i);
    expect(hasEffect(effects, "record_stop")).toBeDefined();
  });

  it("pre_tool_use after premature idle re-arms and clears unread", () => {
    // Simulates: Stop → phase1_timeout → idle + Finished, then next tool arrives.
    const idleAfterFalseStop: SessionData = {
      ...createSession(),
      state: "idle",
      promptSeen: true,
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(idleAfterFalseStop, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Running command",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "clear_unread")).toBeDefined();
  });

  it("agent phase1_timeout finishes (no synthetic preliminary approval)", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent: true,
      toolStatus: "Running subagent",
      capturedToolStatus: "Running subagent",
      stashedQuestion: "may I read foo.ts?",
      lastStopAt: 500_000,
    };
    const { data, effects } = apply(base, { type: "phase1_timeout" });
    // Subagent still "active" must not invent amber attention — full finish.
    expect(data.state).toBe("idle");
    expect(data.approvalInfo).toBeNull();
    expect(data.hasActiveAgent).toBe(false);
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "set_approval")?.info).toBeNull();
    expect(hasEffect(effects, "mark_unread")).toBeDefined();
    expect(effects.find((e) => e.type === "start_timer" && e.id === "phase2")).toBeUndefined();
  });
});

describe("user_accepted from awaiting_approval", () => {
  it("clears approval but keeps processing active (tool is still executing)", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_approval",
      promptSeen: true,
      approvalInfo: {
        agentType: "claude",
        toolName: "Bash",
        summary: "ls",
        category: "permission",
      },
      stashedQuestion: "ls",
    };
    const { data, effects } = apply(base, { type: "user_accepted" });
    expect(data.state).toBe("processing");
    expect(data.approvalInfo).toBeNull();
    expect(data.stashedQuestion).toBeNull();
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "set_approval")?.info).toBeNull();
  });

  it("does not schedule agent_recheck after user_accepted with subagent active", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_approval",
      promptSeen: true,
      hasActiveAgent: true,
      approvalInfo: {
        agentType: "claude",
        toolName: "Task",
        summary: "dispatching",
        category: "permission",
      },
    };
    const { data, effects } = apply(base, { type: "user_accepted" });
    expect(data.state).toBe("processing");
    expect(data.hasActiveAgent).toBe(true); // still tracked for stop-hold only
    const recheck = effects.find(
      (e) => e.type === "start_timer" && e.id === "agent_recheck",
    );
    expect(recheck).toBeUndefined();
  });
});

describe("user_responded → dismissed", () => {
  it("moves to dismissed and starts a dismiss_timeout timer", () => {
    const base: SessionData = {
      ...createSession(),
      state: "awaiting_approval",
      promptSeen: true,
      approvalInfo: {
        agentType: "claude",
        toolName: "Bash",
        summary: "rm -rf /",
        category: "permission",
      },
    };
    const { data, effects } = apply(base, { type: "user_responded" });
    expect(data.state).toBe("dismissed");
    expect(data.promptSeen).toBe(true); // preserved
    expect(data.approvalInfo).toBeNull();
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    const dismiss = effects.find(
      (e) => e.type === "start_timer" && e.id === "dismiss_timeout",
    );
    expect(dismiss).toBeDefined();
    expect((dismiss as { ms: number }).ms).toBe(3000);
  });
});

describe("session_end", () => {
  it("transitions to ended and clears all live state", () => {
    const base: SessionData = {
      ...createSession(),
      state: "processing",
      toolStatus: "Editing",
      hasActiveAgent: true,
      approvalInfo: {
        agentType: "claude",
        toolName: "Edit",
        summary: "touch file",
      },
    };
    const { data, effects } = apply(base, { type: "session_end" });
    expect(data.state).toBe("ended");
    expect(data.toolStatus).toBeNull();
    expect(data.approvalInfo).toBeNull();
    expect(data.hasActiveAgent).toBe(false);
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
  });
});

describe("approval summary formatting from notification", () => {
  it("parses a JSON Bash payload into a human-readable command", () => {
    // processing → notification with permission category
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "go",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Bash",
      question: null,
    }).data;

    const { data } = apply(state, {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: JSON.stringify({ command: "ls -la /tmp" }),
    });
    expect(data.state).toBe("awaiting_approval");
    expect(data.approvalInfo?.summary).toBe("ls -la /tmp");
  });

  it("parses a JSON Edit payload into a shortened path", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "go",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Edit",
      toolStatus: "Edit",
      question: null,
    }).data;

    const { data } = apply(state, {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: JSON.stringify({ file_path: "/Users/neel/project/src/foo.ts" }),
    });
    expect(data.approvalInfo?.summary).toBe("Edit …/src/foo.ts");
  });

  it("leaves non-JSON bodies intact (already human-readable)", () => {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "go",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Bash",
      question: null,
    }).data;

    const { data } = apply(state, {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: "plain text prompt",
    });
    expect(data.approvalInfo?.summary).toBe("plain text prompt");
  });
});

// ===================================================================
// Maximum coverage — uncovered branches of the state machine.
// ===================================================================

describe("approval summary — tool-specific formatters", () => {
  function permission(state: SessionData, body: string) {
    return apply(state, {
      type: "notification",
      category: "permission",
      subtitle: "",
      body,
    });
  }

  function setupTool(toolName: string): SessionData {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "go",
    }).data;
    state = apply(state, {
      type: "pre_tool_use",
      toolName,
      toolStatus: toolName,
      question: null,
    }).data;
    return state;
  }

  it("Read formatter shortens path", () => {
    const { data } = permission(setupTool("Read"), JSON.stringify({ file_path: "/a/b/c/d/file.ts" }));
    expect(data.approvalInfo?.summary).toBe("Read …/d/file.ts");
  });

  it("Read formatter uses default when no path", () => {
    const { data } = permission(setupTool("Read"), JSON.stringify({ foo: "bar" }));
    expect(data.approvalInfo?.summary).toBe("Read file");
  });

  it("Write formatter shortens path", () => {
    const { data } = permission(setupTool("Write"), JSON.stringify({ file_path: "/a/b/c/file.ts" }));
    expect(data.approvalInfo?.summary).toBe("Write …/c/file.ts");
  });

  it("Write formatter uses default when no path", () => {
    const { data } = permission(setupTool("Write"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Write file");
  });

  it("Edit formatter uses default when no path", () => {
    const { data } = permission(setupTool("Edit"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Edit file");
  });

  it("Glob formatter shows pattern", () => {
    const { data } = permission(setupTool("Glob"), JSON.stringify({ pattern: "**/*.ts" }));
    expect(data.approvalInfo?.summary).toBe("Search files: **/*.ts");
  });

  it("Glob formatter falls back when no pattern", () => {
    const { data } = permission(setupTool("Glob"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Search files");
  });

  it("Grep formatter shows truncated pattern", () => {
    const { data } = permission(setupTool("Grep"), JSON.stringify({ pattern: "needle" }));
    expect(data.approvalInfo?.summary).toBe("Grep: needle");
  });

  it("Grep formatter falls back when no pattern", () => {
    const { data } = permission(setupTool("Grep"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Search code");
  });

  it("Task/Agent formatter shows description", () => {
    const { data } = permission(setupTool("Task"), JSON.stringify({ description: "subagent" }));
    expect(data.approvalInfo?.summary).toBe("subagent");
  });

  it("Task/Agent formatter falls back to default", () => {
    const { data } = permission(setupTool("Task"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Subagent task");
  });

  it("WebFetch formatter is constant", () => {
    const { data } = permission(setupTool("WebFetch"), JSON.stringify({ url: "https://example.com" }));
    expect(data.approvalInfo?.summary).toBe("Fetch URL");
  });

  it("WebSearch formatter shows query", () => {
    const { data } = permission(setupTool("WebSearch"), JSON.stringify({ query: "anthropic" }));
    expect(data.approvalInfo?.summary).toBe("Search: anthropic");
  });

  it("WebSearch formatter falls back when no query", () => {
    const { data } = permission(setupTool("WebSearch"), JSON.stringify({}));
    expect(data.approvalInfo?.summary).toBe("Web search");
  });

  it("MCP tool with file_path uses generic formatter", () => {
    const { data } = permission(
      setupTool("mcp__server__editFile"),
      JSON.stringify({ file_path: "/a/b/c/foo.ts" }),
    );
    expect(data.approvalInfo?.summary).toContain("editFile");
    expect(data.approvalInfo?.summary).toContain("…/c/foo.ts");
  });

  it("MCP tool with command uses generic formatter", () => {
    const { data } = permission(
      setupTool("mcp__server__runCmd"),
      JSON.stringify({ command: "echo hi" }),
    );
    expect(data.approvalInfo?.summary).toBe("echo hi");
  });

  it("MCP tool with no recognized fields falls back to first string value", () => {
    const { data } = permission(
      setupTool("mcp__server__doThing"),
      JSON.stringify({ extra: "some value" }),
    );
    expect(data.approvalInfo?.summary).toContain("doThing");
    expect(data.approvalInfo?.summary).toContain("some value");
  });

  it("Bash formatter truncates long commands at 80 chars", () => {
    const longCmd = "echo " + "a".repeat(120);
    const { data } = permission(setupTool("Bash"), JSON.stringify({ command: longCmd }));
    expect(data.approvalInfo?.summary?.length).toBeLessThanOrEqual(80);
    expect(data.approvalInfo?.summary?.endsWith("…")).toBe(true);
  });

  it("malformed JSON falls back to truncated raw text", () => {
    const { data } = permission(setupTool("Bash"), "{invalid json");
    expect(data.approvalInfo?.summary).toContain("Bash");
  });
});

describe("processing → notification (no stop first)", () => {
  function inProcessing(): SessionData {
    let state = createSession();
    state = apply(state, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "go",
    }).data;
    return state;
  }

  it("permission notification while processing → awaiting_approval immediately", () => {
    const state = inProcessing();
    const { data, effects } = apply(state, {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: "approve me",
    });
    expect(data.state).toBe("awaiting_approval");
    expect(effects.find((e) => e.type === "set_processing" && e.value === false)).toBeDefined();
  });

  it("non-permission notification while processing is a no-op", () => {
    const state = inProcessing();
    const { data, effects } = apply(state, {
      type: "notification",
      category: "completed",
      subtitle: "",
      body: "done",
    });
    expect(data).toBe(state);
    expect(effects).toEqual([]);
  });

  it("agent_recheck while processing is a no-op even with hasActiveAgent", () => {
    let state = inProcessing();
    state = apply(state, {
      type: "pre_tool_use",
      toolName: "Task",
      toolStatus: "Spawning agent",
      question: null,
    }).data;
    expect(state.hasActiveAgent).toBe(true);
    state = { ...state, stashedQuestion: "May I read foo?" };

    const { data, effects } = apply(state, { type: "agent_recheck" });
    expect(data.state).toBe("processing");
    expect(data.approvalInfo).toBeNull();
    expect(effects).toEqual([]);
  });

  it("pre_tool_use with Task does not arm agent_recheck timer", () => {
    const state = inProcessing();
    const { data, effects } = apply(state, {
      type: "pre_tool_use",
      toolName: "Task",
      toolStatus: "Spawning agent",
      question: null,
    });
    expect(data.hasActiveAgent).toBe(true);
    expect(data.state).toBe("processing");
    expect(
      effects.find((e) => e.type === "start_timer" && e.id === "agent_recheck"),
    ).toBeUndefined();
  });

  it("pre_tool_use with question (AskUserQuestion / Grok ask_user_question) → awaiting_approval + OS notif", () => {
    const state = inProcessing();
    const { data, effects } = apply(state, {
      type: "pre_tool_use",
      toolName: "ask_user_question",
      toolStatus: "Asking a question",
      question: "Naming for the two voice-related nav items?\n[Writing / Voice]",
    });
    expect(data.state).toBe("awaiting_approval");
    expect(data.approvalInfo?.category).toBe("permission");
    expect(data.approvalInfo?.summary).toContain("Naming for the two voice-related nav items?");
    expect(data.stashedQuestion).toContain("Naming for the two");
    expect(hasEffect(effects, "set_approval")?.info).not.toBeNull();
    expect(hasEffect(effects, "set_processing")?.value).toBe(false);
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/approval/i);
  });

  it("agent_recheck while processing without active agent is no-op", () => {
    const state = inProcessing();
    const { data } = apply(state, { type: "agent_recheck" });
    expect(data).toBe(state);
  });
});

describe("transitionDismissed", () => {
  function dismissed(): SessionData {
    return {
      ...createSession(),
      state: "dismissed",
      promptSeen: true,
      dismissedAt: 100_000,
    };
  }

  it("prompt_submit moves dismissed → processing", () => {
    const { data } = apply(dismissed(), {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "next",
    });
    expect(data.state).toBe("processing");
  });

  it("pre_tool_use re-arms processing (clears dismissedAt)", () => {
    const { data } = apply(dismissed(), {
      type: "pre_tool_use",
      toolName: "Edit",
      toolStatus: "editing",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(data.dismissedAt).toBe(0);
  });

  it("dismiss_timeout moves to idle", () => {
    const { data } = apply(dismissed(), { type: "dismiss_timeout" });
    expect(data.state).toBe("idle");
    expect(data.dismissedAt).toBe(0);
  });

  it("stop moves to idle and records lastStopAt", () => {
    const { data, effects } = apply(dismissed(), { type: "stop" }, CTX({ now: 999 }));
    expect(data.state).toBe("idle");
    expect(data.lastStopAt).toBe(999);
    expect(hasEffect(effects, "record_stop")).toBeDefined();
  });

  it("permission notification while NOT viewing → awaiting_approval", () => {
    const { data } = apply(dismissed(), {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: "{}",
    });
    expect(data.state).toBe("awaiting_approval");
    expect(data.dismissedAt).toBe(0);
  });

  it("permission notification while viewing → no-op", () => {
    const { data, effects } = apply(
      dismissed(),
      { type: "notification", category: "permission", subtitle: "", body: "{}" },
      CTX({ isViewingSession: true }),
    );
    expect(data.state).toBe("dismissed");
    expect(effects).toEqual([]);
  });
});

describe("transitionAwaitingStop edge cases", () => {
  function stopState(hasActiveAgent: boolean): SessionData {
    return {
      ...createSession(),
      state: "awaiting_stop",
      promptSeen: true,
      hasActiveAgent,
      toolStatus: "Editing",
      capturedToolStatus: "Editing",
      lastStopAt: 500_000,
    };
  }

  it("notification arrives → awaiting_approval", () => {
    const { data } = apply(stopState(false), {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: "{}",
    });
    expect(data.state).toBe("awaiting_approval");
  });

  it("pre_tool_use arrives → re-arms processing with cancel_timers + set_processing", () => {
    const { data, effects } = apply(stopState(false), {
      type: "pre_tool_use",
      toolName: "Edit",
      toolStatus: "Edit",
      question: null,
    });
    expect(data.state).toBe("processing");
    expect(hasEffect(effects, "set_processing")?.value).toBe(true);
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
  });

  it("user prompt while awaiting_stop transitions to processing and clears approval", () => {
    const { data, effects } = apply(stopState(false), {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "next",
    });
    expect(data.state).toBe("processing");
    expect(data.approvalInfo).toBeNull();
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
  });

  it("user_accepted while awaiting_stop → processing", () => {
    const { data } = apply(stopState(false), { type: "user_accepted" });
    expect(data.state).toBe("processing");
  });

  it("user_responded while awaiting_stop → dismissed", () => {
    const { data } = apply(stopState(false), { type: "user_responded" });
    expect(data.state).toBe("dismissed");
  });
});

describe("transitionAwaitingApproval extras", () => {
  function awaitingApproval(): SessionData {
    return {
      ...createSession(),
      state: "awaiting_approval",
      promptSeen: true,
      toolStatus: "Bash",
      approvalInfo: {
        agentType: "claude",
        toolName: "Bash",
        summary: "ls",
        category: "permission",
      },
    };
  }

  it("phase2_timeout transitions to idle", () => {
    const { data, effects } = apply(awaitingApproval(), { type: "phase2_timeout" }, CTX({ now: 700_000 }));
    expect(data.state).toBe("idle");
    expect(data.lastStopAt).toBe(700_000);
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/finished/i);
  });

  it("stop event during approval transitions to idle and records stop", () => {
    const { data, effects } = apply(awaitingApproval(), { type: "stop" }, CTX({ now: 800_000 }));
    expect(data.state).toBe("idle");
    expect(data.lastStopAt).toBe(800_000);
    expect(hasEffect(effects, "record_stop")).toBeDefined();
  });

  it("non-permission notification clears approval and treats as passive", () => {
    const { data } = apply(
      awaitingApproval(),
      { type: "notification", category: "completed", subtitle: "", body: "done" },
      CTX({ now: 900_000, isViewingSession: false }),
    );
    expect(data.state).toBe("idle");
    expect(data.approvalInfo).toBeNull();
  });

  it("late pre_tool_use is ignored (returns same data)", () => {
    const base = awaitingApproval();
    const { data } = apply(base, {
      type: "pre_tool_use",
      toolName: "Bash",
      toolStatus: "Bash",
      question: null,
    });
    expect(data).toBe(base);
  });

  it("permission notification while awaiting_approval updates approval info", () => {
    const { data, effects } = apply(awaitingApproval(), {
      type: "notification",
      category: "permission",
      subtitle: "",
      body: '{"command":"npm i"}',
    });
    expect(data.approvalInfo?.summary).toBe("npm i");
    // Single set_approval effect — no extra notification firing
    expect(hasEffect(effects, "set_approval")).toBeDefined();
  });

  it("user prompt while awaiting_approval clears approval and starts processing", () => {
    const { data, effects } = apply(awaitingApproval(), {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "next",
    });
    expect(data.state).toBe("processing");
    expect(data.approvalInfo).toBeNull();
    expect(hasEffect(effects, "cancel_timers")).toBeDefined();
  });
});

describe("transitionInitializing", () => {
  it("pre_tool_use is swallowed (no transition)", () => {
    const base: SessionData = { ...createSession(), state: "initializing" };
    const { data, effects } = apply(base, {
      type: "pre_tool_use",
      toolName: "Edit",
      toolStatus: "edit",
      question: null,
    });
    expect(data).toBe(base);
    expect(effects).toEqual([]);
  });

  it("prompt_submit moves to processing", () => {
    const base: SessionData = { ...createSession(), state: "initializing" };
    const { data } = apply(base, {
      type: "prompt_submit",
      isSlashCommand: false,
      promptText: "hi",
    });
    expect(data.state).toBe("processing");
  });

  it("ignores unrelated events", () => {
    const base: SessionData = { ...createSession(), state: "initializing" };
    const { data, effects } = apply(base, { type: "stop" });
    expect(data).toBe(base);
    expect(effects).toEqual([]);
  });
});

describe("idle non-permission notifications", () => {
  it("waiting category is a no-op even when not viewing", () => {
    const base = createSession();
    const { data, effects } = apply(
      base,
      { type: "notification", category: "waiting", subtitle: "", body: "wait" },
      CTX({ isViewingSession: false }),
    );
    expect(data).toBe(base); // noTransition returns same reference
    expect(effects).toEqual([]);
  });

  it("error category bypasses throttle and emits notification", () => {
    const { data, effects } = apply(
      createSession(),
      { type: "notification", category: "error", subtitle: "", body: "Boom" },
      CTX({ isViewingSession: false }),
    );
    expect(hasEffect(effects, "send_notification")?.title).toMatch(/error/i);
    expect(data.lastPassiveNotifyAt).toBeGreaterThan(0);
  });

  it("repeated non-error notifications within throttle window do not re-notify", () => {
    let state = createSession();
    const t0 = 1_000_000;
    const r1 = apply(
      state,
      { type: "notification", category: "completed", subtitle: "", body: "done" },
      CTX({ now: t0, isViewingSession: false }),
    );
    state = r1.data;
    // mark_unread fires for completed
    expect(hasEffect(r1.effects, "mark_unread")).toBeDefined();

    // No throttle for "completed" specifically — it never sends OS notifications
    expect(hasEffect(r1.effects, "send_notification")).toBeUndefined();
  });

  it("attention notification within throttle window only fires mark_unread", () => {
    const seenState: SessionData = { ...createSession(), lastPassiveNotifyAt: 1_000_000 };
    const r = apply(
      seenState,
      { type: "notification", category: "attention", subtitle: "", body: "psst" },
      CTX({ now: 1_001_000, isViewingSession: false }),
    );
    expect(hasEffect(r.effects, "mark_unread")).toBeDefined();
    expect(hasEffect(r.effects, "send_notification")).toBeUndefined();
  });

  it("attention notification past throttle window fires OS notification", () => {
    const seenState: SessionData = { ...createSession(), lastPassiveNotifyAt: 1_000_000 };
    const r = apply(
      seenState,
      { type: "notification", category: "attention", subtitle: "", body: "psst" },
      CTX({ now: 1_020_000, isViewingSession: false }),
    );
    expect(hasEffect(r.effects, "send_notification")).toBeDefined();
  });
});

describe("session_start while in dismissed state", () => {
  it("from dismissed without prompt_seen → re-initializes (allowed)", () => {
    const base: SessionData = { ...createSession(), state: "dismissed", promptSeen: false };
    const { data } = apply(base, { type: "session_start" });
    // promptSeen=false → not "active" → resets to initializing
    expect(data.state).toBe("initializing");
  });

  it("from dismissed with promptSeen → ignored (still dismissed)", () => {
    const base: SessionData = { ...createSession(), state: "dismissed", promptSeen: true };
    const { data } = apply(base, { type: "session_start" });
    // dismissed is in active list — duplicate ignored
    expect(data).toBe(base);
  });
});

describe("ended state is terminal", () => {
  it("any event after session_end is a no-op", () => {
    const base: SessionData = { ...createSession(), state: "ended" };
    const r1 = apply(base, { type: "prompt_submit", isSlashCommand: false, promptText: "hi" });
    expect(r1.data).toBe(base);
    expect(r1.effects).toEqual([]);
    const r2 = apply(base, { type: "stop" });
    expect(r2.data).toBe(base);
  });
});
