/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CodexDiffBlock } from "../CodexDiffBlock";

afterEach(() => cleanup());

const UNIFIED = [
  "--- a/hero.tsx",
  "+++ b/hero.tsx",
  "@@ -41,3 +41,3 @@",
  '-  <section className="bg-[--accent-indigo]/5">',
  '+  <section className="bg-[--accent-emerald]/5">',
  "   <h1>{headline}</h1>",
].join("\n");

describe("CodexDiffBlock", () => {
  it("renders the file path in the header", () => {
    render(<CodexDiffBlock path="components/landing/hero.tsx" diff={UNIFIED} kind="modify" />);
    expect(screen.getByText("components/landing/hero.tsx")).toBeTruthy();
  });

  it("renders the +N −M stat in the header", () => {
    render(
      <CodexDiffBlock path="hero.tsx" diff={UNIFIED} kind="modify" additions={16} deletions={6} />,
    );
    expect(screen.getByText("+16")).toBeTruthy();
    expect(screen.getByText("−6")).toBeTruthy();
  });

  it("tints added lines and removed lines differently", () => {
    const { container } = render(<CodexDiffBlock path="hero.tsx" diff={UNIFIED} kind="modify" />);
    expect(container.querySelectorAll('[data-line="add"]').length).toBe(1);
    expect(container.querySelectorAll('[data-line="del"]').length).toBe(1);
  });

  it("treats +++ and --- as headers, not add/del lines", () => {
    const { container } = render(<CodexDiffBlock path="hero.tsx" diff={UNIFIED} kind="modify" />);
    expect(container.querySelectorAll('[data-line="header"]').length).toBe(3);
  });

  it("renders header-like content inside a hunk as real additions and deletions", () => {
    const { container } = render(<CodexDiffBlock path="notes.md" diff={"--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n----\n++++"} kind="modify" />);
    expect(container.querySelectorAll('[data-line="add"]').length).toBe(1);
    expect(container.querySelectorAll('[data-line="del"]').length).toBe(1);
    expect(container.querySelectorAll('[data-line="header"]').length).toBe(3);
  });

  it("tints every content line for a created file", () => {
    const { container } = render(
      <CodexDiffBlock path="new.ts" diff={"const a = 1;\nconst b = 2;"} kind="create" />,
    );
    expect(container.querySelectorAll('[data-line="add"]').length).toBe(2);
  });

  it("tints every content line for a deleted file", () => {
    const { container } = render(
      <CodexDiffBlock path="old.ts" diff={"const a = 1;"} kind="delete" />,
    );
    expect(container.querySelectorAll('[data-line="del"]').length).toBe(1);
  });

  it("renders nothing when the diff is empty", () => {
    const { container } = render(<CodexDiffBlock path="a.ts" diff="" kind="modify" />);
    expect(container.firstChild).toBeNull();
  });
});
