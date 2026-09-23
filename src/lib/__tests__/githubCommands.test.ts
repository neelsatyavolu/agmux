import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildIssueDispatchPrompt,
  issueThreadName,
  formatIssueRelativeTime,
  formatOpenIssueCount,
  loadTrackedRepos,
  saveTrackedRepos,
  loadExtraTrackedRepos,
  saveExtraTrackedRepos,
  loadLastIssuesRepo,
  saveLastIssuesRepo,
  splitRepoSlug,
  type GithubIssue,
} from "../githubCommands";

const sample: GithubIssue = {
  number: 42,
  title: "Fix spinner hang",
  state: "OPEN",
  url: "https://github.com/acme/app/issues/42",
  body: "It hangs after stop.",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [{ login: "neel" }],
  author: { login: "alice" },
  repository: "acme/app",
};

describe("githubCommands helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("buildIssueDispatchPrompt includes number, title, url, body, closes line", () => {
    const p = buildIssueDispatchPrompt(sample);
    expect(p).toContain("#42");
    expect(p).toContain("Fix spinner hang");
    expect(p).toContain("https://github.com/acme/app/issues/42");
    expect(p).toContain("It hangs after stop.");
    expect(p).toContain("Closes #42");
    expect(p).toContain("Repository:** acme/app");
    expect(p).toContain("bug");
    expect(p).toContain("neel");
    expect(p).toContain("## How to work");
    expect(p).toContain("Investigate");
  });

  it("buildIssueDispatchPrompt falls back when body empty", () => {
    const p = buildIssueDispatchPrompt({ ...sample, body: null });
    expect(p).toContain("No description provided");
  });

  it("buildIssueDispatchPrompt includes global and special instructions", () => {
    const p = buildIssueDispatchPrompt(sample, {
      globalInstructions: "Always run tests",
      specialInstructions: "Focus on spinner only",
    });
    expect(p).toContain("## User instructions");
    expect(p).toContain("Standing instructions");
    expect(p).toContain("Always run tests");
    expect(p).toContain("Special instructions for this issue");
    expect(p).toContain("Focus on spinner only");
  });

  it("buildIssueDispatchPrompt still accepts legacy repoLabel string", () => {
    const p = buildIssueDispatchPrompt({ ...sample, repository: null }, "other/repo");
    expect(p).toContain("other/repo");
  });

  it("issueThreadName clips long titles", () => {
    const long = issueThreadName({
      ...sample,
      title: "A".repeat(80),
    });
    expect(long.startsWith("#42 ")).toBe(true);
    expect(long.length).toBeLessThan(60);
    expect(long).toContain("…");
  });

  it("formatIssueRelativeTime handles recent timestamps", () => {
    const now = Date.now();
    expect(formatIssueRelativeTime(new Date(now - 30_000).toISOString())).toBe(
      "just now",
    );
    expect(formatIssueRelativeTime(new Date(now - 120_000).toISOString())).toBe(
      "2m ago",
    );
    expect(formatIssueRelativeTime(null)).toBe("—");
  });

  it("tracked repos persist per project", () => {
    saveTrackedRepos("p1", ["a/b", "c/d"]);
    expect(loadTrackedRepos("p1")).toEqual(["a/b", "c/d"]);
    expect(loadTrackedRepos("p2")).toEqual([]);
  });

  it("extra tracked repos are global and merge legacy per-project lists", () => {
    saveTrackedRepos("p1", ["legacy/one"]);
    saveExtraTrackedRepos(["acme/app", "acme/app", "bad"]);
    const merged = loadExtraTrackedRepos(["p1", "p2"]);
    expect(merged).toContain("acme/app");
    expect(merged).toContain("legacy/one");
    expect(merged.filter((s) => s === "acme/app")).toHaveLength(1);
    expect(merged).not.toContain("bad");
  });

  it("splitRepoSlug and formatOpenIssueCount for tab chrome", () => {
    expect(splitRepoSlug("neel-xanom/agmux")).toEqual({
      owner: "neel-xanom",
      name: "agmux",
    });
    // Zeros stay off the tab face (noise); only positive counts badge.
    expect(formatOpenIssueCount(0)).toBeNull();
    expect(formatOpenIssueCount(12)).toBe("12");
    expect(formatOpenIssueCount(100)).toBe("99+");
    expect(formatOpenIssueCount(null)).toBeNull();
  });

  it("remembers last Issues repo selection", () => {
    expect(loadLastIssuesRepo()).toBeNull();
    saveLastIssuesRepo("acme/app");
    expect(loadLastIssuesRepo()).toBe("acme/app");
    saveLastIssuesRepo(null);
    expect(loadLastIssuesRepo()).toBeNull();
  });
});

// Keep invoke wrappers smoke-tested via mock.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  listGithubIssues,
  getGithubIssue,
  githubAuthStatus,
  countGithubOpenIssues,
  discoverProjectGithubRepos,
  resolveGithubRepo,
} from "../githubCommands";

describe("githubCommands invoke", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("listGithubIssues forwards camelCase args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await listGithubIssues({
      repoPath: "/repo",
      state: "open",
      limit: 20,
    });
    expect(invoke).toHaveBeenCalledWith("list_github_issues", {
      repoPath: "/repo",
      repo: null,
      state: "open",
      limit: 20,
    });
  });

  it("getGithubIssue forwards number", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(sample);
    await getGithubIssue({ number: 42, repo: "a/b" });
    expect(invoke).toHaveBeenCalledWith("get_github_issue", {
      number: 42,
      repoPath: null,
      repo: "a/b",
    });
  });

  it("githubAuthStatus invokes command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      ok: true,
      loggedIn: true,
      login: "neel",
      message: "Logged in as neel",
    });
    const s = await githubAuthStatus();
    expect(invoke).toHaveBeenCalledWith("github_auth_status");
    expect(s.login).toBe("neel");
  });

  it("discoverProjectGithubRepos resolves all projects and dedupes slugs", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      expect(cmd).toBe("resolve_github_repo");
      const path = (args as { repoPath: string }).repoPath;
      if (path === "/a") return { nameWithOwner: "acme/one", url: null };
      if (path === "/b") return { nameWithOwner: "acme/two", url: null };
      if (path === "/c") return { nameWithOwner: "acme/one", url: null }; // dupe of /a
      throw new Error("not a github remote");
    });
    const repos = await discoverProjectGithubRepos([
      { id: "1", name: "Beta", repo_path: "/b" },
      { id: "2", name: "Alpha", repo_path: "/a" },
      { id: "3", name: "Clone", repo_path: "/c" },
      { id: "4", name: "LocalOnly", repo_path: "/d" },
    ]);
    expect(repos.map((r) => r.slug)).toEqual(["acme/one", "acme/two"]);
    expect(repos[0].projectName).toBe("Alpha"); // sorted by project name
    expect(repos[0].projectId).toBe("2");
    expect(repos[1].slug).toBe("acme/two");
  });

  it("resolveGithubRepo forwards path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ nameWithOwner: "a/b", url: "https://github.com/a/b" });
    const r = await resolveGithubRepo("/repo");
    expect(invoke).toHaveBeenCalledWith("resolve_github_repo", { repoPath: "/repo" });
    expect(r.nameWithOwner).toBe("a/b");
  });

  it("countGithubOpenIssues forwards camelCase args", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(7);
    const n = await countGithubOpenIssues({ repo: "acme/app", repoPath: "/repo" });
    expect(n).toBe(7);
    expect(invoke).toHaveBeenCalledWith("count_github_open_issues", {
      repoPath: "/repo",
      repo: "acme/app",
    });
  });
});
