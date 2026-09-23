import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatUntrustedOverview,
  formatUntrustedRecord,
  loadTeamsCredentials,
  resolveTeamKey,
  teamsKnowledgeGet,
  UNTRUSTED_PREAMBLE,
} from "./agmux-teams-knowledge-client.mjs";

describe("teams knowledge client", () => {
  it("loads credentials from path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-creds-"));
    const p = path.join(dir, "credentials.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ device_id: "d1", token: "tok", base_url: "https://example.test" }),
    );
    const c = loadTeamsCredentials({ AGMUX_TEAMS_CREDS: p });
    assert.equal(c.deviceId, "d1");
    assert.equal(c.token, "tok");
    assert.equal(c.baseUrl, "https://example.test");
  });

  it("resolveTeamKey prefers arg then env", () => {
    assert.equal(resolveTeamKey({}, { team: "acme" }), "acme");
    assert.equal(resolveTeamKey({ AGMUX_TEAMS_TEAM: "env-team" }, {}), "env-team");
    assert.equal(resolveTeamKey({}, {}), null);
  });

  it("formats untrusted overview with preamble", () => {
    const text = formatUntrustedOverview({
      records: [
        {
          id: "kwr1",
          kind: "decision",
          authority: "official",
          title: "No option_env secrets",
          content: "Use runtime env only.",
          createdByName: "Neel",
        },
      ],
      policy: { knowledgeMcpEnabled: true, mcpAuthorityFilter: "official_only" },
    });
    assert.ok(text.startsWith(UNTRUSTED_PREAMBLE.slice(0, 20)));
    assert.match(text, /kwr1/);
    assert.match(text, /Neel/);
    assert.match(text, /No option_env/);
  });

  it("teamsKnowledgeGet uses bearer and unwraps data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-creds-"));
    const p = path.join(dir, "credentials.json");
    fs.writeFileSync(p, JSON.stringify({ device_id: "d1", token: "secret-token" }));
    let seenAuth = "";
    const fakeFetch = async (url, opts) => {
      seenAuth = opts.headers.Authorization;
      assert.match(url, /knowledge\/overview\?for=mcp$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { records: [], digests: [] } }),
      };
    };
    const res = await teamsKnowledgeGet(
      "/api/teams/t1/knowledge/overview?for=mcp",
      { AGMUX_TEAMS_CREDS: p, AGMUX_TEAMS_URL: "https://teams.test" },
      fakeFetch,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.records, []);
    assert.equal(seenAuth, "Bearer secret-token");
  });

  it("formatUntrustedRecord cites id", () => {
    const t = formatUntrustedRecord({
      record: { id: "kwr9", kind: "fact", authority: "official", title: "T", content: "C" },
    });
    assert.match(t, /kwr9/);
    assert.match(t, /UNTRUSTED/);
  });
});
