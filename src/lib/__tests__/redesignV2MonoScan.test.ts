import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;
const WIDE_TRACKING = /tracking-\[0\.(1[4-9]|2)\d*em\]/;
const SLASH_DIFF = /> \/ <\/span>|"\s\/\s"/;
const HYPHEN_DIFF_COUNT = />-\{(removed|deletions|file\.deletions|linesRemoved)\}/;

/**
 * Every non-test .tsx file touched by Tasks 5-11 (the mockup sweeps), derived
 * from `git diff --name-only cb34340e..HEAD -- '*.tsx'` (cb34340e is the tip of
 * Task 4; HEAD at the time this test was written is the tip of Task 11,
 * f54ca0b4). This is the file set the brief asks this scan to "walk".
 */
const TASK_5_11_FILES = [
  "App.tsx",
  "components/AgentCompleteToast.tsx",
  "components/ApprovalToast.tsx",
  "components/CommandPalette.tsx",
  "components/ErrorBoundary.tsx",
  "components/NotificationHistoryPanel.tsx",
  "components/NotificationPromptDialog.tsx",
  "components/StartupGate.tsx",
  "components/UpdateChecker.tsx",
  "components/WhatsNewDialog.tsx",
  "components/editor/CodeEditor.tsx",
  "components/editor/EditorTabs.tsx",
  "components/editor/FileIcon.tsx",
  "components/editor/FileTreeContextMenu.tsx",
  "components/editor/GitStatusIndicator.tsx",
  "components/layout/HomeScreen.tsx",
  "components/layout/PaneTabBar.tsx",
  "components/layout/QuickOpenDialog.tsx",
  "components/settings/RemoteControlSection.tsx",
  "components/settings/accounts/ChoiceGroup.tsx",
  "components/settings/settingsLayout.tsx",
  "components/sidebar/ArchivedThreadsPanel.tsx",
  "components/sidebar/CloneRepoDialog.tsx",
  "components/sidebar/FocusSection.tsx",
  "components/sidebar/LocalModelSetupDialog.tsx",
  "components/sidebar/LocalModelUpgradeDialog.tsx",
  "components/sidebar/NewProjectDialog.tsx",
  "components/sidebar/NewThreadDialog.tsx",
  "components/sidebar/ProjectGroup.tsx",
  "components/sidebar/SearchDialog.tsx",
  "components/sidebar/SettingsDialog.tsx",
  "components/sidebar/SetupWizardDialog.tsx",
  "components/sidebar/ShellDiffBadge.tsx",
  "components/taskview/AgentAvatar.tsx",
  "components/taskview/NewTaskDialog.tsx",
  "components/taskview/StatePill.tsx",
  "components/taskview/TaskAgentTabBar.tsx",
  "components/taskview/TaskSidebar.tsx",
  "components/taskview/TaskWorktreeHeader.tsx",
  "components/teams/TeamDashboard.tsx",
  "components/teams/TeamSelfView.tsx",
  "components/teams/primitives.tsx",
  "components/thread/AddToJournalDialog.tsx",
  "components/thread/AgentGroupBlock.tsx",
  "components/thread/ApprovalBanner.tsx",
  "components/thread/AskUserQuestionDialog.tsx",
  "components/thread/CodexSessionView.tsx",
  "components/thread/CodexUserInput.tsx",
  "components/thread/CommandBlock.tsx",
  "components/thread/CommitDialog.tsx",
  "components/thread/CoworkToolLine.tsx",
  "components/thread/FileMentionPopup.tsx",
  "components/thread/FilesChangedCard.tsx",
  "components/thread/GitSidebar.tsx",
  "components/thread/JournalPanel.tsx",
  "components/thread/McpToolBlock.tsx",
  "components/thread/MemoryMainPanel.tsx",
  "components/thread/OpenCodeSdkSessionView.tsx",
  "components/thread/PlanFollowUpBanner.tsx",
  "components/thread/SlashCommandPopup.tsx",
  "components/thread/StandaloneTerminalView.tsx",
  "components/thread/TerminalTabBar.tsx",
  "components/thread/ThinkingBlock.tsx",
  "components/thread/ThreadTimelinePopover.tsx",
  "components/thread/ThreadTopBar.tsx",
  "components/thread/ToolActivityGroup.tsx",
  "components/thread/ToolUseBlock.tsx",
  "components/thread/TurnChangeSummary.tsx",
  "components/thread/subagents/SubagentActivityCards.tsx",
  "components/thread/subagents/SubagentLaunchRow.tsx",
  "components/thread/tools/TaskToolRenderer.tsx",
  "components/thread/tools/codex/CodexToolRow.tsx",
  "components/ui/ComposerDropdown.tsx",
  "components/ui/GlassButton.tsx",
  "components/ui/SegmentedControl.tsx",
  "components/ui/panel/SectionEyebrow.tsx",
  "components/usage/AccountUsageRows.tsx",
];

