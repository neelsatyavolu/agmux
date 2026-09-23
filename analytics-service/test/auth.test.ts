import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers/d1";

describe("auth", () => {
  it("me is anonymous and reports configured methods", async () => {
    const env = makeEnv({ OWNER_PASSWORD: "pw" });
    const res = await worker.fetch(
      new Request("https://owner.agmux.dev/api/auth/me"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { user: null; auth: { github: boolean; password: boolean } };
    };
    expect(body.data.user).toBeNull();
    expect(body.data.auth.password).toBe(true);
    expect(body.data.auth.github).toBe(false);
  });

  it("password login sets a session cookie", async () => {
    const env = makeEnv({ OWNER_PASSWORD: "hunter2" });
    const res = await worker.fetch(
      new Request("https://owner.agmux.dev/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "hunter2" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("__Host-agmux_owner=");
  });

  it("wrong password is 403", async () => {
    const env = makeEnv({ OWNER_PASSWORD: "hunter2" });
    const res = await worker.fetch(
      new Request("https://owner.agmux.dev/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("dev login is 404/400 when DEV_AUTH is off", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://owner.agmux.dev/api/auth/dev", { method: "POST" }),
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
