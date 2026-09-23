import { describe, expect, it } from "vitest";
import {
  isLocalFileHref,
  parseMarkdownFileHref,
  resolveMarkdownHref,
} from "../markdownLinks";

describe("parseMarkdownFileHref", () => {
  it("keeps an absolute unix path", () => {
    expect(parseMarkdownFileHref(
      "/Users/neel/Colleges/essays/supplements/university-of-michigan/leaders-citizens.md",
    )).toEqual({
      path: "/Users/neel/Colleges/essays/supplements/university-of-michigan/leaders-citizens.md",
      line: null,
    });
  });

  it("strips a trailing :line suffix from ChatGPT Work links", () => {
    expect(parseMarkdownFileHref("/abs/path/app.py:12")).toEqual({
      path: "/abs/path/app.py",
      line: 12,
    });
  });

  it("strips wrapping angle brackets used for paths with spaces", () => {
    expect(parseMarkdownFileHref("</abs/path/My Project/My Report.md:3>")).toEqual({
      path: "/abs/path/My Project/My Report.md",
      line: 3,
    });
  });

  it("decodes percent-encoded spaces", () => {
    expect(parseMarkdownFileHref("/Users/me/My%20Report.md")).toEqual({
      path: "/Users/me/My Report.md",
      line: null,
    });
  });
});

describe("isLocalFileHref", () => {
  it("treats ChatGPT Work absolute paths as files", () => {
    expect(isLocalFileHref(
      "/Users/neel/Colleges/essays/supplements/university-of-michigan/leaders-citizens.md",
    )).toBe(true);
    expect(isLocalFileHref("/abs/path/app.py:12")).toBe(true);
  });

  it("treats relative and home paths as files", () => {
    expect(isLocalFileHref("leaders-citizens.md")).toBe(true);
    expect(isLocalFileHref("docs/foo.md")).toBe(true);
    expect(isLocalFileHref("./bar.md")).toBe(true);
    expect(isLocalFileHref("~/notes.md")).toBe(true);
    expect(isLocalFileHref("file:///Users/me/notes.md")).toBe(true);
  });

  it("leaves web and mail links alone", () => {
    expect(isLocalFileHref("https://example.com/app.py")).toBe(false);
    expect(isLocalFileHref("http://example.com")).toBe(false);
    expect(isLocalFileHref("mailto:hi@example.com")).toBe(false);
    expect(isLocalFileHref("#heading")).toBe(false);
    expect(isLocalFileHref("example.com")).toBe(false);
    expect(isLocalFileHref("www.foo.io")).toBe(false);
  });
});

describe("resolveMarkdownHref", () => {
  const WORK = "/Users/neel/Colleges";
  const HOME = "/Users/neel";

  it("returns absolute Work links unchanged (minus :line)", () => {
    expect(resolveMarkdownHref(
      "/Users/neel/Colleges/essays/supplements/university-of-michigan/why-lsa.md",
      WORK,
      HOME,
    )).toBe("/Users/neel/Colleges/essays/supplements/university-of-michigan/why-lsa.md");

    expect(resolveMarkdownHref("/Users/neel/Colleges/app.py:12", WORK, HOME))
      .toBe("/Users/neel/Colleges/app.py");
  });

  it("resolves a bare relative name against the session work dir", () => {
    expect(resolveMarkdownHref("leaders-citizens.md", WORK, HOME))
      .toBe("/Users/neel/Colleges/leaders-citizens.md");
  });

  it("returns null for http links", () => {
    expect(resolveMarkdownHref("https://example.com/x.md", WORK, HOME)).toBeNull();
  });

  it("returns null for a relative path when there is no work dir", () => {
    expect(resolveMarkdownHref("docs/foo.md", "", HOME)).toBeNull();
  });
});
