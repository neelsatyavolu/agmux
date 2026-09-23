/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SlashCommandPopup } from "../SlashCommandPopup";
import type { SlashCommand } from "../../../lib/slashCommands";

beforeAll(() => {
  // jsdom does not implement scrollIntoView
  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

afterEach(() => cleanup());

const cmds: SlashCommand[] = [
  {
    name: "/help",
    description: "Show available commands",
    providers: ["ClaudeCode", "Codex"],
    action: "passthrough",
    source: "built-in",
  },
  {
    name: "/clear",
    description: "Clear the conversation",
    providers: ["ClaudeCode"],
    action: "passthrough",
    source: "user",
  },
  {
    name: "/custom",
    description: "Custom user command",
    providers: ["ClaudeCode"],
    args: "<arg>",
    action: "local",
    source: "project",
  },
];

describe("SlashCommandPopup", () => {
  it("returns null when commands list is empty", () => {
    const { container } = render(
      <SlashCommandPopup
        commands={[]}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders all command names in the list", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    // /help appears in list AND preview (active row); /clear and /custom only in list
    expect(screen.getAllByText("/help").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/custom")).toBeTruthy();
  });

  it("marks active command with aria-selected", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={1}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("shows shared badge for commands with multiple providers", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("shared")).toBeTruthy();
  });

  it("calls onSelect with the command when clicked", () => {
    const onSelect = vi.fn();
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText("/clear"));
    expect(onSelect).toHaveBeenCalledWith(cmds[1]);
  });

  it("renders preview pane with active command's description and args", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={2}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("<arg>")).toBeTruthy();
    // Description appears in both list and preview; just confirm preview's source label
    expect(screen.getByText("Project")).toBeTruthy();
  });

  it("shows passthrough hint for passthrough commands", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Sent directly to the agent")).toBeTruthy();
  });

  it("shows source label Built-in for built-in commands", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={0}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("falls back to placeholder when activeIndex is out of bounds", () => {
    render(
      <SlashCommandPopup
        commands={cmds}
        activeIndex={99}
        provider="ClaudeCode"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Select a command")).toBeTruthy();
  });
});
