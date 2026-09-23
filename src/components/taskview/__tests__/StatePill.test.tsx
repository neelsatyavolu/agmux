/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatePill, DiffStat } from "../StatePill";

afterEach(() => cleanup());

describe("StatePill", () => {
  it("renders Queued label for queued state", () => {
    render(<StatePill state="queued" />);
    expect(screen.getByText("Queued")).toBeTruthy();
  });

  it("renders Running label for running state", () => {
    render(<StatePill state="running" />);
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("renders In review label for review state", () => {
    render(<StatePill state="review" />);
    expect(screen.getByText("In review")).toBeTruthy();
  });

  it("renders Merged label for merged state", () => {
    render(<StatePill state="merged" />);
    expect(screen.getByText("Merged")).toBeTruthy();
  });

  it("renders Failed label for failed state", () => {
    render(<StatePill state="failed" />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("renders Needs attention label for attention state", () => {
    render(<StatePill state="attention" />);
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("renders small variant without crashing", () => {
    render(<StatePill state="queued" small />);
    expect(screen.getByText("Queued")).toBeTruthy();
  });
});

describe("DiffStat", () => {
  it("renders additions and deletions", () => {
    render(<DiffStat additions={12} deletions={5} />);
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("−5")).toBeTruthy();
  });

  it("renders zero values", () => {
    render(<DiffStat additions={0} deletions={0} />);
    expect(screen.getByText("+0")).toBeTruthy();
    expect(screen.getByText("−0")).toBeTruthy();
  });
});
