import { invoke } from "@tauri-apps/api/core";

export interface GithubLabel {
  name: string;
  color?: string | null;
}

export interface GithubUser {
  login: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  body?: string | null;
  labels: GithubLabel[];
  assignees: GithubUser[];
  author?: GithubUser | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  repository?: string | null;
}

export interface GithubAuthStatus {
  ok: boolean;
  loggedIn: boolean;
  login?: string | null;
  message: string;
}

export interface GithubRepoInfo {
  nameWithOwner: string;
  url?: string | null;
}

export type GithubIssueState = "open" | "closed" | "all";

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  return invoke<GithubAuthStatus>("github_auth_status");
}

export async function resolveGithubRepo(repoPath: string): Promise<GithubRepoInfo> {
  return invoke<GithubRepoInfo>("resolve_github_repo", { repoPath });
}

export async function listGithubIssues(opts: {
  repoPath?: string | null;
  repo?: string | null;
  state?: GithubIssueState;
  limit?: number;
}): Promise<GithubIssue[]> {
  return invoke<GithubIssue[]>("list_github_issues", {
    repoPath: opts.repoPath ?? null,
    repo: opts.repo ?? null,
    state: opts.state ?? "open",
    limit: opts.limit ?? 50,
  });
}

/** Exact open-issue count (excludes PRs) for badge display. */
export async function countGithubOpenIssues(opts: {
  repoPath?: string | null;
  repo?: string | null;
}): Promise<number> {
  return invoke<number>("count_github_open_issues", {
    repoPath: opts.repoPath ?? null,
    repo: opts.repo ?? null,
  });
}

/** Split `owner/repo` for friendlier tab labels. */
export function splitRepoSlug(slug: string): { owner: string; name: string } {
  const t = slug.trim();
  const i = t.indexOf("/");
  if (i <= 0 || i === t.length - 1) return { owner: "", name: t || "repo" };
  return { owner: t.slice(0, i), name: t.slice(i + 1) };
}

/**
 * Compact badge text for open issue counts.
 * Hides zeros (noise on empty repos) and unknowns; shows 99+ when large.
 */
export function formatOpenIssueCount(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  if (n <= 0) return null;
  if (n > 99) return "99+";
  return String(n);
}

const LAST_REPO_KEY = "agmux-issues-last-repo";

/** Last Issues-tab repo slug the user selected. */
export function loadLastIssuesRepo(): string | null {
  try {
    const s = localStorage.getItem(LAST_REPO_KEY);
    return s && s.includes("/") ? s : null;
  } catch {
    return null;
  }
}

export function saveLastIssuesRepo(slug: string | null): void {
  try {
    if (!slug || !slug.includes("/")) {
      localStorage.removeItem(LAST_REPO_KEY);
      return;
    }
    localStorage.setItem(LAST_REPO_KEY, slug.trim());
  } catch {
    // ignore
  }
}

export async function getGithubIssue(opts: {
  number: number;
  repoPath?: string | null;
  repo?: string | null;
}): Promise<GithubIssue> {
  return invoke<GithubIssue>("get_github_issue", {
    number: opts.number,
    repoPath: opts.repoPath ?? null,
    repo: opts.repo ?? null,
  });
}

export interface IssueDispatchPromptOptions {
  /** `owner/repo` fallback when issue.repository is empty. */
  repoLabel?: string | null;
  /** Standing instructions applied to every Issues dispatch (settings). */
  globalInstructions?: string | null;
  /** One-off instructions for this dispatch only. */
  specialInstructions?: string | null;
}

/**
 * Build the first-message prompt an agent receives when dispatched to an issue.
 * Structured for coding agents: context → description → user instructions → workflow.
 */
