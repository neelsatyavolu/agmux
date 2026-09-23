import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import {
  desktopClaudeForProject,
  desktopCodexForProject,
  desktopSessionCwd,
  folderMatchesProject,
  projectForClaudeDesktopSession,
  projectForCodexWorkSession,
} from "../desktopCowork";
import type { ClaudeDesktopCoworkSession, CodexWorkDesktopSession } from "../commands";

const colleges: Project = {
  id: "p1",
  name: "Colleges",
  repo_path: "/Users/neel/Colleges",
  conventions: "",
  created_at: "",
};
const agmux: Project = {
  id: "p2",
  name: "agmux",
  repo_path: "/Users/neel/Documents/GitHub/agmux",
  conventions: "",
  created_at: "",
};
const essays: Project = {
  id: "p3",
  name: "essays",
  repo_path: "/Users/neel/Colleges/essays",
  conventions: "",
  created_at: "",
};

describe("desktopCowork matching", () => {
  it("matches a folder to its project or a child path", () => {
    expect(folderMatchesProject("/Users/neel/Colleges", colleges)).toBe(true);
    expect(folderMatchesProject("/Users/neel/Colleges/essays", colleges)).toBe(true);
    expect(folderMatchesProject("/Users/neel/Documents/GitHub/agmux", colleges)).toBe(false);
  });

  it("assigns Claude Desktop sessions by user folder, preferring the most specific", () => {
    const sess: ClaudeDesktopCoworkSession = {
      id: "local_1",
      cliSessionId: "cli-1",
      title: "CAPS",
      folders: ["/Users/neel/Colleges/essays"],
      sessionDir: "/tmp/local_1",
      lastActivityAt: 1,
      cwd: "/tmp/local_1/outputs",
    };
    expect(projectForClaudeDesktopSession(sess, [colleges, agmux])?.id).toBe("p1");
    expect(projectForClaudeDesktopSession(sess, [colleges, essays, agmux])?.id).toBe("p3");
    expect(
      projectForClaudeDesktopSession({ ...sess, folders: [] }, [colleges, agmux]),
    ).toBeNull();
  });

  it("does not dump unmatched Desktop chats onto an unrelated project", () => {
    const unmatched: ClaudeDesktopCoworkSession = {
      id: "local_2",
      cliSessionId: "cli-2",
      title: "Loose",
      folders: ["/Users/neel/Documents/Claude Cowork"],
      sessionDir: "/tmp/local_2",
      lastActivityAt: 2,
    };
    expect(projectForClaudeDesktopSession(unmatched, [colleges, agmux])).toBeNull();
    expect(desktopClaudeForProject([unmatched], colleges, [colleges, agmux])).toEqual([]);
  });

  it("assigns ChatGPT Work sessions by cwd", () => {
    const sess: CodexWorkDesktopSession = {
      id: "w1",
      cwd: "/Users/neel/Colleges",
      title: "UMICH SUPPS",
      updatedAt: 1,
    };
    expect(projectForCodexWorkSession(sess, [colleges, agmux])?.id).toBe("p1");
    expect(desktopCodexForProject([sess], colleges).map((s) => s.id)).toEqual(["w1"]);
    expect(desktopCodexForProject([sess], agmux)).toEqual([]);
  });

  it("lists a nested ChatGPT Work chat only under the most specific folder", () => {
    const sess: CodexWorkDesktopSession = {
      id: "w2",
      cwd: "/Users/neel/Colleges/essays",
      title: "nested",
      updatedAt: 1,
    };
    const all = [colleges, essays, agmux];
    expect(desktopCodexForProject([sess], essays, all).map((s) => s.id)).toEqual(["w2"]);
    expect(desktopCodexForProject([sess], colleges, all)).toEqual([]);
  });

  it("prefers Desktop outputs cwd, then sessionDir/outputs", () => {
    const sess: ClaudeDesktopCoworkSession = {
      id: "local_1",
      cliSessionId: "cli-1",
      title: "CAPS",
      folders: ["/Users/neel/Colleges"],
      sessionDir: "/tmp/local_1",
      lastActivityAt: 1,
      cwd: "/tmp/local_1/outputs",
    };
    expect(desktopSessionCwd(sess, colleges)).toBe("/tmp/local_1/outputs");
    expect(desktopSessionCwd({ ...sess, cwd: "" }, colleges)).toBe("/tmp/local_1/outputs");
  });
});
