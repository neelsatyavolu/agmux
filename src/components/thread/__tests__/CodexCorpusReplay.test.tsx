// Opt-in local evidence only; saved JavaScript is parsed, never evaluated.
// AGMUX_CODEX_CORPUS_DIR=/tmp/agmux-codex-audit-2026-09-14 npm test -- CodexCorpusReplay
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expandExecCalls } from "../../../lib/subagentExec";
import { conversationItemsFromExec, conversationItemsFromHistory, groupCodexItems, renderCodexToolItem, renderTimelineEntry, fileChangesFromHistoryItems, type ConversationItem } from "../CodexSessionView";
import { parseDiffLines } from "../tools/codex/CodexDiffBlock";
import type { SessionHistoryItem } from "../../../lib/commands";

const root = process.env.AGMUX_CODEX_CORPUS_DIR;
interface Snapshot { id: string; path: string; sha256: string }
interface SavedCall { session: string; id: string; source: string; result: unknown }
const calls: SavedCall[] = [];
const report = { sessions: 0, records: 0, calls: 0, exec: 0, expanded: 0, rawFallback: 0, rows: 0, historyItems: 0, normalizedItems: 0, diffItems: 0, wrapperDomSamples: [] as string[], historyDomSamples: [] as string[], collapsedToolItems: 0, collapsedToolRows: 0, collapsedLaunchRows: 0, collapsedQuestionItems: 0, collapsedFileItems: 0, diffDomSamples: [] as string[], messageDomCounts: { user: 0, agent: 0, thinking: 0 }, snapshotHashes: [] as Snapshot[], historyHashes: [] as { id: string; sha256: string }[] };
let manifest: Snapshot[] = [];

function paint(items: ConversationItem[]) {
  const open = Object.fromEntries(items.map((item) => [item.id, true]));
  return render(<>{items.map((item) => renderCodexToolItem(item, open, () => {}))}</>);
}

