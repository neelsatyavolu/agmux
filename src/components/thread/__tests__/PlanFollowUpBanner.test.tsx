/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanFollowUpBanner } from "../PlanFollowUpBanner";

afterEach(() => cleanup());

describe("PlanFollowUpBanner", () => {
  it("renders title and three action buttons", () => {
    render(
      <PlanFollowUpBanner
        onImplement={() => {}}
        onRevise={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Plan proposed")).toBeTruthy();
    expect(screen.getByText("Implement")).toBeTruthy();
    expect(screen.getByText("Revise")).toBeTruthy();
  });

  it("fires onImplement when Implement clicked", () => {
    const onImplement = vi.fn();
    render(
      <PlanFollowUpBanner
        onImplement={onImplement}
        onRevise={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Implement"));
    expect(onImplement).toHaveBeenCalledTimes(1);
  });

  it("fires onRevise when Revise clicked", () => {
    const onRevise = vi.fn();
    render(
      <PlanFollowUpBanner
        onImplement={() => {}}
        onRevise={onRevise}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Revise"));
    expect(onRevise).toHaveBeenCalledTimes(1);
  });

  it("fires onDismiss when X clicked", () => {
    const onDismiss = vi.fn();
    render(
      <PlanFollowUpBanner
        onImplement={() => {}}
        onRevise={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTitle("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not fire other handlers when only one button is clicked", () => {
    const onImplement = vi.fn();
    const onRevise = vi.fn();
    const onDismiss = vi.fn();
    render(
      <PlanFollowUpBanner
        onImplement={onImplement}
        onRevise={onRevise}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Implement"));
    expect(onImplement).toHaveBeenCalledTimes(1);
    expect(onRevise).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Dismiss button has accessible title attribute", () => {
    render(
      <PlanFollowUpBanner
        onImplement={() => {}}
        onRevise={() => {}}
        onDismiss={() => {}}
      />,
    );
    const btn = screen.getByTitle("Dismiss");
    expect(btn.tagName).toBe("BUTTON");
  });

  it("each handler can be invoked multiple times across clicks", () => {
    const onImplement = vi.fn();
    render(
      <PlanFollowUpBanner
        onImplement={onImplement}
        onRevise={() => {}}
        onDismiss={() => {}}
      />,
    );
    const btn = screen.getByText("Implement");
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onImplement).toHaveBeenCalledTimes(3);
  });
});
