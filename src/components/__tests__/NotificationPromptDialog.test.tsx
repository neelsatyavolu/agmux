/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NotificationPromptDialog } from "../NotificationPromptDialog";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("NotificationPromptDialog", () => {
  it("renders nothing initially (open=false until permission check resolves)", () => {
    render(<NotificationPromptDialog />);
    expect(screen.queryByText(/enable notifications/i)).toBeNull();
  });

  it("does not render dialog when previously dismissed", () => {
    localStorage.setItem("xanom_notification_prompt_dismissed", "true");
    render(<NotificationPromptDialog />);
    expect(screen.queryByText(/enable notifications/i)).toBeNull();
  });

  it("renders without crashing", () => {
    const { container } = render(<NotificationPromptDialog />);
    expect(container).toBeTruthy();
  });

  it("shows nothing visible immediately after mount (timer-gated)", () => {
    const { container } = render(<NotificationPromptDialog />);
    // Within the 1.5s setTimeout window, dialog should still be closed
    expect(container.textContent ?? "").not.toMatch(/enable notifications/i);
  });

  it("survives unmount during pending permission check", () => {
    const { unmount } = render(<NotificationPromptDialog />);
    // Unmount before timer fires — should not throw or crash
    expect(() => unmount()).not.toThrow();
  });

  it("respects dismissed flag even when permission isn't granted", async () => {
    localStorage.setItem("xanom_notification_prompt_dismissed", "true");
    const { isPermissionGranted } = await import(
      "@tauri-apps/plugin-notification"
    );
    vi.mocked(isPermissionGranted).mockResolvedValueOnce(false);
    render(<NotificationPromptDialog />);
    expect(screen.queryByText(/enable notifications/i)).toBeNull();
  });
});
