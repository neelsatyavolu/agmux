/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TaskToolRenderer } from "../TaskToolRenderer";
import type { AgentChildTool } from "../types";

afterEach(() => cleanup());

function makeChildTool(overrides: Partial<AgentChildTool> = {}): AgentChildTool {
  return {
    name: "Bash",
    toolId: `tool-${Math.random()}`,
    input: { command: "echo hello" },
    pending: false,
    ...overrides,
  };
}

const defaultProps = {
  input: {},
  result: null,
  isError: false,
  isPending: false,
};

describe("TaskToolRenderer", () => {
  it("renders without crashing when no childTools provided", () => {
    render(<TaskToolRenderer {...defaultProps} />);
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("renders child tool rows", () => {
    const tools = [
      makeChildTool({ name: "Bash", input: { command: "ls" } }),
      makeChildTool({ name: "Read", input: { file_path: "/some/file.ts" } }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
  });

  it("uses Codex rows with distinct running, completed, idle, and error states", () => {
    const tools = [
      makeChildTool({ toolId: "idle" }),
      makeChildTool({ toolId: "done", result: { content: "done", isError: false } }),
      makeChildTool({ toolId: "running", pending: true }),
      makeChildTool({ toolId: "error", result: { content: "failed", isError: true } }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getAllByTestId("codex-tool-row").map((row) => row.dataset.status))
      .toEqual(["error", "running", "ok", "idle"]);
  });

  it("shows the latest five tools in reverse order and reveals older tools on expansion", () => {
    const tools = Array.from({ length: 7 }, (_, i) =>
      makeChildTool({ toolId: `t${i}`, input: { command: `cmd${i}` } }),
    );
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    const commands = () => screen.getAllByTestId("codex-tool-row")
      .map((row) => row.querySelector("[title]")?.textContent);
    expect(commands()).toEqual(["cmd6", "cmd5", "cmd4", "cmd3", "cmd2"]);
    fireEvent.click(screen.getByText("Show all 7 tool calls"));
    expect(commands()).toEqual(["cmd6", "cmd5", "cmd4", "cmd3", "cmd2", "cmd1", "cmd0"]);
    fireEvent.click(screen.getByText("Show less"));
    expect(commands()).toEqual(["cmd6", "cmd5", "cmd4", "cmd3", "cmd2"]);
  });

  it("shows 'Show all N tool calls' when more than 5 child tools", () => {
    const tools = Array.from({ length: 7 }, (_, i) =>
      makeChildTool({ name: "Bash", toolId: `t${i}`, input: { command: `cmd${i}` } }),
    );
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("Show all 7 tool calls")).toBeTruthy();
  });

  it("expands to show all tools when 'Show all' is clicked", () => {
    const tools = Array.from({ length: 7 }, (_, i) =>
      makeChildTool({ name: "Bash", toolId: `t${i}`, input: { command: `cmd${i}` } }),
    );
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    fireEvent.click(screen.getByText("Show all 7 tool calls"));
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("does not show overflow button when 5 or fewer child tools", () => {
    const tools = Array.from({ length: 5 }, (_, i) =>
      makeChildTool({ toolId: `t${i}` }),
    );
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("shows error detail for child tools with isError", () => {
    const tools = [
      makeChildTool({
        name: "Bash",
        result: { content: "command not found", isError: true },
      }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("err")).toBeTruthy();
  });

  it("renders 'denied' detail when child tool result is denied", () => {
    const tools = [
      makeChildTool({
        name: "Bash",
        result: { content: "User does not want to proceed", isError: true },
      }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("denied")).toBeTruthy();
  });

  it("renders 'limit' detail when child tool result is rate-limited", () => {
    const tools = [
      makeChildTool({
        name: "Bash",
        result: { content: "You hit your limit", isError: true },
      }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("limit")).toBeTruthy();
  });

  it("renders shortened file path label for Read tool", () => {
    const tools = [
      makeChildTool({ name: "Read", input: { file_path: "/Users/x/proj/src/foo.ts" } }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
  });

  it("uses Bash command as label when description is missing", () => {
    const tools = [
      makeChildTool({ name: "Bash", input: { command: "ls -la" } }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("uses Grok run_command command as label when description is missing", () => {
    const tools = [
      makeChildTool({ name: "run_command", input: { command: "npm test" } }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("prefers Bash description over command", () => {
    const tools = [
      makeChildTool({
        name: "Bash",
        input: { command: "rm -rf /", description: "Cleanup files" },
      }),
    ];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText("Cleanup files")).toBeTruthy();
  });

  it("truncates very long Bash command labels with an ellipsis", () => {
    const cmd = "a".repeat(100);
    const tools = [makeChildTool({ name: "Bash", input: { command: cmd } })];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText(/^a+…$/)).toBeTruthy();
  });

  it("renders Glob/Grep pattern label in quotes", () => {
    const tools = [makeChildTool({ name: "Grep", input: { pattern: "TODO" } })];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getByText('"TODO"')).toBeTruthy();
  });

  it("falls back to tool name when no input fields match", () => {
    const tools = [makeChildTool({ name: "CustomTool", input: {} })];
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    expect(screen.getAllByText("CustomTool").length).toBeGreaterThan(0);
  });

  it("collapses back when 'Show less' is clicked", () => {
    const tools = Array.from({ length: 7 }, (_, i) =>
      makeChildTool({ toolId: `t${i}`, input: { command: `cmd${i}` } }),
    );
    render(<TaskToolRenderer {...defaultProps} childTools={tools} />);
    fireEvent.click(screen.getByText("Show all 7 tool calls"));
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.getByText("Show all 7 tool calls")).toBeTruthy();
  });

  it("renders empty wrapper when childTools is undefined", () => {
    const { container } = render(<TaskToolRenderer {...defaultProps} />);
    // No child rows
    expect(container.querySelectorAll('[data-testid="codex-tool-row"]').length).toBe(0);
  });
});
