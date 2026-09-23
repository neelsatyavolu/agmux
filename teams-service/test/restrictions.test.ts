import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getPolicy, putPolicy } from "../src/routes/policy";
import { addMember, makeEnv, seedGithubUser, seedTeam, seedUser } from "./helpers/d1";

const principal = (userId: string) => ({ userId, deviceId: null, via: "cookie" as const });
const request = (body: unknown) => new Request("https://teams.test/api/teams/team/policy", { method: "PUT", body: JSON.stringify(body) });
async function fixture() {
  const env = makeEnv();
  for (const id of ["owner", "manager", "other", "employee", "outside"]) await seedUser(env, id);
  await seedTeam(env, "team", "owner");
  for (const id of ["manager", "other"]) await addMember(env, "team", id, "manager");
  for (const id of ["employee", "outside"]) await addMember(env, "team", id, "employee");
  return env;
}
const get = async (env: ReturnType<typeof makeEnv>, id: string) => (await (await getPolicy(env, principal(id), "team")).json() as any).data;
const put = (env: ReturnType<typeof makeEnv>, id: string, body: unknown) => putPolicy(request(body), env, principal(id), "team");

it("persists all fields, intersects disjoint sets to deny all, and keeps editable layers independent", async () => {
  const env = await fixture();
  await put(env, "owner", { allowedProviders: ["Codex"], allowedModels: ["model-a"], allowedModes: ["chat"], allowedEfforts: ["low", "high"], defaultPermissionMode: "plan", spendHardStopUsd: 42, mcpAllowlist: ["docs"] });
  await put(env, "manager", { allowedProviders: ["Grok"], allowedModels: ["model-b"], allowedModes: ["terminal"], allowedEfforts: ["high"] });
  const employee = await get(env, "employee");
  expect(employee).toMatchObject({ enforcementVersion: 2, canManage: false, editablePolicy: null, policy: { allowedProviders: [], allowedModels: [], allowedModes: [], allowedEfforts: ["high"], defaultPermissionMode: "plan", spendHardStopUsd: 42, mcpAllowlist: ["docs"] } });
  expect((await get(env, "manager")).editablePolicy).toEqual({ allowedProviders: ["Grok"], allowedModels: ["model-b"], allowedModes: ["terminal"], allowedEfforts: ["high"] });
  expect((await get(env, "owner")).policy.allowedModes).toEqual(["chat"]);
  expect((await get(env, "other")).policy.allowedModes).toEqual(["chat"]);
  await put(env, "owner", { allowedModes: null });
  expect((await get(env, "owner")).policy).toMatchObject({ allowedModels: ["model-a"], defaultPermissionMode: "plan", spendHardStopUsd: 42 });
  expect((await get(env, "employee")).policy.allowedModes).toEqual(["terminal"]);
  const audits = await env.DB.prepare("SELECT detail FROM audit_log WHERE action = 'policy.updated'").all<{ detail: string }>();
  expect(audits.results.some(row => JSON.parse(row.detail).layer === "manager")).toBe(true);
  for (const row of audits.results) {
    expect(row.detail.length).toBeLessThanOrEqual(200);
    expect(row.detail).not.toContain("model-a");
    expect(row.detail).not.toContain("model-b");
    const detail = JSON.parse(row.detail);
    if ("allowedModels" in detail.changes) expect(detail.changes.allowedModels).toBe(1);
  }
});

it("uses live direct and group assignments, self, active manager roles, and overlapping layers", async () => {
  const env = await fixture();
  await put(env, "manager", { allowedModes: ["chat"], allowedEfforts: ["high"] });
  await put(env, "other", { allowedModes: ["terminal"] });
  expect((await get(env, "employee")).policy.allowedModes).toEqual([]);
  await env.DB.prepare("INSERT INTO manager_scope (team_id, manager_user_id, target_user_id, created_at) VALUES ('team', 'manager', 'employee', '2026-09-12')").run();
  expect((await get(env, "outside")).policy.allowedEfforts).toBeNull();
  expect((await get(env, "manager")).policy.allowedModes).toEqual(["chat"]);
  await env.DB.prepare("UPDATE manager_scope SET target_user_id = 'outside' WHERE manager_user_id = 'manager'").run();
  expect((await get(env, "employee")).policy.allowedEfforts).toBeNull();
  expect((await get(env, "outside")).policy.allowedEfforts).toEqual(["high"]);
  await env.DB.prepare("INSERT INTO team_groups (id, team_id, name, created_at) VALUES ('g', 'team', 'Platform', '2026-09-12')").run();
  await env.DB.prepare("INSERT INTO team_group_members (group_id, user_id, added_at) VALUES ('g', 'employee', '2026-09-12')").run();
  await env.DB.prepare("UPDATE manager_scope SET target_user_id = NULL, target_group_id = 'g' WHERE manager_user_id = 'manager'").run();
  expect((await get(env, "employee")).policy.allowedEfforts).toEqual(["high"]);
  expect((await get(env, "manager")).scopeLabel).toContain("Platform");
  await env.DB.prepare("DELETE FROM team_group_members WHERE group_id = 'g'").run();
  expect((await get(env, "employee")).policy.allowedEfforts).toBeNull();
  await env.DB.prepare("UPDATE team_members SET role = 'employee' WHERE user_id = 'other'").run();
  expect((await get(env, "employee")).policy.allowedModes).toBeNull();
  await env.DB.prepare("UPDATE team_members SET left_at = '2026-09-12' WHERE user_id = 'manager'").run();
  await expect(get(env, "manager")).rejects.toThrow();
  expect((await get(env, "outside")).policy.allowedModes).toBeNull();
});

