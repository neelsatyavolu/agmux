import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SubagentInspector } from "../SubagentInspector";
import { useSubagentInspector } from "../SubagentInspectorContext";
import { SubagentLaunchRow } from "../SubagentLaunchRow";
import { useSettingsStore } from "../../../../stores/settingsStore";
import type { SubagentReference } from "../../../../lib/subagentConversations";

const oldAgent: SubagentReference = { toolUseId: "old", title: "Old conversation agent", status: "completed" };
const currentAgent: SubagentReference = { toolUseId: "current", title: "Current agent", status: "running" };
const mountedParent = vi.fn();
function Parent() {
  const inspector = useSubagentInspector()!;
  useEffect(() => { mountedParent(); }, []);
  return <>
    <output data-testid="registry">{JSON.stringify({ references: inspector.references, statuses: inspector.statuses, activity: inspector.activity, selectedId: inspector.selectedId })}</output>
    <button onClick={() => inspector.open(inspector.references[0])}>Inspect first</button>
  </>;
}
function view(agents: SubagentReference[], nativeId = "native-one", staleRow = false) {
  return <SubagentInspector provider="Codex" parentThreadId="parent" parentSessionId={nativeId} workDir="/repo" subagents={agents}>
    <Parent />
    {staleRow && <SubagentLaunchRow {...oldAgent} />}
  </SubagentInspector>;
}
function registry() { return JSON.parse(screen.getByTestId("registry").textContent!); }
beforeEach(() => {
  mountedParent.mockReset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, animationSpeed: "none" } }));
});
afterEach(cleanup);

it("replaces a nonempty roster and cannot re-register a row outside the current feed", () => {
  const mounted = render(view([oldAgent]));
  mounted.rerender(view([currentAgent], "native-one", true));
  expect(registry().references.map((r: SubagentReference) => r.toolUseId)).toEqual(["current"]);
  expect(mountedParent).toHaveBeenCalledTimes(1);
});

it("retains completed agents that still belong to the current conversation", () => {
  const mounted = render(view([oldAgent]));
  mounted.rerender(view([oldAgent, currentAgent]));
  expect(registry().references.map((r: SubagentReference) => r.toolUseId)).toEqual(["old", "current"]);
});

it("does not restart activity reads when streaming recreates an unchanged roster", async () => {
  const mounted = render(view([currentAgent]));
  await act(async () => {});
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  mounted.rerender(view([{ ...currentAgent }]));
  await act(async () => {});
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
});

it("forgets an open agent removed by the parent feed even if that tool ID returns later", () => {
  const mounted = render(view([oldAgent, currentAgent]));
  fireEvent.click(screen.getByText("Inspect first"));
  expect(registry().selectedId).toBe("old");
  mounted.rerender(view([currentAgent]));
  expect(registry().selectedId).toBeNull();
  mounted.rerender(view([oldAgent, currentAgent]));
  expect(registry().selectedId).toBeNull();
});

it("invalidates cached completion when a tool ID refers to a different child", async () => {
  const mounted = render(view([{ ...currentAgent, childId: "first-child" }]));
  vi.mocked(invoke).mockResolvedValueOnce({ toolUseId: "current", status: "completed", items: [{ id: "first-answer", type: "assistant", text: "First child answer" }] });
  fireEvent.click(screen.getByText("Inspect first"));
  await act(async () => {});
  expect(registry().statuses.current).toBe("completed");
  mounted.rerender(view([{ ...currentAgent, childId: "second-child" }]));
  expect(registry().statuses).toEqual({});
  expect(screen.queryByText("First child answer")).toBeNull();
});

it("clears selection and cached completion when the native parent changes without remounting chat", async () => {
  const mounted = render(view([currentAgent]));
  vi.mocked(invoke).mockResolvedValueOnce({ toolUseId: "current", status: "completed", items: [] });
  fireEvent.click(screen.getByText("Inspect first"));
  await act(async () => {});
  expect(registry().statuses.current).toBe("completed");
  mounted.rerender(view([currentAgent], "native-two"));
  expect(registry().selectedId).toBeNull();
  expect(registry().statuses).toEqual({});
  expect(registry().activity).toEqual({});
  expect(mountedParent).toHaveBeenCalledTimes(1);
});

it("ignores a pending child history response from the previous parent scope", async () => {
  const mounted = render(view([currentAgent]));
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByText("Inspect first"));
  mounted.rerender(view([currentAgent], "native-two"));
  await act(async () => { finish({ toolUseId: "current", status: "completed", items: [{ id: "old", type: "assistant", text: "Previous conversation" }] }); });
  expect(registry().statuses).toEqual({});
  expect(registry().selectedId).toBeNull();
  expect(screen.queryByText("Previous conversation")).toBeNull();
});

it("does not show stale completion in an open conversation after the parent reports running", async () => {
  const mounted = render(view([{ ...currentAgent, status: "completed" }]));
  vi.mocked(invoke).mockResolvedValueOnce({ toolUseId: "current", status: "completed", items: [{ id: "answer", type: "assistant", text: "Previous result" }] });
  fireEvent.click(screen.getByText("Inspect first"));
  await act(async () => {});
  const panel = within(screen.getByRole("complementary", { name: "Subagent conversation" }));
  expect(panel.getByText("Completed")).toBeTruthy();
  mounted.rerender(view([currentAgent]));
  expect(panel.queryByText("Completed")).toBeNull();
  expect(panel.getByText("Running")).toBeTruthy();
  expect(panel.getByText("Previous result")).toBeTruthy();
  fireEvent.click(panel.getByRole("button", { name: "Close subagent conversation" }));
  expect(screen.queryByRole("complementary", { name: "Subagent conversation" })).toBeNull();
  expect(registry().statuses).toEqual({});
});
