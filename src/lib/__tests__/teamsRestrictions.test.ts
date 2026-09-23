import { describe, expect, it } from "vitest";
import { teamChoiceAllowed, teamPolicyChoice, teamRestrictionReason, type TeamsRestrictions } from "../teamsRestrictions";

const unrestricted: TeamsRestrictions = { allowedProviders: null, allowedModels: null, allowedModes: null, allowedEfforts: null };
const choice = { provider: "Codex", model: "gpt-a", effort: "high", mode: "chat" as const };
describe("team restrictions", () => {
  it("allows only null to mean unrestricted and rejects unknown defaults", () => {
    expect(teamChoiceAllowed(null, null)).toBe(true);
    expect(teamChoiceAllowed([], "Codex")).toBe(false);
    expect(teamChoiceAllowed(undefined, "Codex")).toBe(false);
    expect(teamChoiceAllowed(["gpt-a"], null)).toBe(false);
    expect(teamChoiceAllowed(["gpt-a"], "gpt-a")).toBe(true);
    expect(teamChoiceAllowed(["gpt-a"], "GPT-A")).toBe(false);
  });
  it.each(["allowedProviders", "allowedModels", "allowedModes", "allowedEfforts"] as const)("denies an empty %s", (field) => {
    expect(teamRestrictionReason({ ...unrestricted, [field]: [] }, choice)).toBeTruthy();
  });
  it("accepts the exact permitted configuration", () => {
    expect(teamRestrictionReason({ allowedProviders: ["Codex"], allowedModels: ["gpt-a"], allowedModes: ["chat"], allowedEfforts: ["high"] }, choice)).toBeNull();
  });
  it("blocks terminals with model or effort limits even when the displayed value is permitted", () => {
    for (const policy of [{ ...unrestricted, allowedModels: ["gpt-a"] }, { ...unrestricted, allowedEfforts: ["high"] }]) {
      expect(teamRestrictionReason(policy, { ...choice, mode: "terminal" })).toContain("Terminal sessions cannot verify");
    }
    expect(teamRestrictionReason(unrestricted, { ...choice, mode: "terminal" })).toBeNull();
  });
});
describe("verified chat restrictions", () => {
  it.each(["Grok", "Gemini"])("explains unsupported strict configuration for %s", (provider) => {
    for (const policy of [{ ...unrestricted, allowedModels: ["gpt-a"] }, { ...unrestricted, allowedEfforts: ["high"] }]) {
      expect(teamRestrictionReason(policy, { ...choice, provider })).toContain(`${provider} chat cannot currently verify model or effort restrictions`);
    }
    expect(teamRestrictionReason(unrestricted, { ...choice, provider })).toBeNull();
  });
  it.each(["Cursor", "OpenCode"])("supports explicit models but explains unsupported effort for %s", (provider) => {
    expect(teamRestrictionReason({ ...unrestricted, allowedModels: ["gpt-a"] }, { ...choice, provider })).toBeNull();
    expect(teamRestrictionReason({ ...unrestricted, allowedModels: ["gpt-a"] }, { ...choice, provider, model: null })).toContain("Choose an allowed model explicitly");
    expect(teamRestrictionReason({ ...unrestricted, allowedEfforts: ["high"] }, { ...choice, provider })).toContain(`${provider} chat cannot currently verify reasoning effort restrictions`);
  });
  it("requires explicit Codex model and effort overrides under strict rules", () => {
    const policy = { ...unrestricted, allowedModels: ["gpt-a"], allowedEfforts: ["high"] };
    expect(teamRestrictionReason(policy, { ...choice, model: null })).toContain("Choose an allowed model explicitly");
    expect(teamRestrictionReason(policy, { ...choice, effort: null })).toContain("Choose an allowed effort explicitly");
    expect(teamRestrictionReason(policy, choice)).toBeNull();
  });
});
describe("local logical provider", () => {
  const localPolicy = { ...unrestricted, allowedProviders: ["MLX"], allowedModels: ["local/org/model"] };
  it.each(["MLX", "OpenCode"])("accepts local chat via %s for MLX-only rules", (provider) => {
    expect(teamRestrictionReason(localPolicy, { ...choice, provider, model: "local/org/model" })).toBeNull();
  });
  it("does not let OpenCode-only rules enable local models", () => {
    expect(teamRestrictionReason({ ...unrestricted, allowedProviders: ["OpenCode"] }, { ...choice, provider: "OpenCode", model: "local/org/model" })).toContain("do not allow this agent");
    expect(teamRestrictionReason({ ...unrestricted, allowedProviders: ["OpenCode"] }, { ...choice, provider: "OpenCode", model: "anthropic/model" })).toBeNull();
  });
  it("keeps incomplete local slugs and unspecified models under OpenCode", () => {
    for (const model of [null, "local/"]) {
      expect(teamRestrictionReason(localPolicy, { ...choice, provider: "OpenCode", model })).toContain("do not allow this agent");
    }
  });
  it("explains unsupported effort limits for local chat", () => {
    expect(teamRestrictionReason({ ...localPolicy, allowedEfforts: ["high"] }, { ...choice, provider: "OpenCode", model: "local/org/model" })).toContain("Local chat cannot currently verify reasoning effort");
  });
});

it("matches backend local and variant normalization and keeps Pi terminals classified as Pi", () => {
  expect(teamPolicyChoice("OpenCode", "local/org/model#high")).toEqual({ provider: "MLX", model: "local/org/model" });
  expect(teamPolicyChoice("MLX", "org/model")).toEqual({ provider: "MLX", model: "local/org/model" });
  expect(teamPolicyChoice("OpenCode", "provider/model#high")).toEqual({ provider: "OpenCode", model: "provider/model" });
  expect(teamPolicyChoice("OpenCode", "locality/model")).toEqual({ provider: "OpenCode", model: "locality/model" });
  expect(teamPolicyChoice("OpenCode", "local/#high")).toEqual({ provider: "OpenCode", model: "local/" });
  expect(teamPolicyChoice("Pi", "local/org/model")).toEqual({ provider: "Pi", model: "local/org/model" });
});
it("requires canonical local/ allowlist IDs for both local picker routes", () => {
  for (const local of [{ provider: "MLX", model: "org/model" }, { provider: "OpenCode", model: "local/org/model#high" }]) {
    expect(teamRestrictionReason({ ...unrestricted, allowedProviders: ["MLX"], allowedModels: ["local/org/model"] }, { ...choice, ...local })).toBeNull();
    expect(teamRestrictionReason({ ...unrestricted, allowedProviders: ["MLX"], allowedModels: ["org/model"] }, { ...choice, ...local })).toContain("Choose an allowed model explicitly");
  }
});
