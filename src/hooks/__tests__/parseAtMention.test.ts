import { describe, expect, it } from "vitest";
import { parseAtMention } from "../useFileMentions";

describe("parseAtMention", () => {
  it("returns null when no @ before cursor", () => {
    expect(parseAtMention("hello world", 5)).toBeNull();
  });

  it("matches @ at start of string", () => {
    expect(parseAtMention("@foo", 4)).toEqual({
      atPos: 0,
      dirPart: "",
      filterPart: "foo",
      showHidden: false,
    });
  });

  it("matches @ after whitespace", () => {
    expect(parseAtMention("hi @bar", 7)).toEqual({
      atPos: 3,
      dirPart: "",
      filterPart: "bar",
      showHidden: false,
    });
  });

  it("returns null when @ is preceded by non-whitespace (e.g. email)", () => {
    expect(parseAtMention("foo@bar", 7)).toBeNull();
  });

  it("returns null when query contains whitespace", () => {
    expect(parseAtMention("@foo bar", 8)).toBeNull();
  });

  it("splits dirPart and filterPart at last slash", () => {
    expect(parseAtMention("@src/lib/fo", 11)).toEqual({
      atPos: 0,
      dirPart: "src/lib/",
      filterPart: "fo",
      showHidden: false,
    });
  });

  it("handles trailing slash as dirPart with empty filter", () => {
    expect(parseAtMention("@src/", 5)).toEqual({
      atPos: 0,
      dirPart: "src/",
      filterPart: "",
      showHidden: false,
    });
  });

  it("flags showHidden when filterPart starts with .", () => {
    expect(parseAtMention("@.git", 5)).toEqual({
      atPos: 0,
      dirPart: "",
      filterPart: ".git",
      showHidden: true,
    });
  });

  it("flags showHidden inside a directory", () => {
    expect(parseAtMention("@src/.h", 7)).toEqual({
      atPos: 0,
      dirPart: "src/",
      filterPart: ".h",
      showHidden: true,
    });
  });

  it("uses cursor position to bound the query", () => {
    const text = "@foo bar @baz";
    expect(parseAtMention(text, 4)).toEqual({
      atPos: 0,
      dirPart: "",
      filterPart: "foo",
      showHidden: false,
    });
    expect(parseAtMention(text, 13)).toEqual({
      atPos: 9,
      dirPart: "",
      filterPart: "baz",
      showHidden: false,
    });
  });

  it("returns null when cursor is before any @", () => {
    expect(parseAtMention("hello @world", 3)).toBeNull();
  });

  it("handles empty query right after @", () => {
    expect(parseAtMention("@", 1)).toEqual({
      atPos: 0,
      dirPart: "",
      filterPart: "",
      showHidden: false,
    });
  });
});
