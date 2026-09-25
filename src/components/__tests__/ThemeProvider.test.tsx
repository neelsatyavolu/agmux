/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { ThemeProvider, useResolvedColorMode } from "../ThemeProvider";
import { useSettingsStore } from "../../stores/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  setWindowTheme: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-mode");
  // Clear inline CSS vars so theme switches don't leak across tests.
  for (const prop of [
    "--accent",
    "--accent-foreground",
    "color-scheme",
    "--text-primary",
    "--text-muted",
    "--glass-bg",
    "--glass-sidebar",
  ]) {
    document.documentElement.style.removeProperty(prop);
  }
});

describe("ThemeProvider", () => {
  beforeEach(() => {
    useSettingsStore.getState().updateSettings({
      theme: "midnight-glass",
      colorMode: "dark",
      accentColor: "",
    });
  });

  it("renders children", () => {
    render(
      <ThemeProvider>
        <span>hello-theme</span>
      </ThemeProvider>,
    );
    expect(screen.getByText("hello-theme")).toBeTruthy();
  });

  it("sets data-theme attribute on root", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBeTruthy();
  });

  it("sets data-mode attribute on root", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    const mode = document.documentElement.getAttribute("data-mode");
    expect(mode === "dark" || mode === "light").toBe(true);
  });

  it("applies CSS variable for accent color", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    const accent = document.documentElement.style.getPropertyValue("--accent");
    expect(accent.length).toBeGreaterThan(0);
  });

  it("applies glass surface CSS variables", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    const glassBg = document.documentElement.style.getPropertyValue("--glass-bg");
    expect(glassBg.length).toBeGreaterThan(0);
  });

  it("applies text color CSS variables", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(
      document.documentElement.style.getPropertyValue("--text-primary").length,
    ).toBeGreaterThan(0);
    expect(
      document.documentElement.style.getPropertyValue("--text-secondary").length,
    ).toBeGreaterThan(0);
  });

  it("re-applies vars on rerender (smoke)", () => {
    const { rerender } = render(<ThemeProvider><div>1</div></ThemeProvider>);
    rerender(<ThemeProvider><div>2</div></ThemeProvider>);
    // Should still have data-theme set after re-render
    expect(document.documentElement.getAttribute("data-theme")).toBeTruthy();
  });

  it("renders nested children", () => {
    render(
      <ThemeProvider>
        <div data-testid="outer">
          <span data-testid="inner">nested</span>
        </div>
      </ThemeProvider>,
    );
    expect(screen.getByTestId("outer")).toBeTruthy();
    expect(screen.getByTestId("inner")).toBeTruthy();
  });

  it("keeps midnight brand accent in dark mode", () => {
    useSettingsStore.getState().updateSettings({ theme: "midnight-glass", colorMode: "dark" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#f2a516");
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight-glass");
  });

  it("uses readable zinc text (not accent) for colored themes in dark mode", () => {
    useSettingsStore.getState().updateSettings({ theme: "sunset-ember", colorMode: "dark" });
    render(<ThemeProvider><div /></ThemeProvider>);
    const muted = document.documentElement.style.getPropertyValue("--text-muted");
    const accent = document.documentElement.style.getPropertyValue("--accent");
    // Muted body text must not collapse to the accent (old neon-text bug).
    expect(muted).not.toBe(accent);
    expect(muted).toMatch(/^#/);
  });

  it("darkens bright accents in light mode for contrast", () => {
    useSettingsStore.getState().updateSettings({ theme: "obsidian-gold", colorMode: "light", surfaceStyle: "glass" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-mode")).toBe("light");
    const accent = document.documentElement.style.getPropertyValue("--accent");
    // Dark-mode gold is #eab308; light mode should darken it, not leave pure yellow.
    expect(accent).not.toBe("#eab308");
    expect(document.documentElement.style.getPropertyValue("--text-primary")).toBe("#18181b");
  });
});


describe("theme transitions and light contrast", () => {
  const value = (name: string) => document.documentElement.style.getPropertyValue(name);
  beforeEach(() => {
    useSettingsStore.getState().updateSettings({
      theme: "midnight-glass", colorMode: "light", accentColor: "",
      glassIntensity: 50, borderBrightness: 50, sidebarOpacity: 55,
    });
  });

  it("replaces the startup inline dark color-scheme and restores it on mode changes", () => {
    document.documentElement.style.colorScheme = "dark";
    render(<ThemeProvider><input /><select><option>Option</option></select></ThemeProvider>);
    expect(document.documentElement.style.colorScheme).toBe("light");
    act(() => useSettingsStore.getState().updateSettings({ colorMode: "dark" }));
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("restores theme accent when a custom accent is cleared", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    const base = value("--accent");
    act(() => useSettingsStore.getState().updateSettings({ accentColor: "#123456" }));
    expect(value("--accent")).toBe("#123456");
    act(() => useSettingsStore.getState().updateSettings({ accentColor: "" }));
    expect(value("--accent")).toBe(base);
  });

  it("preserves custom accent and sidebar opacity when glass settings change", () => {
    useSettingsStore.getState().updateSettings({ accentColor: "#123456", sidebarOpacity: 23, surfaceStyle: "glass" });
    render(<ThemeProvider><div /></ThemeProvider>);
    const sidebar = value("--glass-sidebar");
    act(() => useSettingsStore.getState().updateSettings({ glassIntensity: 80, borderBrightness: 80 }));
    expect(value("--accent")).toBe("#123456");
    expect(value("--glass-sidebar")).toBe(sidebar);
  });

  it.each(["midnight-glass", "forest-green", "frosted-indigo", "obsidian-gold", "violet-haze", "sunset-ember", "rose-quartz", "arctic-frost", "neon-noir", "mocha-latte", "slate-steel", "custom"] as const)(
    "%s accent has at least 4.5:1 contrast on light paper", (theme) => {
      useSettingsStore.getState().updateSettings({ theme, customThemeColor: "#ffffff" });
      render(<ThemeProvider><div /></ThemeProvider>);
      const luminance = (rgb: number[]) => rgb.map(c => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      expect(value("--accent-foreground")).toBe("#ffffff");
      const accent = value("--accent").slice(1).match(/../g)!.map(c => parseInt(c, 16));
      expect(1.05 / (luminance(accent) + 0.05)).toBeGreaterThanOrEqual(4.5);
      expect((luminance([235, 235, 235]) + 0.05) / (luminance(accent) + 0.05)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("unified design surfaces", () => {
  const value = (name: string) => document.documentElement.style.getPropertyValue(name);
  beforeEach(() => {
    useSettingsStore.getState().updateSettings({
      theme: "midnight-glass", colorMode: "dark", accentColor: "",
      surfaceStyle: "flat", glassIntensity: 50, borderBrightness: 50, sidebarOpacity: 65,
    });
  });

  it("marks the root with the surface style", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-surface")).toBe("flat");
    act(() => useSettingsStore.getState().updateSettings({ surfaceStyle: "glass" }));
    expect(document.documentElement.getAttribute("data-surface")).toBe("glass");
  });

  it("paints flat dark surfaces with the slate tokens", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--glass-bg")).toBe("#0f1115");
    expect(value("--glass-sidebar")).toBe("#13161b");
    expect(value("--glass-card")).toBe("#1a1e25");
    expect(value("--glass-border")).toBe("#252a33");
    expect(value("--text-primary")).toBe("#eef0f3");
    expect(value("--text-tertiary")).toBe("#98a1af");
  });

  it("paints flat light surfaces with the light slate tokens", () => {
    useSettingsStore.getState().updateSettings({ colorMode: "light" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--glass-bg")).toBe("#f7f8fa");
    expect(value("--glass-sidebar")).toBe("#edf0f3");
    expect(value("--glass-card")).toBe("#ffffff");
    expect(value("--text-primary")).toBe("#171b22");
  });

  it("uses the new brand gold for Midnight", () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--accent")).toBe("#f2a516");
    expect(value("--accent-foreground")).toBe("#000000");
  });

  it("keeps each theme's accent on flat surfaces", () => {
    useSettingsStore.getState().updateSettings({ theme: "forest-green" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--accent")).toBe("#34d399");
    expect(value("--glass-card")).toBe("#1a1e25");
  });

  it("restores the original glass values when Glass is chosen", () => {
    useSettingsStore.getState().updateSettings({ surfaceStyle: "glass" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--glass-card")).toBe("rgba(0, 0, 0, 0.25)");
    expect(value("--glass-sidebar")).toBe("rgba(0, 0, 0, 0.65)");
    expect(value("--text-primary")).toBe("#ffffff");
  });

  it("maps the Archivo font setting", () => {
    useSettingsStore.getState().updateSettings({ uiFont: "archivo" });
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(value("--font-sans").startsWith('"Archivo"')).toBe(true);
  });
});

describe("system color mode", () => {
  // A controllable prefers-color-scheme media query.
  let systemDark = false;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const setSystemDark = (dark: boolean) => {
    systemDark = dark;
    for (const l of listeners) l({ matches: dark } as MediaQueryListEvent);
  };

  beforeEach(() => {
    systemDark = false;
    listeners.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      get matches() { return systemDark; },
      addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    }));
    useSettingsStore.getState().updateSettings({ theme: "midnight-glass", colorMode: "system" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a light Mac as light on the very first render", () => {
    // Terminals create xterm with the first value they see; a dark first
    // frame made them start dark and flip, and Codex kept dark colors.
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useResolvedColorMode());
      return null;
    }
    render(<Probe />);
    expect(seen[0]).toBe(true);
    expect(seen.every((v) => v)).toBe(true);
  });

  it("follows macOS appearance changes in every consumer", () => {
    const seen: Record<string, boolean> = {};
    function Probe({ id }: { id: string }) {
      seen[id] = useResolvedColorMode();
      return null;
    }
    render(<><Probe id="a" /><Probe id="b" /></>);
    act(() => setSystemDark(true));
    expect(seen).toEqual({ a: false, b: false });
    act(() => setSystemDark(false));
    expect(seen).toEqual({ a: true, b: true });
  });

  it("unpins the window when switching to System even if light/dark is unchanged", async () => {
    const { setWindowTheme } = await import("../../lib/commands");
    const mock = vi.mocked(setWindowTheme);
    act(() => useSettingsStore.getState().updateSettings({ colorMode: "light" }));
    render(<ThemeProvider><div /></ThemeProvider>);
    mock.mockClear();
    // Light Mac: resolved mode stays light, but the window must stop being
    // pinned to Light or it never follows macOS again.
    act(() => useSettingsStore.getState().updateSettings({ colorMode: "system" }));
    expect(mock).toHaveBeenCalledWith("system", true);
  });
});
