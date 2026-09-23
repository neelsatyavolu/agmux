import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { retainShellDiffStats, selectShellDiffStats, useShellDiffStore, type ShellDiffStats } from "../shellDiffStore";

const row: ShellDiffStats = { ownerId: "owner", sessionId: "native", linesAdded: 4, linesRemoved: 2, filesChanged: 1 };
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  vi.clearAllMocks();
  useShellDiffStore.setState({ rows: {} });
});

describe("shell diff totals", () => {
  it("matches owner or native aliases once and replaces repeated absolute totals", () => {
    const store = useShellDiffStore.getState();
    store.update(row);
    store.update(row);
    expect(selectShellDiffStats(useShellDiffStore.getState().rows, ["owner", "native"])).toEqual(row);
    store.update({ ...row, linesAdded: 7 });
    expect(selectShellDiffStats(useShellDiffStore.getState().rows, ["native"])?.linesAdded).toBe(7);
    expect(selectShellDiffStats(useShellDiffStore.getState().rows, ["unrelated"])).toBeUndefined();
    store.update({ ...row, linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    expect(selectShellDiffStats(useShellDiffStore.getState().rows, ["owner"])?.linesAdded).toBe(0);
  });

  it("shares one listener/load and keeps live totals over a stale initial snapshot", async () => {
    let resolveLoad!: (rows: ShellDiffStats[]) => void;
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve as typeof resolveLoad; }));
    const releaseA = retainShellDiffStats();
    const releaseB = retainShellDiffStats();
    await flush();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("list_shell_diff_stats");
    const callback = vi.mocked(listen).mock.calls[0][1];
    callback({ payload: { ...row, linesAdded: 9 }, event: "shell-diff-updated", id: 1 });
    resolveLoad([row]);
    await flush();
    expect(useShellDiffStore.getState().rows.owner.linesAdded).toBe(9);
    releaseA();
    expect(unlisten).not.toHaveBeenCalled();
    releaseB();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockResolvedValue([row]);
    const releaseC = retainShellDiffStats();
    await flush();
    expect(listen).toHaveBeenCalledTimes(2);
    expect(useShellDiffStore.getState().rows.owner.linesAdded).toBe(4);
    releaseC();
    await flush();
  });
});

it("cleans up a listener that finishes registering after unmount", async () => {
  let resolveListen!: (unlisten: () => void) => void;
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(() => new Promise((resolve) => { resolveListen = resolve; }));
  const release = retainShellDiffStats();
  release();
  await flush();
  resolveListen(unlisten);
  await flush();
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});
