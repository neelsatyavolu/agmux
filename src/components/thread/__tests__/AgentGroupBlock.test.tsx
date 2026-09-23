/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AgentGroupBlock, type AgentGroupMember } from "../AgentGroupBlock";

afterEach(() => cleanup());

const makeAgent = (overrides: Partial<AgentGroupMember> = {}): AgentGroupMember => ({
  toolId: "t-" + Math.random().toString(36).slice(2, 8),
  name: "Task",
  input: { description: "Run tests", subagent_type: "general-purpose" },
  pending: false,
  ...overrides,
});

describe("AgentGroupBlock", () => {
  it("renders 'N agents completed' when all done", () => {
    render(
      <AgentGroupBlock
        agents={[
          makeAgent({ result: { content: "ok", isError: false } }),
          makeAgent({ result: { content: "ok", isError: false } }),
        ]}
      />,
    );
    expect(screen.getByText("2 agents completed")).toBeTruthy();
  });

  it("renders 'Running N agents' when all are pending", () => {
    render(
      <AgentGroupBlock
        agents={[makeAgent({ pending: true }), makeAgent({ pending: true })]}
      />,
    );
    expect(screen.getByText("Running 2 agents")).toBeTruthy();
  });

  it("renders 'Running X of N agents' when partially pending", () => {
    render(
      <AgentGroupBlock
        agents={[makeAgent({ pending: true }), makeAgent({ pending: false })]}
      />,
    );
    expect(screen.getByText("Running 1 of 2 agents")).toBeTruthy();
  });

  it("shows common subagent type pill when agents share a type", () => {
    render(
      <AgentGroupBlock
        agents={[
          makeAgent(),
          makeAgent(),
        ]}
      />,
    );
    expect(screen.getByText("general-purpose")).toBeTruthy();
  });

  it("shows individual agent description rows when expanded", () => {
    render(<AgentGroupBlock agents={[makeAgent()]} />);
    expect(screen.getByText("Run tests")).toBeTruthy();
  });

  it("collapses individual rows when header is clicked", () => {
    render(<AgentGroupBlock agents={[makeAgent()]} />);
    const header = screen.getByText("1 agents completed").closest("[role='button']")!;
    fireEvent.click(header);
    expect(screen.queryByText("Run tests")).toBeNull();
  });

  it("renders background-running label when agents are run_in_background", () => {
    render(
      <AgentGroupBlock
        agents={[
          makeAgent({
            input: { description: "bg job", run_in_background: true },
            pending: false,
            backgroundTask: {
              taskId: "bg-1",
              toolUseId: null,
              description: "bg",
              status: "running",
              toolUses: 0,
              lastToolName: null,
              durationMs: 0,
              summary: null,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("1 background agent running")).toBeTruthy();
  });

  it("shows completed badge for finished background task", () => {
    render(
      <AgentGroupBlock
        agents={[
          makeAgent({
            input: { description: "bg job", run_in_background: true },
            pending: false,
            backgroundTask: {
              taskId: "bg-1",
              toolUseId: null,
              description: "bg",
              status: "completed",
              toolUses: 3,
              lastToolName: "Bash",
              durationMs: 0,
              summary: null,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("3 tools")).toBeTruthy();
  });

  it("shows error badge for agents with isError result", () => {
    render(
      <AgentGroupBlock
        agents={[
          makeAgent({
            result: { content: "boom", isError: true },
          }),
        ]}
      />,
    );
    expect(screen.getByText("err")).toBeTruthy();
  });
});
