import { describe, expect, it } from "vitest";
import { heartbeat } from "../src/routes/heartbeat";
import { summary } from "../src/routes/summary";
import { heartbeatBody, makeEnv } from "./helpers/d1";
import worker from "../src/index";

describe("GET /api/summary", () => {
  it("401 without a session or admin token", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://owner.agmux.dev/api/summary"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns counts with ADMIN_TOKEN", async () => {
    const env = makeEnv({ ADMIN_TOKEN: "secret-token" });
    await heartbeat(
      new Request("https://owner.agmux.dev/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heartbeatBody()),
      }),
      env,
    );
    const res = await summary(
      new Request("https://owner.agmux.dev/api/summary?days=30", {
        headers: { authorization: "Bearer secret-token" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { installsTotal: number; todayDau: number; wau: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.installsTotal).toBe(1);
    expect(body.data.todayDau).toBe(1);
    expect(body.data.wau).toBe(1);
  });
});
