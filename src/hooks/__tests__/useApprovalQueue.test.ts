/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useApprovalQueue } from "../useApprovalQueue";
import { broadcastApprovalResolved } from "../../lib/approvalBroadcast";

interface FakeApproval {
  id: string;
  payload: string;
}
const idOf = (a: FakeApproval) => a.id;

afterEach(() => cleanup());

type RespondFn = (approval: FakeApproval, decision: string) => Promise<void>;

describe("useApprovalQueue", () => {
  let respond: RespondFn;
  beforeEach(() => {
    respond = vi.fn(async () => {}) as unknown as RespondFn;
  });

  it("starts empty with pending=null", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    expect(result.current.queue).toEqual([]);
    expect(result.current.pending).toBeNull();
  });

  it("enqueue appends to the queue and exposes head as pending", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    act(() => {
      result.current.enqueue({ id: "a", payload: "first" });
      result.current.enqueue({ id: "b", payload: "second" });
    });
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.pending?.id).toBe("a");
  });

  it("removeById drops the matching entry without touching others", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    act(() => {
      result.current.enqueue({ id: "a", payload: "1" });
      result.current.enqueue({ id: "b", payload: "2" });
      result.current.enqueue({ id: "c", payload: "3" });
    });
    act(() => result.current.removeById("b"));
    expect(result.current.queue.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("clear empties the queue", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    act(() => {
      result.current.enqueue({ id: "a", payload: "1" });
      result.current.enqueue({ id: "b", payload: "2" });
    });
    act(() => result.current.clear());
    expect(result.current.queue).toEqual([]);
    expect(result.current.pending).toBeNull();
  });

  it("resolve calls respond, drops the entry, and broadcasts to siblings", async () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    const approval = { id: "x", payload: "p" };
    act(() => result.current.enqueue(approval));

    const broadcastSpy = vi.fn();
    window.addEventListener("agmux-approval-resolved", broadcastSpy);

    await act(async () => {
      await result.current.resolve(approval, "allow");
    });

    expect(respond).toHaveBeenCalledWith(approval, "allow");
    expect(result.current.queue).toEqual([]);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const ev = broadcastSpy.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toEqual({ sessionId: "s1", requestId: "x" });
    window.removeEventListener("agmux-approval-resolved", broadcastSpy);
  });

  it("respond is awaited before the entry is dropped (rejection keeps queue intact)", async () => {
    respond = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as RespondFn;
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    const approval = { id: "x", payload: "p" };
    act(() => result.current.enqueue(approval));

    await act(async () => {
      await expect(result.current.resolve(approval, "allow")).rejects.toThrow("network");
    });
    // Transport rejected → queue preserved so caller can surface the error.
    expect(result.current.queue).toHaveLength(1);
  });

  it("listens for sibling broadcasts and drops matching ids", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    act(() => {
      result.current.enqueue({ id: "a", payload: "1" });
      result.current.enqueue({ id: "b", payload: "2" });
    });
    act(() => broadcastApprovalResolved("s1", "a"));
    expect(result.current.queue.map((a) => a.id)).toEqual(["b"]);
  });

  it("ignores broadcasts scoped to other sessions", () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf, respond }),
    );
    act(() => result.current.enqueue({ id: "a", payload: "1" }));
    act(() => broadcastApprovalResolved("DIFFERENT_SESSION", "a"));
    expect(result.current.queue).toHaveLength(1);
  });

  it("two hook instances on the same session stay in sync via broadcast", async () => {
    // Simulates the bug we're fixing: split-pane / multi-tab where the same
    // session id is mounted twice.
    const a = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "shared", idOf, respond }),
    );
    const b = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "shared", idOf, respond }),
    );
    const approval = { id: "x", payload: "p" };
    act(() => {
      a.result.current.enqueue(approval);
      b.result.current.enqueue(approval);
    });
    expect(a.result.current.queue).toHaveLength(1);
    expect(b.result.current.queue).toHaveLength(1);

    await act(async () => {
      await a.result.current.resolve(approval, "allow");
    });

    // Both instances drop the entry.
    expect(a.result.current.queue).toEqual([]);
    expect(b.result.current.queue).toEqual([]);
  });

  it("does not call respond when respond is omitted (still drops + broadcasts)", async () => {
    const { result } = renderHook(() =>
      useApprovalQueue<FakeApproval>({ sessionId: "s1", idOf }),
    );
    const approval = { id: "x", payload: "p" };
    act(() => result.current.enqueue(approval));

    await act(async () => {
      await result.current.resolve(approval, "allow");
    });
    expect(result.current.queue).toEqual([]);
  });
});
