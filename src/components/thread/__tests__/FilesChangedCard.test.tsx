/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FilesChangedCard } from "../FilesChangedCard";

const sdkRewindFilesMock = vi.fn();
vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  sdkRewindFiles: (...args: unknown[]) => sdkRewindFilesMock(...args),
}));

afterEach(() => cleanup());
beforeEach(() => sdkRewindFilesMock.mockReset());

describe("FilesChangedCard", () => {
  it("returns null when no files and no failed entries", () => {
    const { container } = render(
      <FilesChangedCard files={[]} failed={[]} userMessageId={null} sessionId="s" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders file count with singular suffix for one file", () => {
    render(
      <FilesChangedCard
        files={[{ filename: "/repo/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId={null}
        sessionId="s"
      />,
    );
    expect(screen.getByText("1 file")).toBeTruthy();
  });

  it("renders file count with plural suffix for multiple files", () => {
    render(
      <FilesChangedCard
        files={[
          { filename: "/repo/a.ts", fileId: "f1" },
          { filename: "/repo/b.ts", fileId: "f2" },
        ]}
        failed={[]}
        userMessageId={null}
        sessionId="s"
      />,
    );
    expect(screen.getByText("2 files")).toBeTruthy();
  });

  it("shortens long file paths to last two segments", () => {
    render(
      <FilesChangedCard
        files={[{ filename: "/very/deep/nested/path/file.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId={null}
        sessionId="s"
      />,
    );
    expect(screen.getByText("path/file.ts")).toBeTruthy();
  });

  it("does not show Undo button when userMessageId is null", () => {
    render(
      <FilesChangedCard
        files={[{ filename: "/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId={null}
        sessionId="s"
      />,
    );
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("shows Undo button when userMessageId is provided", () => {
    render(
      <FilesChangedCard
        files={[{ filename: "/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId="user-msg-1"
        sessionId="s"
      />,
    );
    expect(screen.getByText("Undo")).toBeTruthy();
  });

  it("renders failed file entries with their error messages", () => {
    render(
      <FilesChangedCard
        files={[]}
        failed={[{ filename: "/repo/x.ts", error: "permission denied" }]}
        userMessageId={null}
        sessionId="s"
      />,
    );
    expect(screen.getByText("permission denied")).toBeTruthy();
  });

  it("transitions to Reverted state on successful rewind", async () => {
    sdkRewindFilesMock.mockResolvedValue({ canRewind: true });
    render(
      <FilesChangedCard
        files={[{ filename: "/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId="msg-1"
        sessionId="thread-1"
      />,
    );
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.getByText("Reverted")).toBeTruthy());
    expect(sdkRewindFilesMock).toHaveBeenCalledWith("thread-1", "msg-1");
  });

  it("shows Failed state and error when rewind reports canRewind=false", async () => {
    sdkRewindFilesMock.mockResolvedValue({ canRewind: false, error: "no checkpoint" });
    render(
      <FilesChangedCard
        files={[{ filename: "/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId="msg-1"
        sessionId="thread-1"
      />,
    );
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    expect(screen.getByText("no checkpoint")).toBeTruthy();
  });

  it("disables Undo button after a successful rewind", async () => {
    sdkRewindFilesMock.mockResolvedValue({ canRewind: true });
    render(
      <FilesChangedCard
        files={[{ filename: "/a.ts", fileId: "f1" }]}
        failed={[]}
        userMessageId="msg-1"
        sessionId="thread-1"
      />,
    );
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.getByText("Reverted")).toBeTruthy());
    const btn = screen.getByText("Reverted").closest("button")!;
    expect(btn.hasAttribute("disabled")).toBe(true);
  });
});
