import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEND_BTN_ACTIVE, SEND_BTN_IDLE, STOP_BTN } from "../composerChrome";

describe("composer buttons", () => {
  it("are round like the phone app and use the accent's paired ink", () => {
    for (const cls of [SEND_BTN_ACTIVE, SEND_BTN_IDLE, STOP_BTN]) expect(cls).toContain("rounded-full");
    expect(SEND_BTN_ACTIVE).toContain("text-[var(--accent-foreground)]");
    expect(SEND_BTN_ACTIVE).not.toContain("#14110a");
  });
});

describe("composer shell markers", () => {
  it.each(["ClaudeInputBar.tsx", "DraftChatView.tsx", "OpenCodeSdkSessionView.tsx", "CodexSessionView.tsx"])(
    "%s uses the shared composer shell class",
    file => {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src).toContain("composer-shell");
      expect(src).not.toContain("rgba(255,255,255,0.14), rgba(255,255,255,0.02)");
    },
  );
});