export function buildIssueDispatchPrompt(
  issue: GithubIssue,
  repoLabelOrOpts?: string | null | IssueDispatchPromptOptions,
): string {
  const opts: IssueDispatchPromptOptions =
    repoLabelOrOpts != null && typeof repoLabelOrOpts === "object"
      ? repoLabelOrOpts
      : { repoLabel: repoLabelOrOpts as string | null | undefined };

  const labels = issue.labels.map((l) => l.name).filter(Boolean);
  const assignees = issue.assignees.map((a) => a.login).filter(Boolean);
  const author = issue.author?.login?.trim() || "";
  const body = (issue.body ?? "").trim();
  const repo = (issue.repository ?? opts.repoLabel ?? "").trim();
  const state = (issue.state ?? "open").trim() || "open";
  const global = (opts.globalInstructions ?? "").trim();
  const special = (opts.specialInstructions ?? "").trim();

  const lines: string[] = [
    `# Fix GitHub issue #${issue.number}`,
    "",
    `You are working in a local checkout of **${repo || "this repository"}**. Implement a focused fix for the issue below and open a pull request when ready.`,
    "",
    "## Issue",
    `- **Number:** #${issue.number}`,
    `- **Title:** ${issue.title.trim() || "(untitled)"}`,
    `- **URL:** ${issue.url}`,
    `- **State:** ${state}`,
  ];
  if (repo) lines.push(`- **Repository:** ${repo}`);
  if (labels.length) lines.push(`- **Labels:** ${labels.join(", ")}`);
  if (assignees.length) lines.push(`- **Assignees:** ${assignees.join(", ")}`);
  if (author) lines.push(`- **Author:** ${author}`);
  if (issue.createdAt) lines.push(`- **Created:** ${issue.createdAt}`);
  if (issue.updatedAt) lines.push(`- **Updated:** ${issue.updatedAt}`);

  lines.push("", "## Description", body || "_(No description provided on the issue.)_", "");

  if (global || special) {
    lines.push("## User instructions", "");
    if (global) {
      lines.push("### Standing instructions (apply to every Issues dispatch)", global, "");
    }
    if (special) {
      lines.push("### Special instructions for this issue", special, "");
    }
  }

  lines.push(
    "## How to work",
    "1. **Investigate** — find the root cause in the codebase; do not guess from the title alone.",
    "2. **Fix** — implement a minimal, correct change. Avoid unrelated refactors or drive-by edits.",
    "3. **Verify** — run relevant tests or checks; add/update tests when the change is non-trivial.",
    "4. **Ship** — commit with a clear message; open a PR that references this issue (e.g. `Closes #" +
      issue.number +
      "`).",
    "5. **Report** — summarize what you changed, why, and how to verify.",
    "",
    "If the issue is ambiguous or blocked (missing repro, product decision, secrets), stop and ask before large changes.",
  );

  return lines.join("\n");
}

/** Short thread name from an issue. */
export function issueThreadName(issue: GithubIssue): string {
  const title = issue.title.trim().replace(/\s+/g, " ");
  const clipped = title.length > 48 ? `${title.slice(0, 45)}…` : title;
  return `#${issue.number} ${clipped}`;
}

const TRACKED_REPOS_KEY = "agmux-issues-tracked-repos";
/** Global extras (not tied to a single project). Preferred storage after multi-project scan. */
const EXTRA_REPOS_KEY = "agmux-issues-extra-repos";

function isRepoSlug(s: unknown): s is string {
  return typeof s === "string" && s.includes("/") && s.split("/").length === 2;
}

/** Per-project extra tracked repos (`owner/repo`), beyond the project's own remote. */
export function loadTrackedRepos(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(TRACKED_REPOS_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, string[]>;
    const list = all[projectId];
    return Array.isArray(list) ? list.filter(isRepoSlug) : [];
  } catch {
    return [];
  }
}

export function saveTrackedRepos(projectId: string, repos: string[]): void {
  try {
    const raw = localStorage.getItem(TRACKED_REPOS_KEY);
    const all: Record<string, string[]> = raw ? JSON.parse(raw) : {};
    all[projectId] = repos.filter(isRepoSlug);
    localStorage.setItem(TRACKED_REPOS_KEY, JSON.stringify(all));
  } catch {
    // ignore quota / private mode
  }
}

/** Union of manually tracked extras (global + legacy per-project lists). */
export function loadExtraTrackedRepos(projectIds: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (slug: string) => {
    const s = slug.trim();
    if (!isRepoSlug(s) || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  try {
    const raw = localStorage.getItem(EXTRA_REPOS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as unknown;
      if (Array.isArray(list)) {
        for (const s of list) if (typeof s === "string") push(s);
      }
    }
  } catch {
    // ignore
  }
  for (const id of projectIds) {
    for (const s of loadTrackedRepos(id)) push(s);
  }
  return out;
}

export function saveExtraTrackedRepos(repos: string[]): void {
  try {
    const cleaned = [...new Set(repos.map((s) => s.trim()).filter(isRepoSlug))];
    localStorage.setItem(EXTRA_REPOS_KEY, JSON.stringify(cleaned));
  } catch {
    // ignore quota / private mode
  }
}

/** A GitHub remote resolved from an agmux project folder. */
export interface ProjectGithubRepo {
  slug: string;
  projectId: string;
  projectName: string;
  repoPath: string;
}

/**
 * Resolve `owner/repo` for every agmux project (parallel `gh repo view`).
 * Dedupes by slug (first project wins). Skips folders without a GitHub remote.
 */
export async function discoverProjectGithubRepos(
  projects: ReadonlyArray<{ id: string; name: string; repo_path: string }>,
): Promise<ProjectGithubRepo[]> {
  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        const r = await resolveGithubRepo(p.repo_path);
        const slug = (r.nameWithOwner ?? "").trim();
        if (!isRepoSlug(slug)) return null;
        return {
          slug,
          projectId: p.id,
          projectName: p.name,
          repoPath: p.repo_path,
        } satisfies ProjectGithubRepo;
      } catch {
        return null;
      }
    }),
  );
  const seen = new Set<string>();
  const out: ProjectGithubRepo[] = [];
  for (const r of results) {
    if (!r || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(r);
  }
  // Stable order: project name, then slug.
  out.sort((a, b) => {
    const byName = a.projectName.localeCompare(b.projectName);
    return byName !== 0 ? byName : a.slug.localeCompare(b.slug);
  });
  return out;
}

export function formatIssueRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
