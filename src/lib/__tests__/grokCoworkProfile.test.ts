import { describe, expect, it } from "vitest";
import { GROK_COWORK_SYSTEM_PROMPT, isGrokCoworkThread } from "../grokCoworkProfile";

describe("grokCoworkProfile", () => {
  it("is knowledge-work Grok, not a coding-only prompt", () => {
    expect(GROK_COWORK_SYSTEM_PROMPT.length).toBeGreaterThan(800);
    expect(GROK_COWORK_SYSTEM_PROMPT).toMatch(/Grok Cowork/);
    expect(GROK_COWORK_SYSTEM_PROMPT).toMatch(/knowledge-work/i);
    expect(GROK_COWORK_SYSTEM_PROMPT).toMatch(/same tools/i);
    expect(GROK_COWORK_SYSTEM_PROMPT).not.toMatch(/Claude Code/);
    expect(GROK_COWORK_SYSTEM_PROMPT).not.toMatch(/commentary channel/);
  });

  it("isGrokCoworkThread only matches Grok SDK cowork", () => {
    expect(
      isGrokCoworkThread({
        provider: "Grok",
        agent_profile: "cowork",
        interaction_mode: "grok-sdk",
      }),
    ).toBe(true);
    expect(
      isGrokCoworkThread({
        provider: "Grok",
        agent_profile: null,
        interaction_mode: "grok-sdk",
      }),
    ).toBe(false);
    expect(
      isGrokCoworkThread({
        provider: "ClaudeCode",
        agent_profile: "cowork",
        interaction_mode: "sdk",
      }),
    ).toBe(false);
  });
});
