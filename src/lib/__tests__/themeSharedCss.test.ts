import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const css = postcss.parse(readFileSync(new URL("../../index.css", import.meta.url), "utf8"));
function declaration(selector: string, property: string) {
  let value = "";
  css.walkRules(rule => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls(property, decl => { value = decl.value; });
    }
  });
  return value;
}
function contrastOnPaper(color: string) {
  const channels = color.startsWith("#")
    ? color.slice(1).match(/../g)!.map(c => parseInt(c, 16))
    : (color.match(/[\d.]+/g) || []).map(Number);
  expect(channels.length).toBeGreaterThanOrEqual(3);
  const alpha = channels[3] ?? 1;
  const luminance = (rgb: number[]) => rgb.map(c => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  return (luminance([235, 235, 235]) + 0.05) /
    (luminance(channels.slice(0, 3).map(c => c * alpha + 235 * (1 - alpha))) + 0.05);
}
const light = 'html[data-mode="light"]';
describe("shared light CSS contrast", () => {
  it("matches the parent xterm light surface and native controls", () => {
    expect(declaration(`${light} .terminal-flush-host`, "background-color")).toBe("#ffffff");
    expect(declaration(`${light} .terminal-flush-host`, "color-scheme")).toBe("light");
  });
  it.each(["--status-green", "--status-amber", "--status-red", "--status-blue", "--status-purple"])("%s is readable status text", token => {
    expect(contrastOnPaper(declaration(light, token))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    '.hover\\:text-white\\/60:hover', '.hover\\:text-white\\/75:hover',
    '.hover\\:text-white\\/80:hover', '.hover\\:text-white\\/90:hover',
    '.text-white\\/\\[0\\.48\\]',
  ])("%s remaps pale utility text", selector => {
    expect(contrastOnPaper(declaration(`${light} ${selector}`, "color"))).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps composer placeholders readable on paper", () => {
    expect(contrastOnPaper(declaration(light, "--text-placeholder"))).toBeGreaterThanOrEqual(4.5);
  });
  it("pairs solid accent buttons with light ink after the generic text remaps", () => {
    expect(declaration(`${light} .bg-\\[var\\(--accent\\)\\]`, "color")).toBe("var(--accent-foreground)");
  });
  it.each([
    '.app-chip[data-tone="warn"]', '.app-chip[data-tone="info"]',
    '.app-chip[data-tone="green"]', '.app-chip[data-tone="red"]',
    '.app-chip[data-tone="muted"]', '.glass-seg:hover:not([data-active="true"])',
    '.agent-top-chrome-create-btn:hover', '.agent-top-chrome-filter[data-active="true"]',
    '.issues-state-closed',
    '.orch-card-status[data-state="running"]', '.orch-card-status[data-state="waiting"]',
    '.orch-card-status[data-state="unread"]', '.orch-btn-allow', '.orch-btn-deny',
    '.issues-repo-tab[data-active="true"]', '.issues-repo-tab[data-active="true"] .issues-repo-owner',
    '.issues-repo-count', '.issues-banner', '.issues-banner-error', '.issues-link-btn',
    '.issues-worktree-btn[data-active="true"]', '.mem-kind-important', '.mem-kind-pin',
    '.mem-kind-decision', '.mem-kind-fact', '.mem-kind-issue', '.mem-kind-note', '.mem-kind-session',
  ])("%s has readable light ink", selector => {
    expect(contrastOnPaper(declaration(`${light} ${selector}`, "color") || declaration(selector, "color"))).toBeGreaterThanOrEqual(4.5);
  });
});

it("defines agent terminal canvas backgrounds separately from the shell panel", () => {
  expect(declaration(":root", "--agent-terminal-surface")).toBe("#000000");
  expect(declaration(light, "--agent-terminal-surface")).toBe("#ffffff");
});

describe("Home light-mode readability", () => {
  it.each([".proj .nm", ".sess .lb", ".proj .pic", ".proj .pt", ".proj .br", ".proj .tm", ".sess .sub", ".pill.idle", ".pill.run", ".pill.wait"])("%s has readable text", selector => {
    expect(contrastOnPaper(declaration(`${light} .home-screen-root ${selector}`, "color"))).toBeGreaterThanOrEqual(4.5);
  });
  it("uses theme colors for inline usage labels", () => {
    const source = readFileSync(new URL("../../components/layout/HomeScreen.tsx", import.meta.url), "utf8");
    const palette = source.slice(source.indexOf("function paceColor("), source.indexOf("function parseResetMs("));
    expect(palette).not.toContain("rgb(");
    expect(palette).toContain("var(--status-blue)");
    expect(palette).toContain("var(--status-amber)");
    expect(palette).toContain("var(--status-red)");
  });
});

it.each([
  [".composer-selector-amber", "--status-amber"],
  [".composer-action-amber", "--status-amber"],
  [".composer-selector-violet", "--status-purple"],
])("composer %s uses readable semantic ink", (selector, token) => {
  expect(declaration(selector, "color")).toBe(`var(${token})`);
  expect(contrastOnPaper(declaration(light, token))).toBeGreaterThanOrEqual(4.5);
});

describe("settings toggles in light mode", () => {
  it("uses white thumbs in both states", () => {
    expect(declaration(`${light} .settings-toggle-knob`, "background")).toBe("#ffffff");
  });
  it("replaces the enabled halo with a subtle inset edge", () => {
    expect(declaration(`${light} .settings-toggle`, "box-shadow")).toBe("inset 0 0 0 1px rgba(0, 0, 0, 0.04)");
  });
  it("retains a distinct keyboard focus outline", () => {
    expect(declaration(`${light} .settings-toggle:focus-visible`, "outline")).toBe("2px solid var(--accent)");
    expect(declaration(`${light} .settings-toggle:focus-visible`, "outline-offset")).toBe("3px");
  });
});
