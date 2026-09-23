/**
 * Static lint: forbid theme-bypassing color patterns.
 *
 * Scans all src/ TypeScript/TSX files for:
 *   1. Arbitrary-value Tailwind dark surface classes (bg-[#...], border-[#...],
 *      from-[#...], to-[#...], via-[#...])
 *   2. Inline style hex backgrounds/borders (style={{ background: '#...', etc }})
 *
 * Each allowed exception must be listed in ALLOWLIST below with a reason.
 * To add a new allowed case, append an entry — do NOT weaken the regexes.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Allow-list: patterns that are intentionally not theme-inverted.
// `pattern` is a substring of the offending line that uniquely identifies
// the allowed occurrence — a new violation in the same file still trips.
// ---------------------------------------------------------------------------
const ALLOWLIST: { file: string; pattern: string; reason: string }[] = [
  // ── Brand accent / submit button ─────────────────────────────────────────
  // Default brand accent is website gold #f7ad3c (yellow on black). Hardcoded
  // submit chrome and var(--accent) fills stay the same in light and dark.
  {
    file: "src/components/thread/ClaudeInputBar.tsx",
    pattern: "bg-[#f7ad3c]",
    reason: "Submit button: brand gold accent, intentional in both dark and light",
  },
  {
    file: "src/components/thread/composerChrome.ts",
    pattern: "bg-[var(--accent)]",
    reason: "Shared send button uses theme accent token, intentional in both modes",
  },
  {
    file: "src/components/thread/CodexSessionView.tsx",
    pattern: "bg-[var(--accent)]",
    reason: "Submit button: theme accent token, intentional in both dark and light",
  },

  // ── Active pane tab ───────────────────────────────────────────────────────
  // bg-[#141417] in PaneTabBar is already overridden by the `.pane-tab-active`
  // CSS rule in index.css (html[data-mode="light"] .pane-tab-active { … }).
  {
    file: "src/components/layout/PaneTabBar.tsx",
    pattern: "bg-[#141417]",
    reason:
      "Active tab: overridden by .pane-tab-active CSS rule in index.css for light mode",
  },

  // ── macOS traffic-light dots in Settings preview ──────────────────────────
  // These dots deliberately simulate macOS window chrome; fixed system colours.
  {
    file: "src/components/sidebar/SettingsDialog.tsx",
    pattern: '"#ff5f57"',
    reason: "macOS red traffic-light dot in theme preview widget — fixed system colour",
  },
  {
    file: "src/components/sidebar/SettingsDialog.tsx",
    pattern: '"#febc2e"',
    reason: "macOS yellow traffic-light dot in theme preview widget — fixed system colour",
  },
  {
    file: "src/components/sidebar/SettingsDialog.tsx",
    pattern: '"#28c840"',
    reason: "macOS green traffic-light dot in theme preview widget — fixed system colour",
  },

  // ── Pre-seeded: diff stat bars in GitSidebar ──────────────────────────────
  // Green/red progress bars for diff add/delete counts — semantic colours
  // that intentionally do NOT invert (green = additions, red = deletions).
  {
    file: "src/components/thread/GitSidebar.tsx",
    pattern: '"#34d399"',
    reason: "Diff stat bar: semantic green for additions — intentionally not inverted",
  },
  {
    file: "src/components/thread/GitSidebar.tsx",
    pattern: '"#f87171"',
    reason: "Diff stat bar: semantic red for deletions — intentionally not inverted",
  },

  // ── Status indicator dots ─────────────────────────────────────────────────
  // Small coloured pills used to show file/session status.
  // #3b82f6 (blue-500) = "AI editing this file" badge — brand semantic.
  // #f7ad3c (brand gold) = unsaved-change dirty dot — same as --accent.
  // #60a5fa (blue-400) = unread activity dot — brand semantic.
  // These colours carry meaning in both light and dark modes.
  {
    file: "src/components/editor/EditorTabs.tsx",
    pattern: '"#3b82f6"',
    reason: "AI-active file badge: blue-500 brand semantic indicator, same in both modes",
  },
  {
    file: "src/components/editor/EditorTabs.tsx",
    pattern: '"#f7ad3c"',
    reason: "Unsaved-change dot: brand gold accent, same as CSS variable in both modes",
  },
  {
    file: "src/components/taskview/TaskAgentTab.tsx",
    pattern: '"#60a5fa"',
    reason: "Unread activity dot: blue-400 brand semantic indicator, same in both modes",
  },

  // ── CodeMirror editor theme ───────────────────────────────────────────────
  // codemirrorTheme.ts defines a custom CodeMirror 6 syntax-highlight theme.
  // All hex colours in this file are editor token colours (background for
  // selection highlights, gutter, active line, etc.) that form a coherent
  // dark theme. CodeMirror manages its own light/dark switching via its
  // theme API; these do not go through the Tailwind / CSS-variable remap.
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#fbbf2433"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#fbbf2455"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#ffffff06"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#0c0c0c"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#6366f126"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#ffffff0a"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#ffffff"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },
  {
    file: "src/lib/codemirrorTheme.ts",
    pattern: '"#6366f114"',
    reason: "CodeMirror syntax theme — editor manages its own dark/light via theme API",
  },

  // ── Teams dashboard (dark-only analytics chrome) ─────────────────────────
  {
    file: "src/components/settings/TeamsSection.tsx",
    pattern: "border-[#f87171]",
    reason: "Teams error banner — semantic red, same in both modes",
  },
  {
    file: "src/components/settings/TeamsSection.tsx",
    pattern: "bg-[#60a5fa]",
    reason: "Teams invite/brand chip — semantic blue, same in both modes",
  },
  {
    file: "src/components/settings/TeamsSection.tsx",
    pattern: "border-[#60a5fa]",
    reason: "Teams invite input focus ring — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/ShareToTeamDialog.tsx",
    pattern: "bg-[#60a5fa]",
    reason: "Teams share confirm — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/TeamDashboard.tsx",
    pattern: 'background: "#60a5fa"',
    reason: "Teams legend/chart ink — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/TeamDashboard.tsx",
    pattern: 'background: "#fbbf24"',
    reason: "Teams legend/chart ink — semantic amber, same in both modes",
  },
  {
    file: "src/components/teams/TeamDashboard.tsx",
    pattern: "border-[#fbbf24]",
    reason: "Teams budget warning — semantic amber, same in both modes",
  },
  {
    file: "src/components/teams/TeamDashboard.tsx",
    pattern: "bg-[#60a5fa]",
    reason: "Teams chart bar — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "bg-[#34d399]",
    reason: "Teams status pill — semantic green, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "bg-[#fbbf24]",
    reason: "Teams status pill — semantic amber, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "bg-[#f87171]",
    reason: "Teams status pill — semantic red, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "bg-[#60a5fa]",
    reason: "Teams status pill — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "border-[#60a5fa]",
    reason: "Teams accent border — semantic blue, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "border-[#f87171]",
    reason: "Teams error border — semantic red, same in both modes",
  },
  {
    file: "src/components/teams/primitives.tsx",
    pattern: "border-[#fbbf24]",
    reason: "Teams warning border — semantic amber, same in both modes",
  },

];

// ---------------------------------------------------------------------------
// Patterns to detect
// ---------------------------------------------------------------------------
const TAILWIND_HEX_PATTERN =
  /\b(?:bg|border|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/g;

// Matches: style={{ ... background: '#rrggbb' ... }}
// Uses a lookahead-free approach: find `style={` then scan for hex in the
// `background`, `backgroundColor`, or `borderColor` property.
const INLINE_HEX_STYLE_PATTERN =
  /(?:background|backgroundColor|borderColor)\s*:\s*["']#[0-9a-fA-F]{3,8}["']/g;

// ---------------------------------------------------------------------------
// File discovery (recursive readdir — no glob dep needed)
// ---------------------------------------------------------------------------
function collectFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "dist", "node_modules"].includes(entry.name)) continue;
      collectFiles(full, results);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Allowlist helper
// ---------------------------------------------------------------------------
function isAllowed(relFile: string, line: string): boolean {
  return ALLOWLIST.some(
    (entry) => entry.file === relFile && line.includes(entry.pattern)
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe("themeLightModeCoverage — static lint", () => {
  it("has no un-allowlisted theme-bypassing hex patterns", () => {
    const wt = path.resolve(__dirname, "../../../");
    const srcDir = path.join(wt, "src");
    const files = collectFiles(srcDir);

    type Violation = { file: string; lineNo: number; snippet: string };
    const violations: Violation[] = [];

    for (const absFile of files) {
      const relFile = path.relative(wt, absFile);
      const content = fs.readFileSync(absFile, "utf8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        const trimmed = line.trim();

        // Check Tailwind arbitrary hex classes
        if (TAILWIND_HEX_PATTERN.test(trimmed)) {
          TAILWIND_HEX_PATTERN.lastIndex = 0; // reset stateful regex
          if (!isAllowed(relFile, line)) {
            violations.push({
              file: relFile,
              lineNo,
              snippet: trimmed.slice(0, 120),
            });
          }
        }
        TAILWIND_HEX_PATTERN.lastIndex = 0;

        // Check inline style hex backgrounds
        if (INLINE_HEX_STYLE_PATTERN.test(trimmed)) {
          INLINE_HEX_STYLE_PATTERN.lastIndex = 0; // reset stateful regex
          if (!isAllowed(relFile, line)) {
            violations.push({
              file: relFile,
              lineNo,
              snippet: trimmed.slice(0, 120),
            });
          }
        }
        INLINE_HEX_STYLE_PATTERN.lastIndex = 0;
      });
    }

    const scanned = files.length;
    if (violations.length > 0) {
      const msg = [
        `Found ${violations.length} theme-bypassing pattern(s) in ${scanned} scanned files.`,
        `Add an allow-list entry in themeLightModeCoverage.test.ts if intentional,`,
        `or replace the hard-coded hex with a CSS variable / semantic class.`,
        "",
        ...violations.map(
          (v) => `  ${v.file}:${v.lineNo}\n    ${v.snippet}`
        ),
      ].join("\n");
      expect.fail(msg);
    }

    // Sanity: we scanned a reasonable number of files
    expect(scanned).toBeGreaterThan(10);
  });
});


// Inline neutral text bypasses the light-mode Tailwind remaps. These audited
// surfaces contain UI text, not fixed-color logos or image overlays.
const NEUTRAL_TEXT_COMPONENTS = [
  "CommandPalette.tsx",
  "WhatsNewDialog.tsx",
  "editor/FileTree.tsx",
  "editor/FileTreeContextMenu.tsx",
  "thread/CommitDialog.tsx",
  "taskview/TaskWorktreeHeader.tsx",
  "taskview/TaskAgentTab.tsx",
  "taskview/TaskSidebar.tsx",
  "taskview/TaskSidebarItem.tsx",
  "taskview/TaskAgentTabBar.tsx",
  "taskview/StatePill.tsx",
];

describe("audited light-mode component chrome", () => {
  it("keeps neutral arbitrary text classes theme-aware", () => {
    const files = collectFiles(path.resolve(__dirname, "../../components"));
    const violations = files.flatMap((file) =>
      fs.readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
        /text-\[#(?:fff(?:fff)?|fafafa|f4f4f5|e4e4e7|d4d4d8|a1a1aa|71717a|52525b|3f3f46)\]/i.test(line)
          ? [`${path.basename(file)}:${index + 1}: ${line.trim()}`]
          : []
      )
    );
    expect(violations).toEqual([]);
  });

  it.each(["CommandPalette.tsx", "thread/CommitDialog.tsx"])(
    "%s themes semantic ink as well as neutral text", (file) => {
      const source = fs.readFileSync(path.resolve(__dirname, "../../components", file), "utf8");
      expect(source.match(/"#(?:60a5fa|f7ad3c|a78bfa|fbbf24|f87171)"/g) ?? []).toEqual([]);
      expect(source.match(/\$\{t\.color\}[0-9a-f]{2}/g) ?? []).toEqual([]);
    }
  );

  it("uses themed editor cursors and legible light-mode line numbers", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../codemirrorTheme.ts"), "utf8");
    expect(source.match(/(?:caretColor|borderLeftColor): "#f7ad3c"/g) ?? []).toEqual([]);
    const lightTheme = source.split("export const xanomLightEditorTheme =")[1]
      .split("export const xanomDarkHighlightStyle =")[0];
    expect(lightTheme.match(/color: "#a1a1aa"/g) ?? []).toEqual([]);
  });

  const components = path.resolve(__dirname, "../../components");

  it.each(NEUTRAL_TEXT_COMPONENTS)("%s uses themed neutral text", (file) => {
    const source = fs.readFileSync(path.join(components, file), "utf8");
    const violations = source.split("\n").filter((line) =>
      /(?:\bcolor:|\.style\.color =|\bbaseColor =).*?["']#(?:fff(?:fff)?|fafafa|f4f4f5|e4e4e7|d4d4d8|a1a1aa|71717a|52525b|3f3f46)["']/i.test(line)
    );
    expect(violations).toEqual([]);
    expect(source.match(/color: "rgba\(255,255,255,[^)]+\)"/g) ?? []).toEqual([]);
  });

  it.each(["editor/FileTree.tsx", "thread/CommitDialog.tsx", "taskview/TaskWorktreeHeader.tsx"])(
    "%s keeps input and panel backgrounds theme-aware", (file) => {
      const source = fs.readFileSync(path.join(components, file), "utf8");
      // The black modal scrim is intentional; these values are the embedded
      // field/panel fills that otherwise remain dark behind themed text.
      expect(source).not.toMatch(/background: "rgba\(0,0,0,0\.(?:20|25|30|35|40)\)"/);
    }
  );

  it.each([
    "thread/AgentTerminalView.tsx",
    "thread/TerminalMainPanel.tsx",
    "thread/ClaudeSessionView.tsx",
    "thread/ThreadView.tsx",
    "thread/WarpInputBar.tsx",
  ])("%s inherits the terminal surface", (file) => {
    const source = fs.readFileSync(path.join(components, file), "utf8");
    expect(source).not.toMatch(/bg-\[#(?:0a0a0c|0c0c0e)\]/);
    expect(source).toContain("var(--terminal-surface,var(--agent-terminal-surface))");
  });
});
