import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { STATE_META } from "../taskview/taskStateMeta";
import { StatePill, DiffStat } from "../taskview/StatePill";
import { CodexToolRow } from "../thread/tools/codex/CodexToolRow";

// Note: `new URL(rel, import.meta.url)` is intercepted by Vite's asset-URL
// transform under the jsdom ("dom") test project, resolving to an
// http://localhost dev-server URL instead of a real file path. Resolve via
// fileURLToPath + path instead so readFileSync gets a real filesystem path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("redesign v2 status primitives", () => {
  it("task states route through flat-switchable CSS vars", () => {
    expect(STATE_META.running.fg).toBe("var(--task-running)");
    expect(STATE_META.review.fg).toBe("var(--task-review)");
    expect(STATE_META.merged.fg).toBe("var(--task-merged)");
  });
  it("StatePill is a sans chip; DiffStat reads +3 −1", () => {
    render(<><StatePill state="running" /><DiffStat additions={3} deletions={1} /></>);
    expect(screen.getByText("Running").className).toContain("ui-chip");
    expect(screen.getByText("+3").parentElement!.textContent).toBe("+3 −1");
    expect(screen.getByText("+3").parentElement!.getAttribute("style") ?? "").not.toContain("mono");
  });
  it("tool rows are sans with a mono subject", () => {
    render(<CodexToolRow lead="Read" subject="src/app.ts" detail="212 lines" icon={null} />);
    const row = screen.getByTestId("codex-tool-row");
    expect(row.className).not.toContain("font-mono");
    expect(screen.getByText("src/app.ts").className).toContain("font-mono");
    expect(screen.getByText("212 lines").className).toContain("tabular-nums");
  });
  it("sidebar status dots and pane-tab chips carry flat markers", () => {
    expect(src("sidebar/ProjectGroup.tsx")).toContain("sb-status-ping");
    expect(src("sidebar/ProjectGroup.tsx")).toContain("sb-status-core");
    expect(src("layout/PaneTabBar.tsx")).toContain("pane-tab-status");
    expect(src("sidebar/ArchivedThreadsPanel.tsx")).toContain("arch-status-dot");
  });
});
