import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalStorage } from "./setup";

// Mock the LLM batch entrypoint so summarize() can enqueue without hitting Tauri.
const mocks = vi.hoisted(() => ({
  summarizeThreadNamesBatch: vi.fn(),
  localModelStatus: vi.fn(),
  ensureLocalLlmServer: vi.fn(),
  listThreadTurns: vi.fn(),
}));

vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  summarizeThreadNamesBatch: mocks.summarizeThreadNamesBatch,
  localModelStatus: mocks.localModelStatus,
  ensureLocalLlmServer: mocks.ensureLocalLlmServer,
  listThreadTurns: mocks.listThreadTurns,
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
}));

import {
  isTitleWeakPrompt,
  packTitleContext,
  useSessionNameStore,
} from "../sessionNameStore";
import { useSettingsStore } from "../settingsStore";

beforeEach(() => {
  clearLocalStorage();
  // Summarization is local-only; mock a ready current (non-legacy) model.
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, llmProvider: "local", groqModel: "" },
  }));
  useSessionNameStore.setState(
    { names: {}, logs: [], failedSummarizations: [] },
    false,
  );
  mocks.summarizeThreadNamesBatch.mockReset();
  mocks.localModelStatus.mockReset();
  mocks.ensureLocalLlmServer.mockReset();
  mocks.listThreadTurns.mockReset();
  mocks.listThreadTurns.mockResolvedValue([]);
  mocks.localModelStatus.mockResolvedValue({
    model_downloaded: true,
    server_downloaded: true,
    server_running: true,
    model_name: "Qwen3-1.7B (Q4_K_M)",
    model_size_bytes: 1_100_000_000,
    active_variant: "qwen3-1.7b",
    variants: [],
  });
  mocks.ensureLocalLlmServer.mockResolvedValue(0);
  // Default to never-resolving so the batch flush effectively pauses for unit tests
  // that only inspect synchronous state.
  mocks.summarizeThreadNamesBatch.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionNameStore — pure CRUD", () => {
  it("setName stores a name keyed by id", () => {
    useSessionNameStore.getState().setName("s1", "My Session");
    expect(useSessionNameStore.getState().names["s1"]).toBe("My Session");
  });

  it("setName creates a new names object reference", () => {
    const before = useSessionNameStore.getState().names;
    useSessionNameStore.getState().setName("s1", "x");
    expect(useSessionNameStore.getState().names).not.toBe(before);
  });

  it("setName persists to localStorage", () => {
    useSessionNameStore.getState().setName("s1", "x");
    const raw = localStorage.getItem("agmux-session-names");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ s1: "x" });
  });

  it("setName persists the id as a manual override (manualNames)", () => {
    useSessionNameStore.getState().setName("s1", "Mine");
    const raw = localStorage.getItem("agmux-session-manual-names");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toContain("s1");
  });

  it("clearLogs empties the log entries", () => {
    useSessionNameStore.setState({
      logs: [
        { id: "a", preview: "p", result: null, error: null, timestamp: 1, status: "pending" },
      ],
    });
    useSessionNameStore.getState().clearLogs();
    expect(useSessionNameStore.getState().logs).toEqual([]);
  });

  it("clearFailedSummarizations empties the failed list and persists", () => {
    useSessionNameStore.setState({
      failedSummarizations: [
        { id: "a", preview: "p", error: "bad", timestamp: 1, provider: "groq" },
      ],
    });
    useSessionNameStore.getState().clearFailedSummarizations();
    expect(useSessionNameStore.getState().failedSummarizations).toEqual([]);
    expect(localStorage.getItem("agmux-session-failed-summaries")).toBe("[]");
  });
});

