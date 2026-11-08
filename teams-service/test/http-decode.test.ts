import { describe, expect, it } from "vitest";
import { parseCookies } from "../src/http";

describe("parseCookies", () => {
  it("keeps going past a malformed percent-encoded cookie", () => {
    expect(parseCookies("junk=%E0%A4%A; good=a%20b")).toEqual({ junk: "%E0%A4%A", good: "a b" });
  });
});
