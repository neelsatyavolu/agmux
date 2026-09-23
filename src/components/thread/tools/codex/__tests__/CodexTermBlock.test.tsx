/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CodexTermBlock } from "../CodexTermBlock";

afterEach(() => cleanup());

describe("CodexTermBlock", () => {
  it("renders the command in the header", () => {
    render(<CodexTermBlock command="pnpm dev" output="ready" />);
    expect(screen.getByText(/pnpm dev/)).toBeTruthy();
  });

  it("renders the cwd alongside the command when supplied", () => {
    render(<CodexTermBlock command="pnpm dev" cwd="apps/web" output="ready" />);
    expect(screen.getByText(/apps\/web/)).toBeTruthy();
  });

  it("renders the output body", () => {
    render(<CodexTermBlock command="ls" output="a.ts\nb.ts" />);
    expect(screen.getByText(/a\.ts/)).toBeTruthy();
  });

  it("marks a non-zero exit code as an error", () => {
    render(<CodexTermBlock command="pnpm build" output="boom" exitCode={1} />);
    const el = screen.getByTestId("codex-term");
    expect(el.getAttribute("data-status")).toBe("error");
    expect(screen.getByText(/exit 1/)).toBeTruthy();
  });

  it("does not render an exit badge for a zero exit code", () => {
    render(<CodexTermBlock command="ls" output="ok" exitCode={0} />);
    expect(screen.getByTestId("codex-term").getAttribute("data-status")).toBe("ok");
    expect(screen.queryByText(/exit 0/)).toBeNull();
  });

  it("renders a placeholder when there is no output", () => {
    render(<CodexTermBlock command="true" output="" exitCode={0} />);
    expect(screen.getByText(/no output/i)).toBeTruthy();
  });
});


describe("progressive terminal text", () => {
  it("reveals the entire command in 64k steps with updated omitted counts", () => {
    const command = "a".repeat(128000) + "COMMAND_END";
    const view = render(<CodexTermBlock command={command} output="ready" />);
    expect(view.container.textContent).not.toContain("COMMAND_END");
    expect(screen.getByText("64011 more characters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more command" }));
    expect(screen.queryByText("64011 more characters")).toBeNull();
    expect(screen.getByText("11 more characters")).toBeTruthy();
    expect(view.container.textContent).not.toContain("COMMAND_END");
    fireEvent.click(screen.getByRole("button", { name: "Show more command" }));
    expect(view.container.textContent).toContain("COMMAND_END");
    expect(screen.queryByRole("button", { name: "Show more command" })).toBeNull();
    expect(screen.getByTestId("codex-term").getAttribute("data-status")).toBe("idle");
  });

  it.each([[undefined, "idle"], [0, "ok"], [1, "error"]] as const)("reveals output without changing exit %s status", (exitCode, status) => {
    const output = "o".repeat(64000) + "OUTPUT_END";
    const view = render(<CodexTermBlock command="cat log" output={output} exitCode={exitCode} />);
    expect(view.container.textContent).not.toContain("OUTPUT_END");
    expect(screen.getByText("10 more characters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more output" }));
    expect(view.container.textContent).toContain("OUTPUT_END");
    expect(screen.queryByRole("button", { name: "Show more output" })).toBeNull();
    expect(screen.getByTestId("codex-term").getAttribute("data-status")).toBe(status);
  });
});
