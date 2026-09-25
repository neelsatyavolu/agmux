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

  it("fx-accent has a flat hover state (matches ui-btn[data-variant=accent]:hover)", () => {
    expect(decl(unified, `${FLAT} .fx-accent:hover`, "background")).toBe(
      "color-mix(in srgb, var(--accent) 88%, white)",
    );
  });

  it("fx-input has a flat hover state that doesn't fight the focus ring (button-shaped fields keep hover feedback)", () => {
    expect(decl(unified, `${FLAT} .fx-input:hover:not(:focus):not(:focus-within)`, "background")).toBe(
      "var(--ui-hover)",
    );
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

describe("shell + home flat families", () => {
  const F = 'html[data-surface="flat"]';
  it.each([
    [`${F} .sb-nav-item[data-active="true"]`, "background", "var(--ui-panel)"],
    [`${F} .agent-top-chrome`, "background", "var(--ui-sidebar)"],
    [`${F} .agent-top-chrome-seg button[data-active="true"]`, "background", "var(--ui-panel-2)"],
    [`${F} .agent-top-chrome-pill[data-active="true"]`, "color", "var(--text-primary)"],
    [`${F} .app-card`, "background", "var(--ui-panel)"],
    [`${F} .tile.primary`, "box-shadow", "inset 0 0 0 1px var(--ui-accent-line)"],
    [`${F} .pill.run`, "color", "var(--status-blue)"],
    [`${F} .pill.wait`, "color", "var(--status-amber)"],
    [`${F} .app-kbd`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${F} .cmdk`, "background", "var(--ui-canvas)"],
    [`${F} .pane-tab-active`, "background", "var(--ui-canvas)"],
    [`${F} .pane-tab-bar`, "background", "var(--ui-sidebar)"],
    [`${F} .u-bar`, "background", "var(--ui-panel-2)"],
  ])("%s %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it.each([
    [".pg-h .pnm", "text-transform", "uppercase"], [".pg-h .pnm", "font-size", "11px"],
    [".sb-ttl", "font-weight", "600"], [".sb-ttl", "font-size", "13.5px"],
    [".sb-nav-item", "font-weight", "550"], [".pill", "text-transform", "none"],
    ["#splash-wordmark", "font-family", "var(--font-sans)"],
    [".agent-top-chrome-seg button", "font-size", "12.5px"],
  ])("type %s %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));
});

function hasSelector(root: postcss.Root, selector: string) {
  let found = false;
  root.walkRules(rule => { if (rule.selectors.includes(selector)) found = true; });
  return found;
}

describe("fix round 1: Light + Flat cascade + Glass parity", () => {
  const F = 'html[data-surface="flat"]';

  it.each([
    [`${F} .home-screen-root .proj .nm`, "color", "var(--text-primary)"],
    [`${F} .home-screen-root .sess .lb`, "color", "var(--text-primary)"],
    [`${F} .home-screen-root .proj .pic`, "background", "var(--ui-panel-2)"],
    [`${F} .home-screen-root .proj .pic`, "color", "var(--text-secondary)"],
    [`${F} .home-screen-root .proj .br`, "color", "var(--text-tertiary)"],
    [`${F} .home-screen-root .proj .br`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${F} .home-screen-root .proj .pt`, "color", "var(--text-muted)"],
    [`${F} .home-screen-root .proj .tm`, "color", "var(--text-muted)"],
    [`${F} .home-screen-root .sess .sub`, "color", "var(--text-tertiary)"],
    [`${F} .home-screen-root .pill.idle`, "color", "var(--text-tertiary)"],
    [`${F} .home-screen-root .proj.on .pic`, "background", "var(--ui-panel-2)"],
    [`${F} .home-screen-root .proj.on .pic`, "color", "var(--text-primary)"],
    [`${F} .home-screen-root .proj.on .pic`, "border-color", "transparent"],
    [`${F} .home-screen-root .proj[data-active="true"] .pic`, "border-color", "transparent"],
    [`${F} .home-screen-root .proj[data-active="true"] .pic`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${F} .home-screen-root .proj:hover`, "background", "var(--ui-hover)"],
    [`${F} .home-screen-root .sess:hover`, "background", "var(--ui-hover)"],
    [`${F} .home-screen-root .sess`, "border-top-color", "var(--ui-rule)"],
    [`${F} .home-screen-root .pill.run`, "color", "var(--status-blue)"],
    [`${F} .home-screen-root .pill.wait`, "color", "var(--status-amber)"],
  ])("%s %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it("every index.css light .home-screen-root .proj/.pill/.sess selector has a flat counterpart in unified.css", () => {
    const missing: string[] = [];
    index.walkRules(rule => {
      for (const sel of rule.selectors) {
        if (!sel.startsWith('html[data-mode="light"] .home-screen-root')) continue;
        if (!(sel.includes(".proj") || sel.includes(".pill") || sel.includes(".sess"))) continue;
        const flatSel = sel.replace('html[data-mode="light"]', F);
        if (!hasSelector(unified, flatSel)) missing.push(sel);
      }
    });
    expect(missing).toEqual([]);
  });

  it("pill and kbd box model are flat-only so Glass keeps its size", () => {
    expect(decl(unified, ".pill", "height")).toBe("");
    expect(decl(unified, ".pill", "padding")).toBe("");
    expect(decl(unified, `${F} .pill`, "height")).toBe("22px");
    expect(decl(unified, `${F} .pill`, "padding")).toBe("0 9px");
    expect(decl(unified, ".app-kbd", "padding")).toBe("");
    expect(decl(unified, ".app-kbd", "line-height")).toBe("");
    expect(decl(unified, `${F} .app-kbd`, "padding")).toBe("1px 5px");
    expect(decl(unified, `${F} .app-kbd`, "line-height")).toBe("1.3");
  });
});

describe("conversation/settings/memory flat families", () => {
  const F = 'html[data-surface="flat"]';
  it.each([
    [`${F} .codex-panel`, "background", "var(--ui-code)"],
    [`${F} .codex-panel-head`, "background", "var(--ui-panel-2)"],
    [`${F} .codex-bubble-user`, "background", "var(--ui-bubble)"],
    [`${F} .md-code`, "background", "var(--ui-code)"],
    [`${F} .composer-popover-wash`, "display", "none"],
    [`${F} .status-pill-running`, "color", "var(--status-blue)"],
    [`${F} .status-pill-done`, "color", "var(--status-green)"],
    [`${F} .settings-card`, "background", "var(--ui-panel)"],
    [`${F} .glass-seg[data-active="true"]`, "background", "var(--ui-panel-2)"],
    [`${F} .mem-entry`, "background", "var(--ui-panel)"],
    [`${F} .mem-kind-important`, "color", "var(--status-amber)"],
    [`${F} .mem-kind-binding`, "color", "var(--text-tertiary)"],
  ])("%s %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));
  it("drops uppercase on memory chips in both modes", () => {
    expect(decl(unified, ".mem-filter", "text-transform")).toBe("none");
    expect(decl(unified, ".mem-kind", "text-transform")).toBe("none");
  });
  it("uses the 18px inline approval radius", () => {
    expect(decl(unified, `${F} .approval-card`, "border-radius")).toBe("18px");
  });

  it("status pill box model (padding/min-height) is flat-only so Glass keeps its size", () => {
    expect(decl(unified, ".status-pill", "padding")).toBe("");
    expect(decl(unified, ".status-pill", "min-height")).toBe("");
    expect(decl(unified, `${F} .status-pill`, "padding")).toBe("0 7px");
    expect(decl(unified, `${F} .status-pill`, "min-height")).toBe("19px");
  });
});

function declsFor(root: postcss.Root, selector: string) {
  const found: { prop: string; important: boolean }[] = [];
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls(d => { found.push({ prop: d.prop, important: !!d.important }); });
    }
  });
  return found;
}

describe("Task 4 cascade check: flat counterparts cover light-mode properties (+ !important parity)", () => {
  const F = 'html[data-surface="flat"]';
  const cases: Array<[string, string, string[], string[]?]> = [
    ['html[data-mode="light"] .codex-bubble-user', `${F} .codex-bubble-user`, ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .codex-panel', `${F} .codex-panel`, ["background", "border-color"]],
    ['html[data-mode="light"] .codex-panel-term', `${F} .codex-panel-term`, ["background", "border-color"]],
    ['html[data-mode="light"] .codex-panel-head', `${F} .codex-panel-head`, ["background", "border-bottom-color"]],
    ['html[data-mode="light"] .md-code', `${F} .md-code`, ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .md-code-shell', `${F} .md-code-shell`, ["border-color", "box-shadow"]],
    ['html[data-mode="light"] .md-code-head', `${F} .md-code-head`, ["background", "border-bottom-color"]],
    ['html[data-mode="light"] .md-table-wrap', `${F} .md-table-wrap`, ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .md-table-head', `${F} .md-table-head`, ["background"]],
    ['html[data-mode="light"] .md-table-th', `${F} .md-table-th`, ["border-bottom-color"]],
    ['html[data-mode="light"] .md-table-td', `${F} .md-table-td`, ["border-top-color"]],
    ['html[data-mode="light"] .md-table-row:hover .md-table-td', `${F} .md-table-row:hover .md-table-td`, ["background"]],
    ['html[data-mode="light"] .status-pill-running', `${F} .status-pill-running`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .status-pill-done', `${F} .status-pill-done`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .status-pill-error', `${F} .status-pill-error`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .status-pill-stopped', `${F} .status-pill-stopped`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .status-pill-pending', `${F} .status-pill-pending`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .glass-seg:hover:not([data-active="true"])', `${F} .glass-seg:hover:not([data-active="true"])`, ["background", "color"]],
    ['html[data-mode="light"] .settings-card', `${F} .settings-card`, ["background", "border-color", "box-shadow"], ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .settings-card-header', `${F} .settings-card-header`, ["border-bottom-color"], ["border-bottom-color"]],
    ['html[data-mode="light"] .settings-card-rows > :not(:first-child)', `${F} .settings-card-rows > :not(:first-child)`, ["border-top-color"], ["border-top-color"]],
    ['html[data-mode="light"] .settings-row:hover', `${F} .settings-row:hover`, ["background"]],
    ['html[data-mode="light"] .settings-search', `${F} .settings-search`, ["background", "border-color", "box-shadow"], ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .settings-kbd', `${F} .settings-kbd`, ["background", "border-color", "color"], ["background", "border-color", "color"]],
    ['html[data-mode="light"] .settings-nav-item[data-active="true"]', `${F} .settings-nav-item[data-active="true"]`, ["background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .settings-brand-icon', `${F} .settings-brand-icon`, ["background", "border-color"], ["background", "border-color"]],
    ['html[data-mode="light"] .settings-toggle-off', `${F} .settings-toggle-off`, ["background", "border-color"], ["background", "border-color"]],
    ['html[data-mode="light"] .settings-slider-track', `${F} .settings-slider-track`, ["background"], ["background"]],
    ['html[data-mode="light"] .mem-health', `${F} .mem-health`, ["background", "border-bottom-color"]],
    ['html[data-mode="light"] .mem-filter[data-active="true"]', `${F} .mem-filter[data-active="true"]`, ["background", "color", "border-color"]],
    ['html[data-mode="light"] .mem-entry', `${F} .mem-entry`, ["background", "border-color"]],
    ['html[data-mode="light"] .mem-kind-binding', `${F} .mem-kind-binding`, ["color"]],
    ['html[data-mode="light"] .mem-kind-session', `${F} .mem-kind-session`, ["color"]],
    ['html[data-mode="light"] .mem-kind-review', `${F} .mem-kind-review`, ["color"]],
    ['html[data-mode="light"] .mem-kind-pin', `${F} .mem-kind-pin`, ["color"]],
    ['html[data-mode="light"] .mem-kind-fact', `${F} .mem-kind-fact`, ["color"]],
    ['html[data-mode="light"] .mem-kind-decision', `${F} .mem-kind-decision`, ["color"]],
    ['html[data-mode="light"] .mem-kind-issue', `${F} .mem-kind-issue`, ["color"]],
    ['html[data-mode="light"] .mem-kind-note', `${F} .mem-kind-note`, ["color"]],
    ['html[data-mode="light"] .mem-kind-important', `${F} .mem-kind-important`, ["color"]],
    ['html[data-mode="light"] .mem-more', `${F} .mem-more`, ["color"]],
    ['html[data-mode="light"] .mem-more:hover', `${F} .mem-more:hover`, ["color"]],
  ];

  it.each(cases)("%s -> %s declares the same properties (+ !important where light forces it)", (lightSel, flatSel, props, important) => {
    const lightDecls = declsFor(index, lightSel);
    expect(lightDecls.length, `expected ${lightSel} to exist in index.css`).toBeGreaterThan(0);
    const flatDecls = declsFor(unified, flatSel);
    for (const p of props) {
      const d = flatDecls.find(x => x.prop === p);
      expect(d, `${flatSel} is missing declaration for "${p}"`).toBeTruthy();
      if (important?.includes(p)) {
        expect(d!.important, `${flatSel} "${p}" must be !important to beat the light-mode !important rule`).toBe(true);
      }
    }
  });
});

describe("final whole-branch review fixes", () => {
  const F = 'html[data-surface="flat"]';

  it.each([
    [`${F} .fx-accent:disabled`, "opacity", ".4"],
    [`${F} .fx-accent:disabled`, "cursor", "not-allowed"],
    [`${F} .fx-accent[aria-disabled="true"]`, "opacity", ".4"],
    [`${F} .fx-quiet:disabled`, "opacity", ".4"],
    [`${F} .fx-danger:disabled`, "opacity", ".4"],
  ])("disabled fx-* buttons dim (%s %s)", (sel, prop, value) => {
    expect(decl(unified, sel, prop)).toBe(value);
  });

  it.each([
    [`${F} .ui-btn[data-variant="accent"] .ui-kbd`, "color", "inherit"],
    [`${F} .fx-accent .ui-kbd`, "color", "inherit"],
  ])("kbd hint inside a gold accent button inherits readable text (%s)", (sel, prop, value) => {
    expect(decl(unified, sel, prop)).toBe(value);
  });

  it("fx-chip-q has a flat hover state scoped to interactive elements", () => {
    expect(decl(unified, `${F} button.fx-chip-q:hover`, "background")).toBe("var(--ui-hover)");
    expect(decl(unified, `${F} button.fx-chip-q:hover`, "color")).toBe("var(--text-primary)");
  });

  it("fx-spin-blue colors a border-drawn spinner's leading edge (working = blue)", () => {
    expect(decl(unified, `${F} .fx-spin-blue`, "border-top-color")).toBe("var(--status-blue)");
  });

  it("dark flat fx-danger darkens the red fill so white text clears 4.5:1", () => {
    expect(decl(unified, `${F}:not([data-mode="light"]) .fx-danger`, "background")).toBe(
      "color-mix(in srgb, var(--status-red) 72%, black)",
    );
  });
});

describe("Task 13: subagent cards, editor/file tree, settings sidebar", () => {
  const F = 'html[data-surface="flat"]';

  it.each([
    [`${F} .chat-activity-card`, "background", "var(--ui-panel)"],
    [`${F} .chat-activity-card`, "border-color", "transparent"],
    [`${F} .chat-activity-card`, "box-shadow", "inset 0 0 0 1px var(--ui-rule), var(--ui-shadow-pop)"],
    [`${F} .subagent-avatar-tile`, "background", "var(--ui-panel-2)"],
    [`${F} .subagent-avatar-tile`, "color", "var(--text-secondary)"],
    [`${F} .chat-tasks-rail-btn`, "background", "var(--ui-panel)"],
    [`${F} .chat-tasks-rail-btn:hover`, "background", "var(--ui-hover)"],
    [`${F} .subagent-launch-row[aria-pressed="true"]`, "background", "var(--ui-panel-2)"],
    [`${F} .subagent-launch-row[aria-pressed="true"]`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${F} .panel-bg`, "background", "var(--ui-canvas)"],
    [`${F} .editor-panel-shell`, "border-color", "var(--ui-rule)"],
    [`${F} .file-tree-panel`, "background", "var(--ui-canvas)"],
    [`${F} .file-tree-header`, "background", "var(--ui-sidebar)"],
    [`${F} .file-tree-header`, "border-bottom-color", "var(--ui-rule)"],
    [`${F} .file-tree-filter-section`, "border-bottom-color", "var(--ui-rule)"],
    [`${F} .file-tree-filter-input`, "background", "var(--ui-canvas)"],
    [`${F} .file-tree-filter-input`, "border-color", "var(--ui-rule-2)"],
    [`${F} .file-tree-row-active`, "background", "var(--ui-press)"],
    [`${F} .file-tree-row-active`, "border-left-color", "transparent"],
    [`${F} .file-tree-context-menu`, "border-color", "var(--ui-rule-2)"],
    [`${F} .settings-shell`, "background", "var(--ui-canvas)"],
    [`${F} .settings-sidebar`, "background", "var(--ui-sidebar)"],
    [`${F} .settings-sidebar`, "border-right-color", "var(--ui-rule)"],
    [`${F} .settings-brand-divider`, "border-bottom-color", "var(--ui-rule)"],
    [`${F} .settings-nav-item[data-active="true"] .settings-nav-icon`, "color", "var(--text-primary)"],
  ])("%s %s -> %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it("chat-activity-card ties (later, equal specificity) the light-mode glass rule so Light + Flat resolves to the panel token", () => {
    const lightDecls = declsFor(index, 'html[data-mode="light"] .chat-activity-card');
    expect(lightDecls.length).toBeGreaterThan(0);
    for (const d of lightDecls) expect(d.important).toBe(false);
    const flatDecls = declsFor(unified, `${F} .chat-activity-card`);
    for (const prop of ["background", "border-color", "box-shadow"]) {
      expect(flatDecls.find((d) => d.prop === prop), `${F} .chat-activity-card missing "${prop}"`).toBeTruthy();
    }
  });

  it("settings-shell ties the light-mode glass rule the same way", () => {
    const lightDecls = declsFor(index, 'html[data-mode="light"] .settings-shell');
    expect(lightDecls.length).toBeGreaterThan(0);
    for (const d of lightDecls) expect(d.important).toBe(false);
    expect(declsFor(unified, `${F} .settings-shell`).find((d) => d.prop === "background")).toBeTruthy();
  });

  it("Task 13 follow-up: the Settings main content area (right of the sidebar) has no background of its own in any mode, so it always shows .settings-shell through — confirms the shell's flat canvas fix (above) covers the content side too, not just the sidebar", () => {
    const contentDecls = declsFor(index, ".settings-content");
    const bg = contentDecls.find((d) => d.prop === "background");
    expect(bg, ".settings-content should declare a plain (unscoped) background").toBeTruthy();
    expect(declsFor(unified, `${F} .settings-content`).length, "no flat override should be needed — .settings-content stays transparent in every mode").toBe(0);
    // .settings-topbar (close-bar) is the other piece of the content column;
    // it must also stay transparent so the canvas shows through under it.
    const topbarDecls = declsFor(index, ".settings-topbar");
    expect(topbarDecls.find((d) => d.prop === "background")).toBeTruthy();
    expect(declsFor(unified, `${F} .settings-topbar`).length).toBe(0);
  });

  it.each([
    ['html[data-mode="light"] .file-tree-panel', `${F} .file-tree-panel`, ["background"]],
    ['html[data-mode="light"] .file-tree-header', `${F} .file-tree-header`, ["background", "border-bottom-color"]],
    ['html[data-mode="light"] .file-tree-filter-section', `${F} .file-tree-filter-section`, ["border-bottom-color"]],
    ['html[data-mode="light"] .file-tree-filter-input', `${F} .file-tree-filter-input`, ["background", "border-color"]],
    ['html[data-mode="light"] .settings-sidebar', `${F} .settings-sidebar`, ["background", "border-right-color"]],
    ['html[data-mode="light"] .settings-brand-divider', `${F} .settings-brand-divider`, ["border-bottom-color"]],
  ])("%s -> %s declares the same properties, all !important (light forces it)", (lightSel, flatSel, props) => {
    const lightDecls = declsFor(index, lightSel);
    expect(lightDecls.length, `expected ${lightSel} to exist in index.css`).toBeGreaterThan(0);
    for (const d of lightDecls) expect(d.important, `${lightSel} "${d.prop}" expected !important`).toBe(true);
    const flatDecls = declsFor(unified, flatSel);
    for (const p of props) {
      const d = flatDecls.find((x) => x.prop === p);
      expect(d, `${flatSel} is missing declaration for "${p}"`).toBeTruthy();
      expect(d!.important, `${flatSel} "${p}" must be !important to beat the light-mode !important rule`).toBe(true);
    }
  });
});