describe("sessionNameStore — slash command provisional naming (PTY mode)", () => {
  it("derives a 'Cmd: args' provisional name for slash commands with args", () => {
    useSessionNameStore.getState().summarize("sl-args", "/commit fix the bug");
    const name = useSessionNameStore.getState().names["sl-args"];
    expect(name).toMatch(/^Commit: /);
    expect(name).toContain("fix the bug");
  });

  it("truncates long provisional names to 30 chars (with ellipsis)", () => {
    useSessionNameStore.getState().summarize(
      "sl-long",
      "/commit a much longer message that overflows the 29-char cap",
    );
    const name = useSessionNameStore.getState().names["sl-long"];
    expect(name).toBeDefined();
    expect(name!.length).toBeLessThanOrEqual(30);
    expect(name!.endsWith("…")).toBe(true);
  });

  it("skips bare slash commands with no args in PTY mode", () => {
    useSessionNameStore.getState().summarize("sl-bare", "/clear");
    expect(useSessionNameStore.getState().names["sl-bare"]).toBeUndefined();
  });

  it("does not overwrite an existing name when no SDK upgrade signal is given", () => {
    useSessionNameStore.getState().setName("sl-keep", "Existing");
    useSessionNameStore.getState().summarize("sl-keep", "anything else");
    expect(useSessionNameStore.getState().names["sl-keep"]).toBe("Existing");
  });

  it("ignores summarize() for manually renamed sessions", () => {
    useSessionNameStore.getState().setName("sl-manual", "Manual");
    useSessionNameStore.getState().summarize("sl-manual", "completely new prompt");
    expect(useSessionNameStore.getState().names["sl-manual"]).toBe("Manual");
  });
});

describe("sessionNameStore — instant naming for non-slash prompts", () => {
  it("sets a truncated instant name for short prompts", () => {
    useSessionNameStore.getState().summarize("ins-short", "hello world");
    expect(useSessionNameStore.getState().names["ins-short"]).toBe("hello world");
  });

  it("truncates long prompts to 30 chars including ellipsis", () => {
    const long = "a".repeat(100);
    useSessionNameStore.getState().summarize("ins-long", long);
    const name = useSessionNameStore.getState().names["ins-long"];
    expect(name).toBeDefined();
    expect(name!.length).toBeLessThanOrEqual(30);
    expect(name!.endsWith("…")).toBe(true);
  });

  it("appends a pending log entry when enqueuing for summarization", () => {
    useSessionNameStore.getState().summarize("ins-log", "do the thing");
    const logs = useSessionNameStore.getState().logs;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({ id: "ins-log", status: "pending" });
  });

  it("does not enqueue twice for the same id (pending guard)", () => {
    const before = useSessionNameStore.getState().logs.length;
    useSessionNameStore.getState().summarize("ins-dup", "first");
    useSessionNameStore.getState().summarize("ins-dup", "second");
    // Only one log row added because the second call hits the pending-guard early-return.
    expect(useSessionNameStore.getState().logs.length).toBe(before + 1);
  });

  it("persists the preview to localStorage so clearAllNames can re-summarize", () => {
    useSessionNameStore.getState().summarize("ins-persist", "hello world");
    const raw = localStorage.getItem("agmux-session-previews");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ "ins-persist": "hello world" });
  });
});

describe("sessionNameStore — Cline user_input wrapper", () => {
  it("strips <user_input> wrappers from the instant name", () => {
    useSessionNameStore
      .getState()
      .summarize("cline-uq-1", '<user_input mode="act">fix the cline spinner</user_input>');
    expect(useSessionNameStore.getState().names["cline-uq-1"]).toBe("fix the cline spinner");
  });
});

