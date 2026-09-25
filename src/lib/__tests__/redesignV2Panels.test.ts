import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

// FileTree.tsx and UsagePanel.tsx are explicitly "nothing" in the task-9 brief
// (zinc remap / SectionEyebrow already fixed in Task 5) — they keep pre-existing,
// out-of-scope mono-eyebrow spans elsewhere in those large files untouched here.
const SWEPT_FILES = [
  "components/thread/GitSidebar.tsx",
  "components/thread/CommitDialog.tsx",
  "components/editor/GitStatusIndicator.tsx",
  "components/editor/FileIcon.tsx",
  "components/editor/EditorTabs.tsx",
  "components/editor/CodeEditor.tsx",
  "components/editor/FileTreeContextMenu.tsx",
  "components/layout/QuickOpenDialog.tsx",
  "components/thread/JournalPanel.tsx",
  "components/thread/AddToJournalDialog.tsx",
  "components/thread/ThreadTimelinePopover.tsx",
  "components/thread/MemoryMainPanel.tsx",
  "components/CommandPalette.tsx",
  "components/sidebar/SearchDialog.tsx",
  "components/sidebar/NewProjectDialog.tsx",
  "components/sidebar/CloneRepoDialog.tsx",
  "components/sidebar/NewThreadDialog.tsx",
  "components/layout/CoworkModeButton.tsx",
  "components/taskview/TaskSidebar.tsx",
  "components/taskview/TaskWorktreeHeader.tsx",
  "components/taskview/TaskAgentTabBar.tsx",
  "components/taskview/AgentAvatar.tsx",
  "components/taskview/NewTaskDialog.tsx",
];

describe("panels/palette/dialogs/task-mode sweep", () => {
  it.each(SWEPT_FILES)("%s has no mono eyebrows", f => {
    expect(src(f)).not.toMatch(MONO_EYEBROW);
  });

  it.each([
    "components/layout/QuickOpenDialog.tsx",
    "components/sidebar/NewProjectDialog.tsx",
    "components/sidebar/CloneRepoDialog.tsx",
    "components/sidebar/NewThreadDialog.tsx",
    "components/thread/AddToJournalDialog.tsx",
    "components/sidebar/SearchDialog.tsx",
  ])("%s dialog shell is a flat 20px dialog", f => {
    const s = src(f);
    expect(s).toContain("rounded-[20px]");
    expect(s).toContain("fx-dialog");
  });

  it("CommandPalette drops the hardcoded inset highlight and uses ui-eyebrow for group labels", () => {
    const s = src("components/CommandPalette.tsx");
    expect(s).not.toContain("inset 0 0.5px 0");
    expect(s).toContain("ui-eyebrow");
  });

  it("EditorTabs tab label carries no --font-mono", () => {
    const s = src("components/editor/EditorTabs.tsx");
    const matches = s.match(/fontFamily:\s*"var\(--font-mono\)"/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("GitSidebar dropdown menus, remove/confirm dialog and inputs are flat-scoped", () => {
    const s = src("components/thread/GitSidebar.tsx");
    expect((s.match(/fx-dialog/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(s).toContain("rounded-[20px]");
    expect(s).toContain("fx-soft-gold");
    expect((s.match(/fx-input/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("CommitDialog keeps the accent-dim commit button styling while adding fx-accent", () => {
    const s = src("components/thread/CommitDialog.tsx");
    expect(s).toContain("fx-accent");
    expect(s).toContain("accentDim");
    expect(s).toContain("ui-eyebrow");
  });

  it("NewThreadDialog and NewTaskDialog provider/primary treatment", () => {
    const thread = src("components/sidebar/NewThreadDialog.tsx");
    expect(thread).toContain("ui-choice-item");
    expect(thread).toContain("fx-accent");
    expect(thread).toContain("fx-scrim");

    const task = src("components/taskview/NewTaskDialog.tsx");
    expect(task).toContain("fx-accent");
    expect(task).toContain("fx-scrim");
    expect(task).toContain("fx-dialog");
  });

  it("OpenCodeSdkSessionView converts its old-style eyebrows to ui-eyebrow", () => {
    const s = src("components/thread/OpenCodeSdkSessionView.tsx");
    expect(s).not.toMatch(MONO_EYEBROW);
    expect(s).toContain("ui-eyebrow");
  });
});