describe.skipIf(!root)("frozen Codex corpus frontend replay", () => {
  beforeAll(() => {
    manifest = JSON.parse(readFileSync(join(root!, "manifest.json"), "utf8"));
    for (const session of manifest) {
      const bytes = readFileSync(session.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(session.sha256);
      report.snapshotHashes.push(session);
      const records = bytes.toString().trim().split("\n").map((line) => JSON.parse(line));
      report.sessions++;
      report.records += records.length;
      const outputs = new Map(records.filter((r) => /^(custom_tool_call_output|function_call_output)$/.test(r.payload.type)).map((r) => [r.payload.call_id, r.payload.output]));
      for (const r of records) {
        const p = r.payload;
        if (!/^(custom_tool_call|function_call)$/.test(p.type)) continue;
        report.calls++;
        if (/^(functions\.)?exec$/.test(p.name)) calls.push({ session: session.id, id: p.call_id, source: p.input, result: outputs.get(p.call_id) });
      }
    }
  });
  afterEach(cleanup);
  afterAll(() => writeFileSync(join(root!, "frontend-dom-report.json"), JSON.stringify(report, null, 2)));

  it("replays every exec with complete pairing or an intact raw fallback", () => {
    const representatives = new Map<string, SavedCall>();
    for (const call of calls) {
      const rows = expandExecCalls(call);
      report.exec++;
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      report.rows += rows.length;
      if (rows[0].name === "Code execution") {
        report.rawFallback++;
        expect(rows[0].input.input).toBe(call.source);
        if (Array.isArray(call.result)) {
          for (const block of call.result) {
            if (typeof block.text === "string" && !rows[0].result.includes("original media retained in transcript")) expect(rows[0].result).toContain(block.text);
            if (block.type === "input_image") expect(rows[0].result).toContain("input_image output");
          }
        }
        representatives.set("raw", representatives.get("raw") ?? call);
        if (Array.isArray(call.result) && call.result.some((block) => block.type === "input_image")) representatives.set("media", representatives.get("media") ?? call);
      } else {
        report.expanded++;
        for (const row of rows) {
          if (row.name === "exec_command" && row.exitCode === undefined) representatives.set("incomplete", representatives.get("incomplete") ?? call);
          if (row.isError) representatives.set("error", representatives.get("error") ?? call);
          if (row.name.startsWith("mcp__")) representatives.set("mcp", representatives.get("mcp") ?? call);
          if (row.result.includes("truncated")) representatives.set("truncated", representatives.get("truncated") ?? call);
          if (row.result.includes("<script")) representatives.set("html", representatives.get("html") ?? call);
          if (row.result.includes("\\n")) representatives.set("literal-escape", representatives.get("literal-escape") ?? call);
        }
        if (call.source.includes(".then(")) representatives.set("then", representatives.get("then") ?? call);
        if (call.source.includes("Promise.allSettled")) representatives.set("settled", representatives.get("settled") ?? call);
        if (call.source.startsWith("const ")) representatives.set("bound", representatives.get("bound") ?? call);
      }
    }
    expect(report.expanded + report.rawFallback).toBe(calls.length);
    for (const [kind, call] of representatives) {
      const items = conversationItemsFromExec({ callId: call.id, source: call.source, result: call.result, timestamp: 1, isHistory: true });
      const view = paint(items);
      expect(view.queryAllByTestId("codex-tool-row").length).toBeGreaterThan(0);
      expect(view.container.querySelector("script")).toBeNull();
      for (const item of items) {
        const text = item.type === "mcpTool" ? item.mcpResultText : item.content;
        const emptyResult = item.type === "tool" && item.toolName !== "Code execution"
          && ["{}", "[]", "null"].includes(text?.trim() ?? "");
        if (text?.trim() && text.length < 60_000 && !emptyResult) expect(view.container.textContent).toContain(text);
      }
      report.wrapperDomSamples.push(`${kind}:${call.session}:${call.id}`);
      cleanup();
    }
  });

  it("normalizes all Rust histories and renders representative rows and diffs from each session", () => {
    for (const session of manifest) {
      const bytes = readFileSync(join(root!, "histories", `${session.id}.json`));
      report.historyHashes.push({ id: session.id, sha256: createHash("sha256").update(bytes).digest("hex") });
      const history = JSON.parse(bytes.toString()) as { items: SessionHistoryItem[] };
      report.historyItems += history.items.length;
      const items = conversationItemsFromHistory(history.items);
      report.normalizedItems += items.length;
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
      expect(() => groupCodexItems(items)).not.toThrow();
      const toolItems = items.filter((item) => ["command", "mcpTool", "tool", "file", "webSearch", "subagent"].includes(item.type));
      const collapsed = render(<>{toolItems.map((item) => <div key={item.id} data-corpus-tool={item.id}>{renderTimelineEntry({ kind: "item", timestamp: item.timestamp, item }, {}, () => {}, false)}</div>)}</>);
      expect(collapsed.container.querySelectorAll("[data-corpus-tool]").length).toBe(toolItems.length);
      for (const row of collapsed.container.querySelectorAll("[data-corpus-tool]")) expect(row.textContent?.trim().length, `${session.id}:${row.getAttribute("data-corpus-tool")}:${toolItems.find((item) => item.id === row.getAttribute("data-corpus-tool"))?.toolName}`).toBeGreaterThan(0);
      for (const row of collapsed.queryAllByTestId("codex-tool-row")) {
        expect(row.getAttribute("data-lead")?.trim().length).toBeGreaterThan(0);
        for (const subject of row.querySelectorAll("[title]")) expect(subject.textContent?.trim().length).toBeGreaterThan(0);
      }
      report.collapsedToolItems += toolItems.length;
      report.collapsedToolRows += collapsed.queryAllByTestId("codex-tool-row").length;
      report.collapsedLaunchRows += collapsed.queryAllByTestId("subagent-launch-row").length;
      const questionItems = toolItems.filter((item) => item.toolName === "request_user_input_async").length;
      report.collapsedQuestionItems += questionItems;
      expect(collapsed.queryAllByTestId("codex-tool-row").length + collapsed.queryAllByTestId("subagent-launch-row").length + questionItems).toBe(toolItems.length);
      expect(collapsed.queryAllByTestId("codex-term")).toHaveLength(0);
      expect(collapsed.queryAllByTestId("codex-output")).toHaveLength(0);
      cleanup();
      const files = fileChangesFromHistoryItems(history.items);
      const fileView = render(<>{files.map((fileChange) => <div key={fileChange.id}>{renderTimelineEntry({ kind: "fileChange", timestamp: fileChange.timestamp, fileChange }, {}, () => {}, false)}</div>)}</>);
      expect(fileView.queryAllByTestId("codex-tool-row").length).toBe(files.length);
      for (const row of fileView.queryAllByTestId("codex-tool-row")) expect(row.querySelector("[title]")?.textContent?.trim().length).toBeGreaterThan(0);
      report.collapsedFileItems += files.length;
      cleanup();
      for (const type of ["command", "mcpTool", "tool"] as const) {
        const item = items.find((item) => item.type === type && (type !== "tool" || item.toolName === "Code execution"));
        if (!item) continue;
        const view = paint([item]);
        expect(view.getByTestId("codex-tool-row")).toBeTruthy();
        expect(view.container.querySelector("script")).toBeNull();
        report.historyDomSamples.push(`${session.id}:${item.id}`);
        cleanup();
      }
      for (const item of items) {
        if (item.type !== "user" && item.type !== "agent" && item.type !== "thinking") continue;
        const view = render(<>{renderTimelineEntry({ kind: "item", timestamp: item.timestamp, item }, { [item.id]: true }, () => {}, true)}</>);
        expect(view.container.textContent?.trim().length).toBeGreaterThan(0);
        expect(view.container.querySelector("script")).toBeNull();
        if (item.type === "user") expect(view.container.querySelector("[data-timeline-user-msg]")).toBeTruthy();
        report.messageDomCounts[item.type]++;
        cleanup();
      }
      const diffs = history.items.filter((item) => item.role === "file");
      report.diffItems += diffs.length;
      for (const diff of diffs) {
        expect(() => parseDiffLines(diff.content, "modify")).not.toThrow();
      }
      const diff = diffs.find((item) => item.content && item.file_path);
      if (diff) {
        const [fileChange] = fileChangesFromHistoryItems([diff]);
        const view = render(<>{renderTimelineEntry({ kind: "fileChange", timestamp: fileChange.timestamp, fileChange }, { [fileChange.id]: true }, () => {}, true)}</>);
        expect(view.getByTestId("codex-tool-row").textContent).toContain(diff.file_path!);
        expect(view.container.querySelectorAll("[data-line]").length).toBe(diff.content.split("\n").length);
        expect(view.container.querySelector("script")).toBeNull();
        report.diffDomSamples.push(`${session.id}:${diff.file_path}`);
        cleanup();
      }
    }
  }, 60_000);
});
