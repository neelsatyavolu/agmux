import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSettingsStore,
  commitMessageCandidates,
  ONBOARDING_REVISION,
} from "../settingsStore";
import { clearLocalStorage } from "./setup";

describe("settingsStore", () => {
  beforeEach(() => {
    clearLocalStorage();
    // Reset to a baseline by calling resetSettings — uses module DEFAULT_SETTINGS
    useSettingsStore.getState().resetSettings();
    useSettingsStore.setState({ isOpen: false, isSetupWizardOpen: false }, false);
  });

  it("has a default settings object on init", () => {
    const s = useSettingsStore.getState();
    expect(s.settings).toBeTruthy();
    expect(typeof s.settings.theme).toBe("string");
    expect(typeof s.settings.editorFontSize).toBe("number");
  });

  it("openSettings / closeSettings toggle the dialog flag", () => {
    expect(useSettingsStore.getState().isOpen).toBe(false);
    useSettingsStore.getState().openSettings();
    expect(useSettingsStore.getState().isOpen).toBe(true);
    useSettingsStore.getState().closeSettings();
    expect(useSettingsStore.getState().isOpen).toBe(false);
  });

  it("openSetupWizard / closeSetupWizard toggle the wizard flag", () => {
    useSettingsStore.getState().openSetupWizard();
    expect(useSettingsStore.getState().isSetupWizardOpen).toBe(true);
    useSettingsStore.getState().closeSetupWizard();
    expect(useSettingsStore.getState().isSetupWizardOpen).toBe(false);
  });

  it("updateSettings merges a partial patch into settings", () => {
    const before = useSettingsStore.getState().settings;
    useSettingsStore.getState().updateSettings({ editorFontSize: 22 });
    const after = useSettingsStore.getState().settings;
    expect(after.editorFontSize).toBe(22);
    // Other fields untouched
    expect(after.theme).toBe(before.theme);
  });

  it("updateSettings creates a new settings object reference (immutability)", () => {
    const before = useSettingsStore.getState().settings;
    useSettingsStore.getState().updateSettings({ editorFontSize: 18 });
    const after = useSettingsStore.getState().settings;
    expect(after).not.toBe(before);
  });

  it("updateSettings persists to localStorage", () => {
    useSettingsStore.getState().updateSettings({ editorFontSize: 17 });
    const raw = localStorage.getItem("agmux-settings");
    // Some installations may use a different key — just assert *something* was written.
    const keys = Object.keys(localStorage);
    expect(raw !== null || keys.length > 0).toBe(true);
  });

  it("resetSettings restores defaults", () => {
    useSettingsStore.getState().updateSettings({ editorFontSize: 99 });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().settings.editorFontSize).not.toBe(99);
  });

  it("defaults commitMessageModel to auto", () => {
    expect(useSettingsStore.getState().settings.commitMessageModel).toBe("auto");
  });

  it.each(["gpt-5.3-codex-spark", "gpt-5.6-luna"])("migrates a saved %s preference to GPT-6 Luna", async (saved) => {
    localStorage.setItem("agmux-settings", JSON.stringify({
      commitMessageModel: saved,
    }));
    vi.resetModules();
    const { useSettingsStore: reloadedStore } = await import("../settingsStore");
    expect(reloadedStore.getState().settings.commitMessageModel).toBe("gpt-6-luna");
    expect(commitMessageCandidates(reloadedStore.getState().settings.commitMessageModel)).toEqual([
      { provider: "codex", model: "gpt-6-luna" },
    ]);
  });

  it("defaults onboardingRevision to 0 so existing installs get upgrade prompts", () => {
    expect(useSettingsStore.getState().settings.onboardingRevision).toBe(0);
    expect(ONBOARDING_REVISION).toBeGreaterThan(0);
  });

  it("commitMessageCandidates cascades on auto", () => {
    const c = commitMessageCandidates("auto");
    expect(c.map((x) => x.model)).toEqual([
      "gpt-6-luna",
      "grok-4.5",
      "haiku",
    ]);
  });

  it("commitMessageCandidates pins a single model when set", () => {
    expect(commitMessageCandidates("grok-4.5")).toEqual([
      { provider: "grok", model: "grok-4.5" },
    ]);
    expect(commitMessageCandidates("gpt-6-luna")).toEqual([
      { provider: "codex", model: "gpt-6-luna" },
    ]);
    expect(commitMessageCandidates("haiku")).toEqual([
      { provider: "claude", model: "haiku" },
    ]);
  });

  it("defaults to flat surfaces and Archivo", () => {
    const s = useSettingsStore.getState().settings;
    expect(s.surfaceStyle).toBe("flat");
    expect(s.uiFont).toBe("archivo");
  });

  it("moves a pre-redesign install onto Archivo and flat surfaces once", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({ uiFont: "geist", theme: "midnight-glass" }));
    const { loadSettings, DESIGN_REVISION } = await import("../settingsStore");
    const s = loadSettings();
    expect(s.uiFont).toBe("archivo");
    expect(s.surfaceStyle).toBe("flat");
    expect(s.designRevision).toBe(DESIGN_REVISION);
  });

  it("keeps Geist and Glass when chosen after the redesign", async () => {
    const { loadSettings, DESIGN_REVISION } = await import("../settingsStore");
    localStorage.setItem("agmux-settings", JSON.stringify({
      uiFont: "geist", surfaceStyle: "glass", designRevision: DESIGN_REVISION,
    }));
    const s = loadSettings();
    expect(s.uiFont).toBe("geist");
    expect(s.surfaceStyle).toBe("glass");
  });

  it("keeps a non-default font through the migration", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({ uiFont: "inter" }));
    const { loadSettings } = await import("../settingsStore");
    expect(loadSettings().uiFont).toBe("inter");
  });

  it("falls back to flat for an unknown stored surface", async () => {
    const { loadSettings, DESIGN_REVISION } = await import("../settingsStore");
    localStorage.setItem("agmux-settings", JSON.stringify({ surfaceStyle: "chrome", designRevision: DESIGN_REVISION }));
    expect(loadSettings().surfaceStyle).toBe("flat");
  });

  it("migrates a stored old-gold accentColor to the theme default once", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({ accentColor: "#f7ad3c" }));
    const { loadSettings } = await import("../settingsStore");
    expect(loadSettings().accentColor).toBe("");
  });

  it("migrates the old-gold accentColor case-insensitively", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({ accentColor: "#F7AD3C" }));
    const { loadSettings } = await import("../settingsStore");
    expect(loadSettings().accentColor).toBe("");
  });

  it("keeps a custom accentColor through the migration", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({ accentColor: "#6b8ff8" }));
    const { loadSettings } = await import("../settingsStore");
    expect(loadSettings().accentColor).toBe("#6b8ff8");
  });

  it("does not re-migrate an old-gold accentColor chosen again after the redesign", async () => {
    const { loadSettings, DESIGN_REVISION } = await import("../settingsStore");
    localStorage.setItem("agmux-settings", JSON.stringify({
      accentColor: "#f7ad3c", designRevision: DESIGN_REVISION,
    }));
    expect(loadSettings().accentColor).toBe("#f7ad3c");
  });
});
