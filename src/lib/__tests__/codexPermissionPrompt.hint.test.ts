import { describe, expect, it } from "vitest";
import { codexPermissionChunkHint } from "../codexPermissionPrompt";

describe("codexPermissionChunkHint", () => {
  it("matches form phrases regardless of case and whitespace", () => {
    expect(codexPermissionChunkHint("\x1b[1m2. Allow  for this\n session\x1b[0m")).toBe(true);
    expect(codexPermissionChunkHint("enter to submit | ESC to cancel")).toBe(true);
  });

  it("ignores ordinary agent output", () => {
    expect(codexPermissionChunkHint("Calling Access Canary Mail")).toBe(false);
    expect(codexPermissionChunkHint("")).toBe(false);
  });
});
