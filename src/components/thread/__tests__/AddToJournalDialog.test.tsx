/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AddToJournalDialog } from "../AddToJournalDialog";

const addEntryMock = vi.fn();
vi.mock("../../../stores/journalStore", () => ({
  useJournalStore: (selector: (state: { addEntry: typeof addEntryMock }) => unknown) =>
    selector({ addEntry: addEntryMock }),
}));

afterEach(() => cleanup());
beforeEach(() => addEntryMock.mockReset().mockResolvedValue(undefined));

const baseProps = {
  open: true,
  threadId: "thread-1",
  initialContent: "Decision: use SQLite WAL\nrationale...",
  onClose: vi.fn(),
};

describe("AddToJournalDialog", () => {
  it("returns null when open is false", () => {
    const { container } = render(
      <AddToJournalDialog {...baseProps} open={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders dialog title and kind buttons when open", () => {
    render(<AddToJournalDialog {...baseProps} />);
    expect(screen.getByText("Add to Journal")).toBeTruthy();
    expect(screen.getByText("Decision")).toBeTruthy();
    expect(screen.getByText("Convention")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy(); // CompletedWork mapped label
    expect(screen.getByText("Issue")).toBeTruthy(); // KnownIssue mapped label
  });

  it("populates title from first line of initial content", () => {
    render(<AddToJournalDialog {...baseProps} />);
    const titleInput = screen.getByPlaceholderText("Entry title...") as HTMLInputElement;
    expect(titleInput.value).toBe("Decision: use SQLite WAL");
  });

  it("populates content from initial content", () => {
    render(<AddToJournalDialog {...baseProps} />);
    const contentArea = screen.getByPlaceholderText(
      "Entry content...",
    ) as HTMLTextAreaElement;
    expect(contentArea.value).toBe(baseProps.initialContent);
  });

  it("uses initialKind when provided", () => {
    render(<AddToJournalDialog {...baseProps} initialKind="Decision" />);
    // Just verifying the dialog accepts the prop without error
    expect(screen.getByText("Decision")).toBeTruthy();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<AddToJournalDialog {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("disables Save when title is empty", () => {
    render(
      <AddToJournalDialog
        {...baseProps}
        initialContent=""
        initialKind="Note"
      />,
    );
    const saveBtn = screen.getByText("Save Entry").closest("button")!;
    expect(saveBtn.hasAttribute("disabled")).toBe(true);
  });

  it("calls addEntry with correct args and closes on save", async () => {
    const onClose = vi.fn();
    render(<AddToJournalDialog {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Save Entry"));
    await waitFor(() => expect(addEntryMock).toHaveBeenCalled());
    expect(addEntryMock).toHaveBeenCalledWith(
      "thread-1",
      "Note",
      "Decision: use SQLite WAL",
      baseProps.initialContent,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("switches kind when a kind button is clicked", async () => {
    render(<AddToJournalDialog {...baseProps} />);
    fireEvent.click(screen.getByText("Decision"));
    fireEvent.click(screen.getByText("Save Entry"));
    await waitFor(() => expect(addEntryMock).toHaveBeenCalled());
    expect(addEntryMock).toHaveBeenCalledWith(
      "thread-1",
      "Decision",
      expect.any(String),
      expect.any(String),
    );
  });

  it("moves the gold selected styling to the clicked kind, not just KnownIssue", () => {
    render(<AddToJournalDialog {...baseProps} initialKind="Note" />);
    const noteBtn = screen.getByText("Note").closest("button")!;
    const decisionBtn = screen.getByText("Decision").closest("button")!;
    const issueBtn = screen.getByText("Issue").closest("button")!;

    // Initial kind (Note) is selected — gold; Issue is not clicked, so neutral.
    expect(noteBtn.dataset.active).toBe("true");
    expect(noteBtn.className).toContain("fx-soft-gold");
    expect(decisionBtn.dataset.active).toBeUndefined();
    expect(decisionBtn.className).toContain("fx-chip-q");
    expect(issueBtn.dataset.active).toBeUndefined();
    expect(issueBtn.className).toContain("fx-chip-q");
    expect(issueBtn.className).not.toContain("fx-soft-gold");

    fireEvent.click(decisionBtn);

    // Selected styling now follows the clicked kind (Decision), not KnownIssue.
    expect(decisionBtn.dataset.active).toBe("true");
    expect(decisionBtn.className).toContain("fx-soft-gold");
    expect(noteBtn.dataset.active).toBeUndefined();
    expect(noteBtn.className).toContain("fx-chip-q");
    expect(issueBtn.dataset.active).toBeUndefined();
    expect(issueBtn.className).toContain("fx-chip-q");
  });
});
