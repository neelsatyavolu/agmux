/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TaskNotificationBadge } from "../TaskNotificationBadge";

afterEach(() => cleanup());

describe("TaskNotificationBadge", () => {
  it("renders the status label capitalized", () => {
    render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "completed", summary: "" }}
      />,
    );
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders the summary alongside the status", () => {
    render(
      <TaskNotificationBadge
        notification={{
          taskId: "1",
          status: "running",
          summary: "Processing data",
        }}
      />,
    );
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("Processing data")).toBeTruthy();
  });

  it("omits the separator when summary is empty", () => {
    render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "running", summary: "" }}
      />,
    );
    expect(screen.queryByText("·")).toBeNull();
  });

  it("renders different icons by status (smoke check)", () => {
    const { container, rerender } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "failed", summary: "" }}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();

    rerender(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "unknown-status", summary: "" }}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("uses green dot color class for completed status", () => {
    const { container } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "completed", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-green-500")).toBeTruthy();
  });

  it("uses amber dot color class for running status", () => {
    const { container } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "running", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-amber-500")).toBeTruthy();
  });

  it("uses red dot color for both 'failed' and 'error' status", () => {
    const { container, rerender } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "failed", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-red-500")).toBeTruthy();
    rerender(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "error", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-red-500")).toBeTruthy();
  });

  it("falls back to blue dot for unknown statuses", () => {
    const { container } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "weird", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-blue-500")).toBeTruthy();
  });

  it("status comparison is case-insensitive", () => {
    const { container } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "COMPLETED", summary: "" }}
      />,
    );
    expect(container.querySelector(".bg-green-500")).toBeTruthy();
  });

  it("renders separator when summary is non-empty", () => {
    render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "running", summary: "x" }}
      />,
    );
    expect(screen.getByText("·")).toBeTruthy();
  });

  it("running status shows an animate-spin icon", () => {
    const { container } = render(
      <TaskNotificationBadge
        notification={{ taskId: "1", status: "running", summary: "" }}
      />,
    );
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });
});
