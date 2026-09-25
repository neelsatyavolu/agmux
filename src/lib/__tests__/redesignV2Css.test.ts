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
    // H3: project group names are user repo names, not an eyebrow — mixed
    // case, no tracking, so "PROJECTS" (the real eyebrow, .sb-thh .lbl)
    // stays visually distinct from its child group names.
    [".pg-h .pnm", "text-transform", "none"], [".pg-h .pnm", "font-size", "12.5px"],
    [".pg-h .pnm", "letter-spacing", "normal"], [".pg-h .pnm", "font-weight", "600"],
    // H4: inactive rows are lighter than before so bold no longer marks
    // every row (weight/color step up only on the active row — see the
    // "H2/H4: sidebar row active vs inactive" describe block below).
    [".sb-ttl", "font-weight", "500"], [".sb-ttl", "font-size", "13px"],
    [".sb-nav-item", "font-weight", "550"], [".pill", "text-transform", "none"],
    ["#splash-wordmark", "font-family", "var(--font-sans)"],
    [".agent-top-chrome-seg button", "font-size", "12.5px"],
  ])("type %s %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it("H3: the rename input shares .pg-h .pnm's casing fix explicitly (belt + suspenders on top of the base selector)", () => {
    expect(decl(unified, ".pg-h input.pnm", "text-transform")).toBe("none");
    expect(decl(unified, ".pg-h input.pnm", "letter-spacing")).toBe("normal");
  });
});

