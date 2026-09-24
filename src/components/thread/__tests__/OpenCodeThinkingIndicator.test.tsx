/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { OpenCodeThinkingIndicator, formatElapsed } from "../OpenCodeThinkingIndicator";
import { _resetAppVisibilityForTests } from "../../../lib/appVisibility";
import { SessionPresentationContext } from "../../../hooks/useIsSessionActive";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  _resetAppVisibilityForTests();
});

const ELAPSED_RE = /^\d+ms$|^\d+\.\d+s$|^\d+m \d+s$|^\d+h \d+m \d+s$/;

describe("formatElapsed", () => {
  const t0 = 1_000_000;

  it("formats sub-second as ms", () => {
    expect(formatElapsed(t0, t0 + 250)).toBe("250ms");
  });

  it("formats under a minute with one decimal", () => {
    expect(formatElapsed(t0, t0 + 5_200)).toBe("5.2s");
  });

  it("formats minutes and seconds under an hour", () => {
    expect(formatElapsed(t0, t0 + 65_000)).toBe("1m 5s");
    expect(formatElapsed(t0, t0 + 45 * 60_000 + 12_000)).toBe("45m 12s");
    expect(formatElapsed(t0, t0 + 59 * 60_000 + 59_000)).toBe("59m 59s");
  });

  it("formats hours, minutes, and seconds at an hour and above", () => {
    // 3h 19m 22s = 3*3600 + 19*60 + 22 = 11962s
    expect(formatElapsed(t0, t0 + 11_962_000)).toBe("3h 19m 22s");
    // Screenshot case: 199m 27s → 3h 19m 27s
    expect(formatElapsed(t0, t0 + 199 * 60_000 + 27_000)).toBe("3h 19m 27s");
    expect(formatElapsed(t0, t0 + 3_600_000)).toBe("1h 0m 0s");
    expect(formatElapsed(t0, t0 + 3_661_000)).toBe("1h 1m 1s");
  });
});

describe("OpenCodeThinkingIndicator", () => {
  it("renders default 'thinking' phase", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} />);
    expect(screen.getByText("thinking")).toBeTruthy();
  });

  it("renders custom phase label", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} phase="planning" />);
    expect(screen.getByText("planning")).toBeTruthy();
  });

  it("renders an elapsed time label", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} />);
    // The component formats < 1s as "Xms" — at least one elapsed-style label exists
    const ms = screen.getByText(ELAPSED_RE);
    expect(ms).toBeTruthy();
  });

  it("reserves width for elapsed time so the indicator row stays stable", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} />);
    const elapsed = screen.getByText(ELAPSED_RE);
    expect(elapsed.style.minWidth).toBe("10ch");
    // Left-align keeps short times flush after the mid-dot; minWidth still
    // absorbs growth so trailing meta doesn't shift.
    expect(elapsed.style.textAlign).toBe("left");
  });

  it("renders trailing node when provided", () => {
    render(
      <OpenCodeThinkingIndicator
        startMs={Date.now()}
        trailing={<span>tokens</span>}
      />,
    );
    expect(screen.getByText("tokens")).toBeTruthy();
  });

  it("formats elapsed as Xms when under 1 second", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now() - 250} />);
    expect(screen.getByText(/^\d+ms$/)).toBeTruthy();
  });

  it("formats elapsed as X.Ys when between 1 and 60 seconds", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now() - 5_000} />);
    expect(screen.getByText(/^\d+\.\d+s$/)).toBeTruthy();
  });

  it("formats elapsed as 'Xm Ys' when over 60 seconds", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now() - 65_000} />);
    expect(screen.getByText(/^\d+m \d+s$/)).toBeTruthy();
  });

  it("formats elapsed as 'Xh Ym Zs' when over an hour", () => {
    // 199m 27s = 3h 19m 27s
    render(<OpenCodeThinkingIndicator startMs={Date.now() - (199 * 60_000 + 27_000)} />);
    expect(screen.getByText("3h 19m 27s")).toBeTruthy();
  });

  it("renders a Braille spinner glyph", () => {
    const { container } = render(
      <OpenCodeThinkingIndicator startMs={Date.now()} />,
    );
    const text = container.textContent ?? "";
    // First glyph is "⠋" (frame 0)
    expect(/[⠀-⣿]/.test(text)).toBe(true);
  });

  it("aligns the spinner glyph with the phase label (same size, flex-centered)", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} />);
    const spinner = screen.getByTestId("thinking-spinner");
    expect(spinner.style.fontSize).toBe("12px");
    expect(spinner.style.display).toBe("inline-flex");
    expect(spinner.style.alignItems).toBe("center");
    expect(spinner.style.height).toBe("16px");
  });

  it("does not render trailing node when not provided", () => {
    render(<OpenCodeThinkingIndicator startMs={Date.now()} />);
    expect(screen.queryByText("tokens")).toBeNull();
  });

  it("renders trailing as ReactNode (component children)", () => {
    render(
      <OpenCodeThinkingIndicator
        startMs={Date.now()}
        trailing={<div data-testid="trail-test">A · B</div>}
      />,
    );
    expect(screen.getByTestId("trail-test")).toBeTruthy();
  });
});

describe("OpenCodeThinkingIndicator background gating", () => {
  const glyph = () => screen.getByTestId("thinking-spinner").textContent;

  it("stops ticking while the window is unfocused and catches elapsed up on return", () => {
    vi.useFakeTimers();
    const start = Date.now();
    render(<OpenCodeThinkingIndicator startMs={start} />);

    const first = glyph();
    act(() => { vi.advanceTimersByTime(90); });
    expect(glyph()).not.toBe(first);

    act(() => { window.dispatchEvent(new Event("blur")); });
    const paused = glyph();
    const pausedElapsed = screen.getByText(ELAPSED_RE).textContent;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(glyph()).toBe(paused);
    expect(screen.getByText(ELAPSED_RE).textContent).toBe(pausedElapsed);

    act(() => { window.dispatchEvent(new Event("focus")); });
    // Elapsed derives from startMs, so it jumps straight to wall-clock time.
    expect(screen.getByText(ELAPSED_RE).textContent).toBe(formatElapsed(start, Date.now()));
    act(() => { vi.advanceTimersByTime(90); });
    expect(glyph()).not.toBe(paused);
  });

  it("does not tick when the session presentation context says it is hidden", () => {
    vi.useFakeTimers();
    render(
      <SessionPresentationContext.Provider value={{ id: "t1", active: false }}>
        <OpenCodeThinkingIndicator startMs={Date.now()} />
      </SessionPresentationContext.Provider>,
    );
    const first = glyph();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(glyph()).toBe(first);
  });
});
