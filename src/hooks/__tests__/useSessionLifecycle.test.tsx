/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSessionLifecycle } from "../useSessionLifecycle";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => cleanup());

beforeEach(() => {
  // Reset relevant slices of the store between tests.
  useUiStore.setState({ pendingApprovalsBySession: {} } satisfies Partial<ReturnType<typeof useUiStore.getState>>);
});

describe("useSessionLifecycle", () => {
  it("publishApproval mirrors into the global pendingApprovalsBySession", () => {
    const { result } = renderHook(() => useSessionLifecycle("s1", "ClaudeCode"));
    act(() => {
      result.current.publishApproval({
        agentType: "claude",
        toolName: "Bash",
        summary: "ls",
        cwd: "/x",
        requestId: "req-1",
        interactionMode: "sdk",
      });
    });
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]?.toolName).toBe("Bash");
  });

  it("publishApproval(null) clears the slot", () => {
    const { result } = renderHook(() => useSessionLifecycle("s1", "ClaudeCode"));
    act(() => {
      result.current.publishApproval({
        agentType: "claude",
        toolName: "Bash",
        summary: "",
        cwd: "/x",
        requestId: "r",
        interactionMode: "sdk",
      });
    });
    act(() => result.current.publishApproval(null));
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]).toBeUndefined();
  });

  it("clears the global slot on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useSessionLifecycle("s1", "ClaudeCode"),
    );
    act(() => {
      result.current.publishApproval({
        agentType: "claude",
        toolName: "Bash",
        summary: "",
        cwd: "/x",
        requestId: "r",
        interactionMode: "sdk",
      });
    });
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]).toBeDefined();
    unmount();
    expect(useUiStore.getState().pendingApprovalsBySession["s1"]).toBeUndefined();
  });

  it("setProcessing routes to setCodexProcessing for Codex", () => {
    const setCodexProcessing = vi.spyOn(useUiStore.getState(), "setCodexProcessing");
    const { result } = renderHook(() => useSessionLifecycle("s1", "Codex"));
    act(() => result.current.setProcessing(true));
    expect(setCodexProcessing).toHaveBeenCalledWith("s1", true);
  });

  it("setProcessing routes to setClaudeProcessing for ClaudeCode", () => {
    const setClaudeProcessing = vi.spyOn(useUiStore.getState(), "setClaudeProcessing");
    const { result } = renderHook(() => useSessionLifecycle("s1", "ClaudeCode"));
    act(() => result.current.setProcessing(true));
    expect(setClaudeProcessing).toHaveBeenCalledWith("s1", true);
  });

  it("setProcessing routes to setClaudeProcessing for OpenCode (chat-style spinner)", () => {
    const setClaudeProcessing = vi.spyOn(useUiStore.getState(), "setClaudeProcessing");
    const { result } = renderHook(() => useSessionLifecycle("s1", "OpenCode"));
    act(() => result.current.setProcessing(true));
    expect(setClaudeProcessing).toHaveBeenCalledWith("s1", true);
  });

  it("returned object identity is stable across re-renders (avoids effect-loop bugs)", () => {
    const { result, rerender } = renderHook(() => useSessionLifecycle("s1", "ClaudeCode"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
