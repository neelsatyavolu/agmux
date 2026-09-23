import { describe, expect, it } from "vitest";
import { getLanguageExtension } from "../languageMap";

describe("getLanguageExtension", () => {
  it.each([
    "foo.ts", "bar.tsx", "baz.js", "qux.jsx", "m.mjs", "c.cjs",
    "x.json", "x.jsonc",
    "n.md", "n.mdx",
    "s.css", "s.scss", "s.less",
    "p.html", "p.htm", "p.svg", "p.xml", "p.xhtml",
    "r.rs",
    "p.py", "p.pyw",
    "q.sql",
    "g.go",
    "j.java",
    "c.c", "c.cpp", "c.cc", "c.cxx", "h.h", "h.hpp", "h.hxx",
  ])("returns a LanguageSupport for %s", (path) => {
    const lang = getLanguageExtension(path);
    expect(lang).not.toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(getLanguageExtension("file.unknownext")).toBeNull();
    expect(getLanguageExtension("README")).toBeNull();
    expect(getLanguageExtension("file.")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(getLanguageExtension("Foo.TS")).not.toBeNull();
    expect(getLanguageExtension("X.PY")).not.toBeNull();
  });

  it("uses the last dot segment of the path", () => {
    expect(getLanguageExtension("/some/dir.with.dots/file.ts")).not.toBeNull();
    expect(getLanguageExtension("a/b/c.go")).not.toBeNull();
  });

  it("returns null for an empty input", () => {
    expect(getLanguageExtension("")).toBeNull();
  });
});
