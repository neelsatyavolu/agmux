/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { state } = vi.hoisted(() => ({ state: { mockOutput: undefined as string | undefined } }));

// usePtyOutput(threadId, onData, onExit) — invoke onData with the mock output
// once on mount so ChatView accumulates it into local state.
vi.mock("../../../hooks/usePtyOutput", () => {
  return {
    usePtyOutput: (
      _threadId: string | null,
      onData: (e: { data: string; offset: number }) => void,
    ) => {
      // Use useEffect so React queues the state update properly
      const React = require("react");
      React.useEffect(() => {
        if (state.mockOutput !== undefined) {
          const bytes = new TextEncoder().encode(state.mockOutput);
          let bin = "";
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const b64 = btoa(bin);
          onData({ data: b64, offset: 0 });
        }
        // Only run once on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});

vi.mock("../MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock("../UserMessageText", () => ({
  UserMessageText: ({ content }: { content: string }) => <div data-testid="user-msg">{content}</div>,
}));

vi.mock("../AddToJournalDialog", () => ({
  AddToJournalDialog: () => null,
}));

vi.mock("../../../lib/commands", () => ({
  listThreadTurns: vi.fn(async () => [{id: "turn-1", seq: 1, promptText: "what time is it?"}]),
}));
import { scrollToThreadTurn } from "../../../lib/threadTimelineScroll";
import { ChatView } from "../ChatView";

afterEach(() => {
  cleanup();
  state.mockOutput = undefined;
  vi.unstubAllGlobals();
});

describe("ChatView", () => {
  it("jumps to the matching prompt in the PTY chat surface", async () => {
    state.mockOutput = "> what time is it?\n\nIt is 3pm.";
    const { container } = render(<ChatView threadId="thread-1" />);
    const user = container.querySelector<HTMLElement>("[data-timeline-user-msg]")!;
    user.scrollIntoView = vi.fn();
    expect(user.getAttribute("data-user-prompt")).toBe("what time is it?");
    vi.stubGlobal("CSS", { escape: (text: string) => text });
    expect(await scrollToThreadTurn("thread-1", "turn-1")).toBe(true);
    expect(user.scrollIntoView).toHaveBeenCalledWith({block: "start", behavior: "smooth"});
    expect(await scrollToThreadTurn("thread-1", "missing")).toBe(false);
  });

  it("shows empty state when there is no PTY output yet", () => {
    render(<ChatView threadId="thread-1" />);
    expect(screen.getByText("Awaiting input...")).toBeTruthy();
  });

  it("renders without crashing with onExit callback", () => {
    render(<ChatView threadId="thread-1" onExit={() => {}} />);
    expect(screen.getByText("Awaiting input...")).toBeTruthy();
  });

  it("renders icon in empty state", () => {
    const { container } = render(<ChatView threadId="thread-1" />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("renders user / assistant labels when there is parseable output", () => {
    state.mockOutput = "> what time is it?\n\nIt is 3pm.";
    render(<ChatView threadId="thread-1" />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Assistant")).toBeTruthy();
  });

  it("renders response block content via mocked MarkdownContent", () => {
    state.mockOutput = "Hello world response";
    render(<ChatView threadId="thread-1" />);
    expect(screen.queryAllByTestId("md").length).toBeGreaterThan(0);
  });

  it("strips ANSI escape sequences from output before parsing", () => {
    state.mockOutput = "\x1b[31mred text\x1b[0m response";
    render(<ChatView threadId="thread-1" />);
    // The mock should receive plain text without ANSI
    const md = screen.queryAllByTestId("md");
    expect(md.length).toBeGreaterThan(0);
    expect(md.some((el) => el.textContent?.includes("red text"))).toBe(true);
    expect(md.every((el) => !el.textContent?.includes("\x1b"))).toBe(true);
  });

  it("hides empty state once output is available", () => {
    state.mockOutput = "Hello there";
    render(<ChatView threadId="thread-1" />);
    expect(screen.queryByText("Awaiting input...")).toBeNull();
  });
});
