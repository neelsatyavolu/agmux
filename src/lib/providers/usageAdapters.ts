import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGrokUsage,
  fetchGeminiUsage,
  getPaceInfo,
  type UsageData,
  type PaceInfo,
} from "../commands";
import type { Provider } from "../types";

/** Strategy interface for fetching rate-limit / pace data per provider. New
 *  providers register an adapter here instead of growing switch statements
 *  in the store and topbar. Returning null from a fetch method means "this
 *  provider has no quota concept" — the topbar then silently omits chips. */
export interface ProviderUsageAdapter {
  readonly provider: Provider;
  /** Returns true when this adapter can produce usage data given the current
   *  thread context (model slug, OAuth presence). Adapters that always return
   *  null (Kimi, MLX) report false. */
  hasUsageEndpoint(modelSlug?: string | null): boolean;
  fetchUsage(modelSlug?: string | null): Promise<UsageData | null>;
  fetchPace(modelSlug?: string | null): Promise<PaceInfo | null>;
}

class ClaudeUsageAdapter implements ProviderUsageAdapter {
  readonly provider: Provider = "ClaudeCode";
  hasUsageEndpoint() {
    return true;
  }
  async fetchUsage() {
    return fetchClaudeUsage();
  }
  async fetchPace() {
    return getPaceInfo("ClaudeCode");
  }
}

class CodexUsageAdapter implements ProviderUsageAdapter {
  readonly provider: Provider = "Codex";
  hasUsageEndpoint() {
    return true;
  }
  async fetchUsage() {
    return fetchCodexUsage();
  }
  async fetchPace() {
    return getPaceInfo("Codex");
  }
}

/** SuperGrok credit quota from `~/.grok/auth.json` + grok.com billing. */
class GrokUsageAdapter implements ProviderUsageAdapter {
  readonly provider: Provider = "Grok";
  hasUsageEndpoint() {
    return true;
  }
  async fetchUsage() {
    return fetchGrokUsage();
  }
  async fetchPace() {
    return getPaceInfo("Grok");
  }
}

/** Antigravity (`agy`) weekly / 5-hour quota from Cloud Code. */
class GeminiUsageAdapter implements ProviderUsageAdapter {
  readonly provider: Provider = "Gemini";
  hasUsageEndpoint() {
    return true;
  }
  async fetchUsage() {
    return fetchGeminiUsage();
  }
  async fetchPace() {
    return getPaceInfo("gemini");
  }
}

/** OpenCode bridges to its underlying provider's quota when possible. The
 *  Anthropic OAuth /usage endpoint applies whenever the OpenCode model slug
 *  resolves to an Anthropic Pro/Max account. Other underlying providers
 *  (OpenAI, Google, etc.) lack equivalent rate-limit endpoints, so the
 *  adapter returns null for them. */
class OpenCodeBridgeUsageAdapter implements ProviderUsageAdapter {
  readonly provider: Provider = "OpenCode";
  private isAnthropicSlug(slug?: string | null): boolean {
    if (!slug) return false;
    const s = slug.toLowerCase();
    // Strict: anthropic provider prefix, or a model id starting with "claude-".
    // Substring `"claude"` is too permissive — third-party model names that
    // happen to contain "claude" would otherwise route to the Anthropic OAuth
    // endpoint and surface an unrelated user's quota in the topbar.
    return s.startsWith("anthropic/") || s.startsWith("claude-") || /^claude\b/.test(s);
  }
  hasUsageEndpoint(modelSlug?: string | null) {
    return this.isAnthropicSlug(modelSlug);
  }
  async fetchUsage(modelSlug?: string | null) {
    if (!this.isAnthropicSlug(modelSlug)) return null;
    // Bridging through to Anthropic OAuth only succeeds when the user has a
    // Pro/Max session (not API-key auth). The fetch itself raises on 4xx;
    // the caller treats that as a soft failure.
    return fetchClaudeUsage();
  }
  async fetchPace(modelSlug?: string | null) {
    if (!this.isAnthropicSlug(modelSlug)) return null;
    return getPaceInfo("ClaudeCode");
  }
}

/** Used for providers that have no quota concept (MLX = local) or no
 *  available endpoint yet (Kimi, Cursor). Row 2 still renders identically — just no
 *  chips. */
class NoopUsageAdapter implements ProviderUsageAdapter {
  constructor(public readonly provider: Provider) {}
  hasUsageEndpoint() {
    return false;
  }
  async fetchUsage() {
    return null;
  }
  async fetchPace() {
    return null;
  }
}

const REGISTRY: Record<Provider, ProviderUsageAdapter> = {
  ClaudeCode: new ClaudeUsageAdapter(),
  Codex: new CodexUsageAdapter(),
  OpenCode: new OpenCodeBridgeUsageAdapter(),
  Droid: new NoopUsageAdapter("Droid"),
  Kimi: new NoopUsageAdapter("Kimi"),
  Pi: new NoopUsageAdapter("Pi"),
  MLX: new NoopUsageAdapter("MLX"),
  Grok: new GrokUsageAdapter(),
  Cursor: new NoopUsageAdapter("Cursor"),
  Cline: new NoopUsageAdapter("Cline"),
  Gemini: new GeminiUsageAdapter(),
  Hermes: new NoopUsageAdapter("Hermes"),
};

export function getUsageAdapter(provider: Provider): ProviderUsageAdapter {
  return REGISTRY[provider];
}
