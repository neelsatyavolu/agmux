/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConventionsDialog } from "../ConventionsDialog";
import type { Project } from "../../../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => cleanup());

const project: Project = {
  id: "p1",
  name: "MyProject",
  repo_path: "/tmp/p",
  conventions: JSON.stringify(["Use 2-space indents", "Prefer immutable code"]),
  created_at: new Date().toISOString(),
};

describe("ConventionsDialog", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <ConventionsDialog open={false} project={project} onClose={() => {}} />,
    );
    expect(container.querySelector("h3")).toBeNull();
  });

  it("renders project name in header when open", () => {
    render(
      <ConventionsDialog open={true} project={project} onClose={() => {}} />,
    );
    expect(screen.getByText(/MyProject/)).toBeTruthy();
  });

  it("renders existing conventions from JSON", () => {
    render(
      <ConventionsDialog open={true} project={project} onClose={() => {}} />,
    );
    expect(screen.getByText("Use 2-space indents")).toBeTruthy();
    expect(screen.getByText("Prefer immutable code")).toBeTruthy();
  });

  it("renders empty-state copy when no conventions", () => {
    const empty: Project = { ...project, conventions: "[]" };
    render(<ConventionsDialog open={true} project={empty} onClose={() => {}} />);
    expect(screen.getByText(/No conventions yet/i)).toBeTruthy();
  });

  it("Cancel button fires onClose", () => {
    const onClose = vi.fn();
    render(
      <ConventionsDialog open={true} project={project} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("typing into add-input enables Add button", () => {
    render(
      <ConventionsDialog open={true} project={project} onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/add a convention/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New rule" } });
    expect(input.value).toBe("New rule");
  });

  it("Add button appends a new convention", () => {
    render(<ConventionsDialog open={true} project={{ ...project, conventions: "[]" }} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/add a convention/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Use spaces" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByText("Use spaces")).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("Enter key on input adds a new convention", () => {
    render(<ConventionsDialog open={true} project={{ ...project, conventions: "[]" }} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/add a convention/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "From enter" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("From enter")).toBeTruthy();
  });

  it("trims whitespace from new conventions and ignores blanks", () => {
    render(<ConventionsDialog open={true} project={{ ...project, conventions: "[]" }} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/add a convention/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(screen.getByText(/no conventions yet/i)).toBeTruthy();
  });

  it("falls back to splitting by newlines when conventions is plain string", () => {
    render(
      <ConventionsDialog
        open={true}
        project={{
          ...project,
          conventions: "first\nsecond\n\nthird",
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("third")).toBeTruthy();
  });

  it("renders empty when conventions is null", () => {
    render(
      <ConventionsDialog
        open={true}
        project={{ ...project, conventions: null as any }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/no conventions yet/i)).toBeTruthy();
  });
});