describe("H2/H4: sidebar row active vs inactive (dark hover/selected collision + bold-every-row)", () => {
  const F = 'html[data-surface="flat"]';
  const DARK_F = `${F}:not([data-mode="light"])`;

  it.each([
    [`${DARK_F} .sb-row.on`, "background", "var(--ui-panel-2)"],
    [`${DARK_F} .sb-row.on`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${DARK_F} .sb-nav-item[data-active="true"]`, "background", "var(--ui-panel-2)"],
    [`${DARK_F} .sb-nav-item[data-active="true"]`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
    [`${DARK_F} .settings-nav-item[data-active="true"]`, "background", "var(--ui-panel-2)"],
    [`${DARK_F} .settings-nav-item[data-active="true"]`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2)"],
  ])("%s %s -> %s", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it("light flat keeps the pre-existing selected treatment (white bg was already fine, not touched)", () => {
    // No light-only override exists for these selectors — only the light
    // base rule (panel/rule) + this dark-only bump. Confirms the dark-only
    // scoping actually excludes light.
    expect(hasSelector(unified, 'html[data-surface="flat"][data-mode="light"] .sb-row.on')).toBe(false);
  });

  it.each([
    [`${F} .sb-row.on .sb-ttl`, "color", "var(--text-primary)"],
    [`${F} .sb-row.on .sb-ttl`, "font-weight", "600"],
    [`${F} .sb-row[data-active="true"] .sb-ttl`, "color", "var(--text-primary)"],
  ])("%s %s -> %s (active title steps up)", (sel, prop, value) => expect(decl(unified, sel, prop)).toBe(value));

  it("inactive .sb-ttl is secondary, not primary (H2)", () => {
    expect(decl(unified, `${F} .sb-ttl`, "color")).toBe("var(--text-secondary)");
  });
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
    // H5: press (8% white) barely read as selected next to hover (4.5%),
    // and the left bar that used to mark the open file was gone entirely.
    [`${F} .file-tree-row-active`, "background", "var(--ui-panel-2)"],
    [`${F} .file-tree-row-active`, "border-left-color", "var(--text-tertiary)"],
    [`${F} .file-tree-context-menu`, "border-color", "transparent"],
    [`${F} .file-tree-context-menu`, "box-shadow", "inset 0 0 0 1px var(--ui-rule-2), var(--ui-shadow-pop)"],
    [`${F} .settings-shell`, "background", "var(--ui-canvas)"],
    [`${F} .settings-sidebar`, "background", "var(--ui-sidebar)"],
    [`${F} .settings-sidebar`, "border-right-color", "var(--ui-rule)"],
    [`${F} .settings-brand-divider`, "border-bottom-color", "var(--ui-rule)"],
    [`${F} .settings-nav-item[data-active="true"] .settings-nav-icon`, "color", "var(--text-primary)"],
    [`${F} .settings-nav-item[data-active="true"] .settings-nav-icon svg`, "color", "var(--text-primary)"],
    [`${F} .settings-nav-item[data-active="true"] svg`, "color", "var(--text-primary)"],
    [`${F} .chat-activity-card-header`, "background", "transparent"],
    [`${F} .chat-activity-card-header`, "border-bottom-color", "transparent"],
    [`${F} .subagent-activity-row:hover`, "border-color", "var(--ui-rule-2)"],
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

  it("fix round 1 #5: file-tree-context-menu overrides both the inline border AND the inline box-shadow (both need !important to beat an inline style={{}})", () => {
    for (const prop of ["border-color", "box-shadow"]) {
      const d = declsFor(unified, `${F} .file-tree-context-menu`).find((x) => x.prop === prop);
      expect(d, `${F} .file-tree-context-menu missing "${prop}"`).toBeTruthy();
      expect(d!.important, `${F} .file-tree-context-menu "${prop}" must be !important to beat the inline style`).toBe(true);
    }
  });

  it("fix round 1 #1: selector coverage — index.css's unscoped .settings-nav-item[data-active] svg/span accent rule still exists with exactly these two arms, and BOTH have a higher-specificity flat !important counterpart (a rule painting only the wrapping span never overrides the svg's own directly-targeted color)", () => {
    let goldRuleFound = false;
    let goldRuleColorImportant = false;
    index.walkRules((rule) => {
      if (
        rule.selectors.includes('.settings-nav-item[data-active="true"] svg') &&
        rule.selectors.includes('.settings-nav-item[data-active="true"] span')
      ) {
        goldRuleFound = true;
        rule.walkDecls("color", (d) => { goldRuleColorImportant = goldRuleColorImportant || !!d.important; });
      }
    });
    expect(
      goldRuleFound,
      "index.css's .settings-nav-item[data-active] svg/span gold rule moved or was removed — re-check whether the flat override below is still needed",
    ).toBe(true);
    expect(goldRuleColorImportant, "index.css arm should stay non-!important").toBe(false);

    // Every arm of the index.css selector list needs a flat counterpart at
    // (at least) one extra attribute selector of specificity, i.e. prefixed
    // with the html[data-surface="flat"] attribute selector this branch
    // always adds — that alone beats the unscoped rule regardless of order,
    // and every one below is also !important for defense in depth.
    for (const arm of ['.settings-nav-item[data-active="true"] svg']) {
      const flatSel = `${F} ${arm}`;
      expect(hasSelector(unified, flatSel), `expected a flat counterpart for index.css arm "${arm}"`).toBe(true);
      expect(decl(unified, flatSel, "color")).toBe("var(--text-primary)");
      const d = declsFor(unified, flatSel).find((x) => x.prop === "color");
      expect(d?.important, `${flatSel} "color" must be !important`).toBe(true);
    }
    // The "span" arm only ever matches .settings-nav-icon in this codebase
    // (item.label is plain text, not wrapped in a span) — that flat
    // counterpart already exists and is asserted in the it.each table above.
    expect(hasSelector(unified, `${F} .settings-nav-item[data-active="true"] .settings-nav-icon`)).toBe(true);
  });
});

describe("Task 14 usability audit: H1/H5/M2/M4/M5/M7", () => {
  const F = 'html[data-surface="flat"]';

  function relLuminance(hex: string): number {
    const n = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function contrast(a: string, b: string): number {
    const [l1, l2] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  }

  it("H1: --text-muted clears 4.5:1 on canvas/sidebar/panel in both modes", () => {
    const darkMuted = "#808895";
    const darkBgs = { canvas: "#0f1115", sidebar: "#13161b", panel: "#1a1e25" };
    for (const [name, bg] of Object.entries(darkBgs)) {
      expect(contrast(darkMuted, bg), `dark muted vs ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    const lightMuted = "#636c7d";
    const lightBgs = { canvas: "#f7f8fa", sidebar: "#edf0f3", panel: "#ffffff" };
    for (const [name, bg] of Object.entries(lightBgs)) {
      expect(contrast(lightMuted, bg), `light muted vs ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("H5: the floating editor tab pill is scoped separately from the top session pane tabs, which keep their canvas-on-sidebar fill", () => {
    expect(decl(unified, `${F} .editor-tabs-bar .pane-tab-active`, "background")).toBe("var(--ui-panel-2)");
    expect(decl(unified, `${F} .editor-tabs-bar .pane-tab-active`, "box-shadow")).toBe(
      "inset 0 0 0 1px var(--ui-rule-2)",
    );
    // Unscoped rule (session pane tabs) is untouched.
    expect(decl(unified, `${F} .pane-tab-active`, "background")).toBe("var(--ui-canvas)");
  });

  it("M2: the choice-item radio/checkbox indicator matches the gold selection ring when selected", () => {
    expect(decl(unified, `${F} .ui-choice-item[data-active="true"] .ui-choice-dot`, "background")).toBe(
      "var(--brand-gold)",
    );
    expect(decl(unified, `${F} .ui-choice-item[data-active="true"] .ui-choice-dot`, "color")).toBe(
      "var(--accent-foreground)",
    );
  });

  it("M4: active top-chrome session chip is panel-2 + a rule-2 ring, not canvas (canvas read as recessed next to hover)", () => {
    expect(decl(unified, `${F} .agent-top-chrome-chip[data-active="true"]`, "background")).toBe("var(--ui-panel-2)");
    expect(decl(unified, `${F} .agent-top-chrome-chip[data-active="true"]`, "box-shadow")).toBe(
      "inset 0 0 0 1px var(--ui-rule-2)",
    );
  });

  it("M4: inactive pane tab hover no longer paints a lighter fill than the active tab (background token collapses to the resting sidebar fill; feedback moves to border + text)", () => {
    expect(decl(unified, F, "--surface-tab-inactive-hover")).toBe("var(--ui-sidebar)");
    expect(decl(unified, `${F} .pane-tab-inactive:hover .text-zinc-300`, "color")).toBe("var(--text-primary)");
  });

  it("M5: split/task-view toggle 'on' state carries a ring so it doesn't read the same as hover", () => {
    expect(decl(unified, `${F} .tbtn[data-active="true"]:not(.split-on)`, "box-shadow")).toBe(
      "inset 0 0 0 1px var(--ui-rule-2)",
    );
    expect(decl(unified, `${F} .tbtn.split-on`, "box-shadow")).toBe("inset 0 0 0 1px var(--ui-rule-2)");
  });

  it("M7: important memory entries get a gold left edge distinct from the normal entry ring", () => {
    expect(decl(unified, `${F} .mem-entry-important`, "box-shadow")).toBe(
      "inset 2px 0 0 var(--brand-gold), inset 0 0 0 1px var(--ui-rule)",
    );
  });
});

describe("terminals: slate surface and shell panel chrome (Flat)", () => {
  const F = 'html[data-surface="flat"]';

  it("paints terminal hosts with the slate terminal token", () => {
    expect(decl(unified, `${F} .fx-term`, "background")).toBe("var(--ui-term)");
    expect(decl(unified, ":root", "--ui-term")).toBe("#0b0d10");
    expect(decl(unified, 'html[data-mode="light"]', "--ui-term")).toBe("#fbfbfc");
  });

  it("shares one surface between the shell panel canvas and its chrome", () => {
    expect(decl(unified, `${F} .terminal-panel-surface`, "background")).toBe("var(--terminal-surface, var(--ui-term))");
    expect(decl(unified, `${F} .terminal-panel-bg`, "--term-chrome")).toBe("var(--ui-canvas)");
    expect(decl(unified, `${F} .terminal-panel-bg`, "border-top")).toBe("1px solid var(--ui-rule)");
    expect(decl(unified, `${F} .terminal-panel-bg`, "box-shadow")).toBe("none");
  });

  it("uses graphite tabs with a neutral active tab, never gold", () => {
    expect(decl(unified, `${F} .terminal-panel-tab`, "color")).toBe("var(--text-tertiary)");
    expect(decl(unified, `${F} .terminal-panel-tab[data-active="true"]`, "background")).toBe("var(--ui-panel)");
    expect(decl(unified, `${F} .terminal-panel-tab[data-active="true"]`, "box-shadow")).toBe("inset 0 0 0 1px var(--ui-rule)");
    expect(decl(unified, `${F} .terminal-panel-gb:hover:not(:disabled)`, "background")).toBe("var(--ui-hover)");
  });

  const cases: Array<[string, string, string[]]> = [
    ['html[data-mode="light"] .terminal-panel-bg', `${F} .terminal-panel-bg`, ["--term-chrome", "--term-hairline", "background", "border-top", "box-shadow"]],
    ['html[data-mode="light"].no-vibrancy .terminal-panel-bg', `${F}.no-vibrancy .terminal-panel-bg`, ["background", "box-shadow"]],
    ['html[data-mode="light"] .terminal-panel-surface', `${F} .terminal-panel-surface`, ["background"]],
    ['html[data-mode="light"] .terminal-panel-drag-grip', `${F} .terminal-panel-drag-grip`, ["background"]],
    ['html[data-mode="light"] .terminal-panel-drag:hover .terminal-panel-drag-grip', `${F} .terminal-panel-drag:hover .terminal-panel-drag-grip`, ["background"]],
    ['html[data-mode="light"] .terminal-panel-tab', `${F} .terminal-panel-tab`, ["color"]],
    ['html[data-mode="light"] .terminal-panel-tab:hover', `${F} .terminal-panel-tab:hover`, ["color", "background"]],
    ['html[data-mode="light"] .terminal-panel-tab[data-active="true"]', `${F} .terminal-panel-tab[data-active="true"]`, ["color", "background", "border-color", "box-shadow"]],
    ['html[data-mode="light"] .terminal-panel-gb', `${F} .terminal-panel-gb`, ["color", "background", "border-color"]],
    ['html[data-mode="light"] .terminal-panel-gb:hover:not(:disabled)', `${F} .terminal-panel-gb:hover:not(:disabled)`, ["background", "border-color", "color"]],
    ['html[data-mode="light"] .terminal-panel-cwd', `${F} .terminal-panel-cwd`, ["color"]],
    ['html[data-mode="light"] .terminal-tab-dot', `${F} .terminal-tab-dot`, ["background"]],
  ];

  it.each(cases)("%s -> %s covers the light-mode properties", (lightSel, flatSel, props) => {
    expect(declsFor(index, lightSel).length, `expected ${lightSel} in index.css`).toBeGreaterThan(0);
    const flatDecls = declsFor(unified, flatSel);
    for (const p of props) {
      expect(flatDecls.find(d => d.prop === p), `${flatSel} is missing "${p}"`).toBeTruthy();
    }
  });
});
