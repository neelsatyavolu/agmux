/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      <div {...props}>{children}</div>,
  },
}));

import { JournalPanel } from "../JournalPanel";
import { useUiStore } from "../../../stores/uiStore";
import { useJournalStore } from "../../../stores/journalStore";

beforeEach(() => {
  useUiStore.setState({ journalPanelOpen: true });
  useJournalStore.setState({
    entries: [],
    proposals: [],
    loading: false,
    fetchEntries: vi.fn().mockResolvedValue(undefined),
    addEntry: vi.fn().mockResolvedValue(undefined),
    updateEntry: vi.fn().mockResolvedValue(undefined),
    removeEntry: vi.fn().mockResolvedValue(undefined),
    acceptProposal: vi.fn().mockResolvedValue(undefined),
    dismissProposal: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("JournalPanel", () => {
  it("renders Thread Journal title when open", () => {
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.getByText("Thread Journal")).toBeTruthy();
  });

  it("renders nothing when journalPanelOpen is false", () => {
    useUiStore.setState({ journalPanelOpen: false });
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.queryByText("Thread Journal")).toBeNull();
  });

  it("shows empty state when no entries", () => {
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.getByText(/no journal entries yet/i)).toBeTruthy();
  });

  it("calls onClose when Close button clicked", () => {
    const onClose = vi.fn();
    render(<JournalPanel threadId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByTitle("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles add form visibility on + click", () => {
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.queryByPlaceholderText(/^title$/i)).toBeNull();
    fireEvent.click(screen.getByTitle("Add entry"));
    expect(screen.getByPlaceholderText(/^title$/i)).toBeTruthy();
  });

  it("renders entries from store", () => {
    useJournalStore.setState({
      entries: [
        {
          id: "e1",
          thread_id: "t1",
          kind: "Note",
          title: "My Note",
          content: "Body text",
          source: "User",
          confidence: null,
          created_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          is_archived: 0,
        } as never,
      ],
    });
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.getByText("My Note")).toBeTruthy();
  });

  it("renders proposals section when proposals exist", () => {
    useJournalStore.setState({
      proposals: [
        {
          kind: "Note",
          title: "MyProposal",
          content: "from agent",
        } as never,
      ],
    });
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    expect(screen.getByText("MyProposal")).toBeTruthy();
  });

  it("Cancel button hides the add form", () => {
    render(<JournalPanel threadId="t1" onClose={() => {}} />);
    fireEvent.click(screen.getByTitle("Add entry"));
    expect(screen.getByPlaceholderText(/^title$/i)).toBeTruthy();
    // Cancel button in form
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByPlaceholderText(/^title$/i)).toBeNull();
  });
});
