import { describe, expect, it } from "vitest";
import {
  classifyNotification,
  describeToolUse,
  detectCommandWarnings,
  extractAskUserQuestion,
  extractHookPromptText,
  isAskUserQuestionTool,
  isGrokSubagentHookPayload,
} from "../claudeHooks";

describe("extractHookPromptText", () => {
  it("reads plain string fields (Claude / Grok / OpenCode)", () => {
    expect(extractHookPromptText({ message: "hi" })).toBe("hi");
    expect(extractHookPromptText({ prompt: "do the thing" })).toBe("do the thing");
    expect(extractHookPromptText({ text: "t" })).toBe("t");
    expect(extractHookPromptText({ user_prompt: "u" })).toBe("u");
    expect(extractHookPromptText({ userMessage: "agy prompt" })).toBe("agy prompt");
  });

  it("flattens Kimi Code content-block arrays under prompt", () => {
    // Live payload from kimi 0.33.0 UserPromptSubmit (captured 2026-08-05)
    const kimiPayload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "session_abc",
      cwd: "/tmp",
      client_type: "kimi_code_cli",
      prompt: [
        {
          type: "text",
          text: "Reply with exactly: KIMI_HOOK_TEST_OK. Do not use tools.",
        },
      ],
      is_steer: false,
    };
    expect(extractHookPromptText(kimiPayload)).toBe(
      "Reply with exactly: KIMI_HOOK_TEST_OK. Do not use tools.",
    );
  });

  it("joins multi-block Kimi prompts", () => {
    expect(
      extractHookPromptText({
        prompt: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    ).toBe("line one\nline two");
  });

  it("returns empty string for missing / non-text payloads", () => {
    expect(extractHookPromptText(null)).toBe("");
    expect(extractHookPromptText({})).toBe("");
    expect(extractHookPromptText({ prompt: [] })).toBe("");
    expect(extractHookPromptText({ prompt: [{ type: "image" }] })).toBe("");
  });

  it("does not throw when prompt is an array (regression)", () => {
    expect(() =>
      extractHookPromptText({ prompt: [{ type: "text", text: "x" }] }).trimStart(),
    ).not.toThrow();
  });

  it("reads Hermes pre_llm_call user_message (top-level and extra)", () => {
    expect(extractHookPromptText({ user_message: "fix the hermes title" })).toBe(
      "fix the hermes title",
    );
    expect(
      extractHookPromptText({
        hook_event_name: "pre_llm_call",
        session_id: "20260825_180938_5bc807",
        extra: { user_message: "rename this thread", model: "gpt-5.4-mini" },
      }),
    ).toBe("rename this thread");
  });

  it("reads Cline userPromptSubmit.prompt", () => {
    expect(
      extractHookPromptText({
        hookName: "prompt_submit",
        taskId: "1787706792286_6oz4f",
        userPromptSubmit: { prompt: "rename the thread from this prompt", attachments: [] },
      }),
    ).toBe("rename the thread from this prompt");
  });

  it("unwraps Cline TUI <user_input> wrappers", () => {
    expect(
      extractHookPromptText({
        userPromptSubmit: { prompt: '<user_input mode="act">hello from tui</user_input>' },
      }),
    ).toBe("hello from tui");
    expect(extractHookPromptText('<user_input mode="act">plain wrap</user_input>')).toBe(
      "plain wrap",
    );
  });
});

describe("classifyNotification", () => {
  it("treats null/empty payloads as 'waiting'", () => {
    expect(classifyNotification(null)).toMatchObject({ category: "waiting", subtitle: "Waiting" });
    expect(classifyNotification({})).toMatchObject({ category: "waiting" });
  });

  it("classifies permission keywords", () => {
    const r = classifyNotification({ message: "Approve this command?" });
    expect(r.category).toBe("permission");
    expect(r.body).toContain("Approve");
  });

  it("classifies error keywords", () => {
    const r = classifyNotification({ message: "Operation failed" });
    expect(r.category).toBe("error");
  });

  it("classifies completion keywords", () => {
    const r = classifyNotification({ message: "Task completed" });
    expect(r.category).toBe("completed");
  });

  it("classifies explicit idle signal as waiting", () => {
    const r = classifyNotification({ event: "idle_prompt", message: "still here" });
    expect(r.category).toBe("waiting");
  });

  it("falls through to attention with a custom message", () => {
    const r = classifyNotification({ message: "Look at me" });
    expect(r.category).toBe("attention");
    expect(r.body).toBe("Look at me");
  });

  it("uses a default attention message when none given", () => {
    // Provide a key so it's not 'empty payload'
    const r = classifyNotification({ event: "something" });
    expect(r.category).toBe("attention");
    expect(r.body).toBe("Claude needs your attention");
  });

  it("reads message from nested .notification field", () => {
    const r = classifyNotification({ notification: { message: "permission needed" } });
    expect(r.category).toBe("permission");
  });
});

describe("describeToolUse", () => {
  it("returns null for null input or missing tool_name", () => {
    expect(describeToolUse(null)).toBeNull();
    expect(describeToolUse({})).toBeNull();
  });

  it("describes Read with shortened path", () => {
    expect(describeToolUse({ tool_name: "Read", tool_input: { file_path: "/a/b/c/file.ts" } }))
      .toBe("Reading file.ts");
  });

  it("describes Bash with first token", () => {
    expect(describeToolUse({ tool_name: "Bash", tool_input: { command: "ls -la /tmp" } }))
      .toBe("Running ls");
  });

  it("describes live Kimi PreToolUse Bash payload", () => {
    // Captured from kimi 0.33.0 PreToolUse (2026-08-05)
    expect(
      describeToolUse({
        hook_event_name: "PreToolUse",
        session_id: "session_cbf51b98-e286-4c35-9159-c9b6dd9a9223",
        cwd: "/Users/neel/Documents/GitHub/agmux",
        client_type: "kimi_code_cli",
        tool_name: "Bash",
        tool_input: { command: "echo PERM_TEST" },
        tool_call_id: "tool_uijLRkKp50B8FhhagVn7M4Gy",
      }),
    ).toBe("Running echo");
  });

  it("describes Grep with truncated pattern", () => {
    expect(describeToolUse({ tool_name: "Grep", tool_input: { pattern: "needle" } }))
      .toBe("Grep needle");
  });

  it("describes WebFetch with a static label", () => {
    expect(describeToolUse({ tool_name: "WebFetch", tool_input: {} })).toBe("Fetching URL");
  });

  it("describes Antigravity run_command via toolCall.args.CommandLine", () => {
    expect(
      describeToolUse({
        toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
      }),
    ).toBe("Running npm");
  });

  it("describes Antigravity ask_permission as permission needed", () => {
    expect(describeToolUse({ toolCall: { name: "ask_permission", args: {} } })).toBe(
      "Permission needed",
    );
  });

  it("returns the bare tool name for unknown tools", () => {
    expect(describeToolUse({ tool_name: "MystryTool", tool_input: {} })).toBe("MystryTool");
  });

  it("falls back to a generic label when input is missing", () => {
    expect(describeToolUse({ tool_name: "Edit" })).toBe("Editing file");
    expect(describeToolUse({ tool_name: "Write" })).toBe("Writing file");
  });
});

describe("extractAskUserQuestion", () => {
  it("returns null for non-AskUserQuestion tools", () => {
    expect(extractAskUserQuestion({ tool_name: "Bash" })).toBeNull();
  });

  it("treats Antigravity ask_permission as a permission question", () => {
    expect(extractAskUserQuestion({ toolCall: { name: "ask_permission" } })).toBe(
      "Permission needed",
    );
  });

  it("treats Antigravity ask_question like AskUserQuestion", () => {
    expect(
      extractAskUserQuestion({
        toolCall: { name: "ask_question", args: { question: "Which path?" } },
      }),
    ).toBe("Which path?");
  });

  it("returns null for null payload", () => {
    expect(extractAskUserQuestion(null)).toBeNull();
  });

  it("extracts the first question and option labels", () => {
    const out = extractAskUserQuestion({
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Pick one", options: [{ label: "yes" }, { label: "no" }] },
        ],
      },
    });
    expect(out).toBe("Pick one\n[yes] [no]");
  });

  it("falls back to 'header' when 'question' is missing", () => {
    const out = extractAskUserQuestion({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ header: "Heads up" }] },
    });
    expect(out).toBe("Heads up");
  });

  it("falls back to direct .question on input", () => {
    const out = extractAskUserQuestion({
      tool_name: "AskUserQuestion",
      tool_input: { question: "Direct?" },
    });
    expect(out).toBe("Direct?");
  });

  it("returns 'Asking a question' when nothing extractable", () => {
    const out = extractAskUserQuestion({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{}] },
    });
    expect(out).toBe("Asking a question");
  });

  it("accepts Grok ask_user_question + camelCase fields", () => {
    const out = extractAskUserQuestion({
      toolName: "ask_user_question",
      toolInput: {
        questions: [
          {
            question: "Naming for the two voice-related nav items?",
            options: [
              { label: "Writing / Voice (Recommended)" },
              { label: "Your corpus / Your voice" },
            ],
          },
        ],
      },
    });
    expect(out).toBe(
      "Naming for the two voice-related nav items?\n[Writing / Voice (Recommended)] [Your corpus / Your voice]",
    );
  });

  it("returns 'Asking a question' when Grok payload has tool name but no input", () => {
    expect(extractAskUserQuestion({ toolName: "ask_user_question" })).toBe(
      "Asking a question",
    );
  });
});

