/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolUseBlock } from "../ToolUseBlock";

afterEach(() => cleanup());

// ToolDetailDialog is a heavy modal — stub it out
vi.mock("../ToolDetailDialog", () => ({
  ToolDetailDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="tool-detail-dialog">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// uiStore openFile action
vi.mock("../../../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({ openFile: vi.fn() }),
  },
}));

// CodexCollapse reads animation settings
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: (sel: (s: { settings: { animationSpeed: string } }) => unknown) =>
    sel({ settings: { animationSpeed: "none" } }),
}));

const baseProps = {
  toolId: "tid-1",
  input: {},
  pending: false,
};

describe("ToolUseBlock", () => {
  it("renders Bash tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Bash" input={{ command: "ls -la" }} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByTestId("codex-tool-row")).toBeTruthy();
  });

  it("renders Read tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Read" input={{ file_path: "/src/foo.ts" }} />);
    expect(screen.getByText("Read")).toBeTruthy();
  });

  it("renders Write tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Write" input={{ file_path: "/src/bar.ts", content: "hello" }} />);
    expect(screen.getByText("Write")).toBeTruthy();
  });

  it("renders Edit tool header label", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Edit"
        input={{ file_path: "/src/baz.ts", old_string: "a", new_string: "b" }}
      />,
    );
    expect(screen.getByText("Edit")).toBeTruthy();
  });

  it("renders friendly MLX edit_lines headers with non-zero diff stats", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="edit_lines"
        input={{
          path: "/Users/neel/Documents/GitHub/xanom/src/foo.ts",
          start_line: 8,
          end_line: 8,
          new: "alpha\nbeta",
        }}
        result={{ content: "Edited src/foo.ts lines 8-8", isError: false }}
      />,
    );

    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
  });

  it("renders friendly MLX multi_edit headers with aggregated diff stats", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="multi_edit"
        input={{
          path: "/Users/neel/Documents/GitHub/xanom/src/foo.ts",
          edits: [
            { old: "before", new: "after\nextra", replace_all: false },
            { old: "left\nright", new: "merged", replace_all: false },
          ],
        }}
        result={{ content: "Edited src/foo.ts (2 replacements across 2 edits)", isError: false }}
      />,
    );

    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();
  });

  it("renders Glob tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Glob" input={{ pattern: "*.ts" }} />);
    expect(screen.getByText("Glob")).toBeTruthy();
  });

  it("renders Grep tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Grep" input={{ pattern: "useState" }} />);
    expect(screen.getByText("Grep")).toBeTruthy();
  });

  it("renders friendly labels for MLX git_diff tool blocks", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="git_diff"
        input={{ path: "src-tauri/src/mlx", staged: true }}
        result={{ content: "diff --git a/file b/file", isError: false }}
      />,
    );

    expect(screen.getByText("Git Diff")).toBeTruthy();
    expect(screen.getByText("staged")).toBeTruthy();
  });

  it("renders Task tool header label", () => {
    render(<ToolUseBlock {...baseProps} name="Task" input={{ description: "run tests" }} />);
    expect(screen.getByText("Dispatched Agent")).toBeTruthy();
  });

  it("renders unknown tool name in header", () => {
    render(<ToolUseBlock {...baseProps} name="MyCustomTool" input={{}} />);
    expect(screen.getByText("MyCustomTool")).toBeTruthy();
  });

  it("shows running status when pending", () => {
    render(<ToolUseBlock {...baseProps} name="Bash" input={{ command: "npm test" }} pending />);
    expect(screen.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("running");
    expect(screen.getByTestId("tool-status-label").textContent).toBe("running");
  });

  it("shows auto status for auto-approved tools when pending", () => {
    render(<ToolUseBlock {...baseProps} name="Read" input={{ file_path: "x.ts" }} pending />);
    expect(screen.getByTestId("tool-status-label").textContent).toBe("auto");
  });

  it("shows Done status when result is provided and not pending", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Bash"
        input={{ command: "ls" }}
        result={{ content: "file.ts", isError: false }}
      />,
    );
    expect(screen.getByTestId("tool-status-label").textContent).toBe("Done");
    expect(screen.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("ok");
  });

  it("shows Error status when result is an error", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Bash"
        input={{ command: "bad command" }}
        result={{ content: "command not found", isError: true }}
      />,
    );
    expect(screen.getByTestId("tool-status-label").textContent).toBe("Error");
    expect(screen.getByTestId("codex-tool-row").getAttribute("data-status")).toBe("error");
  });

  it("shows Denied status when result content includes denied language", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Bash"
        input={{ command: "rm -rf /" }}
        result={{ content: "User denied the request", isError: true }}
      />,
    );
    expect(screen.getByTestId("tool-status-label").textContent).toBe("Denied");
  });

  it("expands body when row is clicked for expandable tools", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Bash"
        input={{ command: "echo hello" }}
        result={{ content: "hello", isError: false }}
      />,
    );
    const row = screen.getByTestId("codex-tool-row");
    fireEvent.click(row);
    expect(screen.getByTestId("codex-term")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("opens ToolDetailDialog when info button is clicked", () => {
    render(<ToolUseBlock {...baseProps} name="Bash" input={{ command: "pwd" }} />);
    const infoBtn = screen.getByTitle("View full details");
    fireEvent.click(infoBtn);
    expect(screen.getByTestId("tool-detail-dialog")).toBeTruthy();
  });

  it("keeps hide, info, and the expand arrow side by side on an expanded subagent row", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Task"
        input={{ description: "explore repo", subagent_type: "Explore" }}
        childTools={[
          {
            toolId: "c1",
            name: "Read",
            input: { file_path: "a.ts" },
            pending: false,
            result: { content: "ok", isError: false },
          },
        ]}
        result={{ content: "done", isError: false }}
      />,
    );

    const hide = screen.getByText("hide");
    const info = screen.getByTitle("View full details");
    const row = screen.getAllByTestId("codex-tool-row").find((item) => item.contains(hide))!;
    const actions = screen.getByTestId("tool-row-hover-actions");

    expect(row.contains(hide)).toBe(true);
    expect(row.contains(info)).toBe(true);
    expect(actions.contains(info)).toBe(true);
    // Parked immediately left of hide/chevron — not overlaid, not a reserved column.
    expect(actions.parentElement?.className).toMatch(/right-full/);
  });

  it("does not inset the toggle with a reserved hover-actions column", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="mcp__plugin_context-mode_context-mode__ctx_execute"
        input={{ command: "ls" }}
        result={{ content: "ok", isError: false }}
      />,
    );
    const block = screen.getByTestId("tool-use-block");
    const row = screen.getByTestId("codex-tool-row");
    const actions = screen.getByTestId("tool-row-hover-actions");
    expect(row.parentElement).toBe(block);
    expect(row.contains(actions)).toBe(true);
    expect(screen.getByText("result")).toBeTruthy();
  });

  it("closes ToolDetailDialog when Close is clicked", () => {
    render(<ToolUseBlock {...baseProps} name="Bash" input={{ command: "pwd" }} />);
    fireEvent.click(screen.getByTitle("View full details"));
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByTestId("tool-detail-dialog")).toBeNull();
  });

  it("renders Bash description as label when provided", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="Bash"
        input={{ command: "npm install", description: "Install deps" }}
      />,
    );
    expect(screen.getByText("Install deps")).toBeTruthy();
  });
});