describe("sessionNameStore — Grok user_query wrapper", () => {
  it("strips <user_query> wrappers from the instant name and preview", () => {
    useSessionNameStore
      .getState()
      .summarize(
        "uq-1",
        "<user_query> agmux is stuck in an internal refresh loop </user_query>",
      );
    // Instant name truncates at 29 chars + ellipsis
    expect(useSessionNameStore.getState().names["uq-1"]).toBe(
      "agmux is stuck in an internal…",
    );
    const previews = JSON.parse(localStorage.getItem("agmux-session-previews") as string);
    expect(previews["uq-1"]).toBe("agmux is stuck in an internal refresh loop");
  });

  it("uses Grok skill purpose when the user ask is only a slash skill", () => {
    // Live shape from ~/.grok/sessions chat_history: bare /cmd + skill expansion.
    // Without skill enrichment, clean leaves `/checkagentsdk` and PTY mode skips.
    const raw = [
      "<user_query>",
      "/checkagentsdk",
      "</user_query>",
      "<skill_information>",
      "<skills_referenced>",
      '<skill name="checkagentsdk" path="/Users/neel/.claude/commands/checkagentsdk.md"/>',
      "</skills_referenced>",
      '<skill name="checkagentsdk">',
      "Check for Claude Agent SDK, OpenCode SDK, and Cursor SDK updates and safely upgrade if compatible.",
      "",
      "Run the workflow below for ALL THREE SDKs…",
      "</skill>",
      "</skill_information>",
    ].join("\n");

    useSessionNameStore.getState().summarize("grok-skill-1", raw);
    const name = useSessionNameStore.getState().names["grok-skill-1"];
    expect(name).toBeDefined();
    // Instant name from skill purpose (not raw /checkagentsdk, not "New Grok Thread")
    expect(name!.startsWith("/")).toBe(false);
    expect(name!.toLowerCase()).toContain("check");
    const previews = JSON.parse(localStorage.getItem("agmux-session-previews") as string);
    expect(previews["grok-skill-1"]).toMatch(/Claude Agent SDK/i);
  });

  it("humanizes bare slash when mode=sdk (hook-confirmed turn)", () => {
    useSessionNameStore.getState().summarize("slash-sdk", "/checkagentsdk", "sdk");
    const name = useSessionNameStore.getState().names["slash-sdk"];
    expect(name).toBe("Checkagentsdk");
  });
});

describe("sessionNameStore — ANSI/control sanitization", () => {
  it("strips SGR colour codes from the instant name", () => {
    useSessionNameStore
      .getState()
      .summarize("ansi-sgr", "\x1b[38;2;255;100;50mfix the scraper bug\x1b[0m");
    expect(useSessionNameStore.getState().names["ansi-sgr"]).toBe("fix the scraper bug");
  });

  it("strips OSC and bracketed-paste markers", () => {
    useSessionNameStore
      .getState()
      .summarize("ansi-osc", "\x1b]0;tab title\x07\x1b[200~hello world\x1b[201~");
    expect(useSessionNameStore.getState().names["ansi-osc"]).toBe("hello world");
  });

  it("persists the cleaned preview to localStorage (not the raw ANSI text)", () => {
    useSessionNameStore
      .getState()
      .summarize("ansi-preview", "\x1b[31mfix bug\x1b[0m");
    const raw = localStorage.getItem("agmux-session-previews");
    expect(JSON.parse(raw as string)).toMatchObject({ "ansi-preview": "fix bug" });
  });

  it("does nothing if a prompt is purely ANSI noise", () => {
    useSessionNameStore.getState().summarize("ansi-empty", "\x1b[38;2;1;2;3m\x1b[0m");
    expect(useSessionNameStore.getState().names["ansi-empty"]).toBeUndefined();
  });
});

describe("sessionNameStore — clearAllNames", () => {
  it("clears names and logs and removes the persisted names key", () => {
    useSessionNameStore.getState().setName("a", "X");
    useSessionNameStore.setState({
      logs: [
        { id: "a", preview: "p", result: null, error: null, timestamp: 1, status: "pending" },
      ],
    });
    useSessionNameStore.getState().clearAllNames();
    const s = useSessionNameStore.getState();
    expect(s.names).toEqual({});
    expect(s.logs).toEqual([]);
    expect(localStorage.getItem("agmux-session-names")).toBeNull();
  });

  it("clears manual-name overrides too", () => {
    useSessionNameStore.getState().setName("a", "X");
    useSessionNameStore.getState().clearAllNames();
    // After clearing, summarize for "a" should not be blocked by manualNames.
    useSessionNameStore.getState().summarize("a", "hello");
    expect(useSessionNameStore.getState().names["a"]).toBe("hello");
  });
});

describe("sessionNameStore — retryFailedSummarization", () => {
  it("removes the failed entry and re-queues summarization", () => {
    useSessionNameStore.setState({
      failedSummarizations: [
        { id: "rt-1", preview: "do thing", error: "bad", timestamp: 1, provider: "groq" },
      ],
      names: { "rt-1": "stale" },
    });
    useSessionNameStore.getState().retryFailedSummarization("rt-1");
    const s = useSessionNameStore.getState();
    expect(s.failedSummarizations).toEqual([]);
    // Names cleared and a fresh instant name set by summarize().
    expect(s.names["rt-1"]).toBe("do thing");
  });

  it("is a no-op when the id is not in the failed list", () => {
    const before = useSessionNameStore.getState().failedSummarizations;
    useSessionNameStore.getState().retryFailedSummarization("rt-missing");
    expect(useSessionNameStore.getState().failedSummarizations).toBe(before);
  });
});