describe("isAskUserQuestionTool", () => {
  it("matches Claude and Grok names", () => {
    expect(isAskUserQuestionTool("AskUserQuestion")).toBe(true);
    expect(isAskUserQuestionTool("ask_user_question")).toBe(true);
    expect(isAskUserQuestionTool("ASK_USER_QUESTION")).toBe(true);
    expect(isAskUserQuestionTool("Bash")).toBe(false);
    expect(isAskUserQuestionTool(null)).toBe(false);
  });
});

describe("describeToolUse Grok camelCase", () => {
  it("describes ask_user_question via toolName", () => {
    expect(describeToolUse({ toolName: "ask_user_question" })).toBe("Asking a question");
  });

  it("describes run_terminal_command with camelCase input", () => {
    expect(
      describeToolUse({
        toolName: "run_terminal_command",
        toolInput: { command: "npm test" },
      }),
    ).toBe("Running npm");
  });
});

describe("detectCommandWarnings", () => {
  it("returns [] for non-Bash tools", () => {
    expect(detectCommandWarnings("Read", { command: "$(rm -rf /)" })).toEqual([]);
  });

  it("returns [] when input.command is missing or non-string", () => {
    expect(detectCommandWarnings("Bash", {})).toEqual([]);
    expect(detectCommandWarnings("Bash", { command: 42 })).toEqual([]);
  });

  it("flags $() substitution and backticks and eval", () => {
    expect(detectCommandWarnings("Bash", { command: "echo $(date)" }))
      .toContain("Contains $() substitution");
    expect(detectCommandWarnings("Bash", { command: "echo `date`" }))
      .toContain("Contains backtick substitution");
    expect(detectCommandWarnings("Bash", { command: "eval foo" })).toContain("Uses eval");
  });

  it("flags curl|sh download-and-pipe pattern", () => {
    const w = detectCommandWarnings("Bash", { command: "curl https://x | sh" });
    expect(w).toContain("Downloads and pipes to shell");
    expect(w).toContain("Pipes to shell interpreter");
  });

  it("flags rm -rf and sudo", () => {
    const w = detectCommandWarnings("Bash", { command: "sudo rm -rf /tmp/foo" });
    expect(w).toContain("Recursive or forced delete");
    expect(w).toContain("Elevated privileges (sudo)");
  });

  it("flags --force and --hard but not --force-with-lease", () => {
    expect(detectCommandWarnings("Bash", { command: "git push --force" }))
      .toContain("Uses --force or --hard flag");
    expect(detectCommandWarnings("Bash", { command: "git push --force-with-lease" }))
      .not.toContain("Uses --force or --hard flag");
  });

  it("flags chmod 777 and recursive chmod", () => {
    expect(detectCommandWarnings("Bash", { command: "chmod 777 file" }))
      .toContain("Recursive or world-writable permission change");
    expect(detectCommandWarnings("Bash", { command: "chmod -R 755 dir" }))
      .toContain("Recursive or world-writable permission change");
  });

  it("flags fork bomb pattern", () => {
    expect(detectCommandWarnings("Bash", { command: ":(){ :|:& };:" }))
      .toContain("Possible fork bomb");
  });

  it("returns [] for a benign command", () => {
    expect(detectCommandWarnings("Bash", { command: "ls -la" })).toEqual([]);
  });
});

