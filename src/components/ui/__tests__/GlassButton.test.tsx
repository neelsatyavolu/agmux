/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Star } from "lucide-react";
import { GlassButton } from "../GlassButton";

afterEach(() => cleanup());

describe("GlassButton", () => {
  it("renders children", () => {
    render(<GlassButton>Click me</GlassButton>);
    expect(screen.getByRole("button", { name: /click me/i })).toBeTruthy();
  });

  it("renders with accent variant", () => {
    render(<GlassButton variant="accent">Accept</GlassButton>);
    const btn = screen.getByRole("button", { name: /accept/i });
    expect(btn.className).toContain("var(--accent)");
  });

  it("renders with destructive variant", () => {
    render(<GlassButton variant="destructive">Delete</GlassButton>);
    const btn = screen.getByRole("button", { name: /delete/i });
    expect(btn.className).toContain("red");
  });

  it("renders with ghost variant", () => {
    render(<GlassButton variant="ghost">Ghost</GlassButton>);
    expect(screen.getByRole("button", { name: /ghost/i })).toBeTruthy();
  });

  it("is disabled when disabled prop is true", () => {
    render(<GlassButton disabled>Disabled</GlassButton>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<GlassButton onClick={onClick}>Click</GlassButton>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders with an icon", () => {
    render(<GlassButton icon={Star}>Starred</GlassButton>);
    expect(screen.getByRole("button", { name: /starred/i })).toBeTruthy();
  });

  it("renders title attribute", () => {
    render(<GlassButton title="My title">Btn</GlassButton>);
    expect(screen.getByTitle("My title")).toBeTruthy();
  });
});
