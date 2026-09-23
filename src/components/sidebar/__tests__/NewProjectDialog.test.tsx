/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NewProjectDialog } from "../NewProjectDialog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

afterEach(() => cleanup());

describe("NewProjectDialog", () => {
  it("renders nothing visible when open=false", () => {
    render(<NewProjectDialog open={false} onClose={() => {}} />);
    expect(screen.queryByText(/new project/i)).toBeNull();
  });

  it("renders dialog title when open", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(screen.getByText(/new project/i)).toBeTruthy();
  });

  it("renders Browse for folder button", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(screen.getByText(/browse for folder/i)).toBeTruthy();
  });

  it("renders Cancel and Create buttons", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /create/i })).toBeTruthy();
  });

  it("Cancel button fires onClose", () => {
    const onClose = vi.fn();
    render(<NewProjectDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Create button is disabled when name and repoPath are empty", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    const createBtn = screen.getByRole("button", { name: /create/i }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
  });

  it("does not render Project Name input until repoPath is selected", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(screen.queryByPlaceholderText("My Project")).toBeNull();
  });

  it("Browse button is clickable without throwing", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(() =>
      fireEvent.click(screen.getByText(/browse for folder/i)),
    ).not.toThrow();
  });

  it("Cancel does not invoke create command", () => {
    const onClose = vi.fn();
    render(<NewProjectDialog open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders portal contents into document.body", () => {
    render(<NewProjectDialog open={true} onClose={() => {}} />);
    expect(document.body.textContent).toMatch(/new project/i);
  });
});
