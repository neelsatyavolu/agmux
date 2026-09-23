import type { TeamsEffectivePolicy } from "./teams";

export type TeamsRestrictions = Pick<TeamsEffectivePolicy,
  "allowedProviders" | "allowedModels" | "allowedModes" | "allowedEfforts">;

/** Missing fields are not an unrestricted policy. Only null is unrestricted. */
export function teamChoiceAllowed(allowed: readonly string[] | null | undefined, value: string | null | undefined): boolean {
  return allowed === null || (!!value && !!allowed?.includes(value));
}

/** Policy model IDs retain local/; OpenCode variants are separate from the model. */
export function teamPolicyChoice(provider: string, model?: string | null): { provider: string; model: string | null | undefined } {
  if (provider !== "OpenCode" && provider !== "MLX") return { provider, model };
  // The dedicated MLX picker supplies catalog IDs; its transport adds local/.
  const slug = provider === "MLX" && model && !model.startsWith("local/") ? `local/${model}` : model;
  const base = slug?.split("#")[0] ?? slug;
  const local = base?.startsWith("local/") ? base.slice("local/".length) : null;
  return local ? { provider: "MLX", model: base } : { provider, model: base };
}

export function teamRestrictionReason(policy: TeamsRestrictions, choice: {
  provider: string; model?: string | null; effort?: string | null; mode: "chat" | "terminal";
}): string | null {
  const { provider, model } = teamPolicyChoice(choice.provider, choice.model);
  if (!teamChoiceAllowed(policy.allowedProviders, provider)) return "Your team restrictions do not allow this agent. Choose another agent.";
  if (!teamChoiceAllowed(policy.allowedModes, choice.mode)) return `Your team restrictions do not allow ${choice.mode} sessions.`;
  if (choice.mode === "terminal" && (policy.allowedModels !== null || policy.allowedEfforts !== null)) {
    return "Terminal sessions cannot verify model or effort restrictions. Use Claude or Codex chat with explicitly permitted model and effort choices.";
  }
  if ((choice.provider === "Grok" || choice.provider === "Gemini") && (policy.allowedModels !== null || policy.allowedEfforts !== null)) {
    return `${choice.provider} chat cannot currently verify model or effort restrictions. Use Claude or Codex chat with explicitly permitted choices, or ask your team owner to update the rules.`;
  }
  if ((provider === "Cursor" || provider === "OpenCode" || provider === "MLX") && policy.allowedEfforts !== null) {
    return `${provider === "MLX" ? "Local" : provider} chat cannot currently verify reasoning effort restrictions. Use Claude or Codex chat with an explicitly permitted effort, or ask your team owner to update the rules.`;
  }
  if (!teamChoiceAllowed(policy.allowedModels, model)) return "Your team restrictions do not allow this model or its default configuration. Choose an allowed model explicitly.";
  if (!teamChoiceAllowed(policy.allowedEfforts, choice.effort)) return "Your team restrictions do not allow this reasoning effort or its default configuration. Choose an allowed effort explicitly.";
  return null;
}
