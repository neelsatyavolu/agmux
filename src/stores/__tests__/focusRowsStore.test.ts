/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "../uiStore";
import { FOCUS_DISMISSED_KEY, FOCUS_DISMISS_TTL_MS, FOCUS_PINNED_KEY, loadFocusDismissals, loadFocusPins, useFocusRowsStore } from "../focusRowsStore";

beforeEach(() => {
  localStorage.clear();
  useFocusRowsStore.setState({ timestampsByProject: {}, pinnedByProject: {}, pinnedIds: {}, extraShown: 0, dismissedAt: {} });
});

describe("focusRowsStore pins", () => {
  it("toggles and saves a Focus pin", () => {
    useFocusRowsStore.getState().toggleFocusPin("t1");
    expect(useFocusRowsStore.getState().pinnedIds).toEqual({ t1: true });
    expect(loadFocusPins()).toEqual({ t1: true });
    useFocusRowsStore.getState().toggleFocusPin("t1");
    expect(useFocusRowsStore.getState().pinnedIds).toEqual({});
    expect(loadFocusPins()).toEqual({});
  });

  it("ignores malformed saved pins", () => {
    localStorage.setItem(FOCUS_PINNED_KEY, JSON.stringify(["ok", 3, null]));
    expect(loadFocusPins()).toEqual({ ok: true });
    localStorage.setItem(FOCUS_PINNED_KEY, "{bad");
    expect(loadFocusPins()).toEqual({});
  });
});

describe("focusRowsStore rows", () => {
  it("keeps pinned counts apart from ranked times and drops both with the project", () => {
    useFocusRowsStore.getState().setProjectTimestamps("p1", [3, 2], 1);
    expect(useFocusRowsStore.getState().timestampsByProject).toEqual({ p1: [3, 2] });
    expect(useFocusRowsStore.getState().pinnedByProject).toEqual({ p1: 1 });
    useFocusRowsStore.getState().removeProject("p1");
    expect(useFocusRowsStore.getState().timestampsByProject).toEqual({});
    expect(useFocusRowsStore.getState().pinnedByProject).toEqual({});
  });
});

describe("focusRowsStore dismissals", () => {
  it("records and saves a removal", () => {
    useFocusRowsStore.getState().dismissFromFocus("t1", 1000);
    expect(useFocusRowsStore.getState().dismissedAt).toEqual({ t1: 1000 });
    expect(JSON.parse(localStorage.getItem(FOCUS_DISMISSED_KEY)!)).toEqual({ t1: 1000 });
  });

  it("loads saved removals and drops old or malformed ones", () => {
    const now = 10 * FOCUS_DISMISS_TTL_MS;
    localStorage.setItem(FOCUS_DISMISSED_KEY, JSON.stringify({
      fresh: now - 1000,
      stale: now - FOCUS_DISMISS_TTL_MS - 1,
      bad: "x",
    }));
    expect(loadFocusDismissals(now)).toEqual({ fresh: now - 1000 });
  });

  it("survives unreadable storage", () => {
    localStorage.setItem(FOCUS_DISMISSED_KEY, "{not json");
    expect(loadFocusDismissals(Date.now())).toEqual({});
  });
});

describe("focusRowsStore finish times", () => {
  it("records when a thread stops working or waiting for approval", () => {
    useFocusRowsStore.setState({ finishedAt: {} });
    useUiStore.setState({ claudeProcessingById: { a: true }, codexProcessingById: { b: true } } as Partial<ReturnType<typeof useUiStore.getState>>);
    expect(useFocusRowsStore.getState().finishedAt).toEqual({});
    const before = Date.now();
    useUiStore.setState({ claudeProcessingById: { a: false }, codexProcessingById: { b: true } } as Partial<ReturnType<typeof useUiStore.getState>>);
    const { finishedAt } = useFocusRowsStore.getState();
    expect(Object.keys(finishedAt)).toEqual(["a"]);
    expect(finishedAt.a).toBeGreaterThanOrEqual(before);
    useUiStore.setState({ codexProcessingById: {} } as Partial<ReturnType<typeof useUiStore.getState>>);
    expect(Object.keys(useFocusRowsStore.getState().finishedAt).sort()).toEqual(["a", "b"]);
  });

  it("does not count a hand-off from working to awaiting approval as finishing", () => {
    useFocusRowsStore.setState({ finishedAt: {} });
    useUiStore.setState({ claudeProcessingById: { c: true } } as Partial<ReturnType<typeof useUiStore.getState>>);
    useUiStore.setState({
      claudeProcessingById: {},
      pendingApprovalsBySession: { c: { toolName: "Bash" } },
    } as unknown as Partial<ReturnType<typeof useUiStore.getState>>);
    expect(useFocusRowsStore.getState().finishedAt).toEqual({});
  });
});
