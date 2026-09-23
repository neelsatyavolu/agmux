import { describe, it, expect } from "vitest";
import { codexAccessModeForPermission } from "../initialPermissions";

describe("codexAccessModeForPermission", () => {
  it("maps full to full-access", () => {
    expect(codexAccessModeForPermission("full")).toBe("full-access");
  });

  it("maps auto to auto (auto_review on the wire)", () => {
    expect(codexAccessModeForPermission("auto")).toBe("auto");
  });

  it("maps default to null (supervised)", () => {
    expect(codexAccessModeForPermission("default")).toBeNull();
  });
});
