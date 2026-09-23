/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolDetailDialog, type ToolDetailData } from "../ToolDetailDialog";

afterEach(() => cleanup());

const baseTool: ToolDetailData = {
  name: "Bash",
  toolId: "tid-1",
  input: { command: "ls -la" },
  pending: false,
};

describe("ToolDetailDialog", () => {
  it("renders tool name in header", () => {
    render(<ToolDetailDialog tool={baseTool} onClose={vi.fn()} />);
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("renders tool category for Bash as 'Command'", () => {
    render(<ToolDetailDialog tool={baseTool} onClose={vi.fn()} />);
    expect(screen.getByText("Command")).toBeTruthy();
  });

  it("renders tool category for Grok run_command as 'Command'", () => {
    render(
      <ToolDetailDialog
        tool={{ ...baseTool, name: "run_command", input: { command: "npm test" } }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Command")).toBeTruthy();
  });

  it("renders 'File Edit' category for Edit tool", () => {
    render(
      <ToolDetailDialog
        tool={{ ...baseTool, name: "Edit", input: { file_path: "/a.ts" } }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("File Edit")).toBeTruthy();
  });

  it("renders 'MCP: filesystem' category for MCP-prefixed tool", () => {
    render(
      <ToolDetailDialog
        tool={{ ...baseTool, name: "mcp__filesystem__list_directory", input: {} }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("MCP: filesystem")).toBeTruthy();
  });

  it("shows Running badge when pending and no result", () => {
    render(
      <ToolDetailDialog
        tool={{ ...baseTool, pending: true }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Tool is currently executing…")).toBeTruthy();
  });

  it("shows Error badge and error content when result is error", () => {
    render(
      <ToolDetailDialog
        tool={{
          ...baseTool,
          result: { content: "command not found", isError: true },
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("This tool call returned an error")).toBeTruthy();
    expect(screen.getByText("command not found")).toBeTruthy();
  });

  it("shows Success badge when result has no error", () => {
    render(
      <ToolDetailDialog
        tool={{
          ...baseTool,
          result: { content: "ok", isError: false },
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByText("ok")).toBeTruthy();
  });

  it("renders Tool ID in metadata footer", () => {
    render(<ToolDetailDialog tool={baseTool} onClose={vi.fn()} />);
    expect(screen.getByText(/ID: tid-1/)).toBeTruthy();
  });

  it("calls onClose when Close button is clicked", () => {
    const onClose = vi.fn();
    render(<ToolDetailDialog tool={baseTool} onClose={onClose} />);
    const closeBtn = document.querySelector(".lucide-x")!.closest("button")!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(<ToolDetailDialog tool={baseTool} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders input parameters", () => {
    render(
      <ToolDetailDialog
        tool={{
          ...baseTool,
          input: { command: "echo hi", description: "say hi" },
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("command")).toBeTruthy();
    expect(screen.getByText("description")).toBeTruthy();
    expect(screen.getByText("say hi")).toBeTruthy();
  });

  it("renders empty result placeholder when content is empty string", () => {
    render(
      <ToolDetailDialog
        tool={{
          ...baseTool,
          result: { content: "", isError: false },
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("(empty)")).toBeTruthy();
  });
});