describe("isGrokSubagentHookPayload", () => {
  it("detects Grok's documented subagentType on worker Stop", () => {
    expect(isGrokSubagentHookPayload({
      hookEventName: "stop",
      sessionId: "worker-1",
      subagentType: "explore",
    })).toBe(true);
  });

  it("detects snake_case subagent_type", () => {
    expect(isGrokSubagentHookPayload({ subagent_type: "general-purpose" })).toBe(true);
  });

  it("detects SubagentStop event names even without subagentType", () => {
    expect(isGrokSubagentHookPayload({ hookEventName: "subagent_stop" })).toBe(true);
    expect(isGrokSubagentHookPayload({ hook_event_name: "SubagentStop" })).toBe(true);
    expect(isGrokSubagentHookPayload({ hook_event_name: "SubagentEnd" })).toBe(true);
  });

  it("detects session_kind / parent_session_id on worker payloads", () => {
    expect(isGrokSubagentHookPayload({ session_kind: "subagent" })).toBe(true);
    expect(isGrokSubagentHookPayload({ parent_session_id: "parent-1" })).toBe(true);
  });

  it("is false for the primary Grok session", () => {
    expect(isGrokSubagentHookPayload({
      hookEventName: "stop",
      sessionId: "primary-1",
    })).toBe(false);
    expect(isGrokSubagentHookPayload({ subagentType: "" })).toBe(false);
    expect(isGrokSubagentHookPayload(null)).toBe(false);
  });
});
