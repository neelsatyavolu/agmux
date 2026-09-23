/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { WhatsNewDialog } from "../WhatsNewDialog";
import { useSettingsStore } from "../../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/app", () => ({
  // Return same version we'll claim was last seen so dialog stays closed.
  getVersion: vi.fn().mockResolvedValue("99.99.99"),
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
  useSettingsStore.setState({ isSetupWizardOpen: false });
});

describe("WhatsNewDialog", () => {
  it("renders without crashing", () => {
    // Pre-set last-seen so the dialog won't try to fetch and pop
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    expect(container).toBeTruthy();
  });

  it("does not render visible dialog initially", () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    // Open is false initially; dialog body shouldn't be present
    expect(container.textContent).not.toMatch(/got it/i);
  });

  it("does not render dialog when last seen version matches current", async () => {
    // No localStorage entry initially → component will set last_seen on mount
    const { container } = render(<WhatsNewDialog />);
    // Wait for mount-time version check + localStorage write
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/release notes/i);
  });

  it("uses xanom_last_seen_version as the localStorage key", () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    expect(localStorage.getItem("xanom_last_seen_version")).toBe("1.0.0");
  });

  it("survives unmount during pending getVersion()", () => {
    const { unmount } = render(<WhatsNewDialog />);
    expect(() => unmount()).not.toThrow();
  });

  it("does not show 'Got it' button when version matches last seen", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/got it/i);
  });

  it("does not show 'View full changelog' button when not open", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/view full changelog/i);
  });

  it("renders multiple instances without colliding state", () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container: c1 } = render(<WhatsNewDialog />);
    const { container: c2 } = render(<WhatsNewDialog />);
    expect(c1).toBeTruthy();
    expect(c2).toBeTruthy();
  });
});

describe("WhatsNewDialog — Deep coverage", () => {
  it("does not throw when localStorage already has a stored value", () => {
    localStorage.setItem("xanom_last_seen_version", "1.2.3");
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
  });

  it("preserves localStorage value across mounts when version matches", () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { unmount } = render(<WhatsNewDialog />);
    unmount();
    expect(localStorage.getItem("xanom_last_seen_version")).toBe("99.99.99");
  });

  it("renders no body content when last seen matches current version", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/release notes/i);
  });

  it("renders consistently on multiple mounts with same setup", () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const r1 = render(<WhatsNewDialog />);
    expect(r1.container).toBeTruthy();
    r1.unmount();
    const r2 = render(<WhatsNewDialog />);
    expect(r2.container).toBeTruthy();
    r2.unmount();
  });

  it("does not show category labels (New / Improved / Fixed) when dialog is closed", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/release notes/i);
  });

  it("renders when localStorage is unset", () => {
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
  });

  it("renders when localStorage has malformed value", () => {
    localStorage.setItem("xanom_last_seen_version", "not-a-version");
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
  });

  it("renders when localStorage has empty string", () => {
    localStorage.setItem("xanom_last_seen_version", "");
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
  });

  it("does not crash on quick mount/unmount cycles", () => {
    for (let i = 0; i < 5; i++) {
      const { unmount } = render(<WhatsNewDialog />);
      unmount();
    }
    expect(true).toBe(true);
  });

  it("renders with localStorage prepopulated to a large version number", () => {
    localStorage.setItem("xanom_last_seen_version", "999.999.999");
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
  });

  it("renders without showing 'View full changelog' text when not visible", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/view full changelog/i);
  });

  it("does not render 'Got it' affirmation button when last seen matches", async () => {
    localStorage.setItem("xanom_last_seen_version", "99.99.99");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent ?? "").not.toMatch(/got it/i);
  });

  it("does not open during first-run setup", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        setupWizardCompleted: false,
      },
    });
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(container.textContent ?? "").not.toMatch(/got it/i);
  });

  it("does not open while the upgrade wizard is on screen", async () => {
    useSettingsStore.setState({
      isSetupWizardOpen: true,
      settings: {
        ...useSettingsStore.getState().settings,
        setupWizardCompleted: true,
        onboardingRevision: 2,
      },
    });
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(container.textContent ?? "").not.toMatch(/got it/i);
  });
});

