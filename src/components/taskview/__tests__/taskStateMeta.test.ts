import { describe, it, expect } from "vitest";
import {
  deriveEffectiveState,
  stateGroup,
  diffTotals,
  relativeTime,
  STATE_META,
} from "../taskStateMeta";
import type { Task, WorktreeGitState } from "../../../lib/types";

const baseTask: Task = {
  id: "t1",
  project_id: "p1",
  name: "Test Task",
  branch_name: "feat/test",
  worktree_path: "/tmp/worktree",
  base_branch: "main",
  status: "in_progress",
  prompt: null,
  created_at: new Date().toISOString(),
  linked_pr_number: null,
  linked_pr_url: null,
  linked_issues: null,
};

const cleanGitState: WorktreeGitState = {
  changed_files: [],
  ahead: 0,
  behind: 0,
  dirty_files: [],
  has_upstream: true,
};

describe("STATE_META", () => {
  it("has entries for all states", () => {
    const states = ["queued", "running", "attention", "review", "merged", "failed"] as const;
    for (const state of states) {
      expect(STATE_META[state]).toBeDefined();
      expect(STATE_META[state].label).toBeTruthy();
    }
  });
});

describe("deriveEffectiveState", () => {
  it("returns attention when attentionCount > 0", () => {
    expect(deriveEffectiveState(baseTask, cleanGitState, 0, 1)).toBe("attention");
  });

  it("returns merged when task.status === 'done'", () => {
    expect(deriveEffectiveState({ ...baseTask, status: "done" }, cleanGitState, 0, 0)).toBe("merged");
  });

  it("returns failed when task.status === 'blocked'", () => {
    expect(deriveEffectiveState({ ...baseTask, status: "blocked" }, cleanGitState, 0, 0)).toBe("failed");
  });

  it("returns running when agentCount > 0", () => {
    expect(deriveEffectiveState(baseTask, cleanGitState, 2, 0)).toBe("running");
  });

  it("returns review when git has changed files", () => {
    const dirtyGit: WorktreeGitState = {
      changed_files: [{ path: "foo.ts", added: 10, removed: 2, status: "M" }],
      ahead: 0,
      behind: 0,
      dirty_files: [],
      has_upstream: true,
    };
    expect(deriveEffectiveState(baseTask, dirtyGit, 0, 0)).toBe("review");
  });

  it("returns review when git is ahead", () => {
    const aheadGit: WorktreeGitState = {
      changed_files: [],
      ahead: 1,
      behind: 0,
      dirty_files: [],
      has_upstream: true,
    };
    expect(deriveEffectiveState(baseTask, aheadGit, 0, 0)).toBe("review");
  });

  it("returns queued when clean and no agents", () => {
    expect(deriveEffectiveState(baseTask, cleanGitState, 0, 0)).toBe("queued");
  });

  it("returns queued when gitState is undefined", () => {
    expect(deriveEffectiveState(baseTask, undefined, 0, 0)).toBe("queued");
  });
});

describe("stateGroup", () => {
  it("groups merged as done", () => {
    expect(stateGroup("merged")).toBe("done");
  });

  it("groups failed as done", () => {
    expect(stateGroup("failed")).toBe("done");
  });

  it("groups review as review", () => {
    expect(stateGroup("review")).toBe("review");
  });

  it("groups running as active", () => {
    expect(stateGroup("running")).toBe("active");
  });

  it("groups queued as active", () => {
    expect(stateGroup("queued")).toBe("active");
  });

  it("groups attention as active", () => {
    expect(stateGroup("attention")).toBe("active");
  });
});

describe("diffTotals", () => {
  it("returns zeros for empty changed_files", () => {
    expect(diffTotals(cleanGitState)).toEqual({ additions: 0, deletions: 0 });
  });


  it("sums additions and deletions across files", () => {
    const git: WorktreeGitState = {
      changed_files: [
        { path: "a.ts", added: 5, removed: 2, status: "M" },
        { path: "b.ts", added: 3, removed: 7, status: "M" },
      ],
      ahead: 0,
      behind: 0,
      dirty_files: [],
      has_upstream: true,
    };
    expect(diffTotals(git)).toEqual({ additions: 8, deletions: 9 });
  });

  it("returns zeros when gitState is undefined", () => {
    expect(diffTotals(undefined)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("relativeTime", () => {
  it("returns empty string for null", () => {
    expect(relativeTime(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(relativeTime(undefined)).toBe("");
  });

  it("returns 'just now' for recent timestamps", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    expect(relativeTime(recent)).toBe("just now");
  });

  it("returns minutes for timestamps a few minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(fiveMinAgo)).toBe("5m");
  });

  it("returns hours for timestamps several hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(threeHoursAgo)).toBe("3h");
  });

  it("returns days for timestamps over a day ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(twoDaysAgo)).toBe("2d");
  });

  it("handles SQLite UTC format 'YYYY-MM-DD HH:MM:SS'", () => {
    // 2 days ago in SQLite format
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const sqliteStr = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const result = relativeTime(sqliteStr);
    expect(result).toBe("2d");
  });
});
