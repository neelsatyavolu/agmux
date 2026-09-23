import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThreadTimelinePopover, TimelineTriggerButton } from "../ThreadTimelinePopover";

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn(async () => [
    {
      id: "turn-1",
      threadId: "th-1",
      seq: 1,
      promptText:
        "Improve the session timeline to be more useful — summarize the prompt into something that fits",
      promptSummary: "Improve session timeline",
      status: "done",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      summary:
        "Each timeline turn now shows a short title for what you asked and a plain description of what actually shipped, not tool counts.",
      summarySource: "llm",
      anchorKind: "chat_item",
      anchorRef: "turn-1",
      factsJson: "{}",
      createdAt: new Date().toISOString(),
    },
  ]),
}));

vi.mock("../../../lib/threadTimelineScroll", () => ({
  scrollToThreadTurn: vi.fn(async () => true),
  flashTurnHighlight: vi.fn(),
  findTurnElement: vi.fn(() => null),
  cleanTimelinePrompt: (s: string) => s,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

describe("ThreadTimelinePopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty when closed", () => {
    const { container } = render(
      <ThreadTimelinePopover threadId="th-1" open={false} onClose={() => {}} />,
    );
    expect(container.querySelector("[data-testid='timeline-turn-row']")).toBeNull();
  });

  it("lists turns when open", async () => {
    render(
      <ThreadTimelinePopover threadId="th-1" open onClose={() => {}} />,
    );
    await waitFor(() => {
      // Prefers short promptSummary over raw promptText
      expect(screen.getAllByText("Improve session timeline").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/summarize the prompt into something/i)).toBeNull();
    expect(
      screen.getAllByText(/what actually shipped/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("done").length).toBeGreaterThan(0);
  });

  it("closes and jumps on row click", async () => {
    const onClose = vi.fn();
    const { scrollToThreadTurn } = await import("../../../lib/threadTimelineScroll");
    render(
      <ThreadTimelinePopover threadId="th-1" open onClose={onClose} />,
    );
    const row = await screen.findByTestId("timeline-turn-row");
    // pointer sequence matches real UI (mousedown outside-handler + click)
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
      expect(scrollToThreadTurn).toHaveBeenCalledWith("th-1", "turn-1", {
        promptText: expect.any(String),
        seq: expect.any(Number),
        maxSeq: expect.any(Number),
        promptOccurrenceFromEnd: 0,
      });
    });
  });

  it("renders icon-only trigger with count in title", () => {
    render(
      <TimelineTriggerButton count={3} open={false} onClick={() => {}} />,
    );
    const trigger = screen.getByTestId("timeline-trigger");
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("title")).toBe("Session timeline (3 turns)");
    expect(screen.queryByText("Timeline")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
  });
});
