/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThreadItem } from "../ThreadItem";
import type { Thread } from "../../../lib/types";
import { useThreadStore } from "../../../stores/threadStore";
import { useUiStore } from "../../../stores/uiStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (command: string) => command === "list_shell_diff_stats" ? [] : undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  gitWorktreeStatus: vi.fn().mockResolvedValue({ is_dirty: false, dirty_files: [] }),
  openTerminal: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => cleanup());

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    project_id: "p1",
    name: "My Thread",
    provider: "ClaudeCode",
    interaction_mode: "pty",
    status: "Idle",
    model: "claude-sonnet-4-5",
    work_dir: "/tmp/x",
    work_mode: "InPlace",
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    archived: false,
    ...overrides,
  } as Thread;
}

describe("ThreadItem", () => {
  it("renders thread name", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    expect(screen.getByText("My Thread")).toBeTruthy();
  });

  it("renders provider letter for ClaudeCode", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    expect(screen.getByText("C")).toBeTruthy();
  });

  it("renders provider letter for Codex", () => {
    render(<ThreadItem thread={makeThread({ provider: "Codex" })} isSelected={false} />);
    expect(screen.getByText("X")).toBeTruthy();
  });

  it("shows a prettified Cline model in the meta row", () => {
    render(
      <ThreadItem
        thread={makeThread({ provider: "Cline", model: "gpt-5.6-luna" })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/GPT 5\.6 Luna/)).toBeTruthy();
  });

  it("shows Gemini model names without effort in the meta row", () => {
    render(
      <ThreadItem
        thread={makeThread({ provider: "Gemini", model: "gemini-3.8-flash-high" })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Gemini 3\.8 Flash/)).toBeTruthy();
    expect(screen.queryByText(/High/)).toBeNull();
  });

  it("shows diff stats when present", () => {
    render(
      <ThreadItem
        thread={makeThread({ lines_added: 12, lines_removed: 3, files_changed: 2 })}
        isSelected={false}
      />,
    );
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();
  });

  it("uses aggregate native totals for a Codex owner without adding own-only DB counts again", () => {
    useUiStore.getState().setCodexDiffStats("child-parent-native", { linesAdded: 100, linesRemoved: 9, filesChanged: 5 });
    render(<ThreadItem thread={makeThread({ provider: "Codex", sdk_session_id: "child-parent-native", lines_added: 7, lines_removed: 2 })} isSelected={false} />);
    expect(screen.getByText("+100")).toBeTruthy();
    expect(screen.getByText("−9")).toBeTruthy();
    expect(screen.queryByText("+107")).toBeNull();
  });

  it("opens context menu on right-click", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    const button = screen.getByRole("button");
    fireEvent.contextMenu(button, { clientX: 100, clientY: 100 });
    expect(screen.getByText(/rename/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recalculate diff" })).toBeTruthy();
    expect(screen.getByText(/archive/i)).toBeTruthy();
    expect(screen.getByText(/delete/i)).toBeTruthy();
  });

  it("shortens long claude model names", () => {
    render(<ThreadItem thread={makeThread({ model: "claude-sonnet-4-5" })} isSelected={false} />);
    // Should show "sonnet-4.5" somewhere in the meta line
    expect(screen.getByText(/sonnet-4\.5/)).toBeTruthy();
  });

  it("prettifies MLX model names in the meta line", () => {
    render(
      <ThreadItem
        thread={makeThread({
          provider: "MLX",
          interaction_mode: "mlx",
          model: "lmstudio-community/Qwen3-32B-MLX-4bit",
        })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Qwen 3 32B/)).toBeTruthy();
  });

  it("prettifies OpenCode local/ model slugs in the meta line", () => {
    render(
      <ThreadItem
        thread={makeThread({
          provider: "OpenCode",
          interaction_mode: "opencode-sdk",
          model: "local/mlx-community/Qwen3.6-27B-MLX-4bit",
        })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Qwen 3\.6 27B/)).toBeTruthy();
  });

  it("prettifies Pi local/ model slugs in the meta line", () => {
    render(
      <ThreadItem
        thread={makeThread({
          provider: "Pi",
          model: "local/mlx-community/Qwen3-4B-Instruct-2507-4bit",
        })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Qwen 3 4B/)).toBeTruthy();
  });

  it("prettifies Grok local/ model slugs in the meta line", () => {
    render(
      <ThreadItem
        thread={makeThread({
          provider: "Grok",
          model: "local/mlx-community/Qwen3-4B-Instruct-2507-4bit",
        })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Qwen 3 4B/)).toBeTruthy();
  });

  it("prettifies Grok model names in the meta line", () => {
    render(
      <ThreadItem
        thread={makeThread({
          provider: "Grok",
          model: "grok-build",
        })}
        isSelected={false}
      />,
    );
    expect(screen.getByText(/Grok Build/)).toBeTruthy();
  });

  it("renders 'K' avatar letter for Kimi", () => {
    render(<ThreadItem thread={makeThread({ provider: "Kimi" as any })} isSelected={false} />);
    expect(screen.getByText("K")).toBeTruthy();
  });

  it("renders 'O' avatar letter for OpenCode", () => {
    render(<ThreadItem thread={makeThread({ provider: "OpenCode" as any })} isSelected={false} />);
    expect(screen.getByText("O")).toBeTruthy();
  });

  it("does not start idle Cursor SDK threads on double-click", () => {
    const startThreadSpy = vi
      .spyOn(useThreadStore.getState(), "startThread")
      .mockResolvedValue(undefined);
    render(
      <ThreadItem
        thread={makeThread({
          provider: "Cursor",
          interaction_mode: "cursor-sdk",
          status: "Idle",
        })}
        isSelected={false}
      />,
    );

    fireEvent.doubleClick(screen.getByText("My Thread").closest("button")!);

    expect(startThreadSpy).not.toHaveBeenCalled();
  });

  it("does not start idle Grok SDK threads on double-click", () => {
    const startThreadSpy = vi
      .spyOn(useThreadStore.getState(), "startThread")
      .mockResolvedValue(undefined);
    render(
      <ThreadItem
        thread={makeThread({
          provider: "Grok",
          interaction_mode: "grok-sdk",
          status: "Idle",
        })}
        isSelected={false}
      />,
    );

    fireEvent.doubleClick(screen.getByText("My Thread").closest("button")!);

    expect(startThreadSpy).not.toHaveBeenCalled();
  });

  it("does not show diff stats when all are zero", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    expect(screen.queryByText("+0")).toBeNull();
  });

  it("applies selected styling when isSelected=true", () => {
    const { container } = render(
      <ThreadItem thread={makeThread()} isSelected={true} />,
    );
    // Selected items set data-active for Floating Glass selected fill
    expect(container.innerHTML).toMatch(/data-active="true"|sb-thread-row/i);
  });

  it("opens rename mode from context menu", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByText(/rename/i));
    // Now an input should appear with the existing name
    const input = document.querySelector("input");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("My Thread");
  });

  it("Escape in rename input cancels rename", () => {
    render(<ThreadItem thread={makeThread()} isSelected={false} />);
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByText(/rename/i));
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    // Input should be removed
    expect(document.querySelector("input")).toBeNull();
  });
});
