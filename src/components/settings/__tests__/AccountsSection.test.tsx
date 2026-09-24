import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsSection } from "../AccountsSection";
import { providerAccounts, type ProviderAccountsState, type ProviderAccount } from "../../../lib/providerAccounts";

vi.mock("../../../lib/providerAccounts", () => ({ providerAccounts: {
  list: vi.fn(), loginStart: vi.fn(), loginStatus: vi.fn(), loginCancel: vi.fn(), importCurrent: vi.fn(), update: vi.fn(), remove: vi.fn(), refresh: vi.fn(), setAutoSwitch: vi.fn(),
} }));
const account: ProviderAccount = { id: "one", provider: "codex", label: "My Codex", enabled: true, priority: 0, teamId: null, status: "ready", remainingPercent: null, resetsAt: null, lastCheckedAt: null, error: null };
let state: ProviderAccountsState;
beforeEach(() => {
  vi.resetAllMocks();
  state = { accounts: [], teams: [], autoSwitch: true };
  vi.mocked(providerAccounts.list).mockImplementation(async () => state);
  vi.mocked(providerAccounts.loginStart).mockResolvedValue({ id: "login-1", status: "pending" });
  vi.mocked(providerAccounts.loginStatus).mockResolvedValue({ status: "pending" });
  vi.mocked(providerAccounts.loginCancel).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function showAdd() { const add = screen.queryByRole("button", { name: "Add account" }); if (add) fireEvent.click(add); }
function options() { fireEvent.click(screen.getByRole("button", { name: "Options for My Codex" })); }
async function open() {
  render(<AccountsSection />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh accounts" }) as HTMLButtonElement).disabled).toBe(false));
  showAdd();
  await screen.findByRole("button", { name: "Sign in with browser" });
}
async function begin() { await open(); fireEvent.click(screen.getByText("Sign in with browser")); await screen.findByText(/Finish signing in/); }

describe("AccountsSection", () => {
  it("keeps native Claude read-only without copying its login", async () => {
    state.accounts = [{ ...account, provider: "claude", label: "Native Claude", native: true, currentLogin: true, status: "needs_login", error: "Sign in again" }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "Native Claude" }));
    expect(screen.getByRole("heading", { name: "Claude" })).toBeTruthy();
    expect(row.getByText("Current login")).toBeTruthy();
    expect(row.getByText("Sign in again")).toBeTruthy();
    expect(row.queryByRole("button", { name: /Add to switching|Options|Pause|Resume|Remove|Reconnect/ })).toBeNull();
    expect(row.queryByRole("spinbutton")).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Check usage" }));
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledWith("one", null));
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    expect(providerAccounts.update).not.toHaveBeenCalled();
    expect(providerAccounts.remove).not.toHaveBeenCalled();
  });
  it("offers only browser login for new personal Claude profiles", async () => {
    await open();
    expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Account provider"), { target: { value: "claude" } });
    expect(screen.queryByText("Use existing login")).toBeNull();
    fireEvent.click(screen.getByText("Sign in with browser"));
    await screen.findByText(/Finish signing in/);
    expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "claude", label: "Claude account", teamId: null });
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
  });
  it.each(["owner", "manager", "employee"] as const)("resets personal Claude selection across %s team scope changes", async role => {
    state.teams = [{ id: "t", name: "Studio", role, canManage: true }];
    await open();
    fireEvent.change(screen.getByLabelText("Account provider"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.queryByRole("option", { name: "Claude" })).toBeNull();
    if (role !== "employee") {
      expect((screen.getByLabelText("Account provider") as HTMLSelectElement).value).toBe("codex");
      expect(within(screen.getByLabelText("Account provider")).getAllByRole("option").map(option => option.textContent)).toEqual(["Codex", "Grok"]);
      fireEvent.click(screen.getByText("Use existing login"));
      await screen.findByText("Account connected.");
      expect(providerAccounts.importCurrent).toHaveBeenCalledExactlyOnceWith({ provider: "codex", label: "Codex account", teamId: "t" });
      fireEvent.click(screen.getByText("Sign in with browser"));
      await screen.findByText(/Finish signing in/);
      expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "codex", label: "Codex account", teamId: "t" });
      fireEvent.click(screen.getByText("Cancel sign-in"));
      await screen.findByText("Sign-in canceled.");
      await waitFor(() => expect((screen.getByLabelText("Accounts for") as HTMLSelectElement).disabled).toBe(false));
    } else {
      expect(screen.queryByText("Sign in with browser")).toBeNull();
      expect(providerAccounts.loginStart).not.toHaveBeenCalled();
      expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    }
    fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "" } });
    expect((screen.getByLabelText("Account provider") as HTMLSelectElement).value).toBe("codex");
    expect(screen.getByRole("option", { name: "Claude" })).toBeTruthy();
  });
  it("excludes unsupported Claude team rows and their reconnect controls", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [{ ...account, provider: "claude", teamId: "t", canManage: true, status: "needs_login", label: "Unsupported Claude" }];
    await open();
    fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText("Reconnect")).toBeNull();
    expect(providerAccounts.loginStart).not.toHaveBeenCalled();
  });
  it("retains personal managed Claude reconnect and account controls", async () => {
    state.accounts = [{ ...account, provider: "claude", label: "Managed Claude", status: "needs_login" }];
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Options for Managed Claude" }));
    expect(screen.getByText("Pause")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
    expect(screen.getByLabelText("Priority for Managed Claude")).toBeTruthy();
    fireEvent.click(screen.getByText("Reconnect"));
    await screen.findByText(/Finish signing in/);
    expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "claude", label: "Managed Claude", teamId: null });
  });
  it.each(["codex", "grok"] as const)("shows the native %s login without switching-pool controls and imports only on request", async provider => {
    state.accounts = [{ ...account, id: "native", provider, native: true, currentLogin: true, email: "me@example.com", plan: "Plus" }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "My Codex" }));
    expect(row.getByText("Current login")).toBeTruthy();
    expect(row.getByText("Ready")).toBeTruthy();
    expect(row.getByText("me@example.com")).toBeTruthy();
    expect(row.getByText("Plus")).toBeTruthy();
    expect(row.queryByRole("button", { name: /Options|Pause|Resume|Remove|Reconnect/ })).toBeNull();
    expect(row.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy();
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    fireEvent.click(row.getByRole("button", { name: "Check usage" }));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
    expect(providerAccounts.refresh).toHaveBeenCalledWith("native", null);
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    fireEvent.click(row.getByRole("button", { name: "Add to switching" }));
    await screen.findByText("Account added to switching.");
    expect(providerAccounts.importCurrent).toHaveBeenCalledExactlyOnceWith({ provider, label: "My Codex", teamId: null });
    expect(providerAccounts.loginStart).not.toHaveBeenCalled();
    expect(providerAccounts.update).not.toHaveBeenCalled();
    expect(providerAccounts.remove).not.toHaveBeenCalled();
  });
  it("honors a deduplicated managed current login without inferring identity from email or readiness", async () => {
    state.accounts = [
      { ...account, native: false, currentLogin: true, enabled: false, email: "me@example.com" },
      { ...account, id: "other", label: "Other", email: "me@example.com" },
    ];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getAllByText("Current login")).toHaveLength(1);
    const current = within(screen.getByRole("article", { name: "My Codex" }));
    expect(current.getByText("Current login")).toBeTruthy();
    expect(current.getByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to switching" })).toBeNull();
    options();
    expect(current.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(current.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(current.getByLabelText("Priority for My Codex")).toBeTruthy();
  });
  it.each(["Free", "Plus", "Pro 5x", "Pro 20x", "Pro (tier unavailable)"])("renders the backend plan label %s unchanged", async plan => {
    state.accounts = [{ ...account, plan, email: "me@example.com" }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getByText(plan)).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
  });
  it("does not repeat the email when it is already the account label", async () => {
    state.accounts = [{ ...account, label: "Me@example.com", email: "me@example.com", plan: null }];
    render(<AccountsSection />);
    await screen.findByText("Me@example.com");
    expect(screen.getAllByText(/me@example.com/i)).toHaveLength(1);
  });
  it("surfaces a failed native import without claiming it was added", async () => {
    state.accounts = [{ ...account, native: true, currentLogin: true }];
    vi.mocked(providerAccounts.importCurrent).mockRejectedValueOnce(new Error("Login no longer available"));
    render(<AccountsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to switching" }));
    await screen.findByText("Login no longer available");
    expect(screen.queryByText("Account added to switching.")).toBeNull();
    expect((screen.getByRole("button", { name: "Add to switching" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps connection controls and account options out of the populated overview", async () => {
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.queryByRole("button", { name: "Sign in with browser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.getByRole("button", { name: "Sign in with browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Options for My Codex" }));
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });
  it("groups accounts by provider and shows only known reset times", async () => {
    state.accounts = [account, { ...account, id: "two", provider: "grok", label: "Work Grok" }];
    render(<AccountsSection />);
    await screen.findByRole("heading", { name: "Codex" });
    expect(screen.getByRole("heading", { name: "Grok" })).toBeTruthy();
    expect(screen.queryByText("Reset time unavailable")).toBeNull();
    expect(screen.queryByText("Not checked yet")).toBeNull();
  });
  it("does not present unknown usage as zero or full", async () => {
    state.accounts = [account]; await open();
    expect(screen.getByText("Usage unavailable")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("Reset time unavailable")).toBeNull();
  });
  it("shows known usage and paused state", async () => {
    state.accounts = [{ ...account, remainingPercent: 0, enabled: false, resetsAt: 1800000000 }]; await open();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText(/Resets /)).toBeTruthy();
  });
  it("uses native browser login and polls to completion", async () => {
    await begin();
    expect(providerAccounts.loginStart).toHaveBeenCalledWith({ provider: "codex", label: "Codex account", teamId: null });
    vi.mocked(providerAccounts.loginStatus).mockResolvedValueOnce({ status: "complete" });
    await waitFor(() => expect(screen.getByText("Codex account connected.")).toBeTruthy(), { timeout: 2500 });
    expect(screen.queryByText("Cancel sign-in")).toBeNull();
    expect(providerAccounts.list).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending login and ignores late status completion", async () => {
    let finish!: (value: { status: "complete" }) => void;
    vi.mocked(providerAccounts.loginStatus).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await begin();
    fireEvent.click(screen.getByText("Cancel sign-in"));
    await screen.findByText("Sign-in canceled.");
    await act(async () => finish({ status: "complete" }));
    expect(providerAccounts.loginCancel).toHaveBeenCalledWith("login-1");
    expect(screen.queryByText("Codex account connected.")).toBeNull();
  });
  it("cancels login even if start returns after cancellation", async () => {
    let finish!: (value: { id: string; status: string }) => void;
    vi.mocked(providerAccounts.loginStart).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await open(); fireEvent.click(screen.getByText("Sign in with browser"));
    fireEvent.click(screen.getByText("Cancel sign-in"));
    await act(async () => finish({ id: "late", status: "pending" }));
    expect(providerAccounts.loginCancel).toHaveBeenCalledWith("late");
    expect(providerAccounts.loginStatus).not.toHaveBeenCalled();
  });
  it("keeps a late login available when cancellation fails", async () => {
    let finish!: (value: { id: string; status: string }) => void;
    vi.mocked(providerAccounts.loginStart).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(providerAccounts.loginCancel).mockRejectedValueOnce(new Error("Cancel unavailable"));
    await open(); fireEvent.click(screen.getByText("Sign in with browser"));
    fireEvent.click(screen.getByText("Cancel sign-in"));
    await act(async () => finish({ id: "late", status: "pending" }));
    await screen.findByText("Cancel unavailable");
    fireEvent.click(screen.getByText("Cancel sign-in"));
    await screen.findByText("Sign-in canceled.");
    expect(providerAccounts.loginCancel).toHaveBeenCalledTimes(2);
  });
  it("shows browser start errors and permits retry", async () => {
    vi.mocked(providerAccounts.loginStart).mockRejectedValueOnce(new Error("CLI missing"));
    await open(); fireEvent.click(screen.getByText("Sign in with browser"));
    await screen.findByText("CLI missing");
    expect((screen.getByText("Sign in with browser") as HTMLButtonElement).disabled).toBe(false);
  });
  it("cancels an outstanding login when leaving the tab", async () => {
    await begin(); cleanup();
    expect(providerAccounts.loginCancel).toHaveBeenCalledWith("login-1");
  });
  it("surfaces native login failure and permits another attempt", async () => {
    vi.mocked(providerAccounts.loginStatus).mockResolvedValue({ status: "failed", error: "Browser authorization denied" });
    await open(); fireEvent.click(screen.getByText("Sign in with browser"));
    await screen.findByText("Browser authorization denied");
    expect((screen.getByText("Sign in with browser") as HTMLButtonElement).disabled).toBe(false);
  });
  it("retains cancellation and retry after a polling error", async () => {
    vi.mocked(providerAccounts.loginStatus).mockRejectedValueOnce(new Error("offline"));
    await begin(); await screen.findByText(/Could not check sign-in: offline/);
    expect(screen.getByText("Cancel sign-in")).toBeTruthy();
    vi.mocked(providerAccounts.loginStatus).mockResolvedValue({ status: "complete" });
    fireEvent.click(screen.getByText("Check sign-in again"));
    await screen.findByText("Codex account connected.");
  });
  it("surfaces cancellation errors without discarding the login", async () => {
    await begin(); vi.mocked(providerAccounts.loginCancel).mockRejectedValueOnce(new Error("busy"));
    fireEvent.click(screen.getByText("Cancel sign-in"));
    await screen.findByText(/Could not cancel sign-in: busy/);
    expect(screen.getByText("Cancel sign-in")).toBeTruthy();
  });
  it("employee can inspect only the selected team's availability", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [account, { ...account, id: "shared", teamId: "t", label: "Team Grok", provider: "grok", remainingPercent: 54 }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.queryByText("My Codex")).toBeNull();
    expect(screen.getByText("Team Grok")).toBeTruthy();
    expect(screen.getByText("54%")).toBeTruthy();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Sign in with browser")).toBeNull();
  });
  it.each(["owner", "manager"] as const)("%s can import a login to the selected team", async role => {
    state.teams = [{ id: "t", name: "Studio", role, canManage: true }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText("Account provider"), { target: { value: "grok" } });
    fireEvent.change(screen.getByLabelText("Account label"), { target: { value: "Shared Grok" } });
    fireEvent.click(screen.getByText("Use existing login"));
    await screen.findByText("Account connected.");
    expect(providerAccounts.importCurrent).toHaveBeenCalledWith({ provider: "grok", label: "Shared Grok", teamId: "t" });
  });
  it("keeps unavailable team state visible and disables editing", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true, error: "Team API unavailable" }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.getByText("Team accounts unavailable")).toBeTruthy();
    expect(screen.queryByText("No shared accounts yet")).toBeNull();
    expect(screen.queryByText("Sign in with browser")).toBeNull();
    fireEvent.click(screen.getByText("Retry team connection"));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
  });
  it("surfaces team lookup errors while personal accounts remain usable", async () => {
    state.teamError = "Could not load teams. Check your connection.";
    state.accounts = [account];
    await open();
    expect(screen.getByText(state.teamError)).toBeTruthy();
    expect(screen.getByText("My Codex")).toBeTruthy();
    expect(screen.queryByText("Team accounts appear here when you’re connected to a team.")).toBeNull();
    expect((screen.getByText("Sign in with browser") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Use existing login") as HTMLButtonElement).disabled).toBe(false);
    options(); fireEvent.click(screen.getByText("Pause"));
    await waitFor(() => expect(providerAccounts.update).toHaveBeenCalledWith("one", { enabled: false, teamId: null }));
    await waitFor(() => expect((screen.getByText("Retry team connection") as HTMLButtonElement).disabled).toBe(false));
    state = { ...state, teamError: null };
    fireEvent.click(screen.getByText("Retry team connection"));
    await waitFor(() => expect(screen.queryByText("Team accounts unavailable")).toBeNull());
  });
  it("checks new and stale personal usage on open without being asked", async () => {
    const now = Math.floor(Date.now() / 1000);
    state.accounts = [account, { ...account, id: "fresh", label: "Fresh", lastCheckedAt: now }, { ...account, id: "signed-out", label: "Out", status: "needs_login" }];
    vi.mocked(providerAccounts.refresh).mockImplementation(async id => {
      state = { ...state, accounts: state.accounts.map(row => row.id === id ? { ...row, remainingPercent: 70, lastCheckedAt: now } : row) };
    });
    render(<AccountsSection />);
    expect(await screen.findByText("70%")).toBeTruthy();
    expect(providerAccounts.refresh).toHaveBeenCalledExactlyOnceWith("one", null);
    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledWith("fresh", null));
    expect(providerAccounts.refresh).not.toHaveBeenCalledWith("signed-out", null);
  });
  it("checks a team account's usage once when it has never been measured", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [{ ...account, teamId: "t" }, { ...account, id: "paused", teamId: "t", enabled: false }, { ...account, id: "known", teamId: "t", lastCheckedAt: 100 }];
    vi.mocked(providerAccounts.refresh).mockRejectedValue(new Error("This account is in use right now."));
    render(<AccountsSection />);
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledExactlyOnceWith("one", "t"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh accounts" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(3));
    expect(providerAccounts.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("any team member can check an enabled team account and sees when it was measured", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", remainingPercent: 62, lastCheckedAt: 100 }, { ...account, id: "paused", label: "Paused team", teamId: "t", enabled: false, lastCheckedAt: 100 }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    const row = within(screen.getByRole("article", { name: "My Codex" }));
    expect(row.getByText(/checked/)).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Paused team" })).queryByText("Check usage")).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Check usage" }));
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledWith("one", "t"));
    vi.mocked(providerAccounts.refresh).mockRejectedValueOnce(new Error("This account is in use right now."));
    await waitFor(() => expect((row.getByRole("button", { name: "Check usage" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(row.getByRole("button", { name: "Check usage" }));
    expect(await screen.findByText("This account is in use right now.")).toBeTruthy();
  });
  it("team managers get a usage check without personal-only priority controls", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", canManage: true }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    options();
    expect(screen.queryByText("Team usage refreshes automatically while accounts are allocated.")).toBeNull();
    expect(screen.getAllByText("Check usage")).toHaveLength(1);
    expect(screen.queryByLabelText("Priority for My Codex")).toBeNull();
    expect(screen.getByLabelText("Refresh accounts")).toBeTruthy();
    expect(screen.getByText("Pause")).toBeTruthy();
  });
  it.each([false, undefined])("hides team row mutations when account canManage is %s but keeps add available", async canManage => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", canManage, status: "needs_login" }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.getByText("My Codex")).toBeTruthy();
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Reconnect")).toBeNull();
    showAdd();
    expect(screen.getByText("Add a team account")).toBeTruthy();
    expect((screen.getByText("Sign in with browser") as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not let account capability override team permission", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: false }];
    state.accounts = [{ ...account, teamId: "t", canManage: true }];
    await open(); fireEvent.change(screen.getByLabelText("Accounts for"), { target: { value: "t" } });
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.queryByText("Add a team account")).toBeNull();
  });
  it("keeps personal accounts editable regardless of optional team capability", async () => {
    state.accounts = [{ ...account, canManage: false }];
    await open(); options();
    expect(screen.getByText("Pause")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
  });
  it("requires explicit confirmation before removing", async () => {
    state.accounts = [account]; await open(); options(); fireEvent.click(screen.getByText("Remove"));
    expect(providerAccounts.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Keep account")); expect(screen.queryByText("Confirm remove")).toBeNull();
    fireEvent.click(screen.getByText("Remove")); fireEvent.click(screen.getByText("Confirm remove"));
    await screen.findByText("Account removed."); expect(providerAccounts.remove).toHaveBeenCalledWith("one", null);
  });
  it("pauses an account, updates priority, and saves auto-switch", async () => {
    state.accounts = [{ ...account, lastCheckedAt: Math.floor(Date.now() / 1000) }]; await open(); options(); fireEvent.click(screen.getByText("Pause"));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
    expect(providerAccounts.update).toHaveBeenCalledWith("one", { enabled: false, teamId: null });
    const priority = screen.getByLabelText("Priority for My Codex");
    fireEvent.change(priority, { target: { value: "4" } }); fireEvent.blur(priority);
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(3));
    expect(providerAccounts.update).toHaveBeenCalledWith("one", { priority: 4, teamId: null });
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(providerAccounts.setAutoSwitch).toHaveBeenCalledWith(false));
  });
  it("shows list failures and recovers with retry", async () => {
    vi.mocked(providerAccounts.list).mockRejectedValueOnce(new Error("Service unavailable"));
    render(<AccountsSection />); await screen.findByText("Service unavailable");
    fireEvent.click(screen.getByText("Retry")); await screen.findByText("Add an account");
  });
  it("shows mutation errors without claiming success", async () => {
    await open(); vi.mocked(providerAccounts.importCurrent).mockRejectedValueOnce(new Error("CLI is not signed in"));
    fireEvent.click(screen.getByText("Use existing login")); await screen.findByText("CLI is not signed in");
    expect(screen.queryByText("Account connected.")).toBeNull();
  });
});
