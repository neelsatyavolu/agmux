/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TurnChangeSummary } from "../TurnChangeSummary";
import type { TurnFileChange } from "../../../lib/types";

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

const editChange: TurnFileChange = {
  filePath: "/repo/src/foo.ts",
  shortPath: "src/foo.ts",
  action: "edited",
  additions: 7,
  deletions: 3,
};

const createChange: TurnFileChange = {
  filePath: "/repo/src/new.ts",
  shortPath: "src/new.ts",
  action: "created",
  additions: 12,
  deletions: 0,
};

describe("TurnChangeSummary", () => {
  it("returns null with empty changes", () => {
    const { container } = render(<TurnChangeSummary changes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders edited file with additions and deletions", () => {
    render(<TurnChangeSummary changes={[editChange]} />);
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.getByText("+7")).toBeTruthy();
    expect(screen.getByText("-3")).toBeTruthy();
  });

  it("renders created file with only additions", () => {
    render(<TurnChangeSummary changes={[createChange]} />);
    expect(screen.getByText("src/new.ts")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
  });

  it("renders correct count and pluralization", () => {
    render(<TurnChangeSummary changes={[editChange]} />);
    expect(screen.getByText("1 file")).toBeTruthy();
    cleanup();
    render(<TurnChangeSummary changes={[editChange, createChange]} />);
    expect(screen.getByText("2 files")).toBeTruthy();
  });

  it("does not render Undo button without userMessageId+sessionId", () => {
    render(<TurnChangeSummary changes={[editChange]} />);
    expect(screen.queryByText("Undo changes")).toBeNull();
  });

  it("renders Undo button when both userMessageId and sessionId are provided", () => {
    render(
      <TurnChangeSummary changes={[editChange]} userMessageId="m1" sessionId="s1" />,
    );
    expect(screen.getByText("Undo changes")).toBeTruthy();
  });

  it("transitions to Reverted on successful rewind", async () => {
    sdkRewindFilesMock.mockResolvedValue({ canRewind: true });
    render(
      <TurnChangeSummary changes={[editChange]} userMessageId="m1" sessionId="s1" />,
    );
    fireEvent.click(screen.getByText("Undo changes"));
    await waitFor(() => expect(screen.getByText("Reverted")).toBeTruthy());
    expect(sdkRewindFilesMock).toHaveBeenCalledWith("s1", "m1");
  });

  it("shows Failed and error message when rewind cannot proceed", async () => {
    sdkRewindFilesMock.mockResolvedValue({ canRewind: false, error: "missing checkpoint" });
    render(
      <TurnChangeSummary changes={[editChange]} userMessageId="m1" sessionId="s1" />,
    );
    fireEvent.click(screen.getByText("Undo changes"));
    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    expect(screen.getByText("missing checkpoint")).toBeTruthy();
  });
});
