/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

import {
  AgtermNoticeDialog,
  AGTERM_NOTICE_KEY,
  AGTERM_URL,
  READ_SECONDS,
} from "../AgtermNoticeDialog";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  openUrl.mockClear();
});

describe("AgtermNoticeDialog", () => {
  it("shows until acknowledged", () => {
    render(<AgtermNoticeDialog />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/agterm/i, { selector: "h2" })).toBeTruthy();
  });

  it("stays hidden once acknowledged", () => {
    localStorage.setItem(AGTERM_NOTICE_KEY, "1");
    render(<AgtermNoticeDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cannot be dismissed before the read timer ends, or with Escape", () => {
    render(<AgtermNoticeDialog />);
    const ack = screen.getByRole("button", { name: /understand/i }) as HTMLButtonElement;
    expect(ack.disabled).toBe(true);
    fireEvent.click(ack);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(localStorage.getItem(AGTERM_NOTICE_KEY)).toBeNull();
  });

  it("dismisses and remembers after the read timer", () => {
    render(<AgtermNoticeDialog />);
    // One tick per second: each tick re-renders and arms the next timer.
    for (let i = 0; i < READ_SECONDS; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    const ack = screen.getByRole("button", { name: /understand/i }) as HTMLButtonElement;
    expect(ack.disabled).toBe(false);
    fireEvent.click(ack);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(localStorage.getItem(AGTERM_NOTICE_KEY)).toBe("1");
  });

  it("opens the agterm site without dismissing", async () => {
    render(<AgtermNoticeDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /get agterm/i }));
    });
    expect(openUrl).toHaveBeenCalledWith(AGTERM_URL);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});
