import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const unified = postcss.parse(read("../../styles/unified.css"));
const index = postcss.parse(read("../../index.css"));

function decl(root: postcss.Root, selector: string, prop: string) {
  let value = "";
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(prop, d => { value = d.value; });
  });
  return value;
}

describe("unified design stylesheet", () => {
  it("defines the slate tokens for dark and light", () => {
    expect(decl(unified, ":root", "--ui-canvas")).toBe("#0f1115");
    expect(decl(unified, ":root", "--ui-panel")).toBe("#1a1e25");
    expect(decl(unified, 'html[data-mode="light"]', "--ui-canvas")).toBe("#f7f8fa");
    expect(decl(unified, 'html[data-mode="light"]', "--ui-panel")).toBe("#ffffff");
  });

  it("uses the brand gold and dark status colors from the phone app", () => {
    expect(decl(index, ":root", "--accent")).toBe("#f2a516");
    expect(decl(index, ":root", "--status-blue")).toBe("#6b8ff8");
    expect(decl(index, ":root", "--status-green")).toBe("#3ecf7e");
    expect(decl(index, ":root", "--status-amber")).toBe("#f2a516");
    expect(decl(index, ":root", "--status-red")).toBe("#f2685d");
  });

  it("keeps the readable light status inks", () => {
    expect(decl(index, 'html[data-mode="light"]', "--status-blue")).toBe("#1d4ed8");
    expect(decl(index, 'html[data-mode="light"]', "--status-amber")).toBe("#92400e");
  });

  it("flattens the wallpaper, glass panes, top bar and sidebar only in flat mode", () => {
    expect(decl(unified, 'html[data-surface="flat"] .codex-wall', "background")).toBe("var(--ui-canvas)");
    expect(decl(unified, 'html[data-surface="flat"] .codex-glass', "background")).toBe("var(--ui-canvas)");
    expect(decl(unified, 'html[data-surface="flat"] .codex-topbar', "background")).toBe("var(--ui-canvas)");
    expect(decl(unified, 'html[data-surface="flat"] .sidebar-bg', "background")).toBe("var(--ui-sidebar)");
    expect(decl(unified, ".codex-wall", "background")).toBe("");
  });

  it("gives overlays that relied on backdrop blur an opaque flat background", () => {
    expect(decl(unified, 'html[data-surface="flat"] .agent-complete-toast', "background"))
      .toBe("var(--ui-panel)");
    expect(decl(unified, 'html[data-surface="flat"] .rate-limit-banner', "background"))
      .toBe("color-mix(in srgb, var(--status-amber) 14%, var(--ui-panel))");
    expect(decl(unified, 'html[data-surface="flat"] .flat-opaque-dialog', "background")).toBe("var(--ui-panel)");
    expect(decl(unified, 'html[data-surface="flat"] .flat-opaque-overlay', "background")).toBe("var(--ui-panel)");
    expect(decl(unified, 'html[data-surface="flat"] .drag-drop-overlay', "background"))
      .toBe("color-mix(in srgb, var(--status-blue) 14%, var(--ui-panel))");
  });

  it("drops backdrop blur everywhere in flat mode", () => {
    // postcss keeps "!important" on decl.important, not in the value.
    expect(decl(unified, 'html[data-surface="flat"] *', "backdrop-filter")).toBe("none");
  });

  it("loads Archivo as a variable font", () => {
    let found = false;
    unified.walkAtRules("font-face", at => {
      at.walkDecls("font-family", d => { if (d.value.includes("Archivo")) found = true; });
    });
    expect(found).toBe(true);
  });

  it("starts the splash flat before React mounts", () => {
    expect(read("../../../index.html")).toMatch(/<html[^>]*data-surface="flat"/);
  });

  it.each([
    ".sb-mt", ".pg-h .pcount", ".sb-arch .h .n", ".card-h .eye", ".card-h .cnt", ".card-h .lnk",
    ".proj .br", ".proj .tm", ".sess .sub", ".app-chip",
    ".agent-top-chrome-scope .count", ".agent-top-chrome-pill .count", ".usage-manage-btn",
    ".mem-health", ".mem-filter", ".mem-count", ".mem-kind", ".mem-section-label",
  ])("%s reads in the UI font", selector => {
    expect(decl(unified, selector, "font-family")).toBe("var(--font-sans)");
  });

  it("keeps machine text monospace", () => {
    for (const selector of [".app-kbd", ".md-inline-code", ".terminal-panel-cwd", ".proj .pt", ".mem-transcript-path"]) {
      expect(decl(unified, selector, "font-family")).toBe("");
    }
  });
});
