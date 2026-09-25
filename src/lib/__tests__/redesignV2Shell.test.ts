import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const MONO_EYEBROW = /font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono|letterSpacing:\s*"0\.(1[4-9]|2)\d*em"/;

const unified = postcss.parse(src("styles/unified.css"));
const FLAT = 'html[data-surface="flat"]';
function decl(selector: string, property: string) {
  let value = "";
  let important = false;
  unified.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(property, d => { value = d.value; important = d.important ?? false; });
  });
  return important ? `${value} !important` : value;
}

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

  // Rule 5 (mono only for machine text) applies to every span in a swept file,
  // not just the brief's listed lines — prose status text must be sans.
  const around = (text: string, marker: string, before = 160, after = 40) => {
    const i = text.indexOf(marker);
    expect(i, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
    return text.slice(Math.max(0, i - before), i + marker.length + after);
  };

  it("HomeScreen ProviderUsageSection status text (stale/unavailable/loading) is sans, not mono", () => {
    const s = src("components/layout/HomeScreen.tsx");
    const staleSpan = around(s, "stale · {formatRelative");
    expect(staleSpan).not.toMatch(/font-mono/);
    expect(staleSpan).toContain("ui-meta");
    const unavailableSpan = around(s, 'hasEverFetched ? "unavailable" : "loading…"');
    expect(unavailableSpan).not.toMatch(/font-mono/);
    expect(unavailableSpan).toContain("ui-meta");
  });

  it("HomeScreen ModeRow shortcut stays mono (keyboard key)", () => {
    const s = src("components/layout/HomeScreen.tsx");
    const shortcutSpan = around(s, "{shortcut}</span>", 160, 0);
    expect(shortcutSpan).toMatch(/font-mono/);
  });

  it("AccountUsageRows account-status span is sans, not mono", () => {
    const s = src("components/usage/AccountUsageRows.tsx");
    const statusSpan = around(s, "{status && <span", 20, 100);
    expect(statusSpan).not.toMatch(/font-mono/);
    expect(statusSpan).toContain("ui-meta");
  });

  describe("quit dialog buttons get flat hover feedback and a solid danger fill", () => {
    it("fx-quiet has a flat hover state", () => {
      expect(decl(`${FLAT} .fx-quiet:hover`, "background")).toBe("var(--ui-hover) !important");
      expect(decl(`${FLAT} .fx-quiet:hover`, "color")).toBe("var(--text-primary) !important");
    });
    it("fx-danger is a solid red fill with white text (mockup #alerts)", () => {
      expect(decl(`${FLAT} .fx-danger`, "background")).toBe("var(--status-red) !important");
      expect(decl(`${FLAT} .fx-danger`, "color")).toBe("#fff !important");
    });
    it("fx-danger has a flat hover state", () => {
      expect(decl(`${FLAT} .fx-danger:hover`, "filter")).not.toBe("");
    });
  });
});
