import { describe, expect, it } from "vitest";

import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_MODELS,
  getClaudeModelDisplayName,
  getModelContextWindow,
  contextTokensUsed,
  mergeClaudeModelOptions,
  mergeCodexModelOptions,
  prettifyCodexModelName,
  prettifyCursorModel,
  prettifyGrokModel,
  prettifyKimiModel,
  prettifyOpenCodeSlug,
  prettifyPiModel,
  prettifyClineModel,
  prettifyGeminiModel,
  geminiEffortFromSlug,
  applyGeminiEffort,
  supportsXHighEffort,
  supportsGrokEffort,
  supportsCodexEffort,
  codexEffortsForModel,
  clampCodexEffort,
  normalizeCodexEffort,
  isEffortOptionDisabled,
} from "../types";

describe("getModelContextWindow", () => {
  it("normalizes dated Claude Opus 4.8 model ids to the 1M context window", () => {
    expect(getModelContextWindow("claude-opus-4-8-20260514")).toBe(1_000_000);
  });

  it("resolves the Opus 4.8 1M dropdown slug to the 1M context window", () => {
    expect(getModelContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000);
  });

  it("strips Cursor model query params before resolving context window", () => {
    expect(getModelContextWindow("composer-2.5")).toBe(200_000);
    expect(getModelContextWindow("composer-2.5?thinking=high")).toBe(200_000);
    expect(getModelContextWindow("grok-4.6?effort=high")).toBe(500_000);
  });
});

describe("contextTokensUsed", () => {
  it("adds Anthropic-style disjoint cache-read and cache-write", () => {
    expect(
      contextTokensUsed({
        inputTokens: 9073,
        cacheReadTokens: 89877,
        cacheCreationTokens: 0,
        maxTokens: 1_000_000,
      }),
    ).toBe(9073 + 89877);
  });

  it("does not add Grok-style cache-read that is already inside input", () => {
    // Cursor Grok: 386k in + 327k cache against a 500k window was showing 713k / 100%.
    expect(
      contextTokensUsed({
        inputTokens: 386_000,
        cacheReadTokens: 327_000,
        cacheCreationTokens: 0,
        totalTokens: 386_000 + 7_000 + 327_000,
        maxTokens: 500_000,
      }),
    ).toBe(386_000);
  });

  it("prefers ACP totalTokens only when a window size is also reported", () => {
    expect(
      contextTokensUsed(
        {
          inputTokens: 12_000,
          cacheReadTokens: 0,
          totalTokens: 22_254,
          maxTokens: 512_000,
        },
        { preferTotalTokens: true },
      ),
    ).toBe(22_254);
    expect(
      contextTokensUsed({
        inputTokens: 12_000,
        cacheReadTokens: 0,
        totalTokens: 22_254,
        maxTokens: 512_000,
      }),
    ).toBe(12_000);
  });
});

