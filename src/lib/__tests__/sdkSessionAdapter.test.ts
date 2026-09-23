import { describe, expect, it } from "vitest";
import { mapSdkEventToSessionEvent } from "../sdkSessionAdapter";
import type { SdkEvent } from "../types";

describe("mapSdkEventToSessionEvent", () => {
  it("maps session.started → session_start", () => {
    const evt: SdkEvent = { type: "session.started" } as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toEqual({ type: "session_start" });
  });

  it("maps content.delta → pre_tool_use 'generating'", () => {
    const evt: SdkEvent = {
      type: "content.delta",
      contentType: "text",
      text: "hello",
    };
    expect(mapSdkEventToSessionEvent(evt)).toEqual({
      type: "pre_tool_use",
      toolName: "generating",
      toolStatus: null,
      question: null,
    });
  });

  it("maps tool.started → pre_tool_use with generic name and tool name as status", () => {
    const evt: SdkEvent = {
      type: "tool.started",
      toolUseId: "t1",
      name: "Bash",
      input: {},
    };
    expect(mapSdkEventToSessionEvent(evt)).toEqual({
      type: "pre_tool_use",
      toolName: "tool",
      toolStatus: "Bash",
      question: null,
    });
  });

  it("maps approval.requested → notification(permission)", () => {
    const evt: SdkEvent = {
      type: "approval.requested",
      requestId: "r1",
      toolName: "Edit",
      detail: "May I write x?",
      requestType: "file_change",
    };
    expect(mapSdkEventToSessionEvent(evt)).toEqual({
      type: "notification",
      category: "permission",
      subtitle: "Edit",
      body: "May I write x?",
    });
  });

  it("maps turn.completed → stop", () => {
    const evt = { type: "turn.completed" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toEqual({ type: "stop" });
  });

  it("maps session.ended → session_end", () => {
    const evt = { type: "session.ended" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toEqual({ type: "session_end" });
  });

  it("maps error → session_end (clears processing state)", () => {
    const evt = { type: "error", message: "boom" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toEqual({ type: "session_end" });
  });

  it("maps status running → pre_tool_use (Cursor lifecycle arm spinner)", () => {
    const evt = { type: "status", status: "RUNNING" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toEqual({
      type: "pre_tool_use",
      toolName: "generating",
      toolStatus: null,
      question: null,
    });
    const lower = { type: "status", status: "running" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(lower)?.type).toBe("pre_tool_use");
  });

  it("does not map status finished/idle to stop (turn.completed owns clear)", () => {
    expect(
      mapSdkEventToSessionEvent({ type: "status", status: "FINISHED" } as unknown as SdkEvent),
    ).toBeNull();
    expect(
      mapSdkEventToSessionEvent({ type: "status", status: "idle" } as unknown as SdkEvent),
    ).toBeNull();
  });

  it("returns null for unhandled event types", () => {
    const evt = { type: "tool.completed" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt)).toBeNull();
    const evt2 = { type: "usage.update" } as unknown as SdkEvent;
    expect(mapSdkEventToSessionEvent(evt2)).toBeNull();
  });
});
