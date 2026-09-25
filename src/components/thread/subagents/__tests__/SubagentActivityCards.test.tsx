import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SubagentInspector, SubagentInspectorTasks } from "../SubagentInspector";
import { ChatTasksPanel } from "../../ChatTasksPanel";
import { useSettingsStore } from "../../../../stores/settingsStore";
import type { SubagentProvider, SubagentReference } from "../../../../lib/subagentConversations";
const references: SubagentReference[] = [
  { toolUseId: "impl", childId: "child1", title: "Implementation", prompt: "Cache the search index", status: "running" },
  { toolUseId: "tests", childId: "child2", title: "Tests", prompt: "Test cache invalidation", status: "waiting" },
  { toolUseId: "review", childId: "child3", title: "Code review", status: "completed" },
];
function Harness({ provider = "Codex", active = true }: { provider?: SubagentProvider; active?: boolean }) {
  return <SubagentInspector provider={provider} parentThreadId="parent" workDir="/repo" presentationActive={active} subagents={references}>
    <p>Parent conversation</p>
    <SubagentInspectorTasks><ChatTasksPanel todos={[{ id: "task1", content: "Cache index", status: "in_progress" }]} /></SubagentInspectorTasks>
  </SubagentInspector>;
}
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
    const params = args as { toolUseId: string; activityOnly?: boolean };
    const reference = references.find((r) => r.toolUseId === params.toolUseId)!;
    return { toolUseId: reference.toolUseId, childId: reference.childId, status: reference.status, items: params.activityOnly
      ? [{ id: "tool", type: "tool", text: "", toolName: "Edit", toolInput: { file_path: "/repo/search.ts" }, pending: true }]
      : [{ id: "answer", type: "assistant", text: "Child conversation contents" }] };
  });
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, animationSpeed: "none" } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("stacked Tasks and Subagents cards", () => {
  it.each(["Codex", "ClaudeCode", "Cursor", "Grok"] as const)("shows %s roster even when no transcript launch rows are mounted", async (provider) => {
    render(<Harness provider={provider} />);
    const card = await screen.findByRole("complementary", { name: "Subagents" });
    expect(screen.getByRole("complementary", { name: "Tasks" })).toBeTruthy();
    expect(within(card).getByText("2 active")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Open Implementation conversation/ }).textContent).toContain("Running");
    expect(within(card).getByRole("button", { name: /Open Tests conversation/ }).textContent).toContain("Waiting");
    expect(within(card).queryByRole("button", { name: /Open Code review conversation/ })).toBeNull();
    await within(card).findAllByText(/search.ts/);
    fireEvent.click(within(card).getByRole("button", { name: /Open Implementation conversation/ }));
    const inspector = await screen.findByRole("complementary", { name: "Subagent conversation" });
    await within(inspector).findByText("Child conversation contents");
    expect(screen.queryByRole("complementary", { name: "Subagents" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Tasks" })).toBeNull();
    fireEvent.click(within(inspector).getByRole("button", { name: "Close subagent conversation" }));
    expect(await screen.findByRole("complementary", { name: "Subagents" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Tasks" })).toBeTruthy();
  });
  it("Task 13: card chrome uses the flat panel/chip/icon-tile classes and a blue spinner for running (not a static amber dot)", async () => {
    render(<Harness />);
    const card = await screen.findByRole("complementary", { name: "Subagents" });
    expect(card.className).toContain("chat-activity-card");
    expect(within(card).getByText("2 active").className).toContain("fx-chip-q");
    const runningRow = within(card).getByRole("button", { name: /Open Implementation conversation/ });
    expect(runningRow.querySelector(".subagent-avatar-tile")).toBeTruthy();
    expect(runningRow.querySelector(".animate-spin")).toBeTruthy();
  });

  it("L1: 'Subagents' title outweighs the 'Active agents' eyebrow (13px/600 vs the eyebrow's smaller default), and the active count isn't duplicated next to the eyebrow", async () => {
    render(<Harness />);
    const card = await screen.findByRole("complementary", { name: "Subagents" });
    const title = within(card).getByText("Subagents");
    expect(title.className).toContain("text-[13px]");
    expect(title.className).toContain("font-semibold");
    const eyebrow = within(card).getByText("Active agents");
    expect(eyebrow.className).toContain("ui-eyebrow");
    // Only the header chip ("2 active") carries the count now — no second
    // count span sits next to the "Active agents" eyebrow.
    expect(eyebrow.parentElement?.textContent).toBe("Active agents");
  });

  it("refreshes status without loading full conversations and pauses hidden parents", async () => {
    vi.useFakeTimers();
    const mounted = render(<Harness />);
    await act(async () => {});
    expect(vi.mocked(invoke).mock.calls.length).toBe(2);
    expect(vi.mocked(invoke).mock.calls.every(([, args]) => (args as { activityOnly: boolean }).activityOnly)).toBe(true);
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => ({ toolUseId: (args as { toolUseId: string }).toolUseId, childId: "child", status: "completed", items: [] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("All subagents finished")).toBeTruthy();
    const count = vi.mocked(invoke).mock.calls.length;
    mounted.rerender(<Harness active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(vi.mocked(invoke).mock.calls.length).toBe(count);
  });
  it("lets each card collapse independently and retains completed agents", async () => {
    render(<Harness />);
    const card = await screen.findByRole("complementary", { name: "Subagents" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse tasks" }));
    expect(within(card).getByRole("button", { name: /Open Implementation conversation/ })).toBeTruthy();
    fireEvent.click(within(card).getByText("Completed"));
    expect(within(card).getByRole("button", { name: /Open Code review conversation/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Collapse subagents" }));
    expect(within(card).queryByRole("button", { name: /Open Implementation conversation/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Expand subagents" }));
    expect(within(card).getByRole("button", { name: /Open Implementation conversation/ })).toBeTruthy();
  });
});
