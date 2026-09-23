import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

// Default mock: getVersion returns "1.2.3".
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.2.3"),
}));

describe("useAppVersion", () => {
  beforeEach(async () => {
    // Reset module-level cached / inflight singletons by re-importing the module.
    vi.resetModules();
    // Reset the mock state too.
    const mod = await import("@tauri-apps/api/app");
    (mod.getVersion as ReturnType<typeof vi.fn>).mockClear();
    (mod.getVersion as ReturnType<typeof vi.fn>).mockResolvedValue("1.2.3");
  });
  afterEach(() => {
    cleanup();
  });

  it("returns empty string before resolved", async () => {
    const { useAppVersion } = await import("../useAppVersion");
    const { result } = renderHook(() => useAppVersion());
    expect(result.current).toBe("");
  });

  it("resolves to fetched version", async () => {
    const { useAppVersion } = await import("../useAppVersion");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current).toBe("1.2.3"));
  });

  it("caches across hook instances (only one fetch)", async () => {
    const mod = await import("@tauri-apps/api/app");
    const fn = mod.getVersion as ReturnType<typeof vi.fn>;
    const { useAppVersion } = await import("../useAppVersion");

    const { result: r1 } = renderHook(() => useAppVersion());
    await waitFor(() => expect(r1.current).toBe("1.2.3"));

    const { result: r2 } = renderHook(() => useAppVersion());
    await waitFor(() => expect(r2.current).toBe("1.2.3"));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns 'unknown' when getVersion rejects", async () => {
    const mod = await import("@tauri-apps/api/app");
    (mod.getVersion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { useAppVersion } = await import("../useAppVersion");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current).toBe("unknown"));
    errSpy.mockRestore();
  });

  it("logs error to console.error when fetch fails", async () => {
    const mod = await import("@tauri-apps/api/app");
    (mod.getVersion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { useAppVersion } = await import("../useAppVersion");
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current).toBe("unknown"));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("uses cached value immediately on subsequent mounts (synchronous)", async () => {
    const { useAppVersion } = await import("../useAppVersion");
    const { result: r1 } = renderHook(() => useAppVersion());
    await waitFor(() => expect(r1.current).toBe("1.2.3"));

    // Now value is cached — second hook should be 1.2.3 on initial render
    const { result: r2 } = renderHook(() => useAppVersion());
    expect(r2.current).toBe("1.2.3");
  });

  it("returns same version after multiple consecutive renders", async () => {
    const { useAppVersion } = await import("../useAppVersion");
    const { result, rerender } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current).toBe("1.2.3"));
    rerender();
    rerender();
    expect(result.current).toBe("1.2.3");
  });

  it("doesn't update state after unmount when fetch resolves", async () => {
    const mod = await import("@tauri-apps/api/app");
    let resolve: (v: string) => void = () => {};
    (mod.getVersion as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );
    const { useAppVersion } = await import("../useAppVersion");
    const { result, unmount } = renderHook(() => useAppVersion());
    expect(result.current).toBe("");
    unmount();
    // Resolving the promise after unmount should not throw
    resolve("9.9.9");
    // Allow microtasks to flush
    await Promise.resolve();
    // The unmounted hook's result is whatever it was before unmount
    expect(result.current).toBe("");
  });
});
