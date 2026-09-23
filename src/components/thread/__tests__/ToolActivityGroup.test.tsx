/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ClaudeChatItemToolUse } from "../../../lib/types";

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: (selector: (s: { settings: { sdkAutoExpandToolCalls: boolean } }) => unknown) =>
    selector({ settings: { sdkAutoExpandToolCalls: false } }),
}));

const openFile = vi.hoisted(() => vi.fn());

vi.mock("../../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({ openFile }),
  },
}));

import { ToolActivityGroup } from "../ToolActivityGroup";

afterEach(() => cleanup());

const makeTool = (
  overrides: Partial<ClaudeChatItemToolUse> = {},
): ClaudeChatItemToolUse => ({
  itemType: "ToolUse",
  id: "tid-" + Math.random().toString(36).slice(2, 8),
  name: "Read",
  input: { file_path: "/repo/foo.ts" },
  timestamp: "2024-01-01T00:00:00Z",
  uuid: "u-" + Math.random().toString(36).slice(2, 8),
  ...overrides,
});

describe("ToolActivityGroup", () => {
  it("shows '1 read' header for a single read tool (homogeneous)", () => {
    render(<ToolActivityGroup tools={[makeTool()]} />);
    expect(screen.getByText("1 read")).toBeTruthy();
  });

  it("shows pluralised label for multiple homogeneous tools", () => {
    render(<ToolActivityGroup tools={[makeTool(), makeTool()]} />);
    expect(screen.getByText("2 reads")).toBeTruthy();
  });

  it("classifies MLX edit_lines activity as edits", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "edit_lines",
            input: { path: "/repo/src/foo.ts", start_line: 10, end_line: 10, new: "hello\nworld" },
            result: { content: "Edited src/foo.ts lines 10-10", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 edit")).toBeTruthy();
  });

  it("classifies Antigravity Running find_file / client_view_file as search and read", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "Running find_file",
            input: { GlobPattern: "**/*.rs" },
            result: { content: "src/lib.rs", isError: false },
          }),
          makeTool({
            name: "Running find_file",
            input: { Name: "ToolActivityGroup" },
            result: { content: "ok", isError: false },
          }),
          makeTool({
            name: "Running client_view_file",
            input: { AbsolutePath: "/repo/src/lib.rs" },
            result: { content: "fn main() {}", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.queryByText("3 other")).toBeNull();
    expect(screen.getByText("3 tool calls")).toBeTruthy();
    expect(screen.getByText("1 read · 2 searches")).toBeTruthy();

    fireEvent.click(screen.getByText("3 tool calls"));
    expect(screen.getAllByText("Search").length).toBe(2);
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("Running find_file")).toBeNull();
    expect(screen.queryByText("Running client_view_file")).toBeNull();
  });

  it("classifies MLX git_diff activity as search work", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "git_diff",
            input: { path: "src-tauri/src/mlx", staged: true },
            result: { content: "diff --git a/file b/file", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 search")).toBeTruthy();
  });

  it("classifies Grok run_command activity as bash work", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "run_command",
            input: { command: "npm test" },
            result: { content: "ok", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 bash")).toBeTruthy();
  });

  it("classifies Codex collaboration tools as agent work", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "CollabAgent.spawnAgent",
            input: { prompt: "Implement the scaffold" },
            result: { content: "agent started", isError: false },
          }),
          makeTool({
            name: "CollabAgent.wait",
            input: { receiverThreadIds: ["agent-1"] },
            result: { content: "agent completed", isError: false },
          }),
          makeTool({
            name: "CollabAgent.sendInput",
            input: { receiverThreadId: "agent-1", input: "Please fix the review note" },
            result: { content: "input sent", isError: false },
          }),
          makeTool({
            name: "CollabAgent.closeAgent",
            input: { receiverThreadId: "agent-1" },
            result: { content: "agent closed", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 Agent")).toBeTruthy();
    expect(screen.getByText("4 tool calls")).toBeTruthy();
    expect(screen.queryByText("4 other")).toBeNull();
  });

  it("renders Codex collaboration tools as named agent lifecycle activity", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "CollabAgent.spawnAgent",
            input: { agentNickname: "Harvey", receiverThreadIds: ["agent-1"] },
            result: { content: "agent started", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 Agent")).toBeTruthy();
    expect(screen.getByText("Harvey running")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

    fireEvent.click(screen.getByText("1 Agent"));
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Harvey started")).toBeTruthy();
    expect(screen.queryByText("CollabAgent.spawnAgent")).toBeNull();
  });

  it("keeps in-progress Codex wait calls running instead of finished", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "CollabAgent.wait",
            input: {
              agentNickname: "Dirac",
              receiverThreadIds: ["agent-1"],
              status: "inProgress",
            },
            result: { content: "{}", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("1 Agent")).toBeTruthy();
    expect(screen.getByText("waiting on Dirac")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.queryByText("Dirac finished")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("turns a spawned agent block to finished when its lifecycle is completed", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "CollabAgent.spawnAgent",
            input: {
              agentNickname: "Dirac",
              receiverThreadIds: ["agent-1"],
              agentLifecycleStatus: "finished",
            },
            result: { content: "agent started", isError: false },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Dirac finished")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByText("Dirac running")).toBeNull();
  });

  it("shows tool-call count for mixed kinds", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({ name: "Read", input: { file_path: "/a.ts" } }),
          makeTool({ name: "Bash", input: { command: "ls" } }),
        ]}
      />,
    );
    expect(screen.getByText("2 tool calls")).toBeTruthy();
  });

  it("summarises mixed kinds on the glass group row", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({ name: "Read", input: { file_path: "/a.ts" } }),
          makeTool({ name: "Bash", input: { command: "ls" } }),
        ]}
      />,
    );
    // Subject is a single mono string, e.g. "1 read · 1 bash"
    expect(screen.getByText(/1 read/)).toBeTruthy();
    expect(screen.getByText(/1 bash/)).toBeTruthy();
    expect(screen.getByTestId("codex-tool-row")).toBeTruthy();
  });

  it("renders Done badge when all tools have non-error results", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({ result: { content: "ok", isError: false } }),
          makeTool({ result: { content: "ok", isError: false } }),
        ]}
      />,
    );
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("renders error count badge when any tool has isError result", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({ result: { content: "boom", isError: true } }),
          makeTool({ result: { content: "ok", isError: false } }),
        ]}
      />,
    );
    expect(screen.getByText("1 error")).toBeTruthy();
  });

  it("renders pending count badge when any tool is still pending", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool(), // pending (no result)
          makeTool({ result: { content: "ok", isError: false } }),
        ]}
      />,
    );
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("expands to show child tool rows when header is clicked", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({ name: "Bash", input: { command: "echo hi", description: "say hi" } }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText("1 bash"));
    expect(screen.getAllByText("say hi").length).toBeGreaterThanOrEqual(1);
  });

  it("shows friendly MLX tool row labels after expansion", () => {
    render(
      <ToolActivityGroup
        tools={[
          makeTool({
            name: "git_diff",
            input: { path: "src-tauri/src/mlx", staged: true },
            result: { content: "diff --git a/file b/file", isError: false },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByText("1 search"));
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getAllByText("git diff").length).toBeGreaterThanOrEqual(1);
  });
});


describe("grouped inline details", () => {
  it("opens by keyboard and updates the visible result when a tool finishes", async () => {
    const tool = makeTool({ name: "Bash", input: { command: "npm test" } });
    const { rerender } = render(<ToolActivityGroup tools={[tool]} />);
    fireEvent.click(screen.getByText("1 bash"));
    const row = screen.getAllByTestId("codex-tool-row")[1];
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByText("Tool is currently executing…")).toBeTruthy();
    expect(screen.getByText("Bash · Input")).toBeTruthy();
    rerender(<ToolActivityGroup tools={[{ ...tool, result: { content: "Tests failed", isError: true } }]} />);
    expect(screen.getByText("Tests failed")).toBeTruthy();
    expect(screen.getByText("Error output")).toBeTruthy();
    expect(row.getAttribute("data-status")).toBe("error");
    fireEvent.keyDown(row, { key: " " });
    await waitFor(() => expect(screen.queryByText("Tests failed")).toBeNull());
  });

  it("keeps file opening separate from inline expansion without repeating the path", () => {
    render(<ToolActivityGroup tools={[makeTool()]} />);
    fireEvent.click(screen.getByText("1 read"));
    expect(screen.queryByText("/repo/foo.ts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open /repo/foo.ts" }));
    expect(openFile).toHaveBeenCalledWith("/repo/foo.ts");
    expect(screen.queryByTestId("codex-output")).toBeNull();
  });

  it("reveals overflow rows without opening their output", () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeTool({ input: { file_path: `/repo/file${i}.ts` } }));
    render(<ToolActivityGroup tools={tools} />);
    fireEvent.click(screen.getByText("10 reads"));
    expect(screen.queryByText("file9.ts")).toBeNull();
    fireEvent.click(screen.getByText("Show all 10 tool calls"));
    expect(screen.getByText("file9.ts")).toBeTruthy();
    expect(screen.queryByTestId("codex-output")).toBeNull();
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.queryByText("file9.ts")).toBeNull();
  });
});
