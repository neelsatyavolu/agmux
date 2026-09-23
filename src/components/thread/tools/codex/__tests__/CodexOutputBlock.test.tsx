/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CodexOutputBlock } from "../CodexOutputBlock";

afterEach(() => cleanup());

describe("CodexOutputBlock", () => {
  it("renders the title and body", () => {
    render(<CodexOutputBlock title="brave/search" body="3 results" />);
    expect(screen.getByText("brave/search")).toBeTruthy();
    expect(screen.getByText("3 results")).toBeTruthy();
  });

  it("marks an errored result", () => {
    render(<CodexOutputBlock title="brave/search" body="boom" isError />);
    expect(screen.getByTestId("codex-output").getAttribute("data-status")).toBe("error");
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("defaults to an ok status", () => {
    render(<CodexOutputBlock title="t" body="b" />);
    expect(screen.getByTestId("codex-output").getAttribute("data-status")).toBe("ok");
  });

  it("renders a placeholder for empty output", () => {
    render(<CodexOutputBlock title="t" body="   " />);
    expect(screen.getByText(/no output/i)).toBeTruthy();
  });
});


it("reveals all generic output while retaining error and media notices", () => {
  const notice = "[input_image output: preview unavailable here; original media retained in transcript]";
  const body = "x".repeat(64000) + notice;
  const view = render(<CodexOutputBlock title="Code execution" body={body} isError />);
  expect(view.container.textContent).not.toContain(notice);
  expect(screen.getByText(`${notice.length} more characters`)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show more output" }));
  expect(view.container.textContent).toContain(notice);
  expect(screen.queryByRole("button", { name: "Show more output" })).toBeNull();
  expect(screen.getByTestId("codex-output").getAttribute("data-status")).toBe("error");
});
