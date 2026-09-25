import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const unified = postcss.parse(read("../../styles/unified.css"));
const index = postcss.parse(read("../../index.css"));
const FLAT = 'html[data-surface="flat"]';

function decl(root: postcss.Root, selector: string, prop: string) {
  let value = "";
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(prop, d => { value = d.value; });
  });
  return value;
}

describe("redesign v2 foundation", () => {
  it("sets the phone-app eyebrow tokens", () => {
    expect(decl(index, ":root", "--text-eyebrow")).toBe("11px");
    expect(decl(index, ":root", "--panel-eyebrow-tracking")).toBe("0.08em");
  });

  it("adds hover/press/bubble/term tokens for both modes", () => {
    for (const t of ["--ui-hover", "--ui-press", "--ui-bubble", "--ui-term"]) {
      expect(decl(unified, ":root", t)).not.toBe("");
      expect(decl(unified, 'html[data-mode="light"]', t)).not.toBe("");
    }
  });

  it("eyebrow class is sans 11/700/.08em caps and only colored in flat", () => {
    expect(decl(unified, ".ui-eyebrow", "font-family")).toBe("var(--font-sans)");
    expect(decl(unified, ".ui-eyebrow", "font-size")).toBe("11px");
    expect(decl(unified, ".ui-eyebrow", "font-weight")).toBe("700");
    expect(decl(unified, ".ui-eyebrow", "letter-spacing")).toBe("0.08em");
    expect(decl(unified, ".ui-eyebrow", "color")).toBe("");
    expect(decl(unified, `${FLAT} .ui-eyebrow`, "color")).toBe("var(--text-tertiary)");
  });

  it("chip, kbd, diff and titles match the mockup", () => {
    expect(decl(unified, ".ui-chip", "height")).toBe("22px");
    expect(decl(unified, ".ui-chip", "font-weight")).toBe("650");
    expect(decl(unified, ".ui-chip.sm", "height")).toBe("19px");
    expect(decl(unified, ".ui-kbd", "border-radius")).toBe("5px");
    expect(decl(unified, `${FLAT} .ui-kbd`, "box-shadow")).toBe("inset 0 0 0 1px var(--ui-rule-2)");
    expect(decl(unified, ".ui-diff", "font-variant-numeric")).toBe("tabular-nums");
    expect(decl(unified, ".ui-title-xl", "font-size")).toBe("34px");
    expect(decl(unified, ".ui-title-d", "font-size")).toBe("20px");
  });

  it("every fx-* helper is flat-scoped and !important", () => {
    const offenders: string[] = [];
    unified.walkRules(rule => {
      for (const sel of rule.selectors) {
        if (!/\.fx-/.test(sel)) continue;
        if (!sel.startsWith(FLAT)) offenders.push(sel);
        rule.walkDecls(d => { if (!d.important) offenders.push(`${sel} ${d.prop}`); });
      }
    });
    expect(offenders).toEqual([]);
  });

  it.each([
    ["fx-graphite", "color", "var(--text-tertiary)"],
    ["fx-panel", "background", "var(--ui-panel)"],
    ["fx-scrim", "background", "var(--ui-scrim)"],
    ["fx-accent", "background", "var(--accent)"],
    ["fx-press", "background", "var(--ui-panel-2)"],
    ["fx-chip-q", "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    ["fx-soft-blue", "color", "var(--status-blue)"],
  ])("%s sets %s", (cls, prop, value) => {
    expect(decl(unified, `${FLAT} .${cls}`, prop)).toBe(value);
  });
});

describe("flat neutral remap", () => {
  const FLAT = 'html[data-surface="flat"]';
  const DARK_FLAT = 'html[data-surface="flat"]:not([data-mode="light"])';
  it.each([
    ["--color-zinc-100", "var(--text-primary)"], ["--color-zinc-200", "var(--text-primary)"],
    ["--color-zinc-300", "var(--text-secondary)"], ["--color-zinc-400", "var(--text-tertiary)"],
    ["--color-zinc-500", "var(--text-muted)"], ["--color-zinc-600", "var(--text-muted)"],
    ["--color-zinc-700", "var(--ui-rule-2)"], ["--color-zinc-800", "var(--ui-panel-2)"],
    ["--color-zinc-900", "var(--ui-panel)"], ["--color-zinc-950", "var(--ui-canvas)"],
  ])("%s -> %s", (v, value) => expect(decl(unified, FLAT, v)).toBe(value));

  it("keeps zinc-700 text readable", () => {
    expect(decl(unified, `${FLAT} .text-zinc-700`, "color")).toBe("var(--text-muted)");
  });

  it("keeps the placeholder-zinc-700 composer placeholder readable", () => {
    expect(decl(unified, `${FLAT} .placeholder-zinc-700::placeholder`, "color")).toBe("var(--text-muted)");
  });

  it("keeps border-zinc-300 a rule color, not a text color", () => {
    expect(decl(unified, `${FLAT} .border-zinc-300`, "border-color")).toBe("var(--ui-rule-2)");
  });

  it.each([
    ["--color-red-400", "var(--status-red)"], ["--color-emerald-400", "var(--status-green)"],
    ["--color-green-400", "var(--status-green)"], ["--color-blue-400", "var(--status-blue)"],
    ["--color-sky-400", "var(--status-blue)"], ["--color-indigo-400", "var(--status-blue)"],
    ["--color-amber-400", "var(--status-amber)"], ["--color-violet-400", "var(--status-purple)"],
  ])("dark flat status hue %s", (v, value) => expect(decl(unified, DARK_FLAT, v)).toBe(value));

  it.each([
    [".border-white\\/5", "var(--ui-rule)"], [".border-white\\/\\[0\\.06\\]", "var(--ui-rule)"],
    [".border-white\\/10", "var(--ui-rule-2)"], [".border-white\\/\\[0\\.08\\]", "var(--ui-rule-2)"],
  ])("white-alpha border %s", (sel, value) => {
    expect(decl(unified, `${FLAT} ${sel}`, "border-color")).toBe(value);
  });
});