/**
 * Task 12's own leftover sweep (controller ruling 1): files Tasks 5-11 left
 * untouched ("nothing (zinc remap)" / "SectionEyebrow fixed in Task 5") that
 * still carried old-style mono eyebrows.
 */
const LEFTOVER_SWEEP_FILES = [
  "components/sidebar/UsagePanel.tsx",
  "components/editor/FileTree.tsx",
  "components/teams/ShareToTeamDialog.tsx",
];

const ALL_SWEPT_FILES = [...TASK_5_11_FILES, ...LEFTOVER_SWEEP_FILES];

/**
 * Wide-tracking values that are NOT eyebrow text: RemoteControlSection's
 * "Pairing code" value itself (a 26px display of the actual code the user
 * types/scans — machine text per rule 5) uses `tracking-[0.2em]` purely for
 * legibility of the digits, not as an eyebrow. Its label sits in a separate
 * `ui-eyebrow` span right above it.
 */
const WIDE_TRACKING_EXCEPTIONS: Record<string, RegExp[]> = {
  "components/settings/RemoteControlSection.tsx": [/font-mono text-\[26px\] font-semibold tracking-\[0\.2em\]/],
};

function stripReviewedTracking(file: string, text: string): string {
  let stripped = text;
  for (const pattern of WIDE_TRACKING_EXCEPTIONS[file] ?? []) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

describe("redesign v2 — mono/eyebrow source scan (Task 12)", () => {
  it.each(ALL_SWEPT_FILES)("%s has no old-style mono eyebrows", (f) => {
    const s = src(f);
    expect(s).not.toMatch(MONO_EYEBROW);
    expect(stripReviewedTracking(f, s)).not.toMatch(WIDE_TRACKING);
  });

  describe("diff counts use a real minus sign, not a hyphen, and no slash separators", () => {
    // charts.tsx is deliberately excluded everywhere in this suite: Task 11's
    // own test (redesignV2Teams.test.ts) asserts it stays byte-identical to
    // HEAD, and per the controller ruling chart/data-viz code is untouched.
    const DIFF_COMPONENTS = [
      "components/sidebar/ShellDiffBadge.tsx",
      "components/taskview/StatePill.tsx",
      "components/thread/GitSidebar.tsx",
    ];
    it.each(DIFF_COMPONENTS)("%s has no slash-separated diff counts", (f) => {
      expect(src(f)).not.toMatch(SLASH_DIFF);
    });
    it.each(DIFF_COMPONENTS)("%s has no hyphen-minus deletion counts", (f) => {
      expect(src(f)).not.toMatch(HYPHEN_DIFF_COUNT);
    });
  });

  describe("font-mono survives only on machine text (rule 5)", () => {
    /**
     * Every recognizable category of legitimate machine text this codebase
     * actually uses on lines styled `font-mono` within the swept files:
     * file/dir paths, git branches/shas, cwd, shell commands, tool/model
     * identifiers, keyboard keys, terminal output, code samples, diff line
     * content, and the "mono text-[12.5px]" tool-subject idiom.
     *
     * The check is windowed (10 lines each side of the font-mono line, not
     * just the line itself) because this codebase frequently splits a single
     * styled element's `fontFamily` declaration onto its own line inside a
     * multi-line `style={{ ... }}` object, with the identifying prop/JSX
     * content a few lines away.
     */
    const MACHINE_TEXT_MARKERS = [
      "path",
      "branch",
      "cwd",
      "command",
      "cmd",
      "code",
      "kbd",
      "pairCode",
      "terminal",
      "sha",
      "hash",
      "diff-line",
      "mono text-[12.5px]",
      // Additional categories reviewed and confirmed as machine text while
      // building this scan (tool/model identifiers, keyboard shortcuts,
      // git subjects/diff stats, raw tool output):
      "toolName",
      "displayName",
      "subtaskModel",
      "triggerModel",
      "shortcut",
      "description",
      "hint",
      "model",
      "filter",
      "value",
      "subject",
      "diff",
      "deletions",
      "additions",
      "staged",
      "committed",
      "meta.letter",
      "file.path",
      "relativePath",
      "rootPath",
    ];

    function windowsWithoutMarker(file: string): string[] {
      const lines = src(file).split("\n");
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("font-mono") && !line.includes("--font-mono")) continue;
        const lo = Math.max(0, i - 10);
        const hi = Math.min(lines.length, i + 11);
        const windowText = lines.slice(lo, hi).join("\n").toLowerCase();
        const ok = MACHINE_TEXT_MARKERS.some((m) => windowText.includes(m.toLowerCase()));
        if (!ok) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
      return offenders;
    }

    /**
     * Files with mono usage reviewed line-by-line while writing this scan and
     * confirmed to be a single-character avatar/status glyph, a font-stack
     * declaration, or a shared primitive whose mono-ness is controlled by a
     * caller prop — none of which textually contain one of the markers above
     * within a 10-line window, but all of which are legitimate per rule 5.
     * Anything NOT in this allowlist must pass the marker check above.
     */
    const REVIEWED_EXCEPTIONS: Record<string, number[]> = {
      "components/ApprovalToast.tsx": [583], // .approval-pill: renders the tool command being approved
      "components/sidebar/ProjectGroup.tsx": [2030, 3253], // agent-key tag under an avatar; avatar monogram initial
      "components/sidebar/SetupWizardDialog.tsx": [521, 522], // literal JS code sample in the font-preview card
      "components/taskview/NewTaskDialog.tsx": [342, 356], // avatar monogram initial; "chat"/">_" mode tag
      "components/thread/CommitDialog.tsx": [684, 1221], // commit-message body textarea; raw error output box
      "components/thread/FileMentionPopup.tsx": [79], // file/dir name in the @-mention list
      "components/thread/GitSidebar.tsx": [215], // single-letter git status glyph (M/A/D)
      "components/thread/McpToolBlock.tsx": [110, 118, 126], // raw tool input/output <pre> blocks
      "components/thread/OpenCodeSdkSessionView.tsx": [2432], // <ul> of file paths from a patch
      "components/thread/ThreadTopBar.tsx": [322, 1227], // font-stack declaration; provider avatar initial
      "components/ui/ComposerDropdown.tsx": [127], // shared row: mono-ness is the caller's `metaMono` prop
      "components/editor/FileTree.tsx": [57, 229, 530, 551, 800, 892], // ext tile / row+folder names / rename input / relativePath — all file identity, reviewed in Task 12's leftover sweep
    };

    it.each(ALL_SWEPT_FILES)("%s: every font-mono line is machine text or a reviewed exception", (f) => {
      const offenders = windowsWithoutMarker(f).filter((line) => {
        const [, lineNoStr] = line.match(/^.*?:(\d+):/) ?? [];
        const lineNo = lineNoStr ? Number(lineNoStr) : -1;
        return !(REVIEWED_EXCEPTIONS[f] ?? []).includes(lineNo);
      });
      if (offenders.length > 0) {
        console.error(`Unreviewed font-mono lines in ${f}:\n${offenders.join("\n")}`);
      }
      expect(offenders).toEqual([]);
    });
  });
});
