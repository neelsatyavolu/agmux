import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsSection } from "../AccountsSection";
import { providerAccounts, type ProviderAccountsState, type ProviderAccount } from "../../../lib/providerAccounts";
import { useSettingsStore } from "../../../stores/settingsStore";

vi.mock("../../../lib/providerAccounts", () => ({ providerAccounts: {
  list: vi.fn(), loginStart: vi.fn(), loginStatus: vi.fn(), loginCancel: vi.fn(), importCurrent: vi.fn(), update: vi.fn(), remove: vi.fn(), moveToTeam: vi.fn(), use: vi.fn(), refresh: vi.fn(), setAutoSwitch: vi.fn(),
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
function menu(label = "My Codex") { fireEvent.click(screen.getByRole("button", { name: `Options for ${label}` })); }
function item(name: string) { return screen.queryByRole("menuitem", { name }); }
function choose(name: string) { fireEvent.click(screen.getByRole("radio", { name })); }
async function ready() {
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh accounts" }) as HTMLButtonElement).disabled).toBe(false));
}
async function open() {
  render(<AccountsSection />);
  await ready();
  showAdd();
  await screen.findByRole("button", { name: "Sign in with browser" });
}
async function begin() { await open(); fireEvent.click(screen.getByText("Sign in with browser")); await screen.findByText(/Finish signing in/); }

describe("AccountsSection", () => {
  it("keeps native Claude read-only without copying its login", async () => {
    state.accounts = [{ ...account, provider: "claude", label: "Native Claude", native: true, currentLogin: true, status: "needs_login", error: "Sign in again" }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "Native Claude" }));
    expect(row.getByText("Claude")).toBeTruthy();
    expect(row.getByText("Current login")).toBeTruthy();
    expect(row.getByText("Sign in again")).toBeTruthy();
    expect(row.queryByRole("button", { name: /Reconnect/ })).toBeNull();
    menu("Native Claude");
    expect(screen.getAllByRole("menuitem").map(entry => entry.textContent)).toEqual(["Check usage"]);
    fireEvent.click(item("Check usage")!);
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledWith("one", null));
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    expect(providerAccounts.update).not.toHaveBeenCalled();
    expect(providerAccounts.remove).not.toHaveBeenCalled();
  });
  it("uses custom choices, not native selects, and never offers a copy of the current login", async () => {
    await open();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.queryByText("Use existing login")).toBeNull();
    expect(screen.queryByText("Add to switching")).toBeNull();
    expect(screen.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe("true");
  });
  it("offers only browser login for new personal Claude profiles", async () => {
    await open();
    choose("Claude");
    fireEvent.click(screen.getByText("Sign in with browser"));
    await screen.findByText(/Finish signing in/);
    expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "claude", label: "Claude account", teamId: null });
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
  });
  it.each(["owner", "manager"] as const)("%s adds a team account from the team's own section", async role => {
    state.teams = [{ id: "t", name: "Studio", role, canManage: true }];
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    choose("Claude");
    fireEvent.click(screen.getByText("Cancel"));
    const team = within(screen.getByRole("region", { name: "Studio team" }));
    fireEvent.click(team.getByRole("button", { name: "Add team account" }));
    expect(team.getByText("Add an account for Studio")).toBeTruthy();
    expect(team.getByText(/Everyone on Studio can then use it/)).toBeTruthy();
    expect(team.queryByRole("radio", { name: "Claude" })).toBeNull();
    expect(team.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(team.getByRole("radio", { name: "Grok" }));
    fireEvent.change(team.getByLabelText("Account label"), { target: { value: "Shared Grok" } });
    fireEvent.click(team.getByText("Sign in with browser"));
    await screen.findByText(/Finish signing in/);
    expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "grok", label: "Shared Grok", teamId: "t" });
  });
  it("employees see their team's accounts but cannot add to it", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    render(<AccountsSection />);
    const team = within(await screen.findByRole("region", { name: "Studio team" }));
    expect(team.getByText("No team accounts yet.")).toBeTruthy();
    expect(team.queryByRole("button", { name: "Add team account" })).toBeNull();
    expect(screen.queryByText("Open Teams")).toBeNull();
  });
  it("points to Teams when you are not on a team", async () => {
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getByText("Team accounts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Teams" }));
    expect(useSettingsStore.getState().initialTab).toBe("teams");
  });
  it("lists team accounts next to personal ones for every member, with no sign-in needed", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [account, { ...account, id: "shared", teamId: "t", label: "Team Grok", provider: "grok", remainingPercent: 54 }];
    render(<AccountsSection />);
    const shared = within(await screen.findByRole("article", { name: "Team Grok" }));
    expect(within(screen.getByRole("region", { name: "Your accounts" })).getByRole("article", { name: "My Codex" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Studio team" })).getByRole("article", { name: "Team Grok" })).toBeTruthy();
    expect(screen.getByText("Shared with everyone on Studio. Nobody needs to sign in to use them.")).toBeTruthy();
    expect(shared.getByText("54%")).toBeTruthy();
    expect(screen.queryByLabelText("Accounts for")).toBeNull();
    menu("Team Grok");
    expect(screen.getAllByRole("menuitem").map(entry => entry.textContent)).toEqual(["Use this account", "Check usage"]);
    expect(shared.queryByText("Reconnect")).toBeNull();
  });
  it("lists personal accounts before team accounts", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [{ ...account, id: "shared", teamId: "t", label: "Team Codex", canManage: true }, { ...account, priority: 5 }];
    render(<AccountsSection />);
    await screen.findByText("Team Codex");
    expect(screen.getAllByRole("article").map(row => row.getAttribute("aria-label"))).toEqual(["My Codex", "Team Codex"]);
  });
  it("excludes unsupported Claude team rows and their reconnect controls", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [{ ...account, provider: "claude", teamId: "t", canManage: true, status: "needs_login", label: "Unsupported Claude" }];
    await open();
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText("Reconnect")).toBeNull();
    expect(providerAccounts.loginStart).not.toHaveBeenCalled();
  });
  it("retains personal managed Claude reconnect and account controls", async () => {
    state.accounts = [{ ...account, provider: "claude", label: "Managed Claude", status: "needs_login" }];
    render(<AccountsSection />);
    await screen.findByText("Managed Claude");
    menu("Managed Claude");
    expect(item("Pause")).toBeTruthy();
    expect(item("Remove")).toBeTruthy();
    expect(item("Move to team")).toBeNull();
    fireEvent.click(screen.getByText("Reconnect"));
    await screen.findByText(/Finish signing in/);
    expect(providerAccounts.loginStart).toHaveBeenCalledExactlyOnceWith({ provider: "claude", label: "Managed Claude", teamId: null });
  });
  it.each(["codex", "grok"] as const)("shows the native %s login read-only", async provider => {
    state.accounts = [{ ...account, id: "native", provider, native: true, currentLogin: true, email: "me@example.com", plan: "Plus" }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "My Codex" }));
    expect(row.getByText("Current login")).toBeTruthy();
    expect(row.getByText("Ready")).toBeTruthy();
    expect(row.getByText("me@example.com")).toBeTruthy();
    expect(row.getByText("Plus")).toBeTruthy();
    menu();
    expect(item("Pause")).toBeNull();
    expect(item("Remove")).toBeNull();
    fireEvent.click(item("Check usage")!);
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
    expect(providerAccounts.refresh).toHaveBeenCalledWith("native", null);
    expect(providerAccounts.importCurrent).not.toHaveBeenCalled();
    expect(providerAccounts.update).not.toHaveBeenCalled();
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
    menu();
    expect(item("Resume")).toBeTruthy();
    expect(item("Remove")).toBeTruthy();
  });
  it.each(["Free", "Plus", "Pro 5x", "Pro 20x", "Pro (tier unavailable)"])("renders the backend plan label %s unchanged", async plan => {
    state.accounts = [{ ...account, plan, email: "me@example.com" }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getByText(plan)).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
  });
  it("shows the reported tier in place of the broader plan", async () => {
    state.accounts = [
      { ...account, id: "c", provider: "claude", label: "Claude login", native: true, currentLogin: true, plan: "Max", tier: "Max 20x" },
      { ...account, id: "g", provider: "grok", label: "Grok login", native: true, currentLogin: true, tier: "SuperGrok Heavy" },
    ];
    render(<AccountsSection />);
    expect(within(await screen.findByRole("article", { name: "Claude login" })).getByText("Max 20x")).toBeTruthy();
    expect(screen.queryByText("Max")).toBeNull();
    expect(within(screen.getByRole("article", { name: "Grok login" })).getByText("SuperGrok Heavy")).toBeTruthy();
  });
  it("does not repeat the email when it is already the account label", async () => {
    state.accounts = [{ ...account, label: "Me@example.com", email: "me@example.com", plan: null }];
    render(<AccountsSection />);
    await screen.findByText("Me@example.com");
    expect(screen.getAllByText(/me@example.com/i)).toHaveLength(1);
  });
  it("keeps the add form and account actions out of the populated overview", async () => {
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.queryByRole("button", { name: "Sign in with browser" })).toBeNull();
    expect(item("Remove")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.getByRole("button", { name: "Sign in with browser" })).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("button", { name: "Sign in with browser" })).toBeNull();
    menu();
    expect(item("Remove")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(item("Remove")).toBeNull();
  });
  it("labels each account with its service and shows only known reset times", async () => {
    state.accounts = [{ ...account, id: "two", provider: "grok", label: "Work Grok" }, account];
    render(<AccountsSection />);
    expect(within(await screen.findByRole("article", { name: "Work Grok" })).getByText("Grok")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "My Codex" })).getByText("Codex")).toBeTruthy();
    expect(screen.getAllByRole("article").map(row => row.getAttribute("aria-label"))).toEqual(["My Codex", "Work Grok"]);
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
  it("keeps unavailable team state visible without offering to add to it", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true, error: "Team API unavailable" }];
    await open();
    expect(screen.getByText("Team accounts unavailable")).toBeTruthy();
    expect(screen.getByText("Studio: Team API unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add team account" })).toBeNull();
    fireEvent.click(screen.getByText("Retry team connection"));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
  });
  it("surfaces team lookup errors while personal accounts remain usable", async () => {
    state.teamError = "Could not load teams. Check your connection.";
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getByText(state.teamError)).toBeTruthy();
    menu(); fireEvent.click(item("Pause")!);
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
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(3));
    expect(providerAccounts.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("any team member can check an enabled team account and sees when it was measured", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", remainingPercent: 62, lastCheckedAt: 100 }, { ...account, id: "paused", label: "Paused team", teamId: "t", enabled: false, lastCheckedAt: 100 }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "My Codex" }));
    expect(row.getByText(/checked/)).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Paused team" })).queryByRole("button", { name: /Options/ })).toBeNull();
    await ready();
    menu(); fireEvent.click(item("Check usage")!);
    await waitFor(() => expect(providerAccounts.refresh).toHaveBeenCalledWith("one", "t"));
    vi.mocked(providerAccounts.refresh).mockRejectedValueOnce(new Error("This account is in use right now."));
    await ready();
    menu(); fireEvent.click(item("Check usage")!);
    expect(await screen.findByText("This account is in use right now.")).toBeTruthy();
  });
  it("team managers can pause and remove team accounts they manage", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", canManage: true }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu();
    expect(screen.getAllByRole("menuitem").map(entry => entry.textContent)).toEqual(["Use this account", "Check usage", "Rename", "Pause", "Remove"]);
  });
  it.each([false, undefined])("hides team row mutations when account canManage is %s but keeps add available", async canManage => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", canManage, status: "needs_login" }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu();
    expect(item("Pause")).toBeNull();
    expect(item("Remove")).toBeNull();
    expect(screen.queryByText("Reconnect")).toBeNull();
    expect(screen.getByRole("button", { name: "Add team account" })).toBeTruthy();
  });
  it("does not let account capability override team permission", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "manager", canManage: false }];
    state.accounts = [{ ...account, teamId: "t", canManage: true }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu();
    expect(item("Pause")).toBeNull();
    expect(item("Remove")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add team account" })).toBeNull();
  });
  it("keeps personal accounts editable regardless of optional team capability", async () => {
    state.accounts = [{ ...account, canManage: false }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu();
    expect(item("Pause")).toBeTruthy();
    expect(item("Remove")).toBeTruthy();
  });
  it("requires explicit confirmation before removing", async () => {
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu(); fireEvent.click(item("Remove")!);
    expect(providerAccounts.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Keep account")); expect(screen.queryByText("Confirm remove")).toBeNull();
    menu(); fireEvent.click(item("Remove")!); fireEvent.click(screen.getByText("Confirm remove"));
    await screen.findByText("Account removed."); expect(providerAccounts.remove).toHaveBeenCalledWith("one", null);
  });
  it("pauses an account and saves auto-switch", async () => {
    state.accounts = [{ ...account, lastCheckedAt: Math.floor(Date.now() / 1000) }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    await ready();
    menu(); fireEvent.click(item("Pause")!);
    await waitFor(() => expect(providerAccounts.list).toHaveBeenCalledTimes(2));
    expect(providerAccounts.update).toHaveBeenCalledWith("one", { enabled: false, teamId: null });
    await ready();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(providerAccounts.setAutoSwitch).toHaveBeenCalledWith(false));
  });
  it("shows list failures and recovers with retry", async () => {
    vi.mocked(providerAccounts.list).mockRejectedValueOnce(new Error("Service unavailable"));
    render(<AccountsSection />); await screen.findByText("Service unavailable");
    fireEvent.click(screen.getByText("Retry")); await screen.findByText("Add an account for yourself");
  });
  it("shows mutation errors without claiming success", async () => {
    state.accounts = [account];
    vi.mocked(providerAccounts.remove).mockRejectedValueOnce(new Error("Close sessions using this account first"));
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    await ready();
    menu(); fireEvent.click(item("Remove")!); fireEvent.click(screen.getByText("Confirm remove"));
    await screen.findByText("Close sessions using this account first");
    expect(screen.queryByText("Account removed.")).toBeNull();
  });
  it("moves an added personal account to the chosen team after confirmation", async () => {
    state.teams = [{ id: "t1", name: "Studio", role: "owner", canManage: true }, { id: "t2", name: "Lab", role: "manager", canManage: true }, { id: "t3", name: "Viewer", role: "employee", canManage: false }];
    state.accounts = [account];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    await ready();
    menu(); fireEvent.click(item("Move to team")!);
    expect(providerAccounts.moveToTeam).not.toHaveBeenCalled();
    const target = within(screen.getByRole("radiogroup", { name: "Team for My Codex" }));
    expect(target.getAllByRole("radio").map(option => option.textContent)).toEqual(["Studio", "Lab"]);
    fireEvent.click(target.getByRole("radio", { name: "Lab" }));
    fireEvent.click(screen.getByText("Confirm move"));
    await screen.findByText("Moved to Lab.");
    expect(providerAccounts.moveToTeam).toHaveBeenCalledExactlyOnceWith("one", "t2");
  });
  it("shares the current Codex or Grok login with a team but never Claude", async () => {
    state.teams = [{ id: "t1", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [
      { ...account, id: "native:codex:a", label: "Codex login", native: true, currentLogin: true, canManage: false },
      { ...account, id: "native:claude:b", provider: "claude", label: "Claude login", native: true, currentLogin: true, canManage: false },
    ];
    render(<AccountsSection />);
    await screen.findByText("Codex login");
    await ready();
    menu("Claude login");
    expect(item("Move to team")).toBeNull();
    menu("Codex login");
    fireEvent.click(item("Move to team")!);
    const codex = within(screen.getByRole("article", { name: "Codex login" }));
    expect(codex.getByText(/stay signed in/)).toBeTruthy();
    expect(codex.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(codex.getByText("Confirm move"));
    await screen.findByText("Moved to Studio.");
    expect(providerAccounts.moveToTeam).toHaveBeenCalledExactlyOnceWith("native:codex:a", "t1");
  });
  it("shows a shared current login under its team with the current login badge", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [{ ...account, id: "pac_1", teamId: "t", label: "Codex login", currentLogin: true, canManage: true }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "Codex login" }));
    expect(row.getByText("Current login")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Studio team" })).getByRole("article", { name: "Codex login" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Your accounts" })).queryByRole("article")).toBeNull();
    menu("Codex login");
    expect(item("Move to team")).toBeNull();
  });
  it("offers no team move without a team you manage", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: false }];
    state.accounts = [account, { ...account, id: "native:grok:a", provider: "grok", label: "Grok login", native: true, currentLogin: true, canManage: false }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    menu();
    expect(item("Move to team")).toBeNull();
    menu("Grok login");
    expect(item("Move to team")).toBeNull();
  });
  it("switches the CLI to an account after confirmation", async () => {
    state.accounts = [account, { ...account, id: "native:codex:a", label: "Current", native: true, currentLogin: true, canManage: false }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    await ready();
    menu("Current");
    expect(item("Use this account")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    menu(); fireEvent.click(item("Use this account")!);
    expect(screen.getByText("Sign your Codex CLI into “My Codex”?")).toBeTruthy();
    expect(screen.getByText(/The login you’re replacing stays in Your accounts/)).toBeTruthy();
    expect(providerAccounts.use).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("article", { name: "My Codex" })).getByRole("button", { name: "Use this account" }));
    await screen.findByText("Codex now uses “My Codex”.");
    expect(providerAccounts.use).toHaveBeenCalledExactlyOnceWith("one", null);
  });
  it("never offers to switch Claude, a signed-out account, or one a teammate is using", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [
      { ...account, id: "c", provider: "claude", label: "Claude profile" },
      { ...account, id: "o", label: "Signed out", status: "needs_login" },
      { ...account, id: "busy", teamId: "t", label: "Busy", status: "in_use", inUse: { self: false, by: "Alex", kind: "cli" } },
      { ...account, id: "mine", teamId: "t", label: "Mine", status: "in_use", inUse: { self: true, by: "Neel", kind: "cli" } },
    ];
    render(<AccountsSection />);
    await screen.findByText("Busy");
    for (const label of ["Claude profile", "Signed out", "Busy"]) {
      menu(label); expect(item("Use this account")).toBeNull(); fireEvent.keyDown(document, { key: "Escape" });
    }
    expect(within(screen.getByRole("article", { name: "Busy" })).getByText("In use by Alex’s CLI")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Mine" })).getByText("In use by your CLI")).toBeTruthy();
  });
  it("warns when your CLI shares a team account someone else is using", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "employee", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", label: "Shared", currentLogin: true, status: "in_use", inUse: { self: false, by: "Alex", kind: "session" } }];
    render(<AccountsSection />);
    const row = within(await screen.findByRole("article", { name: "Shared" }));
    expect(row.getByText("In use by Alex")).toBeTruthy();
    expect(row.getByText(/you’re both using up its limits/)).toBeTruthy();
  });
  it("shows each reported limit separately and never invents missing ones", async () => {
    state.accounts = [{ ...account, remainingPercent: 30, usage: {
      session: { utilization: 70, resetsAt: "2026-09-24T01:00:00Z", windowMinutes: 300 },
      weekly: { utilization: 25, resetsAt: null, windowMinutes: 10080 },
    } }];
    render(<AccountsSection />);
    await screen.findByText("My Codex");
    expect(screen.getByRole("progressbar", { name: "My Codex 5-hour remaining" }).getAttribute("aria-valuenow")).toBe("30");
    expect(screen.getByRole("progressbar", { name: "My Codex Weekly remaining" }).getAttribute("aria-valuenow")).toBe("75");
    expect(screen.queryByText(/Opus/)).toBeNull();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
  it("labels old readings honestly without a vague unknown status", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [
      { ...account, teamId: "t", id: "old", label: "Old reading", status: "unknown", remainingPercent: 76, lastCheckedAt: 100 },
      { ...account, teamId: "t", id: "never", label: "Never", status: "unknown" },
      { ...account, id: "claude", provider: "claude", label: "Claude team plan", plan: "Team" },
    ];
    render(<AccountsSection />);
    await screen.findByText("Old reading");
    expect(screen.queryByText("Status unknown")).toBeNull();
    expect(within(screen.getByRole("article", { name: "Never" })).getByText("Not checked yet")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Claude team plan" })).getByText("Team plan")).toBeTruthy();
  });
  it("renames an account you manage", async () => {
    state.teams = [{ id: "t", name: "Studio", role: "owner", canManage: true }];
    state.accounts = [{ ...account, teamId: "t", label: "sharedllm3@example.com", canManage: true }];
    render(<AccountsSection />);
    await screen.findByText("sharedllm3@example.com");
    await ready();
    menu("sharedllm3@example.com"); fireEvent.click(item("Rename")!);
    fireEvent.change(screen.getByLabelText("New name for sharedllm3@example.com"), { target: { value: " Nenu Three " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Account renamed.");
    expect(providerAccounts.update).toHaveBeenCalledExactlyOnceWith("one", { label: "Nenu Three", teamId: "t" });
  });
});
