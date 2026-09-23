import { describe, it, expect } from "vitest";
import { shortenPath, relativeToWorkDir, classifyToolResult, canonicalToolName, filePathFromToolInput } from "../types";

describe("relativeToWorkDir", () => {
  const cwd = "/Users/neel/Documents/GitHub/apexline";

  it("strips the workDir prefix", () => {
    expect(
      relativeToWorkDir(`${cwd}/docs/superpowers/plans/2026-07-23-permissions.md`, cwd),
    ).toBe("docs/superpowers/plans/2026-07-23-permissions.md");
  });

  it("handles trailing slash on workDir", () => {
    expect(relativeToWorkDir(`${cwd}/src/App.tsx`, `${cwd}/`)).toBe("src/App.tsx");
  });

  it("returns '.' when path equals workDir", () => {
    expect(relativeToWorkDir(cwd, cwd)).toBe(".");
  });

  it("leaves paths outside workDir absolute", () => {
    expect(relativeToWorkDir("/tmp/scratch.ts", cwd)).toBe("/tmp/scratch.ts");
  });
});

describe("shortenPath", () => {
  it("prefers workDir strip over markers", () => {
    const cwd = "/Users/neel/Documents/GitHub/apexline";
    expect(shortenPath(`${cwd}/docs/plan.md`, cwd)).toBe("docs/plan.md");
    expect(shortenPath(`${cwd}/src/App.tsx`, cwd)).toBe("src/App.tsx");
  });

  it("shortens paths containing /src/ to relative", () => {
    const full = "/Users/neel/Documents/GitHub/xanom/src/components/App.tsx";
    expect(shortenPath(full)).toBe("src/components/App.tsx");
  });

  it("shortens paths containing /src-tauri/ to relative", () => {
    const full = "/Users/neel/repo/src-tauri/src/lib.rs";
    expect(shortenPath(full)).toBe("src-tauri/src/lib.rs");
  });

  it("shortens paths containing /migrations/", () => {
    const full = "/repo/src-tauri/migrations/001_init.sql";
    // /src-tauri/ marker wins (first match)
    expect(shortenPath(full)).toBe("src-tauri/migrations/001_init.sql");
  });

  it("shortens paths containing /public/", () => {
    const full = "/any/project/public/icon.png";
    expect(shortenPath(full)).toBe("public/icon.png");
  });

  it("falls back to basename when no marker matches", () => {
    expect(shortenPath("/etc/hosts")).toBe("hosts");
    expect(shortenPath("/tmp/file.txt")).toBe("file.txt");
  });

  it("returns empty string for empty input", () => {
    // split("/").pop() on "" returns ""
    expect(shortenPath("")).toBe("");
  });

  it("handles paths without directory separators", () => {
    expect(shortenPath("README.md")).toBe("README.md");
  });
});

describe("canonicalToolName", () => {
  it("strips ACP Running prefixes and maps Antigravity aliases", () => {
    expect(canonicalToolName("Running find_file")).toBe("find_file");
    expect(canonicalToolName("Running client_view_file")).toBe("view_file");
    expect(canonicalToolName("view_file")).toBe("view_file");
    expect(canonicalToolName("list_directory")).toBe("list_dir");
    expect(canonicalToolName("Read")).toBe("Read");
  });
});

describe("filePathFromToolInput", () => {
  it("prefers file_path then Antigravity AbsolutePath", () => {
    expect(filePathFromToolInput({ file_path: "/repo/a.ts" })).toBe("/repo/a.ts");
    expect(filePathFromToolInput({ AbsolutePath: "/repo/b.ts" })).toBe("/repo/b.ts");
    expect(filePathFromToolInput({ TargetFile: "/repo/c.ts" })).toBe("/repo/c.ts");
  });
});

describe("classifyToolResult", () => {
  it("returns 'success' when no result", () => {
    expect(classifyToolResult(undefined)).toBe("success");
  });

  it("returns 'success' when isError is false", () => {
    expect(classifyToolResult({ content: "ok", isError: false })).toBe("success");
  });

  it("returns 'denied' for user-denial phrases", () => {
    for (const msg of [
      "User doesn't want to proceed with this tool use",
      "User does not want to proceed",
      "permission denied",
      "Denied by user",
      "user denied the request",
    ]) {
      expect(
        classifyToolResult({ content: msg, isError: true }),
        `msg: ${msg}`,
      ).toBe("denied");
    }
  });

  it("returns 'limit' for rate-limit phrases", () => {
    for (const msg of [
      "You've hit your limit",
      "rate limit exceeded",
      "too many requests",
    ]) {
      expect(
        classifyToolResult({ content: msg, isError: true }),
        `msg: ${msg}`,
      ).toBe("limit");
    }
  });

  it("returns 'error' for other error content", () => {
    expect(
      classifyToolResult({ content: "ENOENT: no such file", isError: true }),
    ).toBe("error");
    expect(classifyToolResult({ content: "", isError: true })).toBe("error");
  });

  it("matches phrases case-insensitively", () => {
    expect(
      classifyToolResult({ content: "PERMISSION DENIED", isError: true }),
    ).toBe("denied");
    expect(
      classifyToolResult({ content: "RATE LIMIT", isError: true }),
    ).toBe("limit");
  });
});
