import { describe, it, expect } from "vitest";
import { localModelSlug, resolveLocalModelId, type MlxModel } from "../../../lib/mlx";

const model = (id: string): MlxModel => ({
  id,
  displayName: id,
  source: "xanomManaged",
  path: `/tmp/${id}`,
  sizeBytes: 1,
  supportsTools: true,
});

describe("localModelSlug", () => {
  it("prefixes a bare model id for the OpenCode local provider", () => {
    expect(localModelSlug("mlx-community/Qwen3-8B-4bit")).toBe(
      "local/mlx-community/Qwen3-8B-4bit",
    );
  });

  it("is idempotent when the slug is already prefixed", () => {
    expect(localModelSlug("local/a/b")).toBe("local/a/b");
  });
});

/** Both the chat draft and the terminal "local" tile route through this, so
 *  neither surface can open a session with no local model selected — the
 *  terminal case previously fell through to grok's default cloud model. */
describe("resolveLocalModelId", () => {
  it("keeps the preferred model when it is installed", () => {
    expect(resolveLocalModelId([model("a/b"), model("c/d")], "c/d")).toBe("c/d");
  });

  it("accepts an already-prefixed preferred id (lastUsedModel shape)", () => {
    expect(resolveLocalModelId([model("a/b"), model("c/d")], "local/c/d")).toBe("c/d");
  });

  it("falls back to the first installed model when the preference is stale", () => {
    expect(resolveLocalModelId([model("a/b")], "gone/away")).toBe("a/b");
  });

  it("falls back to the first installed model when nothing is preferred", () => {
    expect(resolveLocalModelId([model("a/b")], null)).toBe("a/b");
  });

  it("returns null when nothing is installed, so callers open Settings instead", () => {
    expect(resolveLocalModelId([], "a/b")).toBeNull();
    expect(resolveLocalModelId(undefined, null)).toBeNull();
  });

  it("yields a local/<id> slug for the thread model, never a bare grok model", () => {
    const resolved = resolveLocalModelId([model("mlx-community/Qwen3-8B-4bit")], null);
    expect(resolved).not.toBeNull();
    expect(localModelSlug(resolved!)).toBe("local/mlx-community/Qwen3-8B-4bit");
  });
});