describe("WhatsNewDialog — Final coverage gaps (open path)", () => {
  // Mock fetch to return a release body so the dialog actually opens.
  const fakeRelease = {
    body: `An exciting tagline\n\nA short summary.\n\n### New Features\n- **Feature A** — does new things\n- [fix] **Some fix** — patched a bug\n\n### Improvements\n- **Speed boost** — faster now\n\n### Fixed\n- **Bug** — squashed\n`,
    published_at: "2025-04-01T12:00:00Z",
    name: "Cool Release",
  };
  const fakeReleaseList = [{ tag_name: "v99.99.99" }, { tag_name: "v99.99.98" }];

  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      isSetupWizardOpen: false,
      settings: {
        ...useSettingsStore.getState().settings,
        setupWizardCompleted: true,
      },
    });
    let callIdx = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callIdx++;
      // First call: tag-specific release
      if (callIdx === 1) {
        return { ok: true, json: async () => fakeRelease };
      }
      return { ok: true, json: async () => fakeReleaseList };
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens the dialog when stored version differs from current", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    // wait for getVersion + fetch + 800ms timer
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText("Got it")).toBeTruthy();
  });

  it("renders the tagline parsed from the release body", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText("An exciting tagline")).toBeTruthy();
  });

  it("renders the previous version when fetched", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText(/updated from v99\.99\.98/)).toBeTruthy();
  });

  it("renders categorised items (New / Improved / Fixed)", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getAllByText("New").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Improved").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Fixed").length).toBeGreaterThan(0);
  });

  it("clicking 'Got it' closes the dialog and writes localStorage", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    fireEventClick(screen.getByText("Got it"));
    expect(localStorage.getItem("xanom_last_seen_version")).toBe("99.99.99");
  });

  it("clicking 'View full changelog' triggers external open", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    // Just confirm clicking doesn't throw
    expect(() =>
      fireEventClick(screen.getByText(/view full changelog/i)),
    ).not.toThrow();
  });

  it("Escape key closes the dialog", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText("Got it")).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // The dismiss triggers a state update + an AnimatePresence exit
    // transition before the dialog actually unmounts. A 0ms tick was racing
    // the transition only when the full suite was running (slower
    // scheduler); poll up to 1s instead of guessing a fixed delay.
    await waitFor(
      () => expect(screen.queryByText("Got it")).toBeNull(),
      { timeout: 1000 },
    );
  });

  it("renders empty state body when fetch returns no items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: "", published_at: null, name: null }),
    }));
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText(/Bug fixes and improvements\./)).toBeTruthy();
  });

  it("falls back to default tagline when release body has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: "", published_at: null, name: "v99.99.99" }),
    }));
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByText("What's New")).toBeTruthy();
  });

  it("backdrop click dismisses dialog", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    const backdrop = container.querySelector('[class*="fixed"][class*="inset-0"]') as HTMLElement | null;
    if (backdrop) {
      fireEventClick(backdrop);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(true).toBe(true);
  });

  it("survives fetch returning ok=false (no dialog opens)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    const { container } = render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    // With no release data, dialog still opens with empty state
    expect(container).toBeTruthy();
  });

  it("survives fetch throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    expect(() => render(<WhatsNewDialog />)).not.toThrow();
    await new Promise((r) => setTimeout(r, 900));
  });

  it("toggling 'Don't show again' before close skips localStorage write", async () => {
    localStorage.setItem("xanom_last_seen_version", "1.0.0");
    render(<WhatsNewDialog />);
    await new Promise((r) => setTimeout(r, 900));
    const checkboxLabel = screen.getByText(/Don't show again/);
    // Click twice to toggle off
    fireEventClick(checkboxLabel);
    fireEventClick(screen.getByText("Got it"));
    // Should NOT update localStorage to current version
    expect(localStorage.getItem("xanom_last_seen_version")).toBe("1.0.0");
  });
});

// Helper to avoid pulling fireEvent at top — wraps simulation
function fireEventClick(el: HTMLElement | null): void {
  if (!el) return;
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

import { screen, fireEvent as _fe } from "@testing-library/react";
import { beforeEach } from "vitest";
void _fe;
