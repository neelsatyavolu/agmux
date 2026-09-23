/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { RecalculateDiffAction } from "../RecalculateDiffAction";
import { ShellDiffBadge } from "../ShellDiffBadge";
import { recalculateSessionDiff, type DiffRecalculationResult } from "../../../lib/recalculateDiff";
import { useUiStore } from "../../../stores/uiStore";
import { useThreadStore } from "../../../stores/threadStore";
import { useShellDiffStore } from "../../../stores/shellDiffStore";
import { useDiffRecalculationStore } from "../../../stores/diffRecalculationStore";
import type { Thread } from "../../../lib/types";
import { readFileSync } from "node:fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn() }));

const target = { kind: "codex" as const, id: "native", cwd: "/repo" };
const stats = { linesAdded: 12, linesRemoved: 3, filesChanged: 2 };
const result: DiffRecalculationResult = {
  threadId: null, sessionId: "native", provider: "Codex", ...stats, source: "history", shell: [],
};

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(result);
  useUiStore.setState({ codexDiffStatsById: {}, claudeSessionDiffStatsById: {} });
  useThreadStore.setState({ threads: {} });
  useShellDiffStore.setState({ rows: {} });
  useDiffRecalculationStore.setState({ notices: {} });
});
afterEach(cleanup);

