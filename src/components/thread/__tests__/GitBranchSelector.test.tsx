/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

const getGitInfoMock = vi.fn();
const gitListBranchesMock = vi.fn();
const gitCheckoutBranchMock = vi.fn();
const gitCreateAndCheckoutBranchMock = vi.fn();

vi.mock("../../../lib/commands", () => ({
  setProjectMemoryEnabled: vi.fn().mockResolvedValue(undefined),
  setProjectMemorySessionInject: vi.fn().mockResolvedValue(undefined),
  listThreadTurns: vi.fn().mockResolvedValue([]),
  remoteSyncSessionNames: vi.fn().mockResolvedValue(undefined),
  getGitInfo: (...args: unknown[]) => getGitInfoMock(...args),
  gitListBranches: (...args: unknown[]) => gitListBranchesMock(...args),
  gitCheckoutBranch: (...args: unknown[]) => gitCheckoutBranchMock(...args),
  gitCreateAndCheckoutBranch: (...args: unknown[]) => gitCreateAndCheckoutBranchMock(...args),
}));

import { GitBranchSelector } from "../GitBranchSelector";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});
beforeEach(() => {
  getGitInfoMock.mockReset().mockResolvedValue({ branch: "main" });
  gitListBranchesMock
    .mockReset()
    .mockResolvedValue({
      current: "main",
      branches: [
        { name: "main", remote: false, current: true },
        { name: "feat/x", remote: false, current: false },
        { name: "origin/main", remote: true, current: false },
      ],
    });
  gitCheckoutBranchMock.mockReset().mockResolvedValue(undefined);
  gitCreateAndCheckoutBranchMock.mockReset().mockResolvedValue(undefined);
});

describe("GitBranchSelector", () => {
  it("renders nothing branch-name-related when workDir is empty", async () => {
    render(<GitBranchSelector workDir="" />);
    // getGitInfo should not be called (early return)
    await waitFor(() => expect(getGitInfoMock).not.toHaveBeenCalled());
  });

  it("renders current branch name from getGitInfo", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(getGitInfoMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
  });

  it("opens dropdown and lists branches when clicked", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(gitListBranchesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("feat/x")).toBeTruthy());
  });

  it("calls gitCheckoutBranch when a branch is selected", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(screen.getByText("feat/x")).toBeTruthy());
    fireEvent.click(screen.getByText("feat/x"));
    await waitFor(() =>
      expect(gitCheckoutBranchMock).toHaveBeenCalledWith("/repo", "feat/x"),
    );
  });

  it("toggles new-branch input when '+ New branch' is clicked", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(screen.getByText(/New branch/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/New branch/i));
    expect(screen.getByPlaceholderText("branch-name")).toBeTruthy();
  });

  it("creates a new branch when typing and pressing Enter", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(screen.getByText(/New branch/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/New branch/i));
    const input = screen.getByPlaceholderText("branch-name");
    fireEvent.change(input, { target: { value: "feat/foo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(gitCreateAndCheckoutBranchMock).toHaveBeenCalledWith("/repo", "feat/foo"),
    );
  });

  it("Escape key cancels new-branch input", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(screen.getByText(/New branch/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/New branch/i));
    const input = screen.getByPlaceholderText("branch-name");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("branch-name")).toBeNull();
  });

  it("does not create branch when input is empty", async () => {
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => expect(screen.getByText(/New branch/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/New branch/i));
    const input = screen.getByPlaceholderText("branch-name");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(gitCreateAndCheckoutBranchMock).not.toHaveBeenCalled();
  });

  it("handles getGitInfo failure gracefully", async () => {
    getGitInfoMock.mockRejectedValueOnce(new Error("not a repo"));
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(getGitInfoMock).toHaveBeenCalled());
    // Should not throw — fallback rendering
  });

  it("pauses polling while the document is hidden and resumes on visibility restore", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<GitBranchSelector workDir="/repo" />);
    await waitFor(() => expect(getGitInfoMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));

    // No further polling should happen while backgrounded.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(getGitInfoMock).toHaveBeenCalledTimes(1);

    // Becoming visible again triggers an immediate refresh and resumes the interval.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(getGitInfoMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(getGitInfoMock).toHaveBeenCalledTimes(3));
  });
});

 it("does not poll hidden sessions and resumes on reveal", async () => {
  vi.useFakeTimers();
  const { rerender } = render(<GitBranchSelector workDir="/hidden-repo" active={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(getGitInfoMock).not.toHaveBeenCalled();
  rerender(<GitBranchSelector workDir="/hidden-repo" active />);
  await act(async () => { await Promise.resolve(); });
  expect(getGitInfoMock).toHaveBeenCalledOnce();
  rerender(<GitBranchSelector workDir="/hidden-repo" active={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(getGitInfoMock).toHaveBeenCalledOnce();
});
