import { describe, it, expect } from "vitest";
import {
  COWORK_ALLOWED_TOOLS,
  COWORK_DISALLOWED_TOOLS,
  COWORK_SYSTEM_PROMPT_TEMPLATE,
  coworkSdkStartExtras,
  isCoworkProfile,
  resolveCoworkSystemPrompt,
} from "../claudeCoworkProfile";

describe("claudeCoworkProfile", () => {
  it("isCoworkProfile only matches cowork", () => {
    expect(isCoworkProfile("cowork")).toBe(true);
    expect(isCoworkProfile("code")).toBe(false);
    expect(isCoworkProfile(null)).toBe(false);
  });

  it("exposes Cowork tool policy and real system prompt template", () => {
    expect(COWORK_ALLOWED_TOOLS).toContain("Bash");
    expect(COWORK_ALLOWED_TOOLS).toContain("Skill");
    // Desktop Cowork task list (sticky progress bar) — must not be disallowed
    expect(COWORK_ALLOWED_TOOLS).toContain("TaskCreate");
    expect(COWORK_ALLOWED_TOOLS).toContain("TaskUpdate");
    expect(COWORK_ALLOWED_TOOLS).toContain("ToolSearch");
    expect(COWORK_DISALLOWED_TOOLS).not.toContain("TaskCreate");
    expect(COWORK_DISALLOWED_TOOLS).toContain("Agent");
    expect(COWORK_SYSTEM_PROMPT_TEMPLATE.length).toBeGreaterThan(20_000);
    expect(COWORK_SYSTEM_PROMPT_TEMPLATE).toMatch(/Cowork mode/i);
    expect(COWORK_SYSTEM_PROMPT_TEMPLATE).toMatch(/\{\{memoryDir\}\}/);
    expect(COWORK_SYSTEM_PROMPT_TEMPLATE).toMatch(/file-based memory/i);
    expect(COWORK_SYSTEM_PROMPT_TEMPLATE).toMatch(/TaskCreate/);

    const resolved = resolveCoworkSystemPrompt("/tmp/claude-memory");
    expect(resolved).toContain("/tmp/claude-memory");
    expect(resolved).not.toMatch(/\{\{memoryDir\}\}/);

    expect(coworkSdkStartExtras()).toEqual({ agentProfile: "cowork" });
  });
});
