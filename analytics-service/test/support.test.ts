import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers/d1";
const payload = { kind: "bug", title: "Cannot open project", description: "Clicking Open does nothing", email: "user@example.com", appVersion: "4.1.3", system: "macOS arm64", attachments: [] };
const post = (body: unknown) => new Request("https://owner.agmux.dev/v1/support", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" }, body: JSON.stringify(body) });
describe("support", () => {
  it("accepts a report and exposes it only to the owner", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "test-owner" });
    expect((await worker.fetch(new Request("https://owner.agmux.dev/api/support"), env)).status).toBe(401);
    const response = await worker.fetch(post(payload), env);
    expect(response.status).toBe(201);
    const list = await worker.fetch(new Request("https://owner.agmux.dev/api/support", { headers: { authorization: "Bearer test-owner" } }), env);
    expect(JSON.stringify(await list.json())).toContain(payload.title);
  });
  it("rejects invalid fields and attachment payloads", async () => {
    for (const body of [{ ...payload, kind: "invalid" }, { ...payload, title: "" }, { ...payload, attachments: [{ name: "a", data: "%%%" }] }]) {
      expect((await worker.fetch(post(body), makeEnv())).status).toBe(400);
    }
  });
  it("limits submissions from the same network", async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) expect((await worker.fetch(post(payload), env)).status).toBe(201);
    expect((await worker.fetch(post(payload), env)).status).toBe(429);
  });
  it("never allows an anonymous attachment download", async () => {
    expect((await worker.fetch(new Request("https://owner.agmux.dev/api/support/attachment/anything"), makeEnv())).status).toBe(401);
  });
  it("stores attachment bytes privately and serves owner-only downloads", async () => {
    const stored = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, bytes: Uint8Array) => { stored.set(key, bytes); },
      get: async (key: string) => stored.has(key) ? { body: stored.get(key) } : null,
      delete: async (keys: string[]) => { keys.forEach(key => stored.delete(key)); },
    } as unknown as R2Bucket;
    const env = makeEnv({ ADMIN_TOKEN: "test-owner", SUPPORT_FILES: bucket });
    expect((await worker.fetch(post({ ...payload, attachments: [{ name: "crash.ips", data: btoa("crash bytes") }] }), env)).status).toBe(201);
    const key = [...stored.keys()][0];
    const url = `https://owner.agmux.dev/api/support/attachment/${key}`;
    expect((await worker.fetch(new Request(url), env)).status).toBe(401);
    const download = await worker.fetch(new Request(url, { headers: { authorization: "Bearer test-owner" } }), env);
    expect(await download.text()).toBe("crash bytes");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
  });
  it("does not silently discard attachments when storage is unavailable", async () => {
    const env = makeEnv();
    expect((await worker.fetch(post({ ...payload, attachments: [{ name: "a.txt", data: btoa("hello") }] }), env)).status).toBe(503);
    expect(await env.DB.prepare("SELECT * FROM support_reports").first()).toBeNull();
  });
  it("lets the owner resolve reports and rejects anonymous changes", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "test-owner" });
    const response = await worker.fetch(post(payload), env);
    const { data } = await response.json() as { data: { id: string } };
    const url = `https://owner.agmux.dev/api/support/${data.id}`;
    expect((await worker.fetch(new Request(url, { method: "PATCH", headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) }), env)).status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM support_reports WHERE id = ?").bind(data.id).first<{ status: string }>();
    expect(row?.status).toBe("resolved");
    expect((await worker.fetch(new Request(url, { method: "PATCH", headers: { origin: "https://evil.example", authorization: "Bearer test-owner" }, body: JSON.stringify({ status: "open" }) }), env)).status).toBe(403);
    expect((await worker.fetch(new Request(url, { method: "PATCH", headers: { origin: "https://evil.example" }, body: JSON.stringify({ status: "open" }) }), env)).status).toBe(401);
  });

});
