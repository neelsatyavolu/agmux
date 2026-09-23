/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NotificationHistoryPanel } from "../NotificationHistoryPanel";
import { useUiStore } from "../../stores/uiStore";
import { useNotificationHistoryStore } from "../../stores/notificationHistoryStore";

const navigateToSession = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/navigateToSession", () => ({
  navigateToSession: (opts: unknown) => navigateToSession(opts),
}));

beforeEach(() => {
  useUiStore.setState({ showNotificationHistory: false });
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
  navigateToSession.mockReset();
});

afterEach(() => cleanup());

describe("NotificationHistoryPanel", () => {
  it("renders nothing when closed", () => {
    render(<NotificationHistoryPanel />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders dialog content when open", () => {
    useUiStore.setState({ showNotificationHistory: true });
    render(<NotificationHistoryPanel />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
  });

  it("renders empty-state copy when there are no entries", () => {
    useUiStore.setState({ showNotificationHistory: true });
    render(<NotificationHistoryPanel />);
    expect(screen.getByText(/no notifications yet/i)).toBeTruthy();
  });

  it("renders entries when present", () => {
    useUiStore.setState({ showNotificationHistory: true });
    useNotificationHistoryStore.setState({
      entries: [
        {
          id: "n1",
          title: "Hello world",
          body: "First message body",
          timestamp: Date.now(),
          read: false,
        },
        {
          id: "n2",
          title: "Second item",
          body: "Body 2",
          timestamp: Date.now() - 60_000,
          read: true,
        },
      ],
      unreadCount: 1,
    });
    render(<NotificationHistoryPanel />);
    expect(screen.getByText("Hello world")).toBeTruthy();
    expect(screen.getByText("Second item")).toBeTruthy();
    expect(screen.getByText("First message body")).toBeTruthy();
  });

  it("close button hides the panel", () => {
    useUiStore.setState({ showNotificationHistory: true });
    render(<NotificationHistoryPanel />);
    const closeBtn = screen.getByLabelText(/close notifications/i);
    fireEvent.click(closeBtn);
    expect(useUiStore.getState().showNotificationHistory).toBe(false);
  });

  it("clear-all button empties history when entries exist", () => {
    useUiStore.setState({ showNotificationHistory: true });
    useNotificationHistoryStore.setState({
      entries: [
        { id: "n1", title: "One", body: "", timestamp: Date.now(), read: false },
      ],
      unreadCount: 1,
    });
    render(<NotificationHistoryPanel />);
    fireEvent.click(screen.getByLabelText(/clear all notifications/i));
    expect(useNotificationHistoryStore.getState().entries.length).toBe(0);
  });

  it("clicking an entry with sessionId opens that thread and closes the panel", () => {
    useUiStore.setState({ showNotificationHistory: true });
    useNotificationHistoryStore.setState({
      entries: [
        {
          id: "n1",
          title: "Agent finished",
          body: "done",
          timestamp: Date.now(),
          read: false,
          sessionId: "thread-abc",
        },
      ],
      unreadCount: 1,
    });
    render(<NotificationHistoryPanel />);
    fireEvent.click(screen.getByText("Agent finished"));
    expect(navigateToSession).toHaveBeenCalledWith({ threadId: "thread-abc" });
    expect(useUiStore.getState().showNotificationHistory).toBe(false);
  });
});