describe("Opus 5 model wiring", () => {
  it("exposes Opus 5 as a selectable Claude model with the 1M tier slug", () => {
    expect(CLAUDE_MODELS.some((m) => m.slug === "claude-opus-5[1m]")).toBe(true);
  });

  it("resolves Opus 5 display and 1M context metadata", () => {
    expect(getClaudeModelDisplayName("claude-opus-5")).toBe("Claude Opus 5");
    expect(getClaudeModelDisplayName("claude-opus-5[1m]")).toBe("Claude Opus 5");
    expect(getModelContextWindow("claude-opus-5")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-5[1m]")).toBe(1_000_000);
    // JSONL / API bare id must not fall back to the 200K default
    expect(getModelContextWindow("claude-opus-5")).not.toBe(200_000);
  });

  it("supports XHigh effort on Opus 5", () => {
    expect(supportsXHighEffort("claude-opus-5")).toBe(true);
    expect(supportsXHighEffort("claude-opus-5[1m]")).toBe(true);
    expect(isEffortOptionDisabled("xhigh", { provider: "ClaudeCode", model: "claude-opus-5[1m]" })).toBe(false);
  });

  it("maps the bare opus alias to Opus 5 display", () => {
    expect(getClaudeModelDisplayName("opus")).toBe("Claude Opus 5");
  });
});

describe("Opus 4.8 model wiring", () => {
  it("exposes Opus 4.8 as a selectable Claude model", () => {
    expect(CLAUDE_MODELS.some((m) => m.slug === "claude-opus-4-8[1m]")).toBe(true);
  });

  it("no longer offers retired Opus 4.7 / 4.6 / 4.5 models in the picker", () => {
    const slugs = CLAUDE_MODELS.map((m) => m.slug);
    expect(slugs).not.toContain("opus[1m]");
    expect(slugs).not.toContain("claude-opus-4-7");
    expect(slugs).not.toContain("claude-opus-4-6");
    expect(slugs).not.toContain("claude-opus-4-5");
  });

  it("still resolves display names for retired models in history", () => {
    expect(getClaudeModelDisplayName("opus[1m]")).toBe("Claude Opus 4.7");
    expect(getClaudeModelDisplayName("claude-opus-4-7")).toBe("Claude Opus 4.7");
    expect(getClaudeModelDisplayName("claude-opus-4-6")).toBe("Claude Opus 4.6");
    expect(getClaudeModelDisplayName("claude-opus-4-5")).toBe("Claude Opus 4.5");
  });

  it("renders a friendly display name for Opus 4.8 (with and without the tier suffix)", () => {
    expect(getClaudeModelDisplayName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(getClaudeModelDisplayName("claude-opus-4-8[1m]")).toBe("Claude Opus 4.8");
  });
});

describe("Fable 5 model wiring", () => {
  it("exposes Fable 5 as a selectable Claude model", () => {
    expect(CLAUDE_MODELS.some((m) => m.slug === "claude-fable-5")).toBe(true);
  });

  it("resolves Fable 5 display and context metadata", () => {
    expect(getClaudeModelDisplayName("claude-fable-5")).toBe("Claude Fable 5");
    expect(getClaudeModelDisplayName("claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(getModelContextWindow("claude-fable-5")).toBe(1_000_000);
  });

  it("supports XHigh effort on Fable 5", () => {
    expect(supportsXHighEffort("claude-fable-5")).toBe(true);
    expect(supportsXHighEffort("claude-fable-5[1m]")).toBe(true);
    expect(supportsXHighEffort("fable")).toBe(true);
    expect(isEffortOptionDisabled("xhigh", { provider: "ClaudeCode", model: "claude-fable-5" })).toBe(false);
  });
});

describe("mergeClaudeModelOptions", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-opus-5-5[1m]", "Claude Opus 5.5"],
    ["claude-opus-5.5", "Claude Opus 5.5"],
    ["claude-opus-5-5-20260922", "Claude Opus 5.5"],
    ["claude-opus-6-1", "Claude Opus 6.1"],
  ])("prettifies discovered model %s without a display-name entry", (slug, name) => {
    expect(getClaudeModelDisplayName(slug)).toBe(name);
    if (!/-\d{8}$/.test(slug)) {
      expect(mergeClaudeModelOptions([slug]).find((m) => m.slug === slug)?.name).toBe(name);
    }
  });

  it("prettifies Opus 5.5 in the fallback picker", () => {
    expect(mergeClaudeModelOptions([]).find((m) => m.slug === "claude-opus-5-5")?.name)
      .toBe("Claude Opus 5.5");
  });

  it("keeps Opus 5.5 available with an older installed catalog", () => {
    expect(CLAUDE_MODELS.some((m) => m.slug === "claude-opus-5-5")).toBe(true);
    expect(mergeClaudeModelOptions(["claude-opus-5"]).map((m) => m.slug)).toEqual([
      "claude-opus-5-5", "claude-opus-5",
    ]);
  });

  const live = [
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-opus-4-0",
    "claude-sonnet-5",
    "claude-sonnet-4-0",
    "claude-haiku-4-5",
    "claude-sonnet-4-6[1m]",
    "claude-opus-4-8[1m]",
    "claude-opus-5[1m]",
    "claude-opus-4-20250514",
    "claude-haiku-4",
    "claude-fable-6",
    "claude-opus-5-1",
  ];

  it("maps a current Claude Code catalog to latest + previous per family", () => {
    const slugs = mergeClaudeModelOptions([
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-haiku-4-5",
    ]).map((m) => m.slug);
    expect(slugs).toEqual([
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-sonnet-4-6[1m]",
      "claude-haiku-4-5",
    ]);
  });

  it("falls back to CLAUDE_MODELS when the live catalog is empty", () => {
    expect(mergeClaudeModelOptions([]).map((m) => m.slug)).toEqual(
      CLAUDE_MODELS.map((m) => m.slug),
    );
    expect(mergeClaudeModelOptions(null).map((m) => m.slug)).toEqual(
      CLAUDE_MODELS.map((m) => m.slug),
    );
  });

  it("picks latest + previous per family and prefers 1M slugs", () => {
    const slugs = mergeClaudeModelOptions(live).map((m) => m.slug);
    expect(slugs).toEqual([
      "claude-fable-6",
      "claude-opus-5-5",
      "claude-opus-5-1",
      "claude-sonnet-5",
      "claude-sonnet-4-6[1m]",
      "claude-haiku-4-5",
    ]);
  });

  it("drops mythos, dated snapshots, and bare gen-4 aliases", () => {
    const slugs = mergeClaudeModelOptions(live).map((m) => m.slug);
    expect(slugs).not.toContain("claude-mythos-5");
    expect(slugs).not.toContain("claude-opus-4-20250514");
    expect(slugs).not.toContain("claude-opus-4-0");
    expect(slugs).not.toContain("claude-haiku-4");
    expect(slugs).not.toContain("claude-opus-4-7");
  });

  it("prettifies names and writes role meta without a catalog bump", () => {
    const fable = mergeClaudeModelOptions(["claude-fable-6"])[0];
    expect(fable?.name).toBe("Claude Fable 6");
    expect(fable?.meta).toContain("most capable");
    expect(getModelContextWindow("claude-fable-6")).toBe(1_000_000);
    expect(supportsXHighEffort("claude-fable-6")).toBe(true);
    expect(supportsXHighEffort("claude-opus-5-1")).toBe(true);
  });
});

describe("Sonnet 5 model wiring", () => {
  it("exposes Sonnet 5 as a selectable Claude model", () => {
    expect(CLAUDE_MODELS.some((m) => m.slug === "claude-sonnet-5")).toBe(true);
  });

  it("resolves Sonnet 5 display and context metadata", () => {
    expect(getClaudeModelDisplayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(getModelContextWindow("claude-sonnet-5")).toBe(1_000_000);
  });

  it("supports XHigh effort on Sonnet 5", () => {
    expect(supportsXHighEffort("claude-sonnet-5")).toBe(true);
    expect(supportsXHighEffort("claude-sonnet-5[1m]")).toBe(true);
    expect(supportsXHighEffort("sonnet-5")).toBe(true);
    expect(isEffortOptionDisabled("xhigh", { provider: "ClaudeCode", model: "claude-sonnet-5" })).toBe(false);
  });
});

describe("GPT-5.6 Sol / Terra / Luna model wiring", () => {
  it("exposes Sol, Terra, and Luna as selectable Codex models with Sol as default", () => {
    expect(CODEX_MODELS[0]?.slug).toBe("gpt-5.6-sol");
    const slugs = CODEX_MODELS.map((m) => m.slug);
    expect(slugs).toContain("gpt-5.6-sol");
    expect(slugs).toContain("gpt-5.6-terra");
    expect(slugs).toContain("gpt-5.6-luna");
  });

  it("prettifies GPT-5.6 tier slugs for display", () => {
    expect(prettifyCodexModelName("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(prettifyCodexModelName("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(prettifyCodexModelName("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(prettifyOpenCodeSlug("openai/gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(prettifyOpenCodeSlug("openai/gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(prettifyOpenCodeSlug("openai/gpt-5.6-luna")).toBe("GPT 5.6 Luna");
  });

  it("mergeCodexModelOptions rewrites hyphenated server display names", () => {
    const merged = mergeCodexModelOptions([
      { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
      { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    ]);
    expect(merged.find((m) => m.slug === "gpt-5.6-sol")?.name).toBe("GPT 5.6 Sol");
    expect(merged.find((m) => m.slug === "gpt-5.6-terra")?.name).toBe("GPT 5.6 Terra");
    expect(merged.find((m) => m.slug === "gpt-5.6-luna")?.name).toBe("GPT 5.6 Luna");
  });

  it("uses the 372K context window for GPT-5.6 models", () => {
    expect(getModelContextWindow("gpt-5.6-sol")).toBe(372_000);
    expect(getModelContextWindow("gpt-5.6-terra")).toBe(372_000);
    expect(getModelContextWindow("gpt-5.6-luna")).toBe(372_000);
  });

  it("mergeCodexModelOptions uses the live list as source of truth", () => {
    const merged = mergeCodexModelOptions([
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
      { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    ]);
    const slugs = merged.map((m) => m.slug);
    expect(slugs).toEqual(["gpt-5.5", "gpt-5.4-mini", "gpt-5.6-sol"]);
    expect(slugs).not.toContain("gpt-5.6-terra");
    expect(merged.find((m) => m.slug === "gpt-5.6-sol")?.name).toBe("GPT 5.6 Sol");
  });

  it("mergeCodexModelOptions falls back to the full curated list when empty", () => {
    expect(mergeCodexModelOptions([])).toEqual(CODEX_MODELS);
    expect(mergeCodexModelOptions(null)).toEqual(CODEX_MODELS);
  });

  it("hides retired Codex models but keeps Spark variants", () => {
    const merged = mergeCodexModelOptions([
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "gpt-5.3-codex-spark", name: "GPT-5.3-Codex-Spark" },
      { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
      { slug: "gpt-5.4", name: "GPT-5.4" },
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex (dup)" },
      { slug: "gpt-5.5", name: "GPT-5.5" },
    ]);
    const slugs = merged.map((m) => m.slug);
    expect(slugs).not.toContain("gpt-5.3-codex");
    expect(slugs).toContain("gpt-5.3-codex-spark");
    expect(slugs).not.toContain("gpt-5.2-codex");
    expect(slugs).not.toContain("gpt-5.4");
    expect(slugs).toContain("gpt-5.5");
  });

  it("does not list retired models in the curated catalog", () => {
    const slugs = CODEX_MODELS.map((m) => m.slug);
    expect(slugs).not.toContain("gpt-5.3-codex");
    expect(slugs).not.toContain("gpt-5.2-codex");
    expect(slugs).not.toContain("gpt-5.4");
  });

  it("exposes Max for all GPT-5.6 tiers and Ultra only for Sol/Terra", () => {
    expect(supportsCodexEffort("gpt-5.6-sol", "max")).toBe(true);
    expect(supportsCodexEffort("gpt-5.6-sol", "ultra")).toBe(true);
    expect(supportsCodexEffort("gpt-5.6-terra", "max")).toBe(true);
    expect(supportsCodexEffort("gpt-5.6-terra", "ultra")).toBe(true);
    expect(supportsCodexEffort("gpt-5.6-luna", "max")).toBe(true);
    expect(supportsCodexEffort("gpt-5.6-luna", "ultra")).toBe(false);
    expect(supportsCodexEffort("gpt-5.4", "max")).toBe(false);
    expect(supportsCodexEffort("gpt-5.4", "ultra")).toBe(false);
    expect(supportsCodexEffort("gpt-5.5", "xhigh")).toBe(true);
  });

  it("filters the effort picker per model and clamps unsupported values", () => {
    expect(codexEffortsForModel("gpt-5.6-sol").map((e) => e.value)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
    expect(codexEffortsForModel("gpt-5.6-luna").map((e) => e.value)).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(codexEffortsForModel("gpt-5.4").map((e) => e.value)).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
    expect(clampCodexEffort("gpt-5.4", "ultra")).toBe("high");
    expect(clampCodexEffort("gpt-5.6-luna", "ultra")).toBe("high");
    expect(clampCodexEffort("gpt-5.6-sol", "ultra")).toBe("ultra");
    expect(normalizeCodexEffort("max")).toBe("max");
    expect(normalizeCodexEffort("ultra")).toBe("ultra");
    expect(normalizeCodexEffort("bogus")).toBeNull();
  });
});

describe("GPT-6 Sol / Luna model wiring", () => {
  it("lists both models and prettifies their OpenCode slugs", () => {
    expect(CODEX_MODELS.map((m) => m.slug)).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna"]));
    expect(prettifyOpenCodeSlug("openai/gpt-6-sol")).toBe("GPT 6 Sol");
    expect(prettifyOpenCodeSlug("openai/gpt-6-luna")).toBe("GPT 6 Luna");
    expect(mergeCodexModelOptions([
      { slug: "gpt-6-sol", name: "GPT-6-Sol" },
      { slug: "gpt-6-luna", name: "GPT-6-Luna" },
    ])).toEqual([
      { slug: "gpt-6-sol", name: "GPT 6 Sol" },
      { slug: "gpt-6-luna", name: "GPT 6 Luna" },
    ]);
  });

  it("uses the Codex catalog context window and reasoning levels", () => {
    for (const slug of ["gpt-6-sol", "gpt-6-luna"]) {
      expect(getModelContextWindow(slug)).toBe(272_000);
      expect(supportsCodexEffort(slug, "max")).toBe(true);
    }
    expect(supportsCodexEffort("gpt-6-sol", "ultra")).toBe(true);
    expect(supportsCodexEffort("gpt-6-luna", "ultra")).toBe(false);
  });
});

describe("prettifyPiModel", () => {
  it("prettifies xAI / Claude / Gemini / OpenAI slugs Pi can run", () => {
    expect(prettifyPiModel("grok-4.6")).toBe("Grok 4.6");
    expect(prettifyPiModel("grok-4.5")).toBe("Grok 4.5");
    expect(prettifyPiModel("grok-build-0.1")).toBe("Grok Build 0.1");
    expect(prettifyPiModel("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
    expect(prettifyPiModel("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(prettifyPiModel("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettifyPiModel("gpt-5.6-sol")).toBe("GPT 5.6 Sol");
    expect(prettifyPiModel("gpt-5.4-mini")).toBe("GPT 5.4 Mini");
    expect(prettifyPiModel(null)).toBeNull();
  });
});

describe("prettifyClineModel", () => {
  it("prettifies Cline provider/model slugs", () => {
    expect(prettifyClineModel("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(prettifyClineModel("openai-codex/gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(prettifyClineModel("anthropic/claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
    expect(prettifyClineModel("anthropic/claude-sonnet-4.6")).toBe("Claude Sonnet 4.6");
    expect(prettifyClineModel("claude-sonnet-4.6")).toBe("Claude Sonnet 4.6");
    expect(prettifyClineModel(null)).toBeNull();
  });
});

describe("Hermes model window", () => {
  it("uses the Codex 5.4 mini context window Hermes reports", () => {
    expect(getModelContextWindow("gpt-5.4-mini")).toBe(272_000);
  });
});

describe("Kimi model wiring", () => {
  it("prettifies known Kimi Code slugs and reports 256k context", () => {
    expect(prettifyKimiModel("kimi-code/kimi-for-coding")).toBe("K2.7 Coding");
    expect(prettifyKimiModel("kimi-for-coding-highspeed")).toBe("K2.7 Highspeed");
    expect(prettifyKimiModel("kimi-code/k3")).toBe("K3");
    expect(getModelContextWindow("kimi-code/kimi-for-coding")).toBe(262_144);
    expect(getModelContextWindow("k3")).toBe(262_144);
  });
});

describe("Gemini / Antigravity model window", () => {
  it("uses a 1M context window for Gemini 3 slugs", () => {
    expect(getModelContextWindow("gemini-3.6-flash-medium")).toBe(1_000_000);
    expect(getModelContextWindow("Gemini 3.7 Flash (High)")).toBe(1_000_000);
  });
});

describe("prettifyGeminiModel", () => {
  it("title-cases hyphen slugs and lifts trailing effort", () => {
    expect(prettifyGeminiModel("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettifyGeminiModel("gemini-3.6-flash-medium")).toBe("Gemini 3.6 Flash (Medium)");
    expect(prettifyGeminiModel("gemini-3.7-flash-high")).toBe("Gemini 3.7 Flash (High)");
    expect(prettifyGeminiModel("google/gemini-3.6-flash-medium")).toBe("Gemini 3.6 Flash (Medium)");
  });

  it("keeps Antigravity display names", () => {
    expect(prettifyGeminiModel("Gemini 3.7 Flash (High)")).toBe("Gemini 3.7 Flash (High)");
    expect(prettifyGeminiModel(null)).toBeNull();
  });

  it("can omit trailing effort for compact labels", () => {
    expect(prettifyGeminiModel("gemini-3.8-flash-high", { includeEffort: false })).toBe(
      "Gemini 3.8 Flash",
    );
    expect(prettifyGeminiModel("gemini-3.6-flash-medium", { includeEffort: false })).toBe(
      "Gemini 3.6 Flash",
    );
    expect(prettifyGeminiModel("Gemini 3.8 Flash (High)", { includeEffort: false })).toBe(
      "Gemini 3.8 Flash",
    );
    expect(prettifyGeminiModel("gemini-2.5-flash", { includeEffort: false })).toBe(
      "Gemini 2.5 Flash",
    );
  });
});

describe("gemini effort slugs", () => {
  it("reads and rewrites trailing low/medium/high", () => {
    expect(geminiEffortFromSlug("gemini-3.8-flash-high")).toBe("high");
    expect(geminiEffortFromSlug("gemini-3.8-flash")).toBeNull();
    expect(applyGeminiEffort("gemini-3.8-flash-high", "low")).toBe("gemini-3.8-flash-low");
    expect(applyGeminiEffort("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
  });
});

describe("prettifyCursorModel", () => {
  it("prettifies Composer slugs", () => {
    expect(prettifyCursorModel("composer-2.5")).toBe("Composer 2.5");
    expect(prettifyCursorModel("composer-2")).toBe("Composer 2");
    expect(prettifyCursorModel("composer-2.5?thinking=high")).toBe("Composer 2.5");
  });

  it("prettifies Cursor Claude slugs with version-first + thinking", () => {
    expect(prettifyCursorModel("claude-4.6-sonnet-medium-thinking")).toBe(
      "Sonnet 4.6 Thinking",
    );
    expect(prettifyCursorModel("claude-4-opus")).toBe("Opus 4");
    expect(prettifyCursorModel("claude-4.5-sonnet-high-thinking")).toBe(
      "Sonnet 4.5 Thinking",
    );
  });

  it("title-cases other Cursor slugs", () => {
    expect(prettifyCursorModel("gpt-5.1")).toBe("GPT 5.1");
    expect(prettifyCursorModel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(prettifyCursorModel(null)).toBeNull();
  });

  it("renders hyphenated Fable 5.1 as a dotted version, not spaced digits", () => {
    expect(prettifyCursorModel("fable-5-1")).toBe("Fable 5.1");
    expect(prettifyCursorModel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(prettifyCursorModel("claude-fable-5-1?thinking=high")).toBe("Fable 5.1");
  });
});

describe("Grok model wiring", () => {
  it("exposes Grok 4.7 as the default selectable model", () => {
    expect(GROK_MODELS[0]?.slug).toBe("grok-4.7");
    expect(GROK_MODELS.some((m) => m.slug === "grok-4.7")).toBe(true);
    expect(GROK_MODELS.some((m) => m.slug === "grok-4.6")).toBe(true);
    expect(GROK_MODELS.some((m) => m.slug === "grok-4.5")).toBe(true);
    expect(prettifyGrokModel("grok-4.7")).toBe("Grok 4.7");
    expect(prettifyGrokModel("grok-4.6")).toBe("Grok 4.6");
    expect(prettifyGrokModel("grok-4.5")).toBe("Grok 4.5");
    expect(getModelContextWindow("grok-4.7")).toBe(500_000);
    expect(getModelContextWindow("grok-4.6")).toBe(500_000);
    expect(getModelContextWindow("grok-4.5")).toBe(500_000);
  });

  it("does not offer Composer under xAI chat (historical slugs still prettify)", () => {
    expect(GROK_MODELS.some((m) => m.slug === "grok-composer-2.5-fast")).toBe(false);
    expect(GROK_MODELS.some((m) => m.slug.includes("composer"))).toBe(false);
    expect(prettifyGrokModel("grok-composer-2.5-fast")).toBe("Composer 2.5");
  });

  it("retires Grok 4.3 from the picker but still prettifies historical sessions", () => {
    expect(GROK_MODELS.some((m) => m.slug === "grok-4.3")).toBe(false);
    expect(prettifyGrokModel("grok-4.3")).toBe("Grok 4.3");
    expect(prettifyGrokModel("grok-build")).toBe("Grok Build");
    expect(prettifyGrokModel("composer-2.5")).toBe("Composer 2.5");
  });
});

describe("supportsXHighEffort", () => {
  it("enables XHigh for Fable 5, Sonnet 5, and the latest Opus flagships", () => {
    expect(supportsXHighEffort("claude-fable-5")).toBe(true);
    expect(supportsXHighEffort("claude-sonnet-5")).toBe(true);
    expect(supportsXHighEffort("sonnet-5")).toBe(true);
    expect(supportsXHighEffort("claude-opus-5")).toBe(true);
    expect(supportsXHighEffort("claude-opus-5[1m]")).toBe(true);
    expect(supportsXHighEffort("claude-opus-4-8[1m]")).toBe(true);
    expect(supportsXHighEffort("claude-opus-4-8")).toBe(true);
    expect(supportsXHighEffort("opus[1m]")).toBe(true);
    expect(supportsXHighEffort("claude-opus-4-7")).toBe(true);
  });

  it("disables XHigh for older and unknown models", () => {
    expect(supportsXHighEffort("claude-opus-4-6")).toBe(false);
    expect(supportsXHighEffort("claude-sonnet-4-6")).toBe(false);
    // bare `sonnet` alias is still Sonnet 4.6 in the picker
    expect(supportsXHighEffort("sonnet")).toBe(false);
    expect(supportsXHighEffort("haiku")).toBe(false);
    expect(supportsXHighEffort(null)).toBe(false);
  });
});

describe("supportsGrokEffort / isEffortOptionDisabled", () => {
  it("allows only low/medium/high for Grok 4.5", () => {
    expect(supportsGrokEffort("grok-4.5", "low")).toBe(true);
    expect(supportsGrokEffort("grok-4.5", "medium")).toBe(true);
    expect(supportsGrokEffort("grok-4.5", "high")).toBe(true);
    expect(supportsGrokEffort("grok-4.5", "xhigh")).toBe(false);
    expect(supportsGrokEffort("grok-4.5", "max")).toBe(false);
  });

  it("allows xhigh for Grok 4.6 and 4.7 but not max", () => {
    expect(supportsGrokEffort("grok-4.6", "low")).toBe(true);
    expect(supportsGrokEffort("grok-4.6", "high")).toBe(true);
    expect(supportsGrokEffort("grok-4.6", "xhigh")).toBe(true);
    expect(supportsGrokEffort("grok-4.6", "max")).toBe(false);
    expect(supportsGrokEffort("grok-4.7", "xhigh")).toBe(true);
    expect(supportsGrokEffort("grok-4.7", "max")).toBe(false);
    expect(supportsGrokEffort("grok-4.7-build-fast", "xhigh")).toBe(true);
  });

  it("disables all efforts for Composer (no reasoning dial)", () => {
    expect(supportsGrokEffort("grok-composer-2.5-fast", "low")).toBe(false);
    expect(supportsGrokEffort("grok-composer-2.5-fast", "high")).toBe(false);
  });

  it("grays out xhigh/max in the Grok effort picker", () => {
    expect(isEffortOptionDisabled("low", { provider: "Grok", model: "grok-4.5" })).toBe(false);
    expect(isEffortOptionDisabled("high", { provider: "Grok", model: "grok-4.5" })).toBe(false);
    expect(isEffortOptionDisabled("xhigh", { provider: "Grok", model: "grok-4.5" })).toBe(true);
    expect(isEffortOptionDisabled("max", { provider: "Grok", model: "grok-4.5" })).toBe(true);
    expect(isEffortOptionDisabled("xhigh", { provider: "Grok", model: "grok-4.6" })).toBe(false);
    expect(isEffortOptionDisabled("max", { provider: "Grok", model: "grok-4.6" })).toBe(true);
    expect(isEffortOptionDisabled("xhigh", { provider: "Grok", model: "grok-4.7" })).toBe(false);
    expect(isEffortOptionDisabled("max", { provider: "Grok", model: "grok-4.7" })).toBe(true);
  });

  it("still gates Claude XHigh to Opus flagships", () => {
    expect(isEffortOptionDisabled("low", { provider: "Cursor", model: "composer-2.5" })).toBe(false);
    expect(isEffortOptionDisabled("xhigh", { provider: "ClaudeCode", model: "claude-opus-4-8" })).toBe(false);
    expect(isEffortOptionDisabled("xhigh", { provider: "ClaudeCode", model: "sonnet" })).toBe(true);
    expect(isEffortOptionDisabled("max", { provider: "ClaudeCode", model: "sonnet" })).toBe(false);
  });
});
