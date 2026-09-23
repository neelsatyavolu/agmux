import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SubagentInspector, SubagentInspectorTasks } from "../SubagentInspector";
import { SubagentLaunchRow } from "../SubagentLaunchRow";
import { ToolUseBlock } from "../../ToolUseBlock";
import { useSettingsStore } from "../../../../stores/settingsStore";
import type { SubagentProvider } from "../../../../lib/subagentConversations";

vi.mock("../../ToolDetailDialog", () => ({ ToolDetailDialog: () => null }));
const mockedInvoke = vi.mocked(invoke);
const snapshot = {
  childId: "child-1", toolUseId: "launch-1", status: "completed",
  items: [
    { id: "u1", type: "user", text: "Check the search cache" },
    { id: "t1", type: "thinking", text: "Inspect the invalidation path first." },
    { id: "r1", type: "tool", text: "", toolName: "Read", toolInput: { file_path: "/repo/search.ts" }, toolResult: "const cached = true;", pending: false },
    { id: "e1", type: "tool", text: "", toolName: "Edit", toolInput: { file_path: "/repo/search.ts", old_string: "old", new_string: "new" }, toolResult: "Updated", pending: false },
    { id: "b1", type: "tool", text: "", toolName: "Bash", toolInput: { command: "npm test" }, toolResult: "3 tests passed", pending: false },
    { id: "m1", type: "tool", text: "", toolName: "mcp__docs__search", toolInput: { query: "cache" }, toolResult: "Cache documentation", pending: false },
    { id: "a1", type: "assistant", text: "The cache is **correct**." },
  ],
};
function Harness({ provider = "ClaudeCode", tool = false }: { provider?: SubagentProvider; tool?: boolean }) {
  return <SubagentInspector provider={provider} parentThreadId="parent-1" parentSessionId="native-parent" workDir="/repo">
    <div data-testid="parent">Parent conversation</div>
    {tool ? <ToolUseBlock name={provider === "Grok" ? "spawn_subagent" : provider === "ClaudeCode" ? "Agent" : "task"} toolId="launch-1" input={{ description: "Reviewer", prompt: "Check the search cache" }} pending /> :
      <SubagentLaunchRow toolUseId="launch-1" childId="child-1" title="Reviewer" prompt="Check the search cache" status="completed" />}
    <SubagentLaunchRow toolUseId="launch-2" childId="child-2" title="Tests" status="waiting" />
    <SubagentInspectorTasks><div>Parent tasks</div></SubagentInspectorTasks>
  </SubagentInspector>;
}
beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(snapshot);
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, animationSpeed: "none" } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared subagent inspector", () => {
  it.each(["ClaudeCode", "Cursor", "Grok", "Codex"] as const)("renders %s history with real shared tool renderers and no provider lifecycle calls", async (provider) => {
    render(<Harness provider={provider} />);
    expect(mockedInvoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    const panel = await screen.findByRole("complementary", { name: "Subagent conversation" });
    await within(panel).findByText("The cache is", { exact: false });
    expect(within(panel).getByText("correct").tagName).toBe("STRONG");
    expect(within(panel).getAllByTestId("codex-tool-row").length).toBeGreaterThanOrEqual(4);
    const read = within(panel).getAllByTestId("codex-tool-row").find((row) => row.getAttribute("data-lead") === "Read")!;
    fireEvent.click(read);
    expect(await within(panel).findByText("const cached = true;", { exact: false })).toBeTruthy();
    const bash = within(panel).getAllByTestId("codex-tool-row").find((row) => row.textContent?.includes("npm test"))!;
    fireEvent.click(bash);
    expect(await within(panel).findByText("3 tests passed")).toBeTruthy();
    expect(within(panel).getByTestId("codex-term")).toBeTruthy();
    const edit = within(panel).getAllByTestId("codex-tool-row").find((row) => row.getAttribute("data-lead") === "Edit")!;
    fireEvent.click(edit);
    expect(await within(panel).findByText("new", { exact: true })).toBeTruthy();
    expect(within(panel).getByText("old", { exact: true })).toBeTruthy();
    expect(screen.getByTestId("parent").textContent).toBe("Parent conversation");
    expect(screen.getByText("Viewing")).toBeTruthy();
    expect(screen.queryByText("Parent tasks")).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("read_subagent_conversation", expect.objectContaining({ provider, parentThreadId: "parent-1", parentSessionId: "native-parent", childId: "child-1", toolUseId: "launch-1" }));
    expect(mockedInvoke.mock.calls.map(([command]) => command).filter((command) => /(?:start|resume|send|interrupt|stop|respond)/.test(command))).toEqual([]);
    fireEvent.click(within(panel).getByRole("button", { name: "Close subagent conversation" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByText("Parent tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View Reviewer conversation" }).textContent).toContain("Completed");
  });
  it.each(["ClaudeCode", "Cursor", "Grok", "OpenCode", "Gemini", "MLX"] as const)("opens the inspector from the real %s launch tool", async (provider) => {
    render(<Harness provider={provider} tool />);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    expect(await screen.findByRole("complementary")).toBeTruthy();
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("read_subagent_conversation", expect.objectContaining({ provider, toolUseId: "launch-1" })));
  });
  it.each(["Gemini", "MLX"] as const)("shows %s launch details when native child history is unavailable", async (provider) => {
    mockedInvoke.mockResolvedValue({ childId: null, toolUseId: "launch-1", status: "unknown", items: [], unavailableReason: "This provider does not expose a saved subagent conversation." });
    render(<SubagentInspector provider={provider} parentThreadId="parent" workDir="/repo">
      <ToolUseBlock name="task" toolId="launch-1" input={{ description: "Reviewer", prompt: "Review cache" }} pending={false} result={{ content: "The cache is correct.", isError: false }} />
    </SubagentInspector>);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    const panel = await screen.findByRole("complementary");
    await within(panel).findByText("This provider does not expose a saved subagent conversation.");
    expect(within(panel).getByText("Review cache")).toBeTruthy();
    expect(within(panel).getByText("Launch result")).toBeTruthy();
    expect(within(panel).getByText("The cache is correct.")).toBeTruthy();
    expect(within(panel).getByText("Completed")).toBeTruthy();
  });
  it.each(['<task id="ses_child" state="completed">Cache verified</task>', '[{"type":"text","text":"Cache verified"}]'])("renders readable launch results without a saved transcript: %s", async (content) => {
    mockedInvoke.mockResolvedValue({ childId: null, toolUseId: "launch-1", status: "unknown", items: [], unavailableReason: "No saved child history." });
    render(<SubagentInspector provider="OpenCode" parentThreadId="parent" workDir="/repo">
      <ToolUseBlock name="task" toolId="launch-1" input={{ description: "Reviewer" }} pending={false} result={{ content, isError: false }} />
    </SubagentInspector>);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    expect(await screen.findByText("Cache verified")).toBeTruthy();
  });
  it("does not show stale child history when switching while a read is pending", async () => {
    let finishFirst!: (value: unknown) => void;
    mockedInvoke.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    mockedInvoke.mockResolvedValueOnce({ ...snapshot, childId: "child-2", toolUseId: "launch-2", items: [{ id: "u2", type: "assistant", text: "Second child only" }] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: /Tests/ }));
    await screen.findByText("Second child only");
    finishFirst(snapshot);
    await waitFor(() => expect(screen.queryByText("The cache is", { exact: false })).toBeNull());
  });
  it("shows unavailable history honestly and retries without resuming", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("Transcript not available"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    expect(await screen.findByText("Transcript not available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("The cache is", { exact: false });
    expect(mockedInvoke.mock.calls.map(([command]) => command).filter((command) => /(?:start|resume|send|interrupt|stop|respond)/.test(command))).toEqual([]);
  });
  it("pauses history reads while the parent surface is hidden and stops on close", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ ...snapshot, status: "running" });
    const view = (active: boolean) => <SubagentInspector provider="Cursor" parentThreadId="parent-1" workDir="/repo" presentationActive={active}>
      <SubagentLaunchRow toolUseId="launch-1" title="Reviewer" status="running" />
    </SubagentInspector>;
    const mounted = render(view(true));
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    mounted.rerender(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    mounted.rerender(view(true));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close subagent conversation" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
  it("updates a closed row when the parent reports completion after a running snapshot", async () => {
    mockedInvoke.mockResolvedValue({ ...snapshot, status: "running" });
    const view = (status: "running" | "completed") => <SubagentInspector provider="ClaudeCode" parentThreadId="parent-1" workDir="/repo">
      <SubagentLaunchRow toolUseId="launch-1" title="Reviewer" status={status} />
    </SubagentInspector>;
    const mounted = render(view("running"));
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    await screen.findByText("The cache is", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Close subagent conversation" }));
    mounted.rerender(view("completed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "View Reviewer conversation" }).textContent).toContain("Completed"));
  });

  it.each(["ClaudeCode", "Cursor", "Grok", "Codex"] as const)("cleans %s setup and renders the assignment in the regular chat shell", async (provider) => {
    mockedInvoke.mockResolvedValue({ ...snapshot, items: [
      { id: "setup", type: "user", text: "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Hidden bootstrap rules</INSTRUCTIONS>" },
      { id: "env", type: "user", text: "<environment_context>Hidden environment</environment_context>" },
      { id: "a1", type: "assistant", text: "The cache is correct." },
    ] });
    render(<Harness provider={provider} />);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    const panel = await screen.findByRole("complementary");
    await within(panel).findByText("The cache is correct.");
    expect(within(panel).queryByText(/Hidden bootstrap/)).toBeNull();
    expect(within(panel).queryByText(/Hidden environment/)).toBeNull();
    const prompt = within(panel).getByText("Check the search cache");
    expect(prompt.closest(".codex-bubble-user")).toBeTruthy();
    expect(prompt.closest(".codex-glass")).toBeTruthy();
    expect(panel.querySelector(".codex-wall")).toBeTruthy();
    expect(panel.querySelector(".codex-topbar")).toBeTruthy();
    expect(panel.className).not.toContain("surface-popover");
  });

  it("shows the authoritative delegated assignment and actual wrapped command", async () => {
    mockedInvoke.mockResolvedValue({ ...snapshot, assignment: "Inspect rerenders and report the expensive selectors.", items: [
      { id: "exec", type: "tool", text: "", toolName: "exec", toolInput: { input: 'text(await tools.exec_command({cmd:"rg useStore src"}));' }, toolResult: JSON.stringify([{ type: "input_text", text: JSON.stringify({ output: "src/store.ts:10", exit_code: 0 }) }]), pending: false },
    ] });
    render(<Harness provider="Codex" />);
    fireEvent.click(screen.getByRole("button", { name: "View Reviewer conversation" }));
    const panel = await screen.findByRole("complementary");
    await within(panel).findByText("Inspect rerenders and report the expensive selectors.");
    expect(within(panel).queryByText("Check the search cache")).toBeNull();
    expect(within(panel).queryByText("exec", { exact: true })).toBeNull();
    const row = within(panel).getByTestId("codex-tool-row");
    expect(row.textContent).toContain("rg useStore src");
    fireEvent.click(row);
    expect(await within(panel).findByText("src/store.ts:10")).toBeTruthy();
  });
  it("does not present an encrypted assignment as the parent prompt", async () => {
    mockedInvoke.mockResolvedValue({ ...snapshot, assignment: null, assignmentUnavailableReason: "The delegated assignment is encrypted in this saved conversation.", items: [] });
    render(<SubagentInspector provider="Codex" parentThreadId="parent-1" workDir="/repo">
      <SubagentLaunchRow toolUseId="launch-1" title="Scout" status="completed" prompt={"gAAAAA" + "x".repeat(90)} />
    </SubagentInspector>);
    fireEvent.click(screen.getByRole("button", { name: "View Scout conversation" }));
    await screen.findByText("The delegated assignment is encrypted in this saved conversation.");
    expect(screen.queryByText(/gAAAAA/)).toBeNull();
  });

});
