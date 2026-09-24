import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OLD_GOLD = /#f7ad3c|247,\s*173,\s*60/i;
// xterm and CodeMirror need real colors; charts paint SVG attributes.
const LITERAL_ONLY = ["lib/xterm-loader.ts", "lib/codemirrorTheme.ts", "components/teams/"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
    return /\.(css|tsx?)$/.test(e.name) ? [p] : [];
  });
}

describe("accent literals", () => {
  const files = walk(SRC);

  it("has no old gold left anywhere in src", () => {
    const offenders = files.filter(f => OLD_GOLD.test(fs.readFileSync(f, "utf8")))
      .map(f => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("never puts a spaced color-mix inside a Tailwind arbitrary class", () => {
    const bad = files.filter(f => f.endsWith(".tsx") || f.endsWith(".ts"))
      .filter(f => !LITERAL_ONLY.some(x => f.includes(x)))
      .filter(f => /\[[^\]\s"'`]*color-mix\(in srgb/.test(fs.readFileSync(f, "utf8")))
      .map(f => path.relative(SRC, f));
    expect(bad).toEqual([]);
  });
});
