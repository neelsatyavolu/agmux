import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

const SWEPT_FILES = [
  "components/thread/ThreadTopBar.tsx",
  "components/thread/FilesChangedCard.tsx",
  "components/thread/CommandBlock.tsx",
  "components/thread/McpToolBlock.tsx",
  "components/thread/ToolUseBlock.tsx",
  "components/thread/ApprovalBanner.tsx",
  "components/thread/AskUserQuestionDialog.tsx",
  "components/thread/PlanFollowUpBanner.tsx",
  "components/thread/CodexUserInput.tsx",
  "components/thread/PromptDiffView.tsx",
  "components/thread/AgentGroupBlock.tsx",
  "components/thread/subagents/SubagentActivityCards.tsx",
  "components/thread/subagents/SubagentLaunchRow.tsx",
  "components/thread/subagents/SubagentInspector.tsx",
  "components/thread/ThinkingBlock.tsx",
  "components/thread/TerminalTabBar.tsx",
  "components/thread/StandaloneTerminalView.tsx",
  "components/thread/SlashCommandPopup.tsx",
  "components/thread/FileMentionPopup.tsx",
];

describe("in-session conversation/terminal chrome sweep", () => {
  it.each(SWEPT_FILES)("%s has no mono eyebrows", f => {
    expect(src(f)).not.toMatch(MONO_EYEBROW);
  });

  it("ApprovalBanner uses lg buttons, a flat scrim and kbd hints", () => {
    const s = src("components/thread/ApprovalBanner.tsx");
    expect(s).toContain('size="lg"');
    expect(s).toContain("fx-scrim");
    expect(s).toContain("ui-kbd");
  });

  it("ThinkingBlock drops font-mono", () => {
    expect(src("components/thread/ThinkingBlock.tsx")).not.toMatch(/font-mono/);
  });

  it("SubagentLaunchRow drops font-mono", () => {
    expect(src("components/thread/subagents/SubagentLaunchRow.tsx")).not.toMatch(/font-mono/);
  });

  it("ThreadTopBar routes text colors through surfaceStyle", () => {
    expect(src("components/thread/ThreadTopBar.tsx")).toContain("surfaceStyle");
  });
});
