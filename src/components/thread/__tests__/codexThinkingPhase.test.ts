import { describe, it, expect } from "vitest";
import {
  parseMcpStartupStatusEvent,
  reduceMcpStartingServers,
  formatMcpStartupDetail,
  prettifyMcpServerName,
  codexThinkingPhase,
} from "../codexThinkingPhase";

describe("parseMcpStartupStatusEvent", () => {
  it("parses the documented app-server payload", () => {
    expect(
      parseMcpStartupStatusEvent({
        threadId: "t1",
        name: "xcodebuildmcp",
        status: "starting",
        error: null,
        failureReason: null,
      }),
    ).toEqual({
      threadId: "t1",
      name: "xcodebuildmcp",
      status: "starting",
      error: null,
      failureReason: null,
    });
  });

  it("accepts app-scoped null threadId and nested status", () => {
    expect(
      parseMcpStartupStatusEvent({
        threadId: null,
        name: "parallel",
        status: { type: "ready" },
      }),
    ).toMatchObject({ threadId: null, name: "parallel", status: "ready" });
  });

  it("accepts serverName alias and failed error object", () => {
    expect(
      parseMcpStartupStatusEvent({
        serverName: "vercel",
        status: "failed",
        error: { message: "OAuth expired" },
        failureReason: "reauthenticationRequired",
      }),
    ).toEqual({
      threadId: null,
      name: "vercel",
      status: "failed",
      error: "OAuth expired",
      failureReason: "reauthenticationRequired",
    });
  });

  it("returns null for junk", () => {
    expect(parseMcpStartupStatusEvent(null)).toBeNull();
    expect(parseMcpStartupStatusEvent({})).toBeNull();
    expect(parseMcpStartupStatusEvent({ name: "x", status: "weird" })).toBeNull();
  });
});

describe("reduceMcpStartingServers", () => {
  const start = (name: string) =>
    ({
      threadId: null,
      name,
      status: "starting" as const,
      error: null,
      failureReason: null,
    });
  const done = (name: string, status: "ready" | "failed" | "cancelled" = "ready") =>
    ({
      threadId: null,
      name,
      status,
      error: null,
      failureReason: null,
    });

  it("adds starting servers in order without duplicates", () => {
    let state: string[] = [];
    state = reduceMcpStartingServers(state, start("a"));
    state = reduceMcpStartingServers(state, start("b"));
    state = reduceMcpStartingServers(state, start("a"));
    expect(state).toEqual(["a", "b"]);
  });

  it("removes terminal statuses", () => {
    let state = ["a", "b", "c"];
    state = reduceMcpStartingServers(state, done("b", "ready"));
    state = reduceMcpStartingServers(state, done("a", "failed"));
    state = reduceMcpStartingServers(state, done("c", "cancelled"));
    expect(state).toEqual([]);
  });
});

describe("format / phase", () => {
  it("formats trailing detail", () => {
    expect(formatMcpStartupDetail([])).toBeNull();
    expect(formatMcpStartupDetail(["xcodebuildmcp"])).toBe("xcodebuildmcp");
    expect(formatMcpStartupDetail(["a", "b"])).toBe("a, b");
    expect(formatMcpStartupDetail(["a", "b", "c"])).toBe("a +2");
  });

  it("truncates very long server names", () => {
    const long = "x".repeat(40);
    expect(prettifyMcpServerName(long).endsWith("…")).toBe(true);
    expect(prettifyMcpServerName(long).length).toBeLessThanOrEqual(28);
  });

  it("picks phase label", () => {
    expect(codexThinkingPhase([])).toBe("thinking");
    expect(codexThinkingPhase(["xcodebuildmcp"])).toBe("starting MCP");
  });
});
