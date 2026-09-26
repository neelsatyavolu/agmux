/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const passthrough = (tag: string) => {
    const Comp = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => {
      const Tag = tag as keyof React.JSX.IntrinsicElements;
      const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props as Record<string, unknown>;
      return <Tag {...(rest as object)}>{children}</Tag>;
    };
    return Comp;
  };
  const components = new Map<string, ReturnType<typeof passthrough>>();
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: new Proxy({}, { get: (_t, key: string) => {
      if (!components.has(key)) components.set(key, passthrough(key));
      return components.get(key);
    } }),
  };
});

import { FocusIntroDialog, FOCUS_INTRO_DELAY_MS } from "../FocusIntroDialog";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useLocalModelStore } from "../../../stores/localModelStore";
import { resetAllStores } from "../../../test-helpers/resetStores";

function setSettings(patch: Partial<ReturnType<typeof useSettingsStore.getState>["settings"]>) {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

function renderAndWait() {
  render(<FocusIntroDialog />);
  act(() => {
    vi.advanceTimersByTime(FOCUS_INTRO_DELAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetAllStores();
  setSettings({ focusIntroSeen: false, focusEnabled: false, setupWizardCompleted: true });
  useSettingsStore.setState({ isSetupWizardOpen: false, isWhatsNewPending: false });
  useLocalModelStore.setState({ hasSeenSetupPrompt: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FocusIntroDialog", () => {
  it("offers Focus with a preview of the sidebar group after a short delay", () => {
    render(<FocusIntroDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(FOCUS_INTRO_DELAY_MS);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    const preview = screen.getByTestId("focus-intro-preview");
    expect(preview.querySelector(".pg-h.open .pnm")?.textContent).toBe("Focus");
    const rows = preview.querySelectorAll(".sb-row");
    expect(rows.length).toBeGreaterThan(1);
    expect(preview.querySelector(".pg-h .pcount")?.textContent).toBe(String(rows.length));
    // Rows name their project, like real Focus rows.
    expect(rows[0].querySelector(".sb-mt")?.textContent).toMatch(/^\S+ · /);
  });

  it("turns Focus on and never asks again", () => {
    renderAndWait();
    fireEvent.click(screen.getByText("Turn on Focus"));
    const { settings } = useSettingsStore.getState();
    expect(settings.focusEnabled).toBe(true);
    expect(settings.focusIntroSeen).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("remembers a Not now without turning Focus on", () => {
    renderAndWait();
    fireEvent.click(screen.getByText("Not now"));
    const { settings } = useSettingsStore.getState();
    expect(settings.focusEnabled).toBe(false);
    expect(settings.focusIntroSeen).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats Escape as Not now", () => {
    renderAndWait();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useSettingsStore.getState().settings.focusIntroSeen).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays away once seen or when Focus is already on", () => {
    setSettings({ focusIntroSeen: true });
    renderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    setSettings({ focusIntroSeen: false, focusEnabled: true });
    renderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits for setup, What's New and the local model offer to finish", () => {
    setSettings({ setupWizardCompleted: false });
    renderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    setSettings({ setupWizardCompleted: true });
    useSettingsStore.setState({ isWhatsNewPending: true });
    renderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useSettingsStore.setState({ isWhatsNewPending: false }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    cleanup();

    useLocalModelStore.setState({
      hasSeenSetupPrompt: false,
      status: { model_downloaded: false } as ReturnType<typeof useLocalModelStore.getState>["status"],
    });
    renderAndWait();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
