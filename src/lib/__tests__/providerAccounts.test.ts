import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ACCOUNT_CHANGED_EVENT, providerAccounts } from "../providerAccounts";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.mocked(invoke).mockClear());
afterEach(() => vi.unstubAllGlobals());
describe("provider account command contract", () => {
  it("invalidates visible account limits after mutations but not quota polling", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener(ACCOUNT_CHANGED_EVENT, listener);
    await providerAccounts.update("a", { enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    await providerAccounts.refresh("a", null);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockResolvedValueOnce({ status: "complete" });
    await providerAccounts.loginStatus("job");
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("passes native login and import metadata in camelCase without credentials", async () => {
    const input = { provider: "grok" as const, label: "Studio", teamId: "team-1" };
    await providerAccounts.loginStart(input);
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_login_start", input);
    await providerAccounts.importCurrent(input);
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_import_current", input);
    await providerAccounts.loginStatus("job");
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_login_status", { id: "job" });
    await providerAccounts.loginCancel("job");
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_login_cancel", { id: "job" });
  });
  it("starts personal Claude through native browser login", async () => {
    await providerAccounts.loginStart({ provider: "claude", label: "Personal Claude", teamId: null });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("provider_accounts_login_start", { provider: "claude", label: "Personal Claude", teamId: null });
  });
  it("rejects Claude team login before invoking the backend", async () => {
    await expect(providerAccounts.loginStart({ provider: "claude", label: "Claude", teamId: "t" })).rejects.toThrow(/personal/i);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([null, "t"])("never imports Claude credentials for scope %s", async teamId => {
    await expect(providerAccounts.importCurrent({ provider: "claude", label: "Claude", teamId })).rejects.toThrow(/browser/i);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("preserves team scope for account mutations", async () => {
    await providerAccounts.update("a", { enabled: false, priority: -1, teamId: "t" });
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_update", { id: "a", enabled: false, priority: -1, teamId: "t" });
    await providerAccounts.remove("a", "t");
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_remove", { id: "a", teamId: "t" });
    await providerAccounts.refresh("a", null);
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_refresh", { id: "a", teamId: null });
    await providerAccounts.setAutoSwitch(false);
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_set_auto_switch", { enabled: false });
    await providerAccounts.list();
    expect(invoke).toHaveBeenLastCalledWith("provider_accounts_list");
  });
});
