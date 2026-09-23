import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn() }));
vi.mock("../../lib/providerAccounts", () => ({ providerAccounts: api, ACCOUNT_CHANGED_EVENT: "provider-accounts-changed" }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
const account = (id: string, extra = {}) => ({ id, provider: "codex", label: id, teamId: null, enabled: true, status: "ready", lastCheckedAt: null, ...extra });
const view = (accounts: unknown[]) => ({ accounts, teams: [], autoSwitch: true });
describe("shared account quota cache", () => {
  it("coalesces Home and Usage refreshes and caches the result", async () => {
    api.list.mockResolvedValue(view([]));
    const store = await import("../useAccountUsage");
    await Promise.all([store.refreshAccountUsage(), store.refreshAccountUsage()]);
    await store.refreshAccountUsage();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
  it("refreshes every stale personal account including paused accounts without allocating team credentials", async () => {
    api.list.mockResolvedValue(view([account("a"), account("paused", { enabled: false }), account("team", { teamId: "t" }), account("signed-out", { status: "needs_login" })]));
    api.refresh.mockResolvedValue(undefined);
    const store = await import("../useAccountUsage");
    await store.refreshAccountUsage();
    expect(api.refresh.mock.calls).toEqual([["a", null], ["paused", null]]);
    expect(store.getAccountUsageSnapshot().data?.accounts).toHaveLength(4);
  });
  it("bounds native quota checks to two at once and retains every account after one failure", async () => {
    api.list.mockResolvedValue(view([account("a"), account("b"), account("c"), account("d")]));
    let active = 0, peak = 0;
    api.refresh.mockImplementation(async (id: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      if (id === "a") throw new Error("offline");
    });
    const store = await import("../useAccountUsage");
    await store.refreshAccountUsage();
    expect(peak).toBe(2);
    expect(api.refresh).toHaveBeenCalledTimes(4);
    expect(store.getAccountUsageSnapshot().data?.accounts).toHaveLength(4);
  });
  it("preserves cached account rows and surfaces list failures", async () => {
    api.list.mockResolvedValue(view([account("a", { lastCheckedAt: Date.now() / 1000 })]));
    const store = await import("../useAccountUsage");
    await store.refreshAccountUsage();
    api.list.mockRejectedValue(new Error("offline"));
    await store.refreshAccountUsage(true);
    expect(store.getAccountUsageSnapshot().data?.accounts).toHaveLength(1);
    expect(store.getAccountUsageSnapshot().error).toBeTruthy();
    expect(store.getAccountUsageSnapshot().loading).toBe(false);
  });
});
