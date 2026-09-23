/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  CodexThreadsForProject,
  formatTime,
  getThreadsForProject,
  getThreadName,
  useCodexThreads,
  type CodexThread,
} from "../CodexSessionsList";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
const eventListeners = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>()
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    eventListeners.set(event, handler);
    return Promise.resolve(() => {});
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => cleanup());

const thread: CodexThread = {
  id: "ct1",
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: { type: "active" },
  cwd: "/tmp/p",
  preview: "Codex preview",
};

describe("CodexSessionsList helpers", () => {
  it("getThreadName returns the preview when present", () => {
    expect(getThreadName({ ...thread, preview: "My summary" })).toBe("My summary");
  });

  it("getThreadsForProject filters by cwd", () => {
    const list: CodexThread[] = [
      { ...thread, id: "a", cwd: "/tmp/a", preview: "A" },
      { ...thread, id: "b", cwd: "/tmp/b", preview: "B" },
    ];
    const result = getThreadsForProject(list, "/tmp/a");
    expect(result.some((t) => t.id === "a")).toBe(true);
    expect(result.some((t) => t.id === "b")).toBe(false);
  });

  it("formatTime returns empty string for null", () => {
    expect(formatTime(null)).toBe("");
  });

  it("formatTime returns 'today' for current timestamp", () => {
    expect(formatTime(Date.now())).toBe("today");
  });

  it("formatTime returns 'yesterday' for 1-day-old timestamp", () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    expect(formatTime(yesterday)).toBe("yesterday");
  });

  it("formatTime returns 'Nd ago' for 2-6 day old timestamp", () => {
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    expect(formatTime(fourDaysAgo)).toBe("4d ago");
  });

  it("formatTime returns empty string for undefined", () => {
    expect(formatTime(undefined)).toBe("");
  });

  it("formatTime accepts unix seconds (< 1e12)", () => {
    // Now in seconds
    const nowSec = Math.floor(Date.now() / 1000);
    expect(formatTime(nowSec)).toBe("today");
  });

  it("formatTime accepts ISO strings", () => {
    expect(formatTime(new Date().toISOString())).toBe("today");
  });

  it("formatTime returns empty string for malformed string", () => {
    expect(formatTime("nope")).toBe("");
  });

  it("getThreadName falls back to source-based label when preview missing", () => {
    expect(getThreadName({ ...thread, preview: undefined } as CodexThread)).toBe("cli session");
  });

  it("getThreadName uses source.kind label", () => {
    expect(
      getThreadName({
        ...thread,
        preview: "",
        source: { kind: "vscode" },
      } as CodexThread),
    ).toBe("vscode session");
  });

  it("getThreadsForProject excludes default-named idle threads", () => {
    const list: CodexThread[] = [
      { ...thread, id: "x", cwd: "/p", preview: "Session abc-123", status: { type: "idle" } as any },
      { ...thread, id: "y", cwd: "/p", preview: "Real", status: { type: "idle" } as any },
    ];
    expect(getThreadsForProject(list, "/p").map((t) => t.id)).toEqual(["y"]);
  });

  it("getThreadsForProject keeps selected thread even if default-named", () => {
    const list: CodexThread[] = [
      { ...thread, id: "x", cwd: "/p", preview: "Session abc-123", status: { type: "idle" } as any },
    ];
    const result = getThreadsForProject(list, "/p", { selectedId: "x" });
    expect(result.map((t) => t.id)).toEqual(["x"]);
  });

  it("getThreadsForProject keeps active threads even if default-named", () => {
    const list: CodexThread[] = [
      { ...thread, id: "x", cwd: "/p", preview: "Session foo", status: { type: "active" } },
    ];
    expect(getThreadsForProject(list, "/p").map((t) => t.id)).toEqual(["x"]);
  });

  it("getThreadsForProject keeps threads with local name overrides", () => {
    const list: CodexThread[] = [
      { ...thread, id: "x", cwd: "/p", preview: "Session abc-123", status: { type: "idle" } as any },
    ];
    const result = getThreadsForProject(list, "/p", {
      sessionNames: { x: "My Custom Name" },
    });
    expect(result.map((t) => t.id)).toEqual(["x"]);
  });
});

describe("CodexThreadsForProject", () => {
  it("renders nothing when threads array is empty", () => {
    const { container } = render(<CodexThreadsForProject threads={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders rows for provided threads", () => {
    render(
      <CodexThreadsForProject
        threads={[
          { ...thread, id: "ct1", preview: "Codex one" },
          { ...thread, id: "ct2", preview: "Codex two" },
        ]}
      />,
    );
    expect(screen.getByText("Codex one")).toBeTruthy();
    expect(screen.getByText("Codex two")).toBeTruthy();
  });

  it("renders 'Show more' button when threads exceed page size", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...thread,
      id: `t${i}`,
      preview: `Thread ${i}`,
    }));
    render(<CodexThreadsForProject threads={many} />);
    expect(screen.getByText(/Show more/)).toBeTruthy();
  });

  it("does not render 'Show more' when threads fit in page size", () => {
    render(
      <CodexThreadsForProject
        threads={[{ ...thread, id: "ct1", preview: "only one" }]}
      />,
    );
    expect(screen.queryByText(/Show more/)).toBeNull();
  });
});

describe("useCodexThreads model enrichment", () => {
  it("merges codex-thread-models event payload into thread state", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      data: [
        { ...thread, id: "ct9", model: undefined },
        { ...thread, id: "ct10", model: "gpt-5.2" },
      ],
    });
    const { result } = renderHook(() => useCodexThreads());
    await waitFor(() => expect(result.current.fetchedOnce).toBe(true));
    expect(result.current.threads.find((t) => t.id === "ct9")?.model).toBeUndefined();

    await act(async () => {
      eventListeners.get("codex-thread-models")?.({
        payload: { ct9: "gpt-5.3-codex" },
      });
    });

    expect(result.current.threads.find((t) => t.id === "ct9")?.model).toBe("gpt-5.3-codex");
    // Threads not in the payload are untouched
    expect(result.current.threads.find((t) => t.id === "ct10")?.model).toBe("gpt-5.2");
  });
});