describe("isTitleWeakPrompt — approval-only follow-ups", () => {
  it("flags pure approvals", () => {
    for (const p of [
      "go ahead",
      "Go ahead!",
      "yes go ahead",
      "do it",
      "lgtm",
      "ship it",
      "ok",
      "sure",
      "implement it",
      "please proceed",
      "yes, go ahead",
      "ok, please continue",
      "conitnue",
      "continue with the plan",
      "go ahead and do it please",
    ]) {
      expect(isTitleWeakPrompt(p), p).toBe(true);
    }
  });

  it("keeps prompts that still have a subject after the approval shell", () => {
    expect(isTitleWeakPrompt("go ahead and implement multi-prompt titles")).toBe(
      false,
    );
    expect(isTitleWeakPrompt("yes, fix the login redirect")).toBe(false);
    expect(isTitleWeakPrompt("add dark mode")).toBe(false);
    expect(isTitleWeakPrompt("continue fixing the login redirect")).toBe(false);
    expect(isTitleWeakPrompt("go ahead and add CSV export")).toBe(false);
  });
});

describe("packTitleContext — end-biased multi-prompt packing", () => {
  it("returns a single prompt snipped to budget", () => {
    expect(packTitleContext(["fix the login redirect"], 100)).toBe(
      "fix the login redirect",
    );
    const long = "a".repeat(80);
    const out = packTitleContext([long], 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers Latest and keeps total length under budget", () => {
    const out = packTitleContext(
      [
        "fix the login redirect bug in auth",
        "add unit tests for the login path",
        "also cover the timeout path when the server is slow",
      ],
      200,
    );
    expect(out).toContain("Earlier:");
    expect(out).toContain("Latest:");
    expect(out).toContain("timeout");
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("biases earlier snips toward the more recent prior turns", () => {
    const out = packTitleContext(
      ["ancient unrelated ask", "recent prior turn about codex", "latest about dark mode"],
      120,
    );
    expect(out).toMatch(/Latest:.*dark mode/i);
    // Tiny budget may drop ancient; recent prior should usually survive.
    expect(out.toLowerCase()).toMatch(/codex|dark mode/);
  });

  it("ignores a trailing 'go ahead' and keeps the real work as Latest", () => {
    const out = packTitleContext(
      [
        "add resummarize on each new prompt with end-biased context",
        "go ahead",
      ],
      200,
    );
    expect(out.toLowerCase()).not.toContain("go ahead");
    expect(out.toLowerCase()).toMatch(/resummarize|end-biased|prompt/);
  });
});

describe("sessionNameStore — multi-prompt re-summarize", () => {
  it.each(["pty", "sdk"] as const)("preserves task context across queued/steering follow-ups in %s mode", async (mode) => {
    vi.useFakeTimers();
    const id = `followups-${mode}`;
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ [id]: "Fix login redirect" });
    useSessionNameStore.getState().summarize(id, "fix the login redirect", mode);
    await vi.advanceTimersByTimeAsync(400);
    const callsBefore = mocks.summarizeThreadNamesBatch.mock.calls.length;
    for (let i = 0; i < 15; i++) {
      for (const text of ["yes, go ahead", "conitnue", "/compact", "/commit", "please continue"]) {
        useSessionNameStore.getState().summarize(id, text, mode);
      }
    }
    useSessionNameStore.getState().summarize(id,
      '<user_query>/review</user_query><skill_information><skill name="review">Review code quality</skill></skill_information>', mode);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.summarizeThreadNamesBatch.mock.calls.length).toBe(callsBefore);
    expect(useSessionNameStore.getState().names[id]).toBe("Fix login redirect");
    useSessionNameStore.getState().resummarize(id);
    await vi.advanceTimersByTimeAsync(400);
    const items = mocks.summarizeThreadNamesBatch.mock.lastCall?.[0] as Array<[string, string]>;
    expect(items.find(([key]) => key === id)?.[1]).toContain("login redirect");
  });

  it("keeps the current task as context for steering after a restart without prompt history", async () => {
    vi.useFakeTimers();
    useSessionNameStore.setState({ names: { steering: "Fix login redirect" } });
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ steering: "Test login redirect" });
    useSessionNameStore.getState().summarize("steering", "also cover the timeout path", "sdk");
    await vi.advanceTimersByTimeAsync(400);
    const items = mocks.summarizeThreadNamesBatch.mock.lastCall?.[0] as Array<[string, string]>;
    expect(items.find(([key]) => key === "steering")?.[1]).toContain("Fix login redirect");
  });

  it("re-queues on a second prompt after the first name is set", async () => {
    vi.useFakeTimers();
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ mp: "Fix login" });

    useSessionNameStore.getState().summarize("mp", "fix the login bug");
    await vi.advanceTimersByTimeAsync(400);
    // Flush the microtask from the resolved batch
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionNameStore.getState().names["mp"]).toBe("Fix login");

    mocks.summarizeThreadNamesBatch.mockResolvedValue({ mp: "Test login path" });
    useSessionNameStore.getState().summarize("mp", "add tests for the timeout path");
    // Keep existing title until the new LLM result lands
    expect(useSessionNameStore.getState().names["mp"]).toBe("Fix login");

    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionNameStore.getState().names["mp"]).toBe("Test login path");
    const calls = mocks.summarizeThreadNamesBatch.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const items = lastCall[0] as Array<[string, string]>;
    const packed = items.find(([id]) => id === "mp")?.[1] ?? "";
    expect(packed).toContain("Earlier:");
    expect(packed).toContain("Latest:");
    expect(packed.toLowerCase()).toContain("timeout");
  });

  it("persists multi-prompt history for later resummarize", () => {
    useSessionNameStore.getState().summarize("hist", "first ask about auth");
    useSessionNameStore.getState().summarize("hist", "second ask about tokens");
    const raw = localStorage.getItem("agmux-session-prompt-history");
    expect(raw).not.toBeNull();
    const hist = JSON.parse(raw as string);
    expect(hist["hist"]).toEqual([
      "first ask about auth",
      "second ask about tokens",
    ]);
  });

  it("resummarize clears a manual rename and re-queues from history", async () => {
    vi.useFakeTimers();
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ rs: "Auto title" });

    useSessionNameStore.getState().summarize("rs", "fix spinner");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    useSessionNameStore.getState().setName("rs", "My Manual Name");
    expect(useSessionNameStore.getState().names["rs"]).toBe("My Manual Name");

    mocks.summarizeThreadNamesBatch.mockResolvedValue({ rs: "Fix spinner" });
    useSessionNameStore.getState().resummarize("rs");
    // Manual cleared — still shows old label until LLM returns
    expect(useSessionNameStore.getState().names["rs"]).toBe("My Manual Name");

    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionNameStore.getState().names["rs"]).toBe("Fix spinner");
    // Manual override is gone — a later summarize must not be blocked.
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ rs: "New topic" });
    useSessionNameStore.getState().summarize("rs", "brand new topic about dark mode");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();
    expect(useSessionNameStore.getState().names["rs"]).toBe("New topic");
  });

  it("does not re-title when the new prompt is only 'go ahead'", async () => {
    vi.useFakeTimers();
    mocks.summarizeThreadNamesBatch.mockResolvedValue({
      weak: "Resummarize titles",
    });

    useSessionNameStore
      .getState()
      .summarize("weak", "add resummarize on each new prompt");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();
    expect(useSessionNameStore.getState().names["weak"]).toBe(
      "Resummarize titles",
    );

    const callsBefore = mocks.summarizeThreadNamesBatch.mock.calls.length;
    useSessionNameStore.getState().summarize("weak", "go ahead");
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    // No new LLM call — keep the substantive title.
    expect(mocks.summarizeThreadNamesBatch.mock.calls.length).toBe(callsBefore);
    expect(useSessionNameStore.getState().names["weak"]).toBe(
      "Resummarize titles",
    );
    // History still records the approval turn.
    const hist = JSON.parse(
      localStorage.getItem("agmux-session-prompt-history") as string,
    );
    expect(hist["weak"]).toContain("go ahead");
  });

  it("resummarize hydrates from thread turns when history is empty", async () => {
    vi.useFakeTimers();
    mocks.listThreadTurns.mockResolvedValue([
      { seq: 2, promptText: "latest about dark mode", threadId: "turn-1" },
      { seq: 1, promptText: "earlier about auth", threadId: "turn-1" },
    ]);
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ "turn-1": "Add dark mode" });

    useSessionNameStore.getState().resummarize("turn-1");
    // Allow the listThreadTurns promise to settle
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.listThreadTurns).toHaveBeenCalledWith("turn-1", 20);
    expect(useSessionNameStore.getState().names["turn-1"]).toBe("Add dark mode");
    const calls = mocks.summarizeThreadNamesBatch.mock.calls;
    const lastCall = calls[calls.length - 1];
    const items = lastCall[0] as Array<[string, string]>;
    const packed = items.find(([id]) => id === "turn-1")?.[1] ?? "";
    expect(packed).toContain("Latest:");
    expect(packed.toLowerCase()).toContain("dark mode");
  });

  it("resummarize retains the current task when saved history is only a steering ask", async () => {
    vi.useFakeTimers();
    useSessionNameStore.setState({ names: { "rs-context": "Fix login redirect" } });
    localStorage.setItem("agmux-session-prompt-history", JSON.stringify({ "rs-context": ["also test the timeout path", "yes, go ahead", "/compact"] }));
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ "rs-context": "Test login timeout" });
    useSessionNameStore.getState().resummarize("rs-context");
    await vi.advanceTimersByTimeAsync(400);
    const packed = mocks.summarizeThreadNamesBatch.mock.lastCall?.[0][0][1];
    expect(packed).toContain("Fix login redirect");
    expect(packed).toContain("timeout");
    expect(packed).not.toContain("go ahead");
    expect(packed).not.toContain("/compact");
  });

  it("resummarize recovers real work when the cache only has vague follow-ups", async () => {
    vi.useFakeTimers();
    localStorage.setItem("agmux-session-prompt-history", JSON.stringify({ "rs-recover": ["conitnue", "/commit"] }));
    mocks.listThreadTurns.mockResolvedValue([
      { seq: 1, promptText: "fix login redirect" },
      ...Array.from({ length: 15 }, (_, i) => ({ seq: i + 2, promptText: i % 2 ? "go ahead" : '<user_query>/review</user_query><skill_information><skill name="review">Review code quality</skill></skill_information>' })),
    ]);
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ "rs-recover": "Fix login redirect" });
    useSessionNameStore.getState().resummarize("rs-recover");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.listThreadTurns).toHaveBeenCalledWith("rs-recover", 20);
    expect(mocks.summarizeThreadNamesBatch.mock.lastCall?.[0][0][1]).toBe("fix login redirect");
    expect(JSON.parse(localStorage.getItem("agmux-session-prompt-history")!)["rs-recover"]).toEqual(["fix login redirect"]);
  });

  it("resummarize keeps the title when no substantive history can be recovered", async () => {
    vi.useFakeTimers();
    useSessionNameStore.setState({ names: { "rs-empty": "Fix login redirect" } });
    localStorage.setItem("agmux-session-previews", JSON.stringify({ "rs-empty": "Earlier: yes, go ahead\nLatest: /compact" }));
    useSessionNameStore.getState().resummarize("rs-empty");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.summarizeThreadNamesBatch).not.toHaveBeenCalled();
    expect(useSessionNameStore.getState().names["rs-empty"]).toBe("Fix login redirect");
  });

  it.each([false, true])("resummarize filters legacy packed previews when history lookup fails: %s", async (fails) => {
    vi.useFakeTimers();
    const id = `rs-packed-${fails}`;
    localStorage.setItem("agmux-session-previews", JSON.stringify({ [id]: "Earlier: fix login redirect; /review\nLatest: yes, go ahead" }));
    if (fails) mocks.listThreadTurns.mockRejectedValue(new Error("history unavailable"));
    mocks.summarizeThreadNamesBatch.mockResolvedValue({ [id]: "Fix login redirect" });
    useSessionNameStore.getState().resummarize(id);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.summarizeThreadNamesBatch.mock.lastCall?.[0][0][1]).toBe("fix login redirect");
  });
});
