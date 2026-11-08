import { describe, expect, it } from "vitest";
import { checkInstallOwnership, RECENT_INSTALL_MS, type GhInstallation } from "../src/leaderboard/installVerify";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function org(createdMsAgo: number, updatedMsAgo = createdMsAgo): GhInstallation {
  return {
    id: 42,
    account: { login: "example-org", type: "Organization", id: 900 },
    created_at: iso(NOW - createdMsAgo),
    updated_at: iso(NOW - updatedMsAgo),
  };
}

const none = { kind: "none" } as const;

describe("checkInstallOwnership", () => {
  it("accepts an installation the user's GitHub token can see", () => {
    expect(
      checkInstallOwnership({
        installation: org(10 * RECENT_INSTALL_MS),
        proof: { kind: "user_installations", ids: new Set(["42"]) },
        principalGithubIds: [],
        linkedToOtherTeam: false,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("rejects an installation missing from the user's installations", () => {
    expect(
      checkInstallOwnership({
        installation: org(0),
        proof: { kind: "user_installations", ids: new Set(["7"]) },
        principalGithubIds: ["1"],
        linkedToOtherTeam: false,
        nowMs: NOW,
      }),
    ).toBe("install_not_yours");
  });

  it("refuses an installation already linked to another team", () => {
    expect(
      checkInstallOwnership({
        installation: org(0),
        proof: { kind: "user_installations", ids: new Set(["42"]) },
        principalGithubIds: ["1"],
        linkedToOtherTeam: true,
        nowMs: NOW,
      }),
    ).toBe("install_in_use");
  });

  it("without user proof, a personal install must be the signer's own account", () => {
    const personal: GhInstallation = { id: 5, account: { login: "someone", type: "User", id: 123 } };
    const base = { installation: personal, proof: none, linkedToOtherTeam: false, nowMs: NOW };
    expect(checkInstallOwnership({ ...base, principalGithubIds: ["123"] })).toBeNull();
    expect(checkInstallOwnership({ ...base, principalGithubIds: ["999"] })).toBe("install_not_yours");
  });

  it("without user proof, an org install must be fresh and the signer must have GitHub linked", () => {
    const base = { proof: none, linkedToOtherTeam: false, nowMs: NOW };
    expect(checkInstallOwnership({ ...base, installation: org(60_000), principalGithubIds: ["1"] })).toBeNull();
    // An old installation (someone else's org, id swapped into the callback) is refused.
    expect(
      checkInstallOwnership({ ...base, installation: org(RECENT_INSTALL_MS + 60_000), principalGithubIds: ["1"] }),
    ).toBe("install_verify");
    // Recently re-configured counts as fresh.
    expect(
      checkInstallOwnership({ ...base, installation: org(30 * RECENT_INSTALL_MS, 1000), principalGithubIds: ["1"] }),
    ).toBeNull();
    expect(checkInstallOwnership({ ...base, installation: org(0), principalGithubIds: [] })).toBe("install_verify");
  });
});
