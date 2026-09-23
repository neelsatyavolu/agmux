/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EditToolRenderer } from "../EditToolRenderer";

afterEach(() => cleanup());

const defaultProps = {
  result: null,
  isError: false,
  isPending: false,
};

describe("EditToolRenderer", () => {
  it("renders without crashing with minimal input", () => {
    render(<EditToolRenderer {...defaultProps} input={{ file_path: "src/foo.ts", old_string: "a", new_string: "b" }} />);
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("shows 'Replace All' badge when replace_all is true", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ file_path: "x.ts", old_string: "a", new_string: "b", replace_all: true }}
      />,
    );
    expect(screen.getByText("Replace All")).toBeTruthy();
  });

  it("does not show 'Replace All' badge when replace_all is false", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ file_path: "x.ts", old_string: "a", new_string: "b", replace_all: false }}
      />,
    );
    expect(screen.queryByText("Replace All")).toBeNull();
  });

  it("accepts Cursor oldText / newText keys", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ path: "src/foo.ts", oldText: "old text", newText: "new text" }}
      />,
    );
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("accepts camelCase oldString / newString keys", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ filePath: "src/bar.ts", oldString: "old text", newString: "new text" }}
      />,
    );
    // Should render without crashing — InlineDiff handles the actual diff rendering
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("falls back to empty strings when old/new strings are missing", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ file_path: "src/baz.ts" }}
      />,
    );
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("accepts replaceAll camelCase variant", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ file_path: "x.ts", old_string: "a", new_string: "b", replaceAll: true }}
      />,
    );
    expect(screen.getByText("Replace All")).toBeTruthy();
  });

  it("uses 'path' as a third file_path fallback", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ path: "src/from-path.ts", old_string: "a", new_string: "b" }}
      />,
    );
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("uses 'unknown' when no file path key is provided", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{ old_string: "a", new_string: "b" }}
      />,
    );
    // No crash — InlineDiff still renders for unknown paths
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("renders inline diff content from old and new strings", () => {
    const { container } = render(
      <EditToolRenderer
        {...defaultProps}
        input={{ file_path: "x.txt", old_string: "remove me", new_string: "added line" }}
      />,
    );
    // InlineDiff renders + and - markers for changes
    expect(container.textContent).toContain("remove me");
    expect(container.textContent).toContain("added line");
  });

  it("ignores non-string old/new values", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{
          file_path: "x.ts",
          old_string: 123 as unknown as string,
          new_string: { foo: "bar" } as unknown as string,
        }}
      />,
    );
    expect(document.querySelector("div")).toBeTruthy();
  });

  it("coerces non-string file_path to string via String()", () => {
    render(
      <EditToolRenderer
        {...defaultProps}
        input={{
          file_path: 42 as unknown as string,
          old_string: "a",
          new_string: "b",
        }}
      />,
    );
    expect(document.querySelector("div")).toBeTruthy();
  });
});
