/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThinkingBlock } from "../ThinkingBlock";
import { useSettingsStore } from "../../../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
  once: vi.fn().mockResolvedValue(() => {}),
}));

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      showThinking: false,
    },
  });
});

afterEach(() => cleanup());

describe("ThinkingBlock", () => {
  it("renders streaming indicator when thinking is empty", () => {
    render(<ThinkingBlock thinking="" />);
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByTestId("codex-think-row")).toBeTruthy();
  });

  it("hides thinking content when collapsed (showThinking false)", () => {
    render(<ThinkingBlock thinking="I am reasoning about this." />);
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText("I am reasoning about this.")).toBeNull();
    expect(screen.getByTestId("thinking-block").getAttribute("data-expanded")).toBe("false");
  });

  it("renders expanded content when showThinking is true", () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        showThinking: true,
      },
    });
    render(<ThinkingBlock thinking="Deep thoughts here." />);
    expect(screen.getByText("Deep thoughts here.")).toBeTruthy();
    expect(screen.getByTestId("thinking-block").getAttribute("data-expanded")).toBe("true");
  });

  it("shows elapsed time label when provided", () => {
    render(<ThinkingBlock thinking="Some content." elapsed="12s" />);
    expect(screen.getByText("12s")).toBeTruthy();
  });

  it("does not show elapsed when not provided", () => {
    render(<ThinkingBlock thinking="Some content." />);
    expect(screen.queryByText(/\d+s/)).toBeNull();
  });

  it("toggles open state when row is clicked", () => {
    render(<ThinkingBlock thinking="Toggle me." />);
    expect(screen.getByTestId("thinking-block").getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("codex-tool-row"));
    expect(screen.getByTestId("thinking-block").getAttribute("data-expanded")).toBe("true");
  });

  it("calls onExpand when expanded", () => {
    const onExpand = vi.fn();
    render(<ThinkingBlock thinking="Expand me." onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("codex-tool-row"));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("does not call onExpand when collapsing", () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        showThinking: true,
      },
    });
    const onExpand = vi.fn();
    render(<ThinkingBlock thinking="Collapse me." onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("codex-tool-row"));
    expect(onExpand).not.toHaveBeenCalled();
  });
});
