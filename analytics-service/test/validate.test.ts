import { describe, expect, it } from "vitest";
import { parseEvent, parseHeartbeat, sanitizeDims } from "../src/validate";

describe("validate", () => {
  it.each([parseHeartbeat, parseEvent])("validates the selected install ID alias", (parse) => {
    const valid = "550e8400-e29b-41d4-a716-446655440000";
    const body = { app_version: "4.0.2", name: "app_mode" };
    expect(() => parse({ ...body, install_id: "/private/not-an-id", installId: valid })).toThrow(/UUID v4/);
    expect(parse({ ...body, installId: valid }).installId).toBe(valid);
    expect(parse({ ...body, install_id: valid, installId: "invalid" }).installId).toBe(valid);
  });

  it("accepts a v4 uuid heartbeat and ignores unknown fields", () => {
    const p = parseHeartbeat({
      install_id: "550e8400-e29b-41d4-a716-446655440000",
      app_version: "4.0.2",
      os_name: "macos",
      os_version: "15.5",
      arch: "aarch64",
      channel: "release",
      extra: "drop-me",
    });
    expect(p.installId).toMatch(/^550e8400/);
    expect(p.appVersion).toBe("4.0.2");
  });

  it("defaults channel to release", () => {
    const p = parseHeartbeat({
      install_id: "550e8400-e29b-41d4-a716-446655440000",
      app_version: "1",
    });
    expect(p.channel).toBe("release");
  });

  it("sanitizes event dims to enums", () => {
    expect(
      sanitizeDims("thread_created", {
        provider: "Grok",
        interactionMode: "pty",
        project: "agmux",
      }),
    ).toEqual({ provider: "Grok", interactionMode: "pty" });
    expect(sanitizeDims("app_mode", { mode: "cowork", other: "x" })).toEqual({ mode: "cowork" });
  });

  it("rejects unknown events", () => {
    expect(() =>
      parseEvent({
        install_id: "550e8400-e29b-41d4-a716-446655440000",
        name: "crash",
      }),
    ).toThrow(/unknown event/);
  });
});
