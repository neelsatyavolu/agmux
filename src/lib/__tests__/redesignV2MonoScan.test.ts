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
 * Task 12's own leftover sweep (controller ruling 1, plus fix round 1): files
 * Tasks 5-11 left untouched ("nothing (zinc remap)" / "SectionEyebrow fixed
 * in Task 5") that still carried old-style mono eyebrows or mono-on-prose,
 * found either by the controller's named 3 files, the repo-wide rg check, or
 * while tightening this scan's marker list in fix round 1.
 */
const LEFTOVER_SWEEP_FILES = [
  "components/sidebar/UsagePanel.tsx",
  "components/editor/FileTree.tsx",
  "components/teams/ShareToTeamDialog.tsx",
  "components/ui/EffortSlider.tsx",
  "components/settings/TeamsSyncSection.tsx",
  "components/settings/YourDataSection.tsx",
  "components/settings/OpenCodeAuthPanel.tsx",
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
     * The check is windowed, not just the line itself, because this codebase
     * frequently splits a single styled element's `fontFamily` declaration
     * onto its own line inside a multi-line `style={{ ... }}` object, with
     * the identifying prop/JSX content a few lines away. The window is
     * bounded to the surrounding *paragraph of code* (it stops at the first
     * blank line above/below, capped at 10 lines either way) rather than a
     * flat N-line radius: a flat 10-line radius let a generic marker like
     * "path" leak in from an unrelated SIBLING element several lines away
     * and mask a real bug (fix round 1 — see GitSidebar.tsx's `WarpFileCard`
     * additions/deletions badge, which sat 6 non-blank lines below a
     * `title={file.path}` on a completely different `<span>`). Blank lines
     * reliably separate sibling JSX elements in this codebase's formatting,
     * so stopping there keeps the window scoped to one element's attributes.
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
      // git subjects, provider/agent tags). Deliberately NOT here (fix round
      // 1): "additions"/"deletions" — a bare diff-count span
      // (`font-mono ... +{additions}/-{deletions}`) would pass this check
      // purely because the prop name is spelled out nearby, exactly the kind
      // of count this scan exists to catch (this hid a real bug — see
      // GitSidebar.tsx's `WarpFileCard` badge, fixed in fix round 1). Also
      // dropped: "diff" (too generic — matched an unrelated elapsed-timer
      // span via a nearby `diffLayout`/`DiffBar` reference and hid that
      // bug too), "value" (too generic — matched via unrelated `value=`
      // props, hid three real count bugs in YourDataSection.tsx), and
      // "description"/"hint" (zero legitimate matches depended on either
      // once measured — both are prose-shaped and only ever masked a real
      // bug, e.g. SettingsDialog.tsx's `{m.hint}` sentence, fixed in fix
      // round 1). "model" is kept: every line it covers is a model/provider
      // identifier (e.g. ProjectGroup.tsx's `{model}` chip), never a count.
      "toolName",
      "displayName",
      "subtaskModel",
      "triggerModel",
      "shortcut",
      "model",
      "filter",
      "subject",
      "staged",
      "committed",
      "meta.letter",
      "file.path",
      "relativePath",
      "rootPath",
    ];

    interface MonoOffender {
      lineNo: number;
      text: string;
    }

    const MAX_PARAGRAPH_SPAN = 10;

    /** [lo, hi] inclusive line-index bounds of the blank-line-delimited paragraph containing line i. */
    function paragraphBounds(lines: string[], i: number): [number, number] {
      let lo = i;
      while (lo > 0 && lo > i - MAX_PARAGRAPH_SPAN && lines[lo - 1].trim() !== "") lo--;
      let hi = i;
      while (hi < lines.length - 1 && hi < i + MAX_PARAGRAPH_SPAN && lines[hi + 1].trim() !== "") hi++;
      return [lo, hi];
    }

    function windowsWithoutMarker(file: string): MonoOffender[] {
      const lines = src(file).split("\n");
      const offenders: MonoOffender[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes("font-mono") && !line.includes("--font-mono")) continue;
        const [lo, hi] = paragraphBounds(lines, i);
        const windowText = lines.slice(lo, hi + 1).join("\n").toLowerCase();
        const ok = MACHINE_TEXT_MARKERS.some((m) => windowText.includes(m.toLowerCase()));
        if (!ok) offenders.push({ lineNo: i + 1, text: line.trim() });
      }
      return offenders;
    }

    /**
     * Files with mono usage reviewed line-by-line while writing this scan and
     * confirmed to be a single-character avatar/status glyph, a font-stack
     * declaration, a hex-color/API-key input, a raw code/output block, or a
     * shared primitive whose mono-ness is controlled by a caller prop — none
     * of which textually contain one of the markers above within its
     * paragraph, but all of which are legitimate per rule 5.
     *
     * Keyed by file, each entry is a substring that must appear EXACTLY ONCE
     * in the whole file (enforced by the self-check below) and is matched
     * against the offending line's blank-line-bounded PARAGRAPH — not just
     * the offending line itself, since some sites (e.g. McpToolBlock's three
     * near-identical `<pre>` blocks) are only distinguishable by a sibling
     * line a couple of rows away (the "Arguments"/"Result"/"Error" label).
     *
     * Fix round 2: earlier entries for GitSidebar.tsx, ProjectGroup.tsx and
     * FileTree.tsx used the bare `fontFamily: "var(--font-mono)",` string,
     * which matches every line formatted that way (5/2/6 lines respectively)
     * — the same over-broad-matching problem the marker list had. Every
     * entry below is now a fragment specific to ONE reviewed element (a
     * distinctive prop value, computed style, or label text unique to that
     * site), verified by the self-check test immediately after this map.
     */
    const REVIEWED_EXCEPTIONS: Record<string, string[]> = {
      "components/ApprovalToast.tsx": ["font-family: var(--font-mono);"], // .approval-pill: renders the tool command being approved
      "components/sidebar/ProjectGroup.tsx": [
        "truncate text-[9.5px] lowercase", // agent-key tag under an avatar (`{a.label}`)
        "linear-gradient(135deg, #f59e0b, #ef4444)", // avatar monogram initial in the "New in {project}" menu
      ],
      "components/sidebar/SettingsDialog.tsx": [
        "w-24 rounded-md", // custom-theme hex-color input (#hex)
        "w-20 rounded-md", // accent hex-color input (#hex)
        "text-zinc-300 font-mono", // About panel: app/Tauri/platform version strings
      ],
      "components/sidebar/SetupWizardDialog.tsx": [
        'className="mt-1 font-mono text-xs"', // literal JS code sample in the font-preview card
        'fontFamily: "var(--font-mono)" }}', // same code-sample paragraph's style object
      ],
      "components/taskview/NewTaskDialog.tsx": [
        "font-mono font-bold text-white", // avatar monogram initial
        "font-mono text-[9px] tracking-[0.03em]", // "chat"/">_" mode tag
        "font-mono text-[11.5px] text-zinc-200 outline-none fx-input", // project <select> (identifier tag, not a count)
        "font-mono text-[11.5px] text-zinc-400", // single-project name (companion display when there's no <select>)
      ],
      "components/teams/TeamDashboard.tsx": ["font-mono text-[11.5px] text-[var(--text-secondary)]"], // projectKey cell — "basename or hash only" per the panel's own subtitle
      "components/thread/CommitDialog.tsx": [
        'resize: "vertical"', // commit-message body textarea (git-editor convention)
        "{errorMessage}", // raw error/stack output box
      ],
      "components/thread/FileMentionPopup.tsx": ["font-mono text-xs truncate"], // file/dir name in the @-mention list
      "components/thread/GitSidebar.tsx": [
        "Math.round(size * 0.64)", // StatusMark: single-letter git status glyph (M/A/D)
        "lineHeight: 1.55", // DiffHunk: actual diff-hunk code content
        'backdropFilter: "blur(6px)"', // DiffHunk's sticky hunk-header row
        'style={{ fontFamily: "var(--font-mono)" }}>', // directory-name span in the "Jump to" grouped list (a path segment)
        "text-secondary, #e4e4e7", // "strip" layout chip: file name (file identity)
        "text-tertiary, #a1a1aa", // "Jump to" list row: file name (file identity)
      ],
      "components/thread/McpToolBlock.tsx": [
        ">Arguments</div>", // raw tool-call arguments <pre> block
        ">Result</div>", // raw tool-call result <pre> block
        ">Error</div>", // raw tool-call error <pre> block
      ],
      "components/thread/OpenCodeSdkSessionView.tsx": ["space-y-0.5 font-mono"], // <ul> of file paths from a patch
      "components/thread/ThreadTopBar.tsx": [
        'borderTop: "1px solid var(--glass-border)"', // the font-stack CSS variable declaration itself, not applied content
        "bg-zinc-800 font-mono text-[9px] font-bold", // provider avatar fallback initial
      ],
      "components/ui/ComposerDropdown.tsx": ['metaMono ? "font-mono text-[10.5px]"'], // shared row: mono-ness is the caller's `metaMono` prop
      "components/editor/FileTree.tsx": [
        "fontSize: Math.round(size * 0.6)", // ExtTile: file-extension badge (file identity)
        "file-tree-row group", // tree row: file/folder name (file identity)
        'color: "var(--text-tertiary, #a1a1aa)"', // header: root folder name/path
        "{changedCount} changed", // header: changed-file count badge (a count, out of "labels only" scope for this file's leftover sweep)
        'padding: "7px 10px"', // rename dialog: input editing a filename
        'background: "var(--surface-2)"', // delete-confirmation dialog: the relativePath being deleted
      ],
      "components/settings/TeamsSyncSection.tsx": ["batchId.slice(0, 8)"], // truncated batch id — a short hash-like identifier
      "components/settings/OpenCodeAuthPanel.tsx": [
        'placeholder="Paste API key"', // API-key text input
        'placeholder="Callback code"', // OAuth callback-code text input
      ],
    };

    it("every REVIEWED_EXCEPTIONS fragment matches exactly one line (self-check)", () => {
      const problems: string[] = [];
      for (const [file, fragments] of Object.entries(REVIEWED_EXCEPTIONS)) {
        const lines = src(file).split("\n");
        for (const fragment of fragments) {
          const count = lines.filter((l) => l.includes(fragment)).length;
          if (count !== 1) {
            problems.push(`${file}: ${JSON.stringify(fragment)} matches ${count} lines (expected exactly 1)`);
          }
        }
      }
      if (problems.length > 0) console.error(problems.join("\n"));
      expect(problems).toEqual([]);
    });

    /** True if the offender's own paragraph contains a fragment unique to exactly one reviewed site. */
    function matchesReviewedException(file: string, offender: MonoOffender): boolean {
      const exceptions = REVIEWED_EXCEPTIONS[file] ?? [];
      if (exceptions.length === 0) return false;
      const lines = src(file).split("\n");
      const [lo, hi] = paragraphBounds(lines, offender.lineNo - 1);
      const paragraphText = lines.slice(lo, hi + 1).join("\n");
      return exceptions.some((sub) => paragraphText.includes(sub));
    }

    it.each(ALL_SWEPT_FILES)("%s: every font-mono line is machine text or a reviewed exception", (f) => {
      const offenders = windowsWithoutMarker(f).filter((o) => !matchesReviewedException(f, o));
      if (offenders.length > 0) {
        const formatted = offenders.map((o) => `${f}:${o.lineNo}: ${o.text}`).join("\n");
        console.error(`Unreviewed font-mono lines in ${f}:\n${formatted}`);
      }
      expect(offenders).toEqual([]);
    });
  });
});
