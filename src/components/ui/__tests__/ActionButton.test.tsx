/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Star } from "lucide-react";
import { ActionButton } from "../ActionButton";

afterEach(() => cleanup());

describe("ActionButton", () => {
  it("renders a button", () => {
    render(<ActionButton icon={Star} />);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("is disabled when disabled prop is true", () => {
    render(<ActionButton icon={Star} disabled />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<ActionButton icon={Star} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders title attribute", () => {
    render(<ActionButton icon={Star} title="Star button" />);
    expect(screen.getByTitle("Star button")).toBeTruthy();
  });

  it("applies active class styles when active", () => {
    render(<ActionButton icon={Star} active />);
    expect(screen.getByRole("button").className).toContain("accent");
  });

  it("does not call onClick when disabled and clicked", () => {
    const onClick = vi.fn();
    render(<ActionButton icon={Star} onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders icon at default size 14", () => {
    const { container } = render(<ActionButton icon={Star} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("height")).toBe("14");
  });

  it("renders icon with custom size", () => {
    const { container } = render(<ActionButton icon={Star} size={20} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
  });

  it("merges custom className", () => {
    render(<ActionButton icon={Star} className="custom-class" />);
    expect(screen.getByRole("button").className).toContain("custom-class");
  });

  it("applies inactive hover classes when not active", () => {
    render(<ActionButton icon={Star} />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("text-white/30");
  });

  it("includes disabled:opacity in class for visual disabled state", () => {
    render(<ActionButton icon={Star} disabled />);
    expect(screen.getByRole("button").className).toContain("disabled:opacity-30");
  });

  it("does not require title prop to render", () => {
    const { container } = render(<ActionButton icon={Star} />);
    const btn = container.querySelector("button");
    expect(btn).toBeTruthy();
    // Without title, attribute is unset
    expect(btn?.getAttribute("title")).toBeNull();
  });
});
