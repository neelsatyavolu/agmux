import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

// Files fully swept for this task's mono-eyebrow items — no legitimate
// mono+uppercase eyebrow content remains anywhere in these files.
const MONO_SWEPT_FILES = [
  "components/AgentCompleteToast.tsx",
  "components/ApprovalToast.tsx",
  "components/NotificationHistoryPanel.tsx",
  "components/NotificationPromptDialog.tsx",
  "components/UpdateChecker.tsx",
  "components/WhatsNewDialog.tsx",
  "components/sidebar/LocalModelSetupDialog.tsx",
  "components/sidebar/LocalModelUpgradeDialog.tsx",
  "components/ErrorBoundary.tsx",
  "components/StartupGate.tsx",
  "components/settings/RemoteControlSection.tsx",
];

// SettingsDialog.tsx and SetupWizardDialog.tsx are large multi-section files
// where only the specific sites in the task-10 brief were swept; other
// mono-eyebrow badges elsewhere in those files (e.g. the theme-swatch
// "Default" tag) are out of scope for this task.
const DIALOG_20PX_FILES = [
  "components/NotificationPromptDialog.tsx",
  "components/sidebar/LocalModelSetupDialog.tsx",
  "components/sidebar/LocalModelUpgradeDialog.tsx",
  "components/sidebar/SetupWizardDialog.tsx",
];

describe("settings, wizard and system UI sweep", () => {
  it.each(MONO_SWEPT_FILES)("%s has no mono eyebrows", f => {
    expect(src(f)).not.toMatch(MONO_EYEBROW);
  });

  it.each(DIALOG_20PX_FILES)("%s dialog shell is a flat 20px dialog", f => {
    expect(src(f)).toContain("rounded-[20px]");
  });

  it("UpdateChecker drops the hardcoded accent-foreground hex and uses blue/gold flat helpers", () => {
    const s = src("components/UpdateChecker.tsx");
    expect(s).not.toContain("#14110a");
    expect(s).toContain("var(--accent-foreground)");
    expect(s).toContain("fx-blue");
    expect(s).toContain("fx-fill-blue");
    expect(s).toContain("fx-panel-2");
    expect(s).toContain("fx-gold");
    expect(s).toContain("fx-accent");
  });

  it("AgentCompleteToast shell/icon/badge/numbers adopt the flat helpers", () => {
    const s = src("components/AgentCompleteToast.tsx");
    expect(s).toContain("fx-dialog");
    expect(s).toContain("fx-soft-green");
    expect(s).toContain("fx-green");
    expect(s).toContain("fx-red");
    expect(s).toContain("borderRadius: 16");
    expect(s).toContain("width: 36");
    expect(s).toContain("height: 36");
    expect(s).toContain("borderRadius: 11");
  });

  it("ApprovalToast risk chip carries a flat class per risk kind and the icon/count go gold/tabular", () => {
    const s = src("components/ApprovalToast.tsx");
    expect(s).toContain("fx-soft-gold");
    expect(s).toContain("fx-chip-q");
    expect(s).toContain("fx-soft-violet");
    expect(s).toContain("fx-gold");
    expect(s).toContain("tabular-nums");
  });

  it("NotificationHistoryPanel shell is a flat 16px dialog with an accent unread badge", () => {
    const s = src("components/NotificationHistoryPanel.tsx");
    expect(s).toContain("rounded-2xl");
    expect(s).toContain("fx-dialog");
    expect(s).toContain("fx-accent");
  });

  it("NotificationPromptDialog scrim/dialog/icon/actions are flat-scoped", () => {
    const s = src("components/NotificationPromptDialog.tsx");
    expect(s).toContain("fx-scrim");
    expect(s).toContain("fx-dialog");
    expect(s).toContain("fx-soft-gold");
    expect(s).toContain("fx-accent");
    expect(s).toContain("fx-quiet");
  });

  it("WhatsNewDialog version/category/footer drop mono and adopt ui-eyebrow/tabular-nums", () => {
    const s = src("components/WhatsNewDialog.tsx");
    expect(s).toContain("fx-graphite");
    expect(s).toContain("ui-eyebrow");
    expect(s).toContain("tabular-nums");
  });

  it("SetupWizardDialog SectionLabel uses ui-eyebrow", () => {
    const s = src("components/sidebar/SetupWizardDialog.tsx");
    expect(s).toContain("mb-2 ui-eyebrow");
  });

  it("LocalModelSetupDialog scrim/dialog/icon/bullets/actions are flat-scoped", () => {
    const s = src("components/sidebar/LocalModelSetupDialog.tsx");
    expect(s).toContain("fx-scrim");
    expect(s).toContain("fx-dialog");
    expect(s).toContain("fx-soft-blue");
    expect(s).toContain("fx-graphite");
    expect(s).toContain("fx-quiet");
    expect((s.match(/fx-accent/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("LocalModelUpgradeDialog dialog radius and error text go flat", () => {
    const s = src("components/sidebar/LocalModelUpgradeDialog.tsx");
    expect(s).toContain("rounded-[20px]");
    expect(s).toContain("fx-red");
  });

  it("ErrorBoundary card is a flat card with gold primary and quiet secondaries", () => {
    const s = src("components/ErrorBoundary.tsx");
    expect(s).toContain("rounded-2xl");
    expect(s).toContain("fx-card");
    expect(s).toContain("fx-accent");
    expect((s.match(/fx-quiet/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("StartupGate buttons and error pre are flat-scoped", () => {
    const s = src("components/StartupGate.tsx");
    expect((s.match(/fx-accent/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((s.match(/fx-quiet/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(s).toContain("fx-red");
  });

  it("SettingsDialog version line drops mono/adds tabular-nums, and the pending-log spinner is blue", () => {
    const s = src("components/sidebar/SettingsDialog.tsx");
    expect(s).toContain('fontVariantNumeric: "tabular-nums"');
    expect(s).toContain("animate-spin text-amber-400 fx-blue");
  });

  it("RemoteControlSection pairing-code label is ui-eyebrow while the code itself stays mono", () => {
    const s = src("components/settings/RemoteControlSection.tsx");
    expect(s).toContain("ui-eyebrow mb-1.5");
    expect(s).toContain("font-mono text-[26px]");
  });
});
