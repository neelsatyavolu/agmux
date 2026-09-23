/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TerminalProjectGroup } from "../TerminalProjectGroup";
import type { Project } from "../../../lib/types";
import type { TerminalSession } from "../../../stores/terminalStore";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

afterEach(() => cleanup());

const project = {
  id: "p1",
  name: "MyProject",
  repo_path: "/tmp/p",
  conventions: null,
  created_at: new Date().toISOString(),
} as unknown as Project;

const session = {
  id: "s1",
  label: "term-1",
  cwd: "/tmp/p",
  status: "running",
  saved: false,
} as unknown as TerminalSession;

describe("TerminalProjectGroup", () => {
  it("renders project name", () => {
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    expect(screen.getByText("MyProject")).toBeTruthy();
  });

  it("shows 'No terminals' when sessions empty", () => {
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    expect(screen.getByText(/no terminals/i)).toBeTruthy();
  });

  it("renders session label", () => {
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[session]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    expect(screen.getByText("term-1")).toBeTruthy();
  });

  it("calls onSelectSession when session is clicked", () => {
    const onSelect = vi.fn();
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[session]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={onSelect}
        onCloseSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("term-1"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("calls onNewTerminal when + clicked", () => {
    const onNew = vi.fn();
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[]}
        activeSessionId={null}
        onNewTerminal={onNew}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("New Terminal"));
    expect(onNew).toHaveBeenCalledWith("p1", "/tmp/p");
  });

  it("calls onCloseSession when close (X) icon is clicked", () => {
    const onClose = vi.fn();
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[session]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={onClose}
      />,
    );
    // The close button title typically reads "Close terminal"
    const buttons = screen.getAllByRole("button");
    // Last button on the row should be close
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("collapses and re-expands on header click", () => {
    render(
      <TerminalProjectGroup
        project={project}
        sessions={[session]}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    expect(screen.getByText("term-1")).toBeTruthy();
    fireEvent.click(screen.getByText("MyProject"));
    expect(screen.queryByText("term-1")).toBeNull();
    fireEvent.click(screen.getByText("MyProject"));
    expect(screen.getByText("term-1")).toBeTruthy();
  });

  it("shows multiple session rows", () => {
    const sessions = [
      { ...session, id: "s1", label: "term-1" } as any,
      { ...session, id: "s2", label: "term-2" } as any,
      { ...session, id: "s3", label: "term-3" } as any,
    ];
    render(
      <TerminalProjectGroup
        project={project}
        sessions={sessions}
        activeSessionId={null}
        onNewTerminal={() => {}}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );
    expect(screen.getByText("term-1")).toBeTruthy();
    expect(screen.getByText("term-2")).toBeTruthy();
    expect(screen.getByText("term-3")).toBeTruthy();
  });
});
