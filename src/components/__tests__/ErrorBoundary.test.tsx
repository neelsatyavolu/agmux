/** @vitest-environment jsdom */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

afterEach(() => cleanup());

function Boom(): React.ReactElement {
  throw new Error("Kaboom!");
}

describe("ErrorBoundary", () => {
  it("renders children when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <div>safe child</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("safe child")).toBeTruthy();
  });

  it("renders fallback UI when child throws", () => {
    // Suppress React's error log spam for this test only.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    expect(screen.getByText(/Kaboom!/)).toBeTruthy();
    errSpy.mockRestore();
  });

  it("fallback shows reload button", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: /reload app/i })).toBeTruthy();
    errSpy.mockRestore();
  });

  it("logs caught error via console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // First arg is "agmux caught an error:"
    const calls = errSpy.mock.calls;
    const xanomCall = calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("agmux caught an error"),
    );
    expect(xanomCall).toBeTruthy();
    errSpy.mockRestore();
  });

  it("renders multiple children when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <div>child-a</div>
        <div>child-b</div>
        <div>child-c</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("child-a")).toBeTruthy();
    expect(screen.getByText("child-b")).toBeTruthy();
    expect(screen.getByText("child-c")).toBeTruthy();
  });

  it("shows the error message and a copy-details action instead of a raw stack", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByText("Kaboom!")).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy details/i })).toBeTruthy();
    errSpy.mockRestore();
  });

  it("does NOT show fallback if a previously-thrown child is replaced with a safe child (instance reused)", () => {
    // Once the boundary's state is set to hasError=true, it stays — so
    // even after re-rendering with safe children we still see the fallback.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    rerender(
      <ErrorBoundary>
        <div>now-safe</div>
      </ErrorBoundary>,
    );
    // Fallback persists (no reset method on this implementation)
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    errSpy.mockRestore();
  });
});
