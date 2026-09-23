import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../commands", () => ({ getGitInfo: vi.fn(), gitStatusSummary: vi.fn() }));
import { getGitInfo, gitStatusSummary } from "../commands";
import { pollGitInfo, pollGitStatus } from "../gitPolling";
beforeEach(() => vi.clearAllMocks());
it("coalesces overlapping repo reads but keeps worktrees and operation types separate", async () => {
  let resolve!: (value: never) => void;
  vi.mocked(getGitInfo).mockImplementation(() => new Promise(r => { resolve = r; }));
  const a = pollGitInfo("/main");
  const finishMain = resolve;
  expect(pollGitInfo("/main")).toBe(a);
  const b = pollGitInfo("/worktree");
  expect(getGitInfo).toHaveBeenCalledTimes(2);
  vi.mocked(gitStatusSummary).mockResolvedValue({} as never);
  await pollGitStatus("/main");
  expect(gitStatusSummary).toHaveBeenCalledWith("/main");
  finishMain({} as never); resolve({} as never);
  await Promise.all([a, b]);
  vi.mocked(getGitInfo).mockResolvedValue({} as never);
  await pollGitInfo("/main");
  expect(getGitInfo).toHaveBeenCalledTimes(3);
});
it("releases failed reads for a fresh retry", async () => {
  vi.mocked(getGitInfo).mockRejectedValueOnce(new Error("git failed"));
  await expect(pollGitInfo("/retry")).rejects.toThrow("git failed");
  vi.mocked(getGitInfo).mockResolvedValue({} as never);
  await pollGitInfo("/retry");
  expect(getGitInfo).toHaveBeenCalledTimes(2);
});
