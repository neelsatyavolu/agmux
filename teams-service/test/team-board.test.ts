import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { makeEnv, seedUser, seedTeam, addMember } from "./helpers/d1";
import { createDeviceToken } from "../src/session";
import { sweepBoard } from "../src/routes/team-board";

const project = "github.com/acme/web";

async function fixture() {
  const env = makeEnv();
  for (const id of ["owner", "alice", "bob", "outsider"]) await seedUser(env, id);
  await seedTeam(env, "team", "owner");
  await addMember(env, "team", "alice", "employee");
  await addMember(env, "team", "bob", "employee");
  const tokens: Record<string, string> = {};
  for (const id of ["owner", "alice", "bob", "outsider"]) tokens[id] = await createDeviceToken(env, id, `${id}-mac`, null);
  async function call(who: string, method: string, suffix: string, body?: unknown) {
    const response = await worker.fetch(new Request(`https://teams.agmux.dev/api/teams/team${suffix}`, {
      method, headers: { authorization: `Bearer ${tokens[who]}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: response.status, ...await response.json() as any };
  }
  const share = (who: string) => call(who, "PUT", "/session-sharing", { enabled: true });
  const post = (who: string, body: Record<string, unknown>) => call(who, "POST", "/board", { project, ...body });
  const read = (who: string, query = "") => call(who, "GET", `/board?project=${encodeURIComponent(project)}${query}`);
  return { env, call, share, post, read };
}

afterEach(() => vi.useRealTimers());

describe("team board", () => {
  it("adds the same table to an existing database as the fresh schema", () => {
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../migrations/018_team_board.sql", import.meta.url), "utf8");
    const upgraded = new DatabaseSync(":memory:"), fresh = new DatabaseSync(":memory:");
    try {
      upgraded.exec(schema.slice(0, schema.indexOf("-- Team board:")));
      upgraded.exec(migration);
      fresh.exec(schema);
      expect(upgraded.prepare("PRAGMA table_info(team_board_items)").all()).toEqual(fresh.prepare("PRAGMA table_info(team_board_items)").all());
    } finally { upgraded.close(); fresh.close(); }
  });

  it("is only for members who turned on team sessions", async () => {
    const { post, read, share } = await fixture();
    expect((await read("alice")).code).toBe("sharing_off");
    await share("alice");
    expect((await post("alice", { kind: "note", text: "hi" })).status).toBe(201);
    expect((await read("outsider")).status).toBe(404);
  });

  it("broadcasts a claim, a question and its reply to everyone in the repo", async () => {
    const { post, read, share } = await fixture();
    await share("alice");
    await share("bob");
    const claim = await post("alice", { kind: "claim", text: "Taking migration 365 for the billing table", agent: "codex" });
    expect(claim.status).toBe(201);
    expect(claim.data.expires).toBeTruthy();
    const question = (await post("bob", { kind: "question", text: "Is anyone changing src/auth.ts?", agent: "claude" })).data.id;
    expect((await post("alice", { kind: "reply", replyTo: question, text: "Yes, until 3pm" })).status).toBe(201);
    const items = (await read("bob")).data.items;
    expect(items.map((i: any) => i.kind).sort()).toEqual(["claim", "question", "reply"]);
    expect(items.find((i: any) => i.kind === "claim")).toMatchObject({ member: "alice", mine: false, agent: "codex", status: "open" });
    expect(items.find((i: any) => i.kind === "reply")).toMatchObject({ reply_to: question, member: "alice" });
  });

  it("keeps repos apart and narrows to changes with since", async () => {
    const { call, post, read, share } = await fixture();
    await share("alice");
    await post("alice", { kind: "note", text: "web note" });
    await call("alice", "POST", "/board", { project: "github.com/acme/api", kind: "note", text: "api note" });
    expect((await read("alice")).data.items.map((i: any) => i.text)).toEqual(["web note"]);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect((await read("alice", `&since=${encodeURIComponent(later)}`)).data.items).toEqual([]);
  });

  it("lets only the author close, renew or edit an item", async () => {
    const { call, post, read, share } = await fixture();
    await share("alice");
    await share("bob");
    const id = (await post("alice", { kind: "claim", text: "Editing package.json", hours: 1 })).data.id;
    expect((await call("bob", "PATCH", `/board/${id}`, { status: "released" })).status).toBe(403);
    expect((await call("alice", "PATCH", `/board/${id}`, { renew: true, hours: 2 })).status).toBe(200);
    expect((await call("alice", "PATCH", `/board/${id}`, { status: "done" })).status).toBe(200);
    expect((await read("bob")).data.items[0].status).toBe("done");
    const note = (await post("alice", { kind: "note", text: "n" })).data.id;
    expect((await call("alice", "PATCH", `/board/${note}`, { renew: true })).status).toBe(400);
  });

  it("shows a claim nobody renewed as expired, and the sweep keeps decisions longest", async () => {
    const { env, post, read, share } = await fixture();
    await share("alice");
    await post("alice", { kind: "claim", text: "Taking the deploy", hours: 1 });
    await post("alice", { kind: "decision", text: "Use UUIDv7 ids" });
    await post("alice", { kind: "note", text: "fyi" });
    vi.useFakeTimers({ now: Date.now() + 2 * 3600_000 });
    expect((await read("alice")).data.items.find((i: any) => i.kind === "claim").status).toBe("expired");
    await sweepBoard(env, Math.floor(Date.now() / 1000) + 30 * 86_400);
    const kinds = (await env.DB.prepare("SELECT kind FROM team_board_items").all<{ kind: string }>()).results.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(["decision"]);
  });

  it("refuses replies to items elsewhere, bad kinds, empty or oversized text, and strips control characters", async () => {
    const { post, read, share } = await fixture();
    await share("alice");
    expect((await post("alice", { kind: "reply", replyTo: "tb_nope", text: "x" })).status).toBe(404);
    expect((await post("alice", { kind: "shout", text: "x" })).status).toBe(400);
    expect((await post("alice", { kind: "note", text: "  " })).status).toBe(400);
    expect((await post("alice", { kind: "note", text: "x".repeat(2_001) })).status).toBe(400);
    await post("alice", { kind: "note", text: "hi\u001b[2J\u0015there" });
    expect((await read("alice")).data.items[0].text).toBe("hi [2J there");
  });

  it("always shows held claims and ones that ran out since, however many newer items there are", async () => {
    const { env, post, read, share } = await fixture();
    await share("alice");
    const held = (await post("alice", { kind: "claim", text: "Taking migration 365", hours: 24 })).data.id;
    const short = (await post("alice", { kind: "claim", text: "Editing auth.ts", hours: 1 })).data.id;
    const at = Math.floor(Date.now() / 1000);
    // 250 newer notes, written directly (the hourly cap would stop them).
    for (let i = 0; i < 250; i++) {
      await env.DB.prepare(`INSERT INTO team_board_items (id, team_id, project, kind, body, status, author_user_id, created_at, updated_at)
        VALUES (?, 'team', ?, 'note', 'n', 'open', 'alice', ?, ?)`).bind(`n${i}`, project, at + 1, at + 1).run();
    }
    const full = (await read("alice")).data.items;
    expect(full.some((i: any) => i.id === held)).toBe(true);
    expect(full.some((i: any) => i.id === short)).toBe(true);
    const lastRead = new Date((at + 10) * 1000).toISOString();
    vi.useFakeTimers({ now: (at + 2 * 3600) * 1000 });
    const later = (await read("alice", `&since=${encodeURIComponent(lastRead)}`)).data.items;
    expect(later.map((i: any) => [i.id, i.status])).toEqual(expect.arrayContaining([[held, "open"], [short, "expired"]]));
  });

  it("caps posts per member per hour", async () => {
    const { post, share } = await fixture();
    await share("alice");
    const results = await Promise.all(Array.from({ length: 65 }, (_, i) => post("alice", { kind: "note", text: `n${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(60);
  });
});
