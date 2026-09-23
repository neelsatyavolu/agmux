/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { teamsGetEffectivePolicy, type TeamsEffectivePolicy } from "../../lib/teams";
import { useTeamsRestrictions } from "../useTeamsRestrictions";
vi.mock("../../lib/teams", () => ({ teamsGetEffectivePolicy: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const policy: TeamsEffectivePolicy = { allowedProviders: [], allowedModels: null, allowedModes: null, allowedEfforts: null, defaultPermissionMode: null, policies: [] };
it("blocks during load and on failure, then permits an explicit retry", async () => {
  vi.mocked(teamsGetEffectivePolicy).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(policy);
  const { result } = renderHook(useTeamsRestrictions);
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.error).toContain("Could not load"));
  expect(result.current.policy).toBeNull();
  await act(() => result.current.refresh());
  expect(result.current.error).toBeNull();
  expect(result.current.policy?.allowedProviders).toEqual([]);
});
it("retains restrictions on a failed reload", async () => {
  vi.mocked(teamsGetEffectivePolicy).mockResolvedValueOnce(policy).mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(useTeamsRestrictions);
  await waitFor(() => expect(result.current.policy).toEqual(policy));
  await act(() => result.current.refresh());
  expect(result.current.policy).toEqual(policy);
  expect(result.current.error).toBeTruthy();
});
it("ignores an older request after retry resolves", async () => {
  let resolve!: (p: TeamsEffectivePolicy) => void;
  vi.mocked(teamsGetEffectivePolicy).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(policy);
  const { result } = renderHook(useTeamsRestrictions);
  await act(() => result.current.refresh());
  await act(async () => resolve({ ...policy, allowedProviders: null }));
  expect(result.current.policy?.allowedProviders).toEqual([]);
});
it("reloads tightened and relaxed rules on focus and removes the listener on unmount", async () => {
  const relaxed = { ...policy, allowedProviders: null };
  vi.mocked(teamsGetEffectivePolicy).mockResolvedValueOnce(relaxed).mockResolvedValueOnce(policy).mockResolvedValueOnce(relaxed);
  const { result, unmount } = renderHook(useTeamsRestrictions);
  await waitFor(() => expect(result.current.policy).toEqual(relaxed));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current.policy).toEqual(policy);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current.policy).toEqual(relaxed);
  unmount();
  window.dispatchEvent(new Event("focus"));
  expect(teamsGetEffectivePolicy).toHaveBeenCalledTimes(3);
});