// Grok ACP emits its own snake_case tool names with provider-specific arg
// keys. These render via the same shared infrastructure as Claude SDK tools.
describe("ToolUseBlock — Grok tools", () => {
  it("renders read_file as Read with the target_file path", () => {
    render(
      <ToolUseBlock {...baseProps} name="read_file" input={{ target_file: "/src/grok.ts" }} />,
    );
    expect(screen.getByText("Read")).toBeTruthy();
    // The path resolves instead of falling back to the literal "unknown".
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("renders Cursor edit rows with +N −M from the result payload", () => {
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
 keep
-old
+new`;
    render(
      <ToolUseBlock
        {...baseProps}
        name="edit"
        input={{ path: "src/foo.ts" }}
        result={{
          content: JSON.stringify({
            status: "success",
            value: { linesAdded: 4, linesRemoved: 2, diffString: diff },
          }),
          isError: false,
        }}
      />,
    );
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("+4")).toBeTruthy();
    expect(screen.getByText("−2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("codex-tool-row"));
    expect(document.querySelectorAll('[data-line="add"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-line="del"]').length).toBeGreaterThan(0);
  });

  it("renders Cursor write rows with +N from fileText", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="write"
        input={{ path: "src/new.ts", fileText: "a\nb\nc" }}
        result={{ content: "ok", isError: false }}
      />,
    );
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
  });

  it("renders Cursor delete as Delete, not Write", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="delete"
        input={{ path: "src/gone.ts" }}
        result={{ content: JSON.stringify({ status: "success", value: { fileSize: 12 } }), isError: false }}
      />,
    );
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText("Write")).toBeNull();
  });

  it("renders search_replace as an Edit", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="search_replace"
        input={{ file_path: "/src/a.ts", old_string: "a", new_string: "b" }}
      />,
    );
    expect(screen.getByText("Edit")).toBeTruthy();
  });

  it("renders run_command as a Bash tool", () => {
    render(<ToolUseBlock {...baseProps} name="run_command" input={{ command: "ls -la" }} />);
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("renders run_terminal_command as a Bash tool", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="run_terminal_command"
        input={{ command: "find . -name '*.md'", description: "Find markdown" }}
      />,
    );
    // description becomes the label; the command is the detail.
    expect(screen.getByText("Find markdown")).toBeTruthy();
    expect(screen.getByText(/find \. -name/)).toBeTruthy();
  });

  it("renders list_dir with the target_directory path", () => {
    const { container } = render(
      <ToolUseBlock {...baseProps} name="list_dir" input={{ target_directory: "src/lib" }} />,
    );
    expect(screen.getByText("List Dir")).toBeTruthy();
    // target_directory resolves (shortened to "lib") — not the bare "." default.
    expect(container.textContent).toContain("lib");
    expect(container.textContent).not.toContain("List Dir·.");
  });

  it("renders get_command_or_subagent_output as a Task Output tool", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="get_command_or_subagent_output"
        input={{ block: true, task_id: "call-1dc5b01e-593b-4106", timeout_ms: 5000 }}
      />,
    );
    expect(screen.getByText("Task Output")).toBeTruthy();
  });

  it("renders kill_command_or_subagent as a Kill Task tool", () => {
    render(
      <ToolUseBlock {...baseProps} name="kill_command_or_subagent" input={{ task_id: "call-x" }} />,
    );
    expect(screen.getByText("Kill Task")).toBeTruthy();
  });

  it("renders search_tool with a clean label", () => {
    render(
      <ToolUseBlock {...baseProps} name="search_tool" input={{ query: "filesystem schema" }} />,
    );
    expect(screen.getByText("Search Tools")).toBeTruthy();
  });

  it("renders ask_user_question as a Question", () => {
    render(
      <ToolUseBlock
        {...baseProps}
        name="ask_user_question"
        input={{ questions: [{ question: "Which approach?" }] }}
      />,
    );
    expect(screen.getByText("Question")).toBeTruthy();
  });
});
