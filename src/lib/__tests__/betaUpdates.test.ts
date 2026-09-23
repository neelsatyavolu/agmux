import { describe, expect, it, vi } from "vitest";
import {
  BETA_VERIFY_URL,
  isExpiredAssetError,
  updaterCheckOptions,
  updaterDownloadOptions,
  verifyBetaToken,
} from "../betaUpdates";

describe("updaterCheckOptions", () => {
  it("omits Authorization when toggle is off or token empty", () => {
    expect(updaterCheckOptions(false, "agmux_beta_abc")).toBeUndefined();
    expect(updaterCheckOptions(true, "  ")).toBeUndefined();
    expect(updaterCheckOptions(true, "")).toBeUndefined();
  });

  it("sends Bearer when toggle is on and token is set", () => {
    expect(updaterCheckOptions(true, "  agmux_beta_abc  ")).toEqual({
      headers: { Authorization: "Bearer agmux_beta_abc" },
    });
  });
});

describe("updaterDownloadOptions", () => {
  it("replaces headers with an empty object (no tester Bearer)", () => {
    expect(updaterDownloadOptions()).toEqual({ headers: {} });
  });
});

describe("verifyBetaToken", () => {
  it("skips the network when the field is empty", async () => {
    const fetchImpl = vi.fn();
    expect(await verifyBetaToken("  ", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the token to agmux.dev", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, reason: "revoked" }),
    });
    const result = await verifyBetaToken("agmux_beta_x", fetchImpl);
    expect(result).toEqual({ ok: false, reason: "revoked" });
    expect(fetchImpl).toHaveBeenCalledWith(
      BETA_VERIFY_URL,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "agmux_beta_x" }),
      }),
    );
  });
});

describe("isExpiredAssetError", () => {
  it("detects 403 without treating it as a missing file", () => {
    expect(isExpiredAssetError("403 Forbidden")).toBe(true);
    expect(isExpiredAssetError("not found")).toBe(false);
  });
});
