import { describe, expect, it } from "vitest";
import { addMember, makeEnv, seedTeam, seedUser } from "./helpers/d1";
import * as knowledge from "../src/routes/knowledge";
import { findSecrets } from "../src/knowledge/dlp";
import { HttpError } from "../src/http";
import type { Principal } from "../src/session";

function pr(userId: string, deviceId: string | null = "dev1"): Principal {
  return { userId, deviceId, via: deviceId ? "device" : "cookie" };
}

async function read(res: Response): Promise<{ ok: boolean; data?: any; error?: string; code?: string }> {
  return res.json() as Promise<any>;
}

/** Route handlers throw HttpError; the Worker maps them via errorResponse. */
async function call(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(JSON.stringify({ ok: false, error: err.message, code: err.code }), {
        status: err.status,
        headers: { "content-type": "application/json" },
      });
    }
    throw err;
  }
}

function jsonReq(body: unknown): Request {
  return new Request("http://t", { method: "POST", body: JSON.stringify(body) });
}

/** Accept knowledge disclosure for a principal (required before share/enable). */
async function acceptKw(env: ReturnType<typeof makeEnv>, userId: string, teamKey: string) {
  return call(() => knowledge.acceptDisclosure(env, pr(userId), teamKey));
}

describe("knowledge readiness", () => {
  it("advertises features.knowledge when schema is present", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_ready");
    await seedTeam(env, "team_ready", owner);
    const { featuresPayload, resetKnowledgeReadyCache } = await import("../src/knowledge/ready");
    resetKnowledgeReadyCache();
    const f = await featuresPayload(env);
    expect(f.knowledge).toBe(true);
  });

  it("getSettings soft-fails with available:false is not needed when schema present", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_soft");
    await seedTeam(env, "team_soft", owner);
    const { resetKnowledgeReadyCache } = await import("../src/knowledge/ready");
    resetKnowledgeReadyCache();
    const res = await call(() => knowledge.getSettings(env, pr(owner), "team_soft"));
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.data.available).toBe(true);
  });
});

describe("knowledge DLP", () => {
  it("flags absolute paths and common secrets", () => {
    expect(findSecrets("see /Users/neel/secret", "summary").some((h) => h.code === "absolute_path")).toBe(
      true,
    );
    expect(findSecrets("key sk-abcdefghijklmnopqrstuvwxyz123456", "summary").length).toBeGreaterThan(0);
    expect(findSecrets("normal decision text", "summary")).toEqual([]);
  });
});

