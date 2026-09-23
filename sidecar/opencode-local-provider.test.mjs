import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpencodeConfig, parseModelSlug } from "./opencode-local-provider.mjs";

test("no local models means no local provider", () => {
  const cfg = buildOpencodeConfig([], 21434);
  assert.equal(cfg.provider, undefined);
});

test("declares an openai-compatible provider pointed at the gateway", () => {
  const cfg = buildOpencodeConfig([{ id: "mlx-community/Qwen3-8B-4bit" }], 21434);
  assert.equal(cfg.provider.local.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.local.options.baseURL, "http://127.0.0.1:21434/v1");
  assert.equal(cfg.provider.local.options.apiKey, "local-no-auth");
});

test("maps each installed model into the provider", () => {
  const cfg = buildOpencodeConfig(
    [
      { id: "mlx-community/Qwen3-8B-4bit", displayName: "Qwen3 8B" },
      { id: "mlx-community/Phi-4-mini" },
    ],
    21434,
  );
  assert.deepEqual(Object.keys(cfg.provider.local.models), [
    "mlx-community/Qwen3-8B-4bit",
    "mlx-community/Phi-4-mini",
  ]);
  assert.equal(cfg.provider.local.models["mlx-community/Qwen3-8B-4bit"].name, "Qwen3 8B");
  assert.equal(cfg.provider.local.models["mlx-community/Qwen3-8B-4bit"].tool_call, true);
  assert.equal(cfg.provider.local.models["mlx-community/Phi-4-mini"].tool_call, true);
});

test("falls back to the id when no display name is given", () => {
  const cfg = buildOpencodeConfig([{ id: "a/b" }], 21434);
  assert.equal(cfg.provider.local.models["a/b"].name, "a/b");
  assert.equal(cfg.provider.local.models["a/b"].tool_call, true);
});

test("duplicate ids: first declaration wins, later ones are skipped", () => {
  const cfg = buildOpencodeConfig(
    [
      { id: "a/b", displayName: "First" },
      { id: "a/b", displayName: "Second" },
    ],
    21434,
  );
  assert.deepEqual(Object.keys(cfg.provider.local.models), ["a/b"]);
  assert.equal(cfg.provider.local.models["a/b"].name, "First");
});

test("parseModelSlug: two-segment slug splits into provider and model", () => {
  assert.deepEqual(parseModelSlug("anthropic/claude-opus"), {
    providerID: "anthropic",
    modelID: "claude-opus",
  });
});

test("parseModelSlug: model id containing slashes is kept whole", () => {
  assert.deepEqual(parseModelSlug("local/mlx-community/Qwen3-8B-4bit"), {
    providerID: "local",
    modelID: "mlx-community/Qwen3-8B-4bit",
  });
});

test("parseModelSlug: #variant is stripped from modelID and returned separately", () => {
  assert.deepEqual(parseModelSlug("anthropic/claude-sonnet-4-5#high"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    variant: "high",
  });
});

test("parseModelSlug: #variant works with slash-containing model ids", () => {
  assert.deepEqual(parseModelSlug("local/mlx-community/Qwen3-8B-4bit#fast"), {
    providerID: "local",
    modelID: "mlx-community/Qwen3-8B-4bit",
    variant: "fast",
  });
});

test("parseModelSlug: trailing # alone does not invent a variant", () => {
  assert.deepEqual(parseModelSlug("anthropic/claude-opus#"), {
    providerID: "anthropic",
    modelID: "claude-opus",
  });
});

test("parseModelSlug: bare string with no slash yields empty modelID", () => {
  assert.deepEqual(parseModelSlug("nogood"), { providerID: "nogood", modelID: "" });
});

test("parseModelSlug: empty string yields empty providerID and modelID", () => {
  assert.deepEqual(parseModelSlug(""), { providerID: "", modelID: "" });
});

test("parseModelSlug: null/undefined coerces to empty string", () => {
  assert.deepEqual(parseModelSlug(undefined), { providerID: "", modelID: "" });
  assert.deepEqual(parseModelSlug(null), { providerID: "", modelID: "" });
});
