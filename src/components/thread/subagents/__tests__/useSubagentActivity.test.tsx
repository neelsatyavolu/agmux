import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSubagentActivity } from "../useSubagentActivity";
import type { SubagentReference } from "../../../../lib/subagentConversations";

afterEach(() => { cleanup(); vi.useRealTimers(); });
it("keeps at most three readers in flight when the roster changes", async () => {
  vi.useFakeTimers();
  const finish: Array<(value: unknown) => void> = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const onActivity = vi.fn();
  const refs: SubagentReference[] = Array.from({ length: 4 }, (_, i) => ({ toolUseId: String(i), title: String(i), status: "running" }));
  const { rerender } = renderHook(({ references }) => useSubagentActivity({ provider: "Codex", parentThreadId: "parent", workDir: "/repo" }, references, {}, true, onActivity), { initialProps: { references: refs } });
  expect(invoke).toHaveBeenCalledTimes(3);
  rerender({ references: [...refs, { toolUseId: "new", title: "New", status: "running" }] });
  expect(invoke).toHaveBeenCalledTimes(3);
  await act(async () => { finish.splice(0).forEach((resolve) => resolve({ status: "completed", items: [] })); });
  expect(onActivity).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(invoke).toHaveBeenCalledTimes(6);
});