describe("knowledge API", () => {
  it("defaults disabled — writes blocked until owner activates", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner", "Owner");
    await seedTeam(env, "team1", owner);

    const settings = await call(() => knowledge.getSettings(env, pr(owner), "team1"));
    const s = await read(settings);
    expect(s.data.access).toBe("none");
    expect(s.data.policy.knowledgeMode).toBe("disabled");

    const create = await call(() =>
      knowledge.createRecord(env, pr(owner), "team1", jsonReq({ kind: "decision", title: "X", content: "Y" })),
    );
    expect(create.status).toBe(403);
  });

  it("blocks enable / share / create without disclosure accept", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner", "Owner");
    await seedTeam(env, "team1", owner);

    const patch = await call(() =>
      knowledge.patchSettings(env, pr(owner), "team1", jsonReq({ knowledgeMode: "full" })),
    );
    expect(patch.status).toBe(403);
    expect((await read(patch)).code).toBe("disclosure_required");

    await acceptKw(env, owner, "team1");
    const ok = await call(() =>
      knowledge.patchSettings(env, pr(owner), "team1", jsonReq({ knowledgeMode: "full", editRecordsRole: "all" })),
    );
    expect(ok.status).toBe(200);

    // Second user must accept before creating records.
    const emp = await seedUser(env, "u_emp2", "Emp2");
    await addMember(env, "team1", emp, "employee");
    const blocked = await call(() =>
      knowledge.createRecord(
        env,
        pr(emp),
        "team1",
        jsonReq({ kind: "fact", title: "No", content: "disclosure missing" }),
      ),
    );
    expect(blocked.status).toBe(403);
  });

  it("owner activates → manager can create; employee blocked by edit_records_role", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner", "Owner");
    const mgr = await seedUser(env, "u_mgr", "Mgr");
    const emp = await seedUser(env, "u_emp", "Emp");
    await seedTeam(env, "team1", owner);
    await addMember(env, "team1", mgr, "manager");
    await addMember(env, "team1", emp, "employee");

    await acceptKw(env, owner, "team1");
    const patch = await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", shareRole: "manager_plus", editRecordsRole: "manager_plus" }),
      ),
    );
    expect(patch.status).toBe(200);
    expect((await read(patch)).data.policy.knowledgeMode).toBe("full");

    await acceptKw(env, mgr, "team1");
    const rec = await call(() =>
      knowledge.createRecord(
        env,
        pr(mgr),
        "team1",
        jsonReq({
          kind: "decision",
          title: "Use official-only MCP",
          content: "Agents only read official records in Phase 1.",
        }),
      ),
    );
    expect(rec.status).toBe(201);

    const empCreate = await call(() =>
      knowledge.createRecord(
        env,
        pr(emp),
        "team1",
        jsonReq({ kind: "fact", title: "Nope", content: "Employees blocked" }),
      ),
    );
    expect(empCreate.status).toBe(403);

    const list = await call(() =>
      knowledge.listRecords(env, pr(emp), "team1", new Request("http://t/knowledge/records")),
    );
    expect(list.status).toBe(200);
    expect((await read(list)).data.records.length).toBe(1);
  });

  it("rejects secrets on digest share and requires idempotency key", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    await seedTeam(env, "team1", owner);
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", shareRole: "all", editRecordsRole: "all" }),
      ),
    );

    const bad = await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "Leak",
          summary: "token sk-abcdefghijklmnopqrstuvwxyz123456",
          idempotencyKey: "idem-key-00123",
        }),
      ),
    );
    expect(bad.status).toBe(422);

    const noIdem = await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({ title: "Ok", summary: "Shipped knowledge share path." }),
      ),
    );
    expect(noIdem.status).toBe(400);

    const envBlocked = await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "Session wrap",
          summary: "Implemented Knowledge digests and records.",
          files: ["knowledge.ts", ".env"],
          idempotencyKey: "idem-key-good-01",
        }),
      ),
    );
    expect(envBlocked.status).toBe(422);

    const good2 = await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "Session wrap",
          summary: "Implemented Knowledge digests and records.",
          outcomes: ["API works"],
          files: ["knowledge.ts"],
          idempotencyKey: "idem-key-good-02",
        }),
      ),
    );
    expect(good2.status).toBe(201);
    const d = await read(good2);
    expect(d.data.digest.title).toBe("Session wrap");

    const again = await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "Different",
          summary: "Should not create a second row.",
          idempotencyKey: "idem-key-good-02",
        }),
      ),
    );
    expect(again.status).toBe(200);
    expect((await read(again)).data.digest.id).toBe(d.data.digest.id);
  });

  it("optimistic concurrency + official verify/reset", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    const emp = await seedUser(env, "u_emp");
    await seedTeam(env, "team1", owner);
    await addMember(env, "team1", emp, "employee");
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", editRecordsRole: "all", shareRole: "all" }),
      ),
    );

    await acceptKw(env, emp, "team1");
    const rec = await call(() =>
      knowledge.createRecord(
        env,
        pr(emp),
        "team1",
        jsonReq({
          kind: "decision",
          title: "Billing enforce off",
          content: "Keep BILLING_ENFORCE false until launch.",
        }),
      ),
    );
    const id = (await read(rec)).data.record.id as string;

    const v = await call(() => knowledge.verifyRecord(env, pr(owner), "team1", id));
    expect(v.status).toBe(200);
    expect((await read(v)).data.record.authority).toBe("official");

    // Employee who owns the record still cannot PATCH official (would demote).
    const empPatch = await call(() =>
      knowledge.patchRecord(
        env,
        pr(emp),
        "team1",
        id,
        jsonReq({ expectedVersion: 1, content: "Sneaky demotion" }),
      ),
    );
    expect(empPatch.status).toBe(403);
    expect((await read(empPatch)).error).toMatch(/official/i);

    const ok = await call(() =>
      knowledge.patchRecord(
        env,
        pr(owner),
        "team1",
        id,
        jsonReq({
          expectedVersion: 1,
          content: "Updated decision text without reverify.",
        }),
      ),
    );
    expect(ok.status).toBe(200);
    const after = await read(ok);
    expect(after.data.record.version).toBe(2);
    expect(after.data.record.authority).toBe("member");

    const stale2 = await call(() =>
      knowledge.patchRecord(
        env,
        pr(owner),
        "team1",
        id,
        jsonReq({ expectedVersion: 1, content: "nope" }),
      ),
    );
    expect(stale2.status).toBe(412);
  });

  it("employee cannot PATCH any official record (own or others)", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    const emp = await seedUser(env, "u_emp");
    await seedTeam(env, "team1", owner);
    await addMember(env, "team1", emp, "employee");
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", editRecordsRole: "all", shareRole: "all" }),
      ),
    );
    await acceptKw(env, emp, "team1");

    const own = await call(() =>
      knowledge.createRecord(
        env,
        pr(emp),
        "team1",
        jsonReq({ kind: "fact", title: "Mine", content: "employee-owned" }),
      ),
    );
    const ownId = (await read(own)).data.record.id as string;
    await call(() => knowledge.verifyRecord(env, pr(owner), "team1", ownId));

    const other = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "fact", title: "Theirs", content: "owner-owned" }),
      ),
    );
    const otherId = (await read(other)).data.record.id as string;
    await call(() => knowledge.verifyRecord(env, pr(owner), "team1", otherId));

    for (const id of [ownId, otherId]) {
      const patch = await call(() =>
        knowledge.patchRecord(
          env,
          pr(emp),
          "team1",
          id,
          jsonReq({ expectedVersion: 1, content: "demote attempt" }),
        ),
      );
      expect(patch.status).toBe(403);
    }

    // Manager can still edit (demotes without reverify).
    const mgr = await seedUser(env, "u_mgr");
    await addMember(env, "team1", mgr, "manager");
    await acceptKw(env, mgr, "team1");
    const mgrOk = await call(() =>
      knowledge.patchRecord(
        env,
        pr(mgr),
        "team1",
        otherId,
        jsonReq({ expectedVersion: 1, content: "manager edit" }),
      ),
    );
    expect(mgrOk.status).toBe(200);
    expect((await read(mgrOk)).data.record.authority).toBe("member");
  });

  it("MCP overview excludes digests and non-official when filter is official_only", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    await seedTeam(env, "team1", owner);
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({
          knowledgeMode: "full",
          knowledgeMcpEnabled: true,
          mcpAuthorityFilter: "official_only",
          shareRole: "all",
          editRecordsRole: "all",
        }),
      ),
    );

    const r1 = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "decision", title: "Member only", content: "not official" }),
      ),
    );
    const id1 = (await read(r1)).data.record.id as string;

    const r2 = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "decision", title: "Official one", content: "canonical" }),
      ),
    );
    const id2 = (await read(r2)).data.record.id as string;
    await call(() => knowledge.verifyRecord(env, pr(owner), "team1", id2));

    await call(() =>
      knowledge.createDigest(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "Digest",
          summary: "Should not appear in MCP overview.",
          idempotencyKey: "idem-mcp-01xx",
        }),
      ),
    );

    const mcp = await call(() =>
      knowledge.overview(env, pr(owner), "team1", new Request("http://t/knowledge/overview?for=mcp")),
    );
    const mcpData = await read(mcp);
    expect(mcpData.data.digests).toEqual([]);
    expect(mcpData.data.records.every((r: { authority: string }) => r.authority === "official")).toBe(true);
    expect(mcpData.data.records.some((r: { id: string }) => r.id === id2)).toBe(true);
    expect(mcpData.data.records.some((r: { id: string }) => r.id === id1)).toBe(false);

    const web = await call(() =>
      knowledge.overview(env, pr(owner), "team1", new Request("http://t/knowledge/overview")),
    );
    expect((await read(web)).data.digests.length).toBeGreaterThan(0);
  });

  it("cross-team IDOR fails", async () => {
    const env = makeEnv();
    const a = await seedUser(env, "u_a");
    const b = await seedUser(env, "u_b");
    await seedTeam(env, "teamA", a);
    await seedTeam(env, "teamB", b);
    await acceptKw(env, a, "teamA");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(a),
        "teamA",
        jsonReq({ knowledgeMode: "full", editRecordsRole: "all" }),
      ),
    );
    const rec = await call(() =>
      knowledge.createRecord(
        env,
        pr(a),
        "teamA",
        jsonReq({ kind: "fact", title: "Secret to A", content: "only team A" }),
      ),
    );
    const id = (await read(rec)).data.record.id as string;

    // teamB Knowledge is disabled (default) → 403; wrong-team id on enabled team → 404 membership
    expect((await call(() => knowledge.getRecord(env, pr(b), "teamB", id))).status).toBe(403);
    expect((await call(() => knowledge.getRecord(env, pr(b), "teamA", id))).status).toBe(404);
  });

  it("promote creates a record", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    await seedTeam(env, "team1", owner);
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", editRecordsRole: "all" }),
      ),
    );
    const res = await call(() =>
      knowledge.promote(
        env,
        pr(owner),
        "team1",
        jsonReq({
          title: "From local memory",
          content: "Never bake secrets with option_env.",
          kind: "decision",
          from: "local",
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect((await read(res)).data.record.source).toBe("promote");
  });

  it("owner export includes records and omits soft-deleted", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    const employee = await seedUser(env, "u_emp");
    await seedTeam(env, "team1", owner);
    await addMember(env, "team1", employee, "employee");
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({ knowledgeMode: "full", editRecordsRole: "all" }),
      ),
    );
    const created = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "decision", title: "Export me", content: "body" }),
      ),
    );
    const id = (await read(created)).data.record.id as string;
    await call(() =>
      knowledge.deleteRecord(
        env,
        pr(owner),
        "team1",
        id,
        new Request("http://t/knowledge/records/" + id, { method: "DELETE" }),
      ),
    );
    const again = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "fact", title: "Keep me", content: "still here" }),
      ),
    );
    expect(again.status).toBe(201);

    const exp = await call(() => knowledge.exportKnowledge(env, pr(owner), "team1"));
    expect(exp.status).toBe(200);
    const data = (await read(exp)).data;
    expect(data.records.some((r: { title: string }) => r.title === "Keep me")).toBe(true);
    expect(data.records.some((r: { title: string }) => r.title === "Export me")).toBe(false);

    const denied = await call(() => knowledge.exportKnowledge(env, pr(employee), "team1"));
    expect(denied.status).toBe(403);
  });

  it("MCP getRecord rejects digests and non-official under official_only", async () => {
    const env = makeEnv();
    const owner = await seedUser(env, "u_owner");
    await seedTeam(env, "team1", owner);
    await acceptKw(env, owner, "team1");
    await call(() =>
      knowledge.patchSettings(
        env,
        pr(owner),
        "team1",
        jsonReq({
          knowledgeMode: "full",
          knowledgeMcpEnabled: true,
          mcpAuthorityFilter: "official_only",
          editRecordsRole: "all",
        }),
      ),
    );
    const mem = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "decision", title: "Member", content: "not official" }),
      ),
    );
    const memId = (await read(mem)).data.record.id as string;
    const off = await call(() =>
      knowledge.createRecord(
        env,
        pr(owner),
        "team1",
        jsonReq({ kind: "decision", title: "Official", content: "yes" }),
      ),
    );
    const offId = (await read(off)).data.record.id as string;
    await call(() => knowledge.verifyRecord(env, pr(owner), "team1", offId));

    const digReject = await call(() =>
      knowledge.getRecord(
        env,
        pr(owner),
        "team1",
        "kwd_fake",
        new Request("http://t/r?for=mcp"),
      ),
    );
    expect(digReject.status).toBe(400);

    const memberHidden = await call(() =>
      knowledge.getRecord(
        env,
        pr(owner),
        "team1",
        memId,
        new Request("http://t/r?for=mcp"),
      ),
    );
    expect(memberHidden.status).toBe(404);

    const ok = await call(() =>
      knowledge.getRecord(
        env,
        pr(owner),
        "team1",
        offId,
        new Request("http://t/r?for=mcp"),
      ),
    );
    expect(ok.status).toBe(200);
    expect((await read(ok)).data.record.authority).toBe("official");
  });
});
