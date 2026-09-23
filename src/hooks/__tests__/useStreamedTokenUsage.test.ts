/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useStreamedTokenUsage } from "../useStreamedTokenUsage";

afterEach(() => cleanup());

describe("useStreamedTokenUsage", () => {
  it("starts with running=null and context=null", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    expect(result.current.running).toBeNull();
    expect(result.current.context).toBeNull();
  });

  it("recordUsage({running}) sets running totals", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    act(() =>
      result.current.recordUsage({
        running: { inputTokens: 100, outputTokens: 50 },
      }),
    );
    expect(result.current.running).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("recordUsage merges partial running updates against the previous total", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    act(() =>
      result.current.recordUsage({
        running: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
      }),
    );
    act(() =>
      result.current.recordUsage({
        running: { outputTokens: 75 }, // only output bumped
      }),
    );
    expect(result.current.running).toEqual({
      inputTokens: 100,
      outputTokens: 75,
      cacheCreationTokens: 0,
      cacheReadTokens: 10,
    });
  });

  it("recordUsage({context}) sets context snapshot", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    act(() =>
      result.current.recordUsage({
        context: {
          usedTokens: 5000,
          maxTokens: 200_000,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalProcessedTokens: 150,
          totalCostUsd: 0,
          numTurns: 1,
          lastInputTokens: 100,
          lastOutputTokens: 50,
          lastCachedInputTokens: null,
          compactsAutomatically: true,
        },
      }),
    );
    expect(result.current.context?.usedTokens).toBe(5000);
    expect(result.current.context?.maxTokens).toBe(200_000);
  });

  it("recordUsage({context: null}) clears the context snapshot", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    act(() =>
      result.current.recordUsage({
        context: {
        usedTokens: 1,
        maxTokens: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalProcessedTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCachedInputTokens: null,
        compactsAutomatically: true,
      },
      }),
    );
    expect(result.current.context).not.toBeNull();
    act(() => result.current.recordUsage({ context: null }));
    expect(result.current.context).toBeNull();
  });

  it("reset clears both fields", () => {
    const { result } = renderHook(() => useStreamedTokenUsage());
    act(() =>
      result.current.recordUsage({
        running: { inputTokens: 100, outputTokens: 50 },
        context: {
        usedTokens: 1,
        maxTokens: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalProcessedTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCachedInputTokens: null,
        compactsAutomatically: true,
      },
      }),
    );
    act(() => result.current.reset());
    expect(result.current.running).toBeNull();
    expect(result.current.context).toBeNull();
  });

  it("returned object identity is stable when nothing changed", () => {
    const { result, rerender } = renderHook(() => useStreamedTokenUsage());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
