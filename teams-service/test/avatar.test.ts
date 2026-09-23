import { describe, expect, it } from "vitest";
import { githubAvatarUrl, resolveAvatarUrl, sanitizeAvatarUrl } from "../src/avatar";

describe("sanitizeAvatarUrl", () => {
  it("accepts https URLs", () => {
    expect(sanitizeAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
  });

  it("rejects non-https and empty", () => {
    expect(sanitizeAvatarUrl("http://evil.example/x.png")).toBeNull();
    expect(sanitizeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeAvatarUrl("")).toBeNull();
    expect(sanitizeAvatarUrl(null)).toBeNull();
  });
});

describe("githubAvatarUrl", () => {
  it("builds CDN URL from numeric id", () => {
    expect(githubAvatarUrl("12345")).toBe("https://avatars.githubusercontent.com/u/12345?v=4");
  });

  it("rejects non-numeric ids", () => {
    expect(githubAvatarUrl("octocat")).toBeNull();
    expect(githubAvatarUrl("")).toBeNull();
  });
});

describe("resolveAvatarUrl", () => {
  it("prefers stored URL over GitHub fallback", () => {
    expect(
      resolveAvatarUrl("https://lh3.googleusercontent.com/a/photo", "99"),
    ).toBe("https://lh3.googleusercontent.com/a/photo");
  });

  it("falls back to GitHub CDN", () => {
    expect(resolveAvatarUrl(null, "42")).toBe("https://avatars.githubusercontent.com/u/42?v=4");
  });

  it("returns null when nothing available", () => {
    expect(resolveAvatarUrl(null, null)).toBeNull();
  });
});
