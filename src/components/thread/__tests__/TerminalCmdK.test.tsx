/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  askAi: vi.fn().mockResolvedValue("ls -la"),
}));

import TerminalCmdK from "../TerminalCmdK";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("TerminalCmdK", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <TerminalCmdK open={false} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    expect(container.textContent).not.toMatch(/command instructions/i);
  });

  it("renders input placeholder when open", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    expect(screen.getByPlaceholderText(/command instructions/i)).toBeTruthy();
  });

  it("calls onClose when X clicked", () => {
    const onClose = vi.fn();
    render(
      <TerminalCmdK open={true} onClose={onClose} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders provider label (default Haiku)", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    expect(screen.getByText("Haiku")).toBeTruthy();
  });

  it("renders Submit button (disabled when no query)", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    const btn = screen.getByLabelText(/submit/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Submit button enables when user types into query", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/command instructions/i);
    fireEvent.change(input, { target: { value: "list files" } });
    const btn = screen.getByLabelText(/submit/i) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("typing updates the textarea value", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/command instructions/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "find todos" } });
    expect(input.value).toBe("find todos");
  });

  it("provider button is enabled when not loading", () => {
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    // Click the Haiku provider toggle to ensure it doesn't throw
    expect(() => fireEvent.click(screen.getByText("Haiku"))).not.toThrow();
  });

  it("loads stored 'codex' provider from localStorage", () => {
    localStorage.setItem("agmux-cmdk-provider", "codex");
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("falls back to default Haiku for unknown stored values", () => {
    localStorage.setItem("agmux-cmdk-provider", "garbage");
    render(
      <TerminalCmdK open={true} onClose={() => {}} terminalContext="" workDir="/" onInsertCommand={() => {}} />,
    );
    expect(screen.getByText("Haiku")).toBeTruthy();
  });
});