it("does not apply manager restrictions to owners or peers explicitly assigned to scope", async () => {
  const env = await fixture();
  await put(env, "manager", { allowedModes: [] });
  for (const id of ["owner", "other"]) await env.DB.prepare("INSERT INTO manager_scope (team_id, manager_user_id, target_user_id, created_at) VALUES ('team','manager',?,'2026-09-12')").bind(id).run();
  for (const id of ["owner", "other", "employee"]) expect((await get(env, id)).policy.allowedModes).toBeNull();
  expect((await get(env, "manager")).policy.allowedModes).toEqual([]);
});

it("rejects employee and staff writes and all owner-only fields from managers", async () => {
  const env = await fixture();
  await seedGithubUser(env, "staff", "neelsatyavolu");
  expect(await get(env, "staff")).toMatchObject({ canManage: false, editablePolicy: null });
  for (const id of ["employee", "staff"]) await expect(put(env, id, { allowedModes: [] })).rejects.toThrow();
  for (const key of ["spendHardStopUsd", "defaultPermissionMode", "mcpAllowlist"]) await expect(put(env, "manager", { [key]: null })).rejects.toThrow("Only owners");
});

describe("strict request validation", () => {
  it.each<unknown>([[], {}, { unknown: [] }, { toString: [] }, { allowedModes: "chat" }, { allowedModes: ["Chat"] }, { allowedEfforts: ["extreme"] }, { allowedEfforts: ["low", "low"] }, { allowedModels: [2] }, { allowedModels: [""] }, { allowedModels: [" spaced"] }, { allowedModels: ["x".repeat(201)] }, { allowedModels: Array.from({ length: 129 }, (_, i) => `m${i}`) }, { spendHardStopUsd: "42" }, { spendHardStopUsd: -1 }, { defaultPermissionMode: false }, { mcpAllowlist: {} }])("rejects %j without writing", async body => {
    const env = await fixture();
    await expect(put(env, "owner", body)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT * FROM team_policies").first()).toBeNull();
  });
});

it("distinguishes null, empty, and exact lists across all four fields", async () => {
  const env = await fixture();
  for (const field of ["allowedProviders", "allowedModels", "allowedModes", "allowedEfforts"]) {
    await put(env, "owner", { [field]: [] });
    expect((await get(env, "employee")).policy[field]).toEqual([]);
    await put(env, "owner", { [field]: null });
    expect((await get(env, "employee")).policy[field]).toBeNull();
  }
});

it("migrates legacy empty lists without restricting them", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE teams(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE team_policies(team_id TEXT PRIMARY KEY, allowed_providers TEXT, allowed_models TEXT);");
  db.exec(`INSERT INTO team_policies VALUES ('legacy', '[ ]', '[]'), ('limited', '["Codex"]', '["exact-id"]')`);
  db.exec(readFileSync(new URL("../migrations/012_restrictions.sql", import.meta.url), "utf8"));
  expect(db.prepare("SELECT * FROM team_policies WHERE team_id='legacy'").get()).toMatchObject({ allowed_providers: null, allowed_models: null, allowed_modes: null, allowed_efforts: null });
  expect(db.prepare("SELECT allowed_providers FROM team_policies WHERE team_id='limited'").get()).toMatchObject({ allowed_providers: '["Codex"]' });
  db.close();
});

it("fails on an unmigrated database rather than advertising v2 with missing restrictions", async () => {
  const env = await fixture();
  await env.DB.prepare("ALTER TABLE team_policies DROP COLUMN allowed_modes").run();
  await expect(get(env, "owner")).rejects.toThrow("allowed_modes");
});
