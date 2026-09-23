import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SubagentInspector, SubagentInspectorTasks } from "../SubagentInspector";
import { ChatTasksPanel } from "../../ChatTasksPanel";

afterEach(cleanup);
describe("floating stacked card placement", () => {
  it("keeps the cards in the chat stage below the full-width top bar", async () => {
    vi.mocked(invoke).mockResolvedValue({ toolUseId: "task", childId: "child", status: "completed", items: [] });
    render(<SubagentInspector provider="Codex" parentThreadId="parent" workDir="/repo" subagents={[{ toolUseId: "task", title: "Reviewer", status: "completed" }]}>
      <div data-testid="thread-shell">
        <header data-testid="thread-topbar">Thread tools</header>
        <div className="subagent-card-stage" data-testid="chat-stage">
          <p>Conversation</p>
          <SubagentInspectorTasks><ChatTasksPanel todos={[{ id: "todo", content: "Review", status: "in_progress" }]} /></SubagentInspectorTasks>
        </div>
      </div>
    </SubagentInspector>);
    const card = await screen.findByRole("complementary", { name: "Subagents" });
    expect(screen.getByTestId("chat-stage").contains(card)).toBe(true);
    expect(screen.getByTestId("chat-stage").contains(screen.getByRole("complementary", { name: "Tasks" }))).toBe(true);
    expect(screen.getByTestId("thread-topbar").parentElement).toBe(screen.getByTestId("thread-shell"));
    expect(screen.getByTestId("subagent-inspector-layout").querySelector(":scope > .subagent-overview-host")).toBeNull();
  });
});
