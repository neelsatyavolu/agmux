import { describe, expect, it } from "vitest";
import { getPolicy, putPolicy } from "../src/routes/policy";
import { makeEnv, seedTeam, seedUser } from "./helpers/d1";

const providers = ["ClaudeCode", "Codex", "Grok", "Cursor", "Droid", "Pi", "Kimi", "Cline", "Gemini", "Hermes", "OpenCode", "MLX"];
const owner = { userId: "owner", deviceId: null, via: "cookie" as const };

async function fixture() {
  const env = makeEnv();
  await seedUser(env, "owner");
  await seedTeam(env, "team", "owner");
  return env;
}

function request(allowedProviders: string[] | null) {
  return new Request("https://teams.test/api/teams/team/policy", {
    method: "PUT", body: JSON.stringify({ allowedProviders }),
  });
}

describe("provider policy", () => {
  it.each(providers)("round-trips %s as the sole allowed provider", async (provider) => {
    const env = await fixture();
    await putPolicy(request([provider]), env, owner, "team");
    const body = await (await getPolicy(env, owner, "team")).json() as any;
    expect(body.data.policy.allowedProviders).toEqual([provider]);
  });

  it("still rejects unknown providers", async () => {
    const env = await fixture();
    await expect(putPolicy(request(["NotAnAgent"]), env, owner, "team")).rejects.toThrow("Unknown provider");
  });

  it.each([null, []])("round-trips nullable allowlists (%j)", async (allowed) => {
    const env = await fixture();
    const body = await (await putPolicy(request(allowed), env, owner, "team")).json() as any;
    expect(body.data.policy.allowedProviders).toEqual(allowed);
  });
});
