import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  LocalModelEjectButton,
  isLocalModelSession,
} from "../LocalModelEjectButton";

vi.mock("../../../lib/mlx", () => ({
  mlxEjectModel: vi.fn(() => Promise.resolve()),
}));

import { mlxEjectModel } from "../../../lib/mlx";

describe("isLocalModelSession", () => {
  it("detects MLX provider", () => {
    expect(isLocalModelSession("MLX", "anything")).toBe(true);
  });

  it("detects OpenCode local/ slug", () => {
    expect(isLocalModelSession("OpenCode", "local/mlx-community/Qwen3-4B")).toBe(
      true,
    );
  });

  it("ignores cloud OpenCode models", () => {
    expect(
      isLocalModelSession("OpenCode", "anthropic/claude-sonnet-4-5"),
    ).toBe(false);
  });

  it("ignores Claude", () => {
    expect(isLocalModelSession("ClaudeCode", "sonnet")).toBe(false);
  });
});

describe("LocalModelEjectButton", () => {
  beforeEach(() => {
    vi.mocked(mlxEjectModel).mockClear();
  });

  it("is hidden for non-local sessions", () => {
    const { container } = render(
      <LocalModelEjectButton
        provider="OpenCode"
        model="anthropic/claude-sonnet-4-5"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders and ejects for local OpenCode models", async () => {
    render(
      <LocalModelEjectButton
        provider="OpenCode"
        model="local/mlx-community/Qwen3-4B-Instruct-2507-4bit"
      />,
    );
    const btn = screen.getByTestId("local-model-eject");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mlxEjectModel).toHaveBeenCalledTimes(1);
    });
  });

  it("renders for MLX provider", () => {
    const { getAllByTestId } = render(
      <LocalModelEjectButton provider="MLX" model="foo/bar" />,
    );
    expect(getAllByTestId("local-model-eject").length).toBeGreaterThanOrEqual(1);
  });
});
