import { describe, it, expect } from "vitest";
import { buildGithubCommitUrl, parseGithubOwnerRepo } from "../gitUrls";

describe("parseGithubOwnerRepo", () => {
  it("parses SSH git@ form", () => {
    expect(parseGithubOwnerRepo("git@github.com:neel-xanom/agmux.git")).toBe(
      "neel-xanom/agmux",
    );
  });

  it("parses SSH without .git suffix", () => {
    expect(parseGithubOwnerRepo("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("parses ssh:// form", () => {
    expect(parseGithubOwnerRepo("ssh://git@github.com/owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  it("parses https form", () => {
    expect(parseGithubOwnerRepo("https://github.com/owner/repo.git")).toBe(
      "owner/repo",
    );
  });

  it("parses https with www and trailing slash", () => {
    expect(parseGithubOwnerRepo("https://www.github.com/owner/repo/")).toBe(
      "owner/repo",
    );
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGithubOwnerRepo("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGithubOwnerRepo("https://bitbucket.org/owner/repo.git")).toBeNull();
  });
});

describe("buildGithubCommitUrl", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";

  it("builds https commit URL from SSH remote", () => {
    expect(
      buildGithubCommitUrl("git@github.com:owner/repo.git", sha),
    ).toBe(`https://github.com/owner/repo/commit/${sha}`);
  });

  it("accepts abbreviated SHAs", () => {
    expect(buildGithubCommitUrl("https://github.com/o/r.git", "abc1234")).toBe(
      "https://github.com/o/r/commit/abc1234",
    );
  });

  it("returns null for invalid SHA or missing remote", () => {
    expect(buildGithubCommitUrl("git@github.com:o/r.git", "not-a-sha")).toBeNull();
    expect(buildGithubCommitUrl(null, sha)).toBeNull();
    expect(buildGithubCommitUrl("git@github.com:o/r.git", "")).toBeNull();
  });

  it("returns null for non-GitHub remotes", () => {
    expect(
      buildGithubCommitUrl("git@gitlab.com:owner/repo.git", sha),
    ).toBeNull();
  });
});
