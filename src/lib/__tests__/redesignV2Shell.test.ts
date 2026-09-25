import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

describe("shell/home sweep", () => {
  it.each(["components/layout/HomeScreen.tsx", "components/usage/AccountUsageRows.tsx"])("%s has no mono eyebrows", f => {
    expect(src(f)).not.toMatch(MONO_EYEBROW);
  });
  it("Home uses the title/stat vocabulary", () => {
    const s = src("components/layout/HomeScreen.tsx");
    expect(s).toContain("ui-title-xl");
    expect(s).toContain("home-stat");
  });
  it("quit dialog is a flat 20px dialog", () => {
    const s = src("App.tsx");
    expect(s).toContain("rounded-[20px]");
    expect(s).toContain("fx-dialog");
    expect(s).toContain("fx-scrim");
  });
});
