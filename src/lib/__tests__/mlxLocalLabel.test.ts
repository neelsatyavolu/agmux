import { describe, it, expect } from "vitest";
import {
  formatLocalModelLabel,
  isLocalModelSlug,
  prettifyMlxModelName,
} from "../mlx";

describe("isLocalModelSlug", () => {
  it("matches local/ harness slugs", () => {
    expect(isLocalModelSlug("local/mlx-community/Qwen3.6-27B-4bit")).toBe(true);
  });
  it("rejects bare and cloud slugs", () => {
    expect(isLocalModelSlug("mlx-community/Qwen3.6-27B-4bit")).toBe(false);
    expect(isLocalModelSlug("anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isLocalModelSlug(null)).toBe(false);
  });
});

describe("formatLocalModelLabel", () => {
  it("shortens OpenCode local chat slugs", () => {
    expect(
      formatLocalModelLabel("local/mlx-community/Qwen3.6-27B-MLX-4bit"),
    ).toBe("Qwen 3.6 27B");
  });

  it("shortens Pi local terminal slugs", () => {
    expect(
      formatLocalModelLabel(
        "local/mlx-community/Qwen3-4B-Instruct-2507-4bit",
      ),
    ).toBe("Qwen 3 4B");
  });

  it("handles Coder-Next and MoE active-param cut", () => {
    expect(
      formatLocalModelLabel(
        "local/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit",
      ),
    ).toBe("Qwen 3 Coder 30B");
    expect(
      formatLocalModelLabel("local/mlx-community/Qwen3-Coder-Next-4bit"),
    ).toBe("Qwen 3 Coder Next");
  });

  it("accepts bare discovery ids", () => {
    expect(formatLocalModelLabel("mlx-community/Qwen3.5-9B-MLX-4bit")).toBe(
      "Qwen 3.5 9B",
    );
  });
});

describe("prettifyMlxModelName", () => {
  it("is idempotent on already-pretty labels", () => {
    expect(prettifyMlxModelName("Qwen 3.6 27B")).toBe("Qwen 3.6 27B");
  });

  it("tolerates full local/ paths", () => {
    expect(
      prettifyMlxModelName("local/mlx-community/Qwen3.6-35B-A3B-4bit"),
    ).toBe("Qwen 3.6 35B");
  });
});
