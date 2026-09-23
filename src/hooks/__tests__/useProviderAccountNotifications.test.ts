import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { useProviderAccountNotifications } from "../useProviderAccountNotifications";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
let emit: (payload: unknown) => void;
const unlisten = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockImplementation(async (event, callback) => {
    emit = payload => callback({ event, id: 0, payload });
    return unlisten;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const event = { provider: "codex", sessionKey: "session-1", status: "ready" };

describe("useProviderAccountNotifications", () => {
  describe.each(["claude", "codex", "grok"])("%s", provider => {
    it.each([
      ["model_unavailable", "Account switching paused: this session’s model could not be verified."],
      ["waiting_for_idle", "Usage limit reached. Waiting for this session to finish its current work before switching accounts."],
      ["identity_unavailable", "Usage limit reached. Reopen this session to choose another account."],
      ["ready", "Account switched. Conversation is ready to continue."],
      ["resume_failed", "Account switched, but the conversation could not be reopened. Open the conversation to try again."],
      ["unavailable", "No replacement account is available. Check Accounts for sign-in and usage availability."],
    ])("presents fixed copy for %s", async (status, message) => {
      const { result } = renderHook(useProviderAccountNotifications);
      await act(async () => {});
      expect(listen).toHaveBeenCalledWith("provider-account-runtime", expect.any(Function));
      act(() => emit({ ...event, provider, status, credentials: "secret", error: "secret", accountLabel: "secret" }));
      expect(result.current.notifications[0]).toEqual({ key: JSON.stringify([provider, event.sessionKey]), provider, status, message });
      expect(JSON.stringify(result.current.notifications)).not.toContain("secret");
    });
  });
  it("keeps Claude distinct from Codex and Grok for the same session key", async () => {
    const { result } = renderHook(useProviderAccountNotifications);
    await act(async () => {});
    act(() => {
      emit(event);
      emit({ ...event, provider: "grok" });
      emit({ ...event, provider: "claude", status: "waiting_for_idle" });
      emit({ ...event, provider: "claude", status: "ready" });
      emit({ ...event, provider: "claude", status: "ready" });
    });
    expect(result.current.notifications.map(({ provider, status }) => [provider, status])).toEqual([
      ["codex", "ready"], ["grok", "ready"], ["claude", "ready"],
    ]);
    act(() => result.current.dismiss(JSON.stringify(["claude", event.sessionKey])));
    expect(result.current.notifications.map(notice => notice.provider)).toEqual(["codex", "grok"]);
  });
  it("updates terminal notices without retaining rehydration metadata", async () => {
    const { result } = renderHook(useProviderAccountNotifications);
    await act(async () => {});
    act(() => emit({ ...event, status: "waiting_for_idle" }));
    expect(result.current.notifications[0].message).not.toContain("Account switched");
    act(() => emit({ ...event, status: "identity_unavailable" }));
    expect(result.current.notifications[0].message).not.toContain("Account switched");
    act(() => emit({ ...event, threadId: "terminal-thread", continuationRequired: true }));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]).toEqual({
      key: JSON.stringify(["codex", "session-1"]), provider: "codex", status: "ready",
      message: "Account switched. Conversation is ready to continue.",
    });
  });
  it("replaces state per session and deduplicates repeated notices", async () => {
    const { result } = renderHook(useProviderAccountNotifications);
    await act(async () => {});
    act(() => { emit(event); emit(event); emit({ ...event, status: "unavailable" }); });
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].status).toBe("unavailable");
    act(() => emit({ ...event, provider: "grok" }));
    expect(result.current.notifications).toHaveLength(2);
    act(() => result.current.dismiss(result.current.notifications[0].key));
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0].provider).toBe("grok");
  });
  it.each(["claude", "codex", "grok"])("ignores unknown statuses and malformed %s events", async provider => {
    const { result } = renderHook(useProviderAccountNotifications);
    await act(async () => {});
    const payload = { ...event, provider };
    act(() => [null, "secret", {}, { ...payload, status: "unchanged" }, { ...payload, status: "toString" }, { ...payload, provider: "other" }, { ...payload, sessionKey: "" }].forEach(emit));
    expect(result.current.notifications).toEqual([]);
  });
  it("bounds notices without conflating concurrent sessions", async () => {
    const { result } = renderHook(useProviderAccountNotifications);
    await act(async () => {});
    act(() => { for (let i = 0; i < 6; i++) emit({ ...event, sessionKey: String(i) }); });
    expect(result.current.notifications).toHaveLength(4);
    expect(new Set(result.current.notifications.map(item => item.key)).size).toBe(4);
  });
  it("unsubscribes on unmount and ignores late callbacks", async () => {
    const { result, unmount } = renderHook(useProviderAccountNotifications);
    await act(async () => {}); unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    act(() => emit(event));
    expect(result.current.notifications).toEqual([]);
  });
  it("unsubscribes when registration resolves after unmount", async () => {
    let resolve!: (stop: () => void) => void;
    vi.mocked(listen).mockReturnValue(new Promise(done => { resolve = done; }));
    const { unmount } = renderHook(useProviderAccountNotifications);
    unmount(); await act(async () => resolve(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
  });
  it("handles listener failure without exposing native error details", async () => {
    vi.mocked(listen).mockRejectedValue(new Error("secret token"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(useProviderAccountNotifications);
    await act(async () => {});
    expect(warn).toHaveBeenCalledExactlyOnceWith("Account change notifications are unavailable.");
  });
});
