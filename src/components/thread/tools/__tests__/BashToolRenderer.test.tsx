/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BashToolRenderer } from "../BashToolRenderer";

afterEach(() => cleanup());

function renderBash(overrides: Partial<Parameters<typeof BashToolRenderer>[0]> = {}) {
  return render(
    <BashToolRenderer
      input={{ command: "ls -la" }}
      result={null}
      isError={false}
      isPending={false}
      {...overrides}
    />,
  );
}

describe("BashToolRenderer", () => {
  it("renders the command with a $ prefix", () => {
    renderBash({ input: { command: "npm test" } });
    expect(screen.getByText("npm test")).toBeTruthy();
    // $ separator is its own span
    expect(screen.getByText(/\$/)).toBeTruthy();
  });

  it("shows description text above the command when provided", () => {
    renderBash({
      input: { command: "rm tmp", description: "clean up temp files" },
    });
    expect(screen.getByText("clean up temp files")).toBeTruthy();
  });

  it("shows 'Running...' while pending", () => {
    renderBash({ isPending: true });
    expect(screen.getByText(/Running/)).toBeTruthy();
  });

  it("labels the output panel 'output' for plain text", () => {
    renderBash({ result: "hello\nworld" });
    expect(screen.getByText("output")).toBeTruthy();
    expect(screen.getByText("2 lines")).toBeTruthy();
  });

  it("labels the panel 'error' on error results", () => {
    renderBash({ result: "ENOENT", isError: true });
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("labels the panel 'json' for JSON output and formats it", () => {
    renderBash({ result: '{"hello":"world","nested":{"a":1}}' });
    expect(screen.getByText("json")).toBeTruthy();
  });

  it("does not label output 'json' when output is not JSON", () => {
    renderBash({ result: "just plain text" });
    expect(screen.queryByText("json")).toBeNull();
    expect(screen.getByText("output")).toBeTruthy();
  });

  it("singularizes 'line' when there is exactly one line", () => {
    renderBash({ result: "one line" });
    expect(screen.getByText("1 line")).toBeTruthy();
  });

  it("shows 'Show all' toggle only when output exceeds threshold", () => {
    const short = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    renderBash({ result: short });
    expect(screen.queryByText(/Show all/)).toBeNull();

    cleanup();

    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    renderBash({ result: long });
    expect(screen.getByText("Show all (30 lines)")).toBeTruthy();
  });

  it("toggles between 'Show all' and 'Show less' when clicked", () => {
    const long = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
    renderBash({ result: long });
    const toggle = screen.getByText("Show all (25 lines)");
    fireEvent.click(toggle);
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("copies output to clipboard when copy button clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderBash({ result: "something to copy" });
    const copyBtn = screen.getByTitle("Copy output");
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith("something to copy");
  });

  it("does not render output panel when result is null", () => {
    renderBash({ result: null });
    expect(screen.queryByText("output")).toBeNull();
    expect(screen.queryByText("error")).toBeNull();
  });

  it("treats non-string commands as empty string", () => {
    // A malformed input shouldn't crash the renderer.
    renderBash({ input: { command: 42 as unknown as string } });
    // $ prefix still renders
    expect(screen.getByText(/\$/)).toBeTruthy();
  });
});
