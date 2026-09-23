/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ReadToolRenderer } from "../ReadToolRenderer";

afterEach(() => cleanup());

function renderRead(overrides: Partial<Parameters<typeof ReadToolRenderer>[0]> = {}) {
  return render(
    <ReadToolRenderer
      input={{ file_path: "/Users/x/repo/src/index.ts" }}
      result={null}
      isError={false}
      isPending={false}
      {...overrides}
    />,
  );
}

describe("ReadToolRenderer", () => {
  it("displays a shortened file path", () => {
    renderRead({ input: { file_path: "/Users/x/repo/src/components/App.tsx" } });
    expect(screen.getByText("src/components/App.tsx")).toBeTruthy();
  });

  it("falls back to 'unknown' when no path provided", () => {
    renderRead({ input: {} });
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("accepts 'path' as an alias for 'file_path'", () => {
    renderRead({ input: { path: "/repo/src/util.ts" } });
    expect(screen.getByText("src/util.ts")).toBeTruthy();
  });

  it("shows 'lines X–Y' pill when offset and limit are both set", () => {
    renderRead({ input: { file_path: "/repo/src/a.ts", offset: 10, limit: 50 } });
    expect(screen.getByText("lines 10–60")).toBeTruthy();
  });

  it("shows 'from line X' pill when only offset is set", () => {
    renderRead({ input: { file_path: "/repo/src/a.ts", offset: 42 } });
    expect(screen.getByText("from line 42")).toBeTruthy();
  });

  it("shows no pill when neither offset nor limit is set", () => {
    renderRead({ input: { file_path: "/repo/src/a.ts" } });
    expect(screen.queryByText(/line/)).toBeNull();
  });

  it("shows 'Reading file...' while pending", () => {
    renderRead({ isPending: true });
    expect(screen.getByText("Reading file...")).toBeTruthy();
  });

  it("renders the result and no toggle when lines are below threshold", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    renderRead({ result: lines });
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("shows 'Show all' toggle when exceeding threshold", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    renderRead({ result: lines });
    expect(screen.getByText("Show all (40 lines)")).toBeTruthy();
  });

  it("toggles to 'Show less' when clicked", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    renderRead({ result: lines });
    fireEvent.click(screen.getByText("Show all (40 lines)"));
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("does not render result panel when result is null", () => {
    const { container } = renderRead({ result: null });
    // No <pre> when result is null
    expect(container.querySelector("pre")).toBeNull();
  });
});
