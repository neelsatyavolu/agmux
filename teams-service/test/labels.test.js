import { describe, expect, it } from "vitest";
import { prettyModel, prettyProvider, prettyMixLabel } from "../web/labels.js";

describe("prettyProvider", () => {
  it("maps known provider ids", () => {
    expect(prettyProvider("ClaudeCode")).toBe("Claude Code");
    expect(prettyProvider("Codex")).toBe("Codex");
    expect(prettyProvider("Grok")).toBe("Grok");
    expect(prettyProvider("Other")).toBe("Other");
  });
});

describe("prettyModel", () => {
  it("prettifies Claude slugs", () => {
    expect(prettyModel("claude-opus-4-6")).toBe("Claude Opus 4.6");
    expect(prettyModel("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
    expect(prettyModel("claude-opus-5")).toBe("Claude Opus 5");
    expect(prettyModel("claude-opus-5[1m]")).toBe("Claude Opus 5 (1M)");
    expect(prettyModel("claude-fable-5")).toBe("Claude Fable 5");
  });

  it("prettifies GPT / Codex slugs", () => {
    expect(prettyModel("gpt-5.3-codex")).toBe("GPT 5.3 Codex");
    expect(prettyModel("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
  });

  it("prettifies Grok / xAI slugs", () => {
    expect(prettyModel("grok-4.6")).toBe("Grok 4.6");
    expect(prettyModel("grok-4.5")).toBe("Grok 4.5");
    expect(prettyModel("xai/grok-code-fast-1")).toBe("Grok Code Fast 1");
    expect(prettyModel("grok-composer-2.5-fast")).toBe("Composer 2.5");
  });
});

describe("prettyMixLabel", () => {
  it("routes by axis", () => {
    expect(prettyMixLabel("ClaudeCode", { mono: false })).toBe("Claude Code");
    expect(prettyMixLabel("claude-opus-4-6", { mono: true })).toBe("Claude Opus 4.6");
  });
});
