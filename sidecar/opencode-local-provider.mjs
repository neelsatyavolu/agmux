/**
 * Builds the OPENCODE_CONFIG_CONTENT payload agmux hands to `opencode serve`.
 *
 * agmux fully owns OpenCode's config in this process (the bridge has always
 * passed an object here), so declaring a provider is just adding a key. The
 * provider points at agmux's own gateway, which does model residency —
 * OpenCode never talks to mlx_lm.server directly.
 */
export function buildOpencodeConfig(models, port) {
  if (!Array.isArray(models) || models.length === 0) return {};
  const entries = {};
  for (const m of models) {
    if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
    // First declaration of a given id wins; later duplicates are skipped
    // rather than silently overwriting it.
    if (Object.prototype.hasOwnProperty.call(entries, m.id)) continue;
    // tool_call: true — OpenCode only routes agentic edits through models that
    // advertise tool calling; local installs are already filtered to tool-capable
    // templates on the Rust side, so declare it explicitly here (defensive).
    entries[m.id] = { name: m.displayName || m.id, tool_call: true };
  }
  if (Object.keys(entries).length === 0) return {};
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Model",
        // Dummy apiKey: openai-compatible clients require a key field even when
        // the gateway ignores auth. Without it some SDK paths refuse to connect.
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "local-no-auth",
        },
        models: entries,
      },
    },
  };
}

/**
 * Splits an OpenCode model slug ("providerID/modelID" or
 * "providerID/modelID#variant") on the FIRST slash only. OpenCode's modelID
 * segment can itself contain slashes (e.g. local models declared from
 * installed paths like "mlx-community/Qwen3-8B-4bit"), so naive `split("/")`
 * destructuring drops everything after the second segment.
 *
 * UI stores variants as a `#suffix` on the slug (e.g.
 * `anthropic/claude-sonnet-4-5#high`). That suffix is stripped from modelID
 * and returned as optional `variant` for `session.prompt({ variant })`.
 * Empty/no-slash input mirrors the caller's existing
 * "falsy providerID/modelID = invalid" check.
 */
export function parseModelSlug(raw) {
  const s = String(raw ?? "");
  const hash = s.indexOf("#");
  const base = hash === -1 ? s : s.slice(0, hash);
  const variant = hash === -1 || hash === s.length - 1 ? undefined : s.slice(hash + 1);
  const slash = base.indexOf("/");
  if (slash === -1) {
    const out = { providerID: base, modelID: "" };
    if (variant !== undefined) out.variant = variant;
    return out;
  }
  const out = {
    providerID: base.slice(0, slash),
    modelID: base.slice(slash + 1),
  };
  if (variant !== undefined) out.variant = variant;
  return out;
}
