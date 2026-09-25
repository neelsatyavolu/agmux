import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

describe("Teams chrome on the shared slate palette", () => {
  it("primitives.tsx has no mono eyebrows left and uses the shared seg/chip vocabulary", () => {
    const s = src("components/teams/primitives.tsx");
    expect(s).not.toMatch(MONO_EYEBROW);
    expect(s).toContain("ui-seg");
    expect(s).toContain("fx-chip-q");
  });

  it("charts.tsx keeps its categorical chart colors byte-for-byte (Rule 4)", () => {
    const current = src("components/teams/charts.tsx");
    const atHead = execSync("git show HEAD:src/components/teams/charts.tsx", {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
    });
    expect(current).toBe(atHead);
  });
});
