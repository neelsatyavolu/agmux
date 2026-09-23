import { describe, expect, it } from "vitest";
import { heartbeat } from "../src/routes/heartbeat";
import { heartbeatBody, INSTALL_ID, makeEnv } from "./helpers/d1";

describe("POST /v1/heartbeat", () => {
  it("inserts install + daily_active", async () => {
    const env = makeEnv();
    const res = await heartbeat(
      new Request("https://owner.agmux.dev/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heartbeatBody()),
      }),
      env,
    );
    expect(res.status).toBe(204);
    const inst = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(Number(inst?.n)).toBe(1);
    const dau = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_active").first<{ n: number }>();
    expect(Number(dau?.n)).toBe(1);
  });

  it("same-day retry updates install, no second daily row", async () => {
    const env = makeEnv();
    const post = (body: unknown) =>
      heartbeat(
        new Request("https://owner.agmux.dev/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
    await post(heartbeatBody());
    const res = await post(heartbeatBody({ app_version: "4.0.3" }));
    expect(res.status).toBe(204);
    const inst = await env.DB.prepare("SELECT last_app_version FROM installs WHERE install_id = ?")
      .bind(INSTALL_ID)
      .first<{ last_app_version: string }>();
    expect(inst?.last_app_version).toBe("4.0.3");
    const dau = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_active").first<{ n: number }>();
    expect(Number(dau?.n)).toBe(1);
  });

  it("rejects a non-v4 install id", async () => {
    const env = makeEnv();
    await expect(
      heartbeat(
        new Request("https://owner.agmux.dev/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(heartbeatBody({ install_id: "not-a-uuid" })),
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
