import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellDiffBadge } from "../ShellDiffBadge";
import { useShellDiffStore } from "../../../stores/shellDiffStore";
import { useUiStore } from "../../../stores/uiStore";
import { useDiffRecalculationStore } from "../../../stores/diffRecalculationStore";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

beforeEach(() => {
  useShellDiffStore.setState({ rows: {} });
  useDiffRecalculationStore.setState({ notices: {} });
  useUiStore.setState({ claudeSessionMap: { thread: ["native"] } });
  vi.mocked(invoke).mockResolvedValue([]);
  vi.mocked(listen).mockResolvedValue(() => {});
});
afterEach(cleanup);

it("hides absent/zero counts and shows shell-only changes through Claude mapping", () => {
  const { container } = render(<ShellDiffBadge id="thread" filesChanged={0} />);
  expect(container.textContent).toBe("");
  act(() => useShellDiffStore.getState().update({ ownerId: "native", sessionId: null, linesAdded: 5, linesRemoved: 1, filesChanged: 2 }));
  expect(container.textContent).toBe("+5 / -1");
  expect(container.firstElementChild?.getAttribute("title")).toBe("Includes verified shell changes");
  act(() => useShellDiffStore.getState().update({ ownerId: "native", sessionId: null, linesAdded: 0, linesRemoved: 0, filesChanged: 0 }));
  expect(container.textContent).toBe("");
});

it("adds only at render, preserves styles and keeps file counts separate across history refreshes", () => {
  useShellDiffStore.getState().update({ ownerId: "owner", sessionId: "native", linesAdded: 5, linesRemoved: 1, filesChanged: 2 });
  const { container, rerender } = render(<ShellDiffBadge id="native" linesAdded={3} linesRemoved={2} filesChanged={2} additionClassName="text-emerald-400/80" />);
  expect(container.textContent).toBe("+8 / -3");
  expect(container.querySelector(".text-emerald-400\\/80")).not.toBeNull();
  expect(container.firstElementChild?.getAttribute("title")).toBe("Includes verified shell changes");
  rerender(<ShellDiffBadge id="native" linesAdded={1} linesRemoved={0} filesChanged={1} />);
  expect(container.textContent).toBe("+6 / -1");
  expect(useShellDiffStore.getState().rows.owner.linesAdded).toBe(5);
});

it("matches an explicit SDK session alias without double counting the owner", () => {
  useShellDiffStore.getState().update({ ownerId: "thread", sessionId: "sdk", linesAdded: 2, linesRemoved: 0, filesChanged: 1 });
  const { container } = render(<ShellDiffBadge id="thread" sessionId="sdk" />);
  expect(container.textContent).toBe("+2 / -0");
});

it("shows verified file-only shell changes even with no line changes", () => {
  useShellDiffStore.getState().update({ ownerId: "binary", sessionId: null, linesAdded: 0, linesRemoved: 0, filesChanged: 1 });
  const { container } = render(<ShellDiffBadge id="binary" />);
  expect(container.textContent).toBe("+0 / -0");
  expect(container.firstElementChild?.getAttribute("title")).toBe("Includes verified shell changes");
});

it("preserves native file tooltips when no shell changes are included", () => {
  const { container, rerender } = render(<ShellDiffBadge id="native-only" linesAdded={2} filesChanged={1} />);
  expect(container.firstElementChild?.getAttribute("title")).toBe("1 file changed");
  rerender(<ShellDiffBadge id="native-only" linesAdded={2} filesChanged={3} />);
  expect(container.firstElementChild?.getAttribute("title")).toBe("3 files changed");
});

it("marks measured totals as partial when the mapped session has missing captures", () => {
  useDiffRecalculationStore.getState().record(["native"], "incomplete");
  const { container } = render(<ShellDiffBadge id="thread" linesAdded={7} linesRemoved={2} />);
  expect(container.textContent).toBe("+7 / -2 · partial");
  expect(container.firstElementChild?.getAttribute("title")).toContain("Partial totals");
});

it("explains unreadable history separately from missing file snapshots", () => {
  useDiffRecalculationStore.getState().record(["native"], "history-incomplete");
  const { container, rerender } = render(<ShellDiffBadge id="native" linesAdded={10} />);
  expect(container.textContent).toBe("+10 / -0 · partial");
  expect(container.firstElementChild?.getAttribute("title")).toBe("Partial totals: some session history could not be verified.");
  rerender(<ShellDiffBadge id="native" />);
  expect(container.textContent).toBe("Diff unavailable");
  expect(container.firstElementChild?.getAttribute("title")).not.toContain("Original file versions");
});

it("shows native file-only counts after recalculation", () => {
  const { container } = render(<ShellDiffBadge id="native" filesChanged={1} />);
  expect(container.textContent).toBe("+0 / -0");
  expect(container.firstElementChild?.getAttribute("title")).toBe("1 file changed");
});

it("retains and persists missing-capture notices when old hook metadata ages out", () => {
  useDiffRecalculationStore.getState().record(["native"], "incomplete");
  useDiffRecalculationStore.getState().record(["native"], "empty");
  useDiffRecalculationStore.getState().record(["native"], null);
  expect(useDiffRecalculationStore.getState().notices.native).toBe("incomplete");
  expect(JSON.parse(localStorage.getItem("agmux-diff-recalculation-notices") ?? "{}").native).toBe("incomplete");
});

it("does not rerender all badges for unchanged discovery notices", () => {
  const changed = vi.fn();
  const unsubscribe = useDiffRecalculationStore.subscribe(changed);
  useDiffRecalculationStore.getState().record(["native"], null);
  expect(changed).not.toHaveBeenCalled();
  useDiffRecalculationStore.getState().record(["native"], "incomplete");
  useDiffRecalculationStore.getState().record(["native"], "incomplete");
  useDiffRecalculationStore.getState().record(["native"], null);
  expect(changed).toHaveBeenCalledTimes(1);
  unsubscribe();
});
