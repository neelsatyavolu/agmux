import { describe, expect, it } from "vitest";
import {
  consultToolFromName,
  consultToolNames,
  formatSeconds,
  parseConsultAnswers,
  summarizeConsultCall,
} from "../consultTools";

// Shapes consult-mcp 1.0.3 replies with (server.js formatReply / formatPanel).
const SINGLE =
  "The retry loop never resets `attempt`.\n\n---\nagent: codex · model: gpt-6-astra · session_id: 0199-abc · 42.3s\nPass session_id to ask a follow-up in the same conversation.";
const PANEL = [
  "## codex\n\nLooks fine.\n\nagent: codex · session_id: s-1 · 12.0s",
  "## grok\n\nFailed: grok exited with code 1",
  "## claude\n\n1. **High**: `src/a.ts:10` drops errors.\n\nagent: claude · model: opus · session_id: s-3 · 95.5s",
].join("\n\n") + "\n\n---\nPass an advisor's session_id to ask_agent for a follow-up.";

describe("consultToolFromName", () => {
  it("recognizes every provider's naming", () => {
    expect(consultToolFromName("mcp__consult__ask_agent")).toBe("ask_agent");
    expect(consultToolFromName("consult__review_changes")).toBe("review_changes");
    expect(consultToolFromName("send_message", "consult")).toBe("send_message");
  });

  it("ignores other servers and unknown tools", () => {
    expect(consultToolFromName("mcp__agmux-memory__memory_list")).toBeNull();
    expect(consultToolFromName("mcp__consult__unknown")).toBeNull();
    expect(consultToolFromName("ask_agent", "other")).toBeNull();
    expect(consultToolFromName("ask_agent")).toBeNull();
  });

  it("lists both name forms for the renderer registry", () => {
    const names = consultToolNames();
    expect(names).toContain("mcp__consult__ask_agents");
    expect(names).toContain("consult__list_sessions");
  });
});

describe("summarizeConsultCall", () => {
  it("names the advisor and model", () => {
    expect(summarizeConsultCall("ask_agent", { agent: "codex", model: "gpt-6-astra", question: "Is it safe?" })).toEqual({
      label: "Asked Codex (gpt-6-astra)",
      detail: "Is it safe?",
    });
    expect(summarizeConsultCall("ask_agent", { agent: "agy", question: "q" }).label).toBe("Asked Gemini");
  });

  it("describes reviews by focus or base", () => {
    expect(summarizeConsultCall("review_changes", { agents: ["codex", "grok"] })).toEqual({
      label: "Review by Codex, Grok",
      detail: "uncommitted changes",
    });
    expect(summarizeConsultCall("review_changes", { agents: ["claude"], base: "main" }).detail).toBe("changes since main");
    expect(summarizeConsultCall("review_changes", { agents: ["claude"], focus: "retry path" }).detail).toBe("retry path");
  });

  it("tolerates missing input", () => {
    expect(summarizeConsultCall("ask_agents", {}).label).toBe("Asked advisors");
    expect(summarizeConsultCall("send_message", {}).detail).toBe("");
  });
});

describe("parseConsultAnswers", () => {
  it("parses a single reply and its footer", () => {
    expect(parseConsultAnswers(SINGLE)).toEqual([
      {
        agent: "codex",
        model: "gpt-6-astra",
        sessionId: "0199-abc",
        seconds: 42.3,
        answer: "The retry loop never resets `attempt`.",
      },
    ]);
  });

  it("parses panel sections, including failures", () => {
    const answers = parseConsultAnswers(PANEL);
    expect(answers?.map((a) => a.agent)).toEqual(["codex", "grok", "claude"]);
    expect(answers?.[0]).toMatchObject({ answer: "Looks fine.", seconds: 12 });
    expect(answers?.[1]).toMatchObject({ failed: true, answer: "grok exited with code 1" });
    expect(answers?.[2]).toMatchObject({ model: "opus", answer: "1. **High**: `src/a.ts:10` drops errors." });
  });

  it("returns null for replies that aren't answers", () => {
    expect(parseConsultAnswers(null)).toBeNull();
    expect(parseConsultAnswers('[{"session_id":"x"}]')).toBeNull();
    expect(parseConsultAnswers("Sent to the codex session x. It reads the message now.")).toBeNull();
    expect(parseConsultAnswers("text\n\n---\nnot a footer")).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("shortens long calls to minutes", () => {
    expect(formatSeconds(undefined)).toBe("");
    expect(formatSeconds(42.3)).toBe("42s");
    expect(formatSeconds(95.5)).toBe("1m 36s");
    expect(formatSeconds(120)).toBe("2m");
  });
});
