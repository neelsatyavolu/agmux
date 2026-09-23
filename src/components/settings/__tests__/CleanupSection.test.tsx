import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CleanupSection } from "../CleanupSection";
import { useSessionNameStore } from "../../../stores/sessionNameStore";
import { scanAppCleanup, cleanAppCleanup, getCleanupSessionActivity } from "../../../lib/cleanupCommands";

vi.mock("../../../lib/cleanupCommands", () => ({
  scanAppCleanup: vi.fn(), cleanAppCleanup: vi.fn(), getCleanupSessionActivity: vi.fn(),
}));

const file = { relativePath: "cache/ide-icons/editor.png", bytes: 2048, modifiedMs: 1, identity: "file-snapshot" };
const preview = { entries: [{ id: "old", fingerprint: "snapshot", bytes: 1024 }], unknownCount: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(scanAppCleanup).mockResolvedValue({ files: [file], errors: [] });
  vi.mocked(cleanAppCleanup).mockResolvedValue({ removedCount: 1, removedBytes: 2048, skippedCount: 0, errors: [] });
  vi.mocked(getCleanupSessionActivity).mockResolvedValue([]);
  vi.spyOn(useSessionNameStore.getState(), "cleanupSessionIds").mockReturnValue(["old"]);
  vi.spyOn(useSessionNameStore.getState(), "previewCleanup").mockReturnValue(preview);
  vi.spyOn(useSessionNameStore.getState(), "cleanup").mockReturnValue({ removedCount: 1, removedBytes: 1024, skippedCount: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function scan() {
  fireEvent.click(screen.getByRole("button", { name: "Scan for cleanup" }));
  await screen.findByRole("button", { name: "Review cleanup" });
}

describe("Settings cleanup", () => {
  it("still offers file cleanup if summary activity cannot be scanned", async () => {
    vi.mocked(getCleanupSessionActivity).mockRejectedValue(new Error("Native history unavailable"));
    render(<CleanupSection />);
    await scan();
    expect(screen.getByRole("alert").textContent).toContain("Native history unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    await screen.findByText(/Removed 0 saved summaries and 1 cached file/);
    expect(useSessionNameStore.getState().cleanup).not.toHaveBeenCalled();
  });

  it("does not delete on opening, scanning or cancelling confirmation", async () => {
    render(<CleanupSection />);
    expect(scanAppCleanup).not.toHaveBeenCalled();
    await scan();
    expect(screen.getByText(/Teams data is always kept/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cleanAppCleanup).not.toHaveBeenCalled();
    expect(useSessionNameStore.getState().cleanup).not.toHaveBeenCalled();
  });

  it("rechecks summaries at confirmation and cleans only selected categories", async () => {
    render(<CleanupSection />);
    await scan();
    fireEvent.click(screen.getByRole("checkbox", { name: /Cached files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    await screen.findByText(/Removed 1 saved summary and 0 cached files/);
    expect(getCleanupSessionActivity).toHaveBeenCalledTimes(2);
    expect(cleanAppCleanup).not.toHaveBeenCalled();
    expect(useSessionNameStore.getState().cleanup).toHaveBeenCalledWith(preview, [], expect.any(Array));
  });

  it("reports file errors and skipped files instead of claiming everything was removed", async () => {
    vi.mocked(cleanAppCleanup).mockResolvedValue({ removedCount: 0, removedBytes: 0, skippedCount: 1, errors: ["Could not remove cached icon"] });
    render(<CleanupSection />);
    await scan();
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    await screen.findByText(/Could not remove cached icon/);
    expect(screen.getByText(/1 item skipped/)).toBeTruthy();
    expect(cleanAppCleanup).toHaveBeenCalledWith([file]);
  });

  it("blocks summary deletion when activity cannot be rechecked", async () => {
    render(<CleanupSection />);
    await scan();
    vi.mocked(getCleanupSessionActivity).mockRejectedValue(new Error("Activity unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Activity unavailable"));
    expect(useSessionNameStore.getState().cleanup).not.toHaveBeenCalled();
  });
});
