/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import {
  ChatTasksPanel,
  CHAT_TASKS_NARROW_THRESHOLD_PX,
} from "../ChatTasksPanel";

afterEach(() => cleanup());

const sampleTodos = [
  { id: "1", content: "Confirm Common App", status: "completed" as const },
  { id: "2", content: "UMN supplements", status: "in_progress" as const },
  { id: "3", content: "Draft checklist", status: "pending" as const },
];

type RoCallback = (entries: Array<{ contentRect: { width: number } }>) => void;

let roCallback: RoCallback | null = null;
let observedEl: Element | null = null;

class StubResizeObserver {
  constructor(cb: RoCallback) {
    roCallback = cb;
  }
  observe(el: Element) {
    observedEl = el;
  }
  disconnect() {
    roCallback = null;
    observedEl = null;
  }
  unobserve() {}
}

function setStageWidth(width: number) {
  if (!observedEl) return;
  vi.spyOn(observedEl, "getBoundingClientRect").mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  act(() => {
    roCallback?.([{ contentRect: { width } }]);
  });
}

beforeEach(() => {
  roCallback = null;
  observedEl = null;
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
});

describe("ChatTasksPanel", () => {
  it("returns nothing when todos are empty", () => {
    const { container } = render(<ChatTasksPanel todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a floating Tasks panel with progress counts", () => {
    render(
      <div style={{ width: 900, position: "relative" }}>
        <ChatTasksPanel todos={sampleTodos} />
      </div>,
    );
    // Wide enough / zero rect → expanded card
    const panel = screen.getByTestId("chat-tasks-panel");
    expect(panel.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Confirm Common App")).toBeTruthy();
    expect(screen.getByText("UMN supplements")).toBeTruthy();
    expect(screen.getByText("Draft checklist")).toBeTruthy();
    // 1 completed of 3
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("collapses to an edge rail and expands again", () => {
    render(
      <div style={{ width: 900, position: "relative" }}>
        <ChatTasksPanel todos={sampleTodos} />
      </div>,
    );
    fireEvent.click(screen.getByLabelText("Collapse tasks"));
    const collapsed = screen.getByTestId("chat-tasks-panel");
    expect(collapsed.getAttribute("data-collapsed")).toBe("true");
    // Edge rail — expand control
    const expandBtn = screen.getByLabelText("Show Tasks");
    expect(expandBtn.tagName).toBe("BUTTON");
    fireEvent.click(expandBtn);
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-collapsed")).toBe(
      "false",
    );
    expect(screen.getByText("UMN supplements")).toBeTruthy();
  });

  it("auto-collapses to the edge rail when the stage is narrow", async () => {
    render(
      <div data-stage style={{ width: 400, position: "relative", height: 500 }}>
        <ChatTasksPanel todos={sampleTodos} />
      </div>,
    );

    // Flush rAF attach + observe
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

    setStageWidth(CHAT_TASKS_NARROW_THRESHOLD_PX - 40);
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-collapsed")).toBe(
      "true",
    );
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-narrow")).toBe(
      "true",
    );
    expect(screen.getByLabelText("Show Tasks")).toBeTruthy();
    // Full task text hidden in rail mode
    expect(screen.queryByText("Confirm Common App")).toBeNull();
  });

  it("stays expanded when user pins open on a narrow stage", async () => {
    render(
      <div style={{ width: 400, position: "relative", height: 500 }}>
        <ChatTasksPanel todos={sampleTodos} />
      </div>,
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    setStageWidth(500);
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-collapsed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByLabelText("Show Tasks"));
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-collapsed")).toBe(
      "false",
    );
    expect(screen.getByText("UMN supplements")).toBeTruthy();

    // Still narrow — pin holds
    setStageWidth(480);
    expect(screen.getByTestId("chat-tasks-panel").getAttribute("data-collapsed")).toBe(
      "false",
    );
  });

  it("notifies onCollapsedChange", async () => {
    const onCollapsedChange = vi.fn();
    render(
      <div style={{ width: 900, position: "relative" }}>
        <ChatTasksPanel todos={sampleTodos} onCollapsedChange={onCollapsedChange} />
      </div>,
    );
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByLabelText("Collapse tasks"));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("does not render an implementation footer", () => {
    render(<ChatTasksPanel todos={sampleTodos} />);
    expect(screen.queryByText(/TaskCreate/i)).toBeNull();
    expect(screen.queryByText(/Updating from/i)).toBeNull();
  });
});