describe("Recalculate diff", () => {
  it.skipIf(!process.env.AGMUX_RECALCULATE_NOTES_PAYLOAD)("renders the real Notes backend response as unavailable after the menu closes", async () => {
    const recorded: DiffRecalculationResult = JSON.parse(readFileSync(process.env.AGMUX_RECALCULATE_NOTES_PAYLOAD!, "utf8"));
    expect(recorded.captureIncomplete).toBe(true);
    expect(recorded.sessionId).toBe("01a0a1dd-13db-7720-b4a4-989c45eb0c5e");
    vi.mocked(invoke).mockImplementation(async (command) => command === "list_shell_diff_stats" ? [] : recorded);
    const selected = { kind: "codex" as const, id: recorded.sessionId!, cwd: "/Users/neel/Documents/GitHub/infocus-packages" };
    const { rerender } = render(<><RecalculateDiffAction target={selected} /><ShellDiffBadge id={selected.id} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    expect(await screen.findByText("Diff unavailable")).toBeTruthy();
    rerender(<ShellDiffBadge id={selected.id} />);
    expect(screen.getByText("Diff unavailable")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("shows unavailable in the sidebar when missing before-images cannot be reconstructed", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "list_shell_diff_stats" ? [] : {
      ...result, linesAdded: 0, linesRemoved: 0, filesChanged: 0, captureIncomplete: true,
    });
    const { rerender } = render(<><RecalculateDiffAction target={target} /><ShellDiffBadge id="native" /></>);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    expect(await screen.findByText("Diff unavailable")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("original file versions");
    expect(screen.queryByText("Diff recalculated")).toBeNull();
    rerender(<ShellDiffBadge id="native" />);
    expect(screen.getByText("Diff unavailable")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("keeps an explicit zero recalculation visible instead of silently hiding it", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "list_shell_diff_stats" ? [] : {
      ...result, linesAdded: 0, linesRemoved: 0, filesChanged: 0, captureIncomplete: false,
    });
    render(<><RecalculateDiffAction target={target} /><ShellDiffBadge id="native" /></>);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    expect(await screen.findByText("No diff recorded")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No recorded file changes were found.");
  });

  it("shows progress, suppresses duplicate requests, and publishes absolute native and shell totals", async () => {
    let resolve!: (value: DiffRecalculationResult) => void;
    vi.mocked(invoke).mockReturnValue(new Promise((done) => { resolve = done; }));
    const refreshed = vi.fn();
    render(<RecalculateDiffAction target={target} onRecalculated={refreshed} />);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    expect((screen.getByRole("button", { name: "Recalculating diff…" }) as HTMLButtonElement).disabled).toBe(true);
    const duplicate = recalculateSessionDiff(target);
    expect(invoke).toHaveBeenCalledTimes(1);
    const shell = { ownerId: "native", sessionId: null, linesAdded: 4, linesRemoved: 1, filesChanged: 1 };
    await act(async () => { resolve({ ...result, shell: [shell] }); await duplicate; });
    expect(useUiStore.getState().codexDiffStatsById.native).toEqual(stats);
    expect(useShellDiffStore.getState().rows.native).toEqual(shell);
    expect(screen.getByRole("status").textContent).toBe("Diff recalculated");
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("retains counts on failure and allows retry", async () => {
    useUiStore.getState().setCodexDiffStats("native", stats);
    vi.mocked(invoke).mockRejectedValueOnce("Session history is unavailable");
    render(<RecalculateDiffAction target={target} />);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Session history is unavailable");
    expect(useUiStore.getState().codexDiffStatsById.native).toEqual(stats);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    await screen.findByText("Diff recalculated");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("publishes a verified zero result instead of retaining stale totals", async () => {
    useUiStore.getState().setCodexDiffStats("native", stats);
    vi.mocked(invoke).mockResolvedValue({ ...result, linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    await recalculateSessionDiff(target);
    expect(useUiStore.getState().codexDiffStatsById.native).toEqual({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
  });

  it("reports saved-only refresh without overwriting native history counts", async () => {
    useUiStore.getState().setCodexDiffStats("native", stats);
    vi.mocked(invoke).mockResolvedValue({ ...result, source: "saved", linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    render(<RecalculateDiffAction target={target} />);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate diff" }));
    await screen.findByText("Saved counts refreshed. This session does not support a full recalculation.");
    expect(useUiStore.getState().codexDiffStatsById.native).toEqual(stats);
  });

  it("does not replace newer native, thread, or shell events with an older response", async () => {
    const thread = { id: "thread", lines_added: 1, lines_removed: 0, files_changed: 1 } as Thread;
    useThreadStore.setState({ threads: { project: [thread] } });
    let resolve!: (value: DiffRecalculationResult) => void;
    vi.mocked(invoke).mockReturnValue(new Promise((done) => { resolve = done; }));
    const request = recalculateSessionDiff(target);
    const newer = { linesAdded: 30, linesRemoved: 5, filesChanged: 4 };
    useUiStore.getState().setCodexDiffStats("native", newer);
    useThreadStore.getState().patchThreadDiffStats("thread", 30, 5, 4);
    useShellDiffStore.getState().update({ ownerId: "native", sessionId: null, ...newer });
    resolve({ ...result, threadId: "thread", shell: [{ ownerId: "native", sessionId: null, ...stats }] });
    await request;
    expect(useUiStore.getState().codexDiffStatsById.native).toEqual(newer);
    expect(useThreadStore.getState().threads.project[0].lines_added).toBe(30);
    expect(useShellDiffStore.getState().rows.native.linesAdded).toBe(30);
  });

  it("updates a DB thread without adding shell totals into its counters", async () => {
    useThreadStore.setState({ threads: { project: [{ id: "thread", lines_added: 1, lines_removed: 0, files_changed: 1 } as Thread] } });
    vi.mocked(invoke).mockResolvedValue({ ...result, threadId: "thread", sessionId: "claude", provider: "ClaudeCode",
      shell: [{ ownerId: "thread", sessionId: "claude", linesAdded: 20, linesRemoved: 2, filesChanged: 1 }] });
    await recalculateSessionDiff({ kind: "thread", id: "thread", cwd: "/repo" });
    expect(useThreadStore.getState().threads.project[0].lines_added).toBe(12);
    expect(useUiStore.getState().claudeSessionDiffStatsById.claude).toEqual(stats);
    expect(useShellDiffStore.getState().rows.thread.linesAdded).toBe(20);
  });
});
