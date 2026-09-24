import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Vite dev rewrites a named import from a pre-bundled (CommonJS) package into
 * `const name = __vite__cjsImport["name"]` at the import's own position. An
 * import from a package placed after code that uses it therefore throws
 * "Cannot access 'name' before initialization" in `tauri dev` only — tests and
 * production builds hoist it. Keep package imports above all other code.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

function latePackageImports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  let seenCode = false;
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) {
      seenCode = true;
      continue;
    }
    const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const isPackage = !specifier.startsWith(".") && !specifier.startsWith("/");
    if (seenCode && isPackage && !stmt.importClause?.isTypeOnly) {
      const { line } = source.getLineAndCharacterOfPosition(stmt.getStart());
      found.push(`${path.relative(SRC, file)}:${line + 1} (${specifier})`);
    }
  }
  return found;
}

describe("package imports", () => {
  it("come before any other code, so Vite dev can't read them before they exist", () => {
    expect(walk(SRC).flatMap(latePackageImports)).toEqual([]);
  });
});
