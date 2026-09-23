/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CodexToolRow } from "../CodexToolRow";

afterEach(() => cleanup());

describe("CodexToolRow", () => {
  it("renders the lead verb and subject", () => {
    render(<CodexToolRow lead="Searched" subject='"--accent-indigo"' />);
    expect(screen.getByText("Searched")).toBeTruthy();
    expect(screen.getByText('"--accent-indigo"')).toBeTruthy();
  });

  it("applies optional leadClassName for muted verbs", () => {
    render(
      <CodexToolRow
        lead="Searched Firecrawl for"
        leadClassName="text-[var(--text-muted)]"
        subject="UMN application"
        subjectClassName="text-[var(--text-secondary)]"
      />,
    );
    expect(screen.getByText("Searched Firecrawl for").className).toMatch(/text-muted|text-\[var\(--text-muted\)\]/);
    expect(screen.getByText("UMN application").className).toMatch(/text-secondary|text-\[var\(--text-secondary\)\]/);
  });

  it("renders a dim detail segment", () => {
    render(<CodexToolRow lead="Read" subject="app/tokens.css" detail="212 lines" />);
    expect(screen.getByText("212 lines")).toBeTruthy();
  });

  it("renders additions and deletions when present", () => {
    render(<CodexToolRow lead="Edited" subject="hero.tsx" additions={16} deletions={6} />);
    expect(screen.getByText("+16")).toBeTruthy();
    expect(screen.getByText("−6")).toBeTruthy();
  });

  it("omits a zero addition or deletion count", () => {
    render(<CodexToolRow lead="Edited" subject="button.tsx" additions={2} deletions={0} />);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryByText("−0")).toBeNull();
  });

  it("shows a spinner while running", () => {
    const { container } = render(<CodexToolRow lead="Searched" subject="q" status="running" />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("marks an errored row", () => {
    render(<CodexToolRow lead="Ran" subject="pnpm build" status="error" />);
    expect(screen.getByRole("listitem").getAttribute("data-status")).toBe("error");
  });

  it("fires onToggle when the toggle is clicked and reflects open state", () => {
    const onToggle = vi.fn();
    render(
      <CodexToolRow
        lead="Edited"
        subject="hero.tsx"
        toggle={{ open: false, openLabel: "hide diff", closedLabel: "show diff", onToggle }}
      />,
    );
    const btn = screen.getByRole("button", { name: /show diff/i });
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("uses the open label when expanded", () => {
    render(
      <CodexToolRow
        lead="Edited"
        subject="hero.tsx"
        toggle={{ open: true, openLabel: "hide diff", closedLabel: "show diff", onToggle: () => {} }}
      />,
    );
    expect(screen.getByRole("button", { name: /hide diff/i })).toBeTruthy();
  });

  it("renders no toggle when none is supplied", () => {
    render(<CodexToolRow lead="Read" subject="a.ts" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("parks trailing actions immediately left of the toggle", () => {
    render(
      <CodexToolRow
        lead="Ran"
        subject="pwd"
        toggle={{ open: false, openLabel: "hide", closedLabel: "result", onToggle: () => {} }}
        trailing={<span data-testid="trail">info</span>}
      />,
    );
    const trail = screen.getByTestId("trail");
    const result = screen.getByText("result");
    expect(screen.getByTestId("codex-tool-row").contains(trail)).toBe(true);
    expect(trail.parentElement?.className).toMatch(/right-full/);
    expect(trail.parentElement?.parentElement).toBe(result.parentElement?.parentElement);
  });
});
