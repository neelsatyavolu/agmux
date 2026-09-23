/**
 * CSS variable regression test: light-mode override coverage.
 *
 * Asserts that:
 *   1. Every --surface-* variable defined in :root also appears in
 *      html[data-mode="light"] { … } with a DIFFERENT value.
 *      (Same value → light override is a no-op → regression.)
 *   2. Every variable defined in BOTH blocks has a different value.
 *
 * Add a name to INTENTIONALLY_IDENTICAL if a variable is genuinely the same
 * in both modes (none right now, but the hook is here for future use).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Variables that are intentionally the same value in both dark and light mode.
// These are mid-grey values (zinc-500 = #71717a) that read equally well on
// dark and light backgrounds; no inversion needed.
const INTENTIONALLY_IDENTICAL: string[] = [
  "text-muted",    // #71717a (zinc-500) — neutral grey, works in both modes
  "commit-fg-mut", // #71717a — muted text in commit dialog, same reasoning
  "status-green",  // #34d399 — semantic success green, same in both modes
];

// ---------------------------------------------------------------------------
// CSS parser helpers
// ---------------------------------------------------------------------------

/** Strip block comments from CSS text. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Extract the body of all top-level blocks that start with `selector {`.
 * Uses naive brace counting — assumes no nested at-rules at this depth.
 * Returns concatenated bodies.
 */
function extractBlocks(css: string, selectorRe: RegExp): string {
  let body = "";
  let pos = 0;
  while (pos < css.length) {
    const match = selectorRe.exec(css);
    if (!match) break;
    const start = css.indexOf("{", match.index);
    if (start === -1) break;
    // Walk forward counting braces
    let depth = 0;
    let i = start;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    body += css.slice(start + 1, i) + "\n";
    pos = i + 1;
    selectorRe.lastIndex = pos;
  }
  return body;
}

/** Parse all `--var-name: value;` pairs from a CSS block body. */
function parseVars(blockBody: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockBody)) !== null) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe("themeCssVariables — light-mode override coverage", () => {
  const wt = path.resolve(__dirname, "../../../");
  const cssPath = path.join(wt, "src/index.css");
  const rawCss = fs.readFileSync(cssPath, "utf8");
  const css = stripComments(rawCss);

  // Extract :root block(s)
  const rootRe = /:root\s*\{/g;
  const rootBody = extractBlocks(css, rootRe);
  const rootVars = parseVars(rootBody);

  // Extract html[data-mode="light"] { … } block(s)
  const lightRe = /html\[data-mode="light"\]\s*\{/g;
  const lightBody = extractBlocks(css, lightRe);
  const lightVars = parseVars(lightBody);

  it("parses a non-empty :root block", () => {
    expect(rootVars.size).toBeGreaterThan(5);
  });

  it("parses a non-empty html[data-mode=light] block", () => {
    expect(lightVars.size).toBeGreaterThan(5);
  });

  it("every --surface-* in :root has a counterpart in html[data-mode=light]", () => {
    const missing: string[] = [];
    for (const name of rootVars.keys()) {
      if (!name.startsWith("surface-")) continue;
      if (INTENTIONALLY_IDENTICAL.includes(name)) continue;
      if (!lightVars.has(name)) {
        missing.push(
          `--${name} defined in :root (value: ${rootVars.get(name)}) ` +
            `has no counterpart in html[data-mode="light"]`
        );
      }
    }
    if (missing.length > 0) {
      expect.fail(
        [
          `Missing light-mode overrides for ${missing.length} --surface-* variable(s).`,
          `Add them to the html[data-mode="light"] { … } block in src/index.css.`,
          "",
          ...missing.map((m) => `  ${m}`),
        ].join("\n")
      );
    }
  });

  it("every variable defined in both :root and html[data-mode=light] has a different value", () => {
    const sameValue: string[] = [];
    for (const [name, darkVal] of rootVars) {
      if (!lightVars.has(name)) continue;
      if (INTENTIONALLY_IDENTICAL.includes(name)) continue;
      const lightVal = lightVars.get(name)!;
      if (darkVal === lightVal) {
        sameValue.push(
          `--${name}: dark="${darkVal}" | light="${lightVal}" (identical — override is a no-op)`
        );
      }
    }
    if (sameValue.length > 0) {
      expect.fail(
        [
          `${sameValue.length} variable(s) have the same value in :root and html[data-mode="light"].`,
          `Either remove the duplicate declaration or provide a real light-mode value.`,
          `Add to INTENTIONALLY_IDENTICAL in themeCssVariables.test.ts if truly correct.`,
          "",
          ...sameValue.map((s) => `  ${s}`),
        ].join("\n")
      );
    }
  });
});
