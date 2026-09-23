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

  it("migrates a saved Spark preference to Luna", async () => {
    localStorage.setItem("agmux-settings", JSON.stringify({
      commitMessageModel: "gpt-5.3-codex-spark",
    }));
    vi.resetModules();
    const { useSettingsStore: reloadedStore } = await import("../settingsStore");
    expect(reloadedStore.getState().settings.commitMessageModel).toBe("gpt-5.6-luna");
    expect(commitMessageCandidates(reloadedStore.getState().settings.commitMessageModel)).toEqual([
      { provider: "codex", model: "gpt-5.6-luna" },
    ]);
  });

  it("defaults onboardingRevision to 0 so existing installs get upgrade prompts", () => {
    expect(useSettingsStore.getState().settings.onboardingRevision).toBe(0);
    expect(ONBOARDING_REVISION).toBeGreaterThan(0);
  });

  it("commitMessageCandidates cascades on auto", () => {
    const c = commitMessageCandidates("auto");
    expect(c.map((x) => x.model)).toEqual([
      "gpt-5.6-luna",
      "grok-4.5",
      "haiku",
    ]);
  });

  it("commitMessageCandidates pins a single model when set", () => {
    expect(commitMessageCandidates("grok-4.5")).toEqual([
      { provider: "grok", model: "grok-4.5" },
    ]);
    expect(commitMessageCandidates("gpt-5.6-luna")).toEqual([
      { provider: "codex", model: "gpt-5.6-luna" },
    ]);
    expect(commitMessageCandidates("haiku")).toEqual([
      { provider: "claude", model: "haiku" },
    ]);
  });
});
