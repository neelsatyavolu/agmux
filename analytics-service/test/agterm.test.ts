import { describe, expect, it } from "vitest";
import { event } from "../src/routes/event";
import { events } from "../src/routes/events";
import { heartbeat } from "../src/routes/heartbeat";
import { summary } from "../src/routes/summary";
import { heartbeatBody, INSTALL_ID, makeEnv } from "./helpers/d1";

type TestEnv = ReturnType<typeof makeEnv>;
const AGTERM_ID = "7d444840-9dc0-41a6-9a5e-6c0b2c8d1f3e";

function post(handler: typeof events, env: TestEnv, path: string, body: unknown) {
  return handler(
    new Request(`https://owner.agmux.dev${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function getSummary(env: TestEnv, query: string) {
  const res = await summary(new Request(`https://owner.agmux.dev/api/summary?${query}`), env);
  const body = (await res.json()) as { data: Record<string, unknown> & { events: { name: string }[] } };
  return body.data;
}

describe("agterm reporting", () => {
  it("stores the heartbeat's app and keeps agmux the default", async () => {
    const env = makeEnv();
    await post(heartbeat, env, "/v1/heartbeat", heartbeatBody());
    await post(heartbeat, env, "/v1/heartbeat", heartbeatBody({ install_id: AGTERM_ID, app: "agterm", app_version: "1.1.8" }));
    const rows = await env.DB.prepare("SELECT install_id, app FROM installs ORDER BY app").all<{ app: string }>();
    expect(rows.results.map((r) => r.app)).toEqual(["agmux", "agterm"]);
    const active = await env.DB.prepare("SELECT app FROM daily_active WHERE install_id = ?").bind(AGTERM_ID).first<{ app: string }>();
    expect(active?.app).toBe("agterm");
  });

  it("rejects an unknown app", async () => {
    const env = makeEnv();
    await expect(post(heartbeat, env, "/v1/heartbeat", heartbeatBody({ app: "other" }))).rejects.toMatchObject({ status: 400 });
  });

  it("counts a batch, drops unknown names and props", async () => {
    const env = makeEnv();
    const res = await post(events, env, "/v1/events", {
      install_id: AGTERM_ID,
      app: "agterm",
      events: [
        { name: "agent_started", props: { agent: "claude", cwd: "/Users/me/secret" } },
        { name: "agent_started", props: { agent: "my-private-tool" } },
        { name: "feature_used", props: { feature: "split" } },
        { name: "prompt_typed", props: { text: "hi" } },
      ],
    });
    expect(res.status).toBe(204);
    const counts = await env.DB.prepare("SELECT name, count FROM daily_events ORDER BY name").all<{ name: string; count: number }>();
    expect(counts.results.map((r) => [r.name, Number(r.count)])).toEqual([["agent_started", 2], ["feature_used", 1]]);
    const dims = await env.DB.prepare("SELECT dim_key, dim_value FROM daily_event_dims ORDER BY dim_key").all<{ dim_key: string; dim_value: string }>();
    expect(dims.results).toEqual([
      { dim_key: "agent", dim_value: "claude" },
      { dim_key: "feature", dim_value: "split" },
    ]);
  });

  it("keeps each app's events to its own names", async () => {
    const env = makeEnv();
    await expect(
      post(event, env, "/v1/event", { install_id: AGTERM_ID, app: "agterm", name: "thread_created", props: {} }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      post(event, env, "/v1/event", { install_id: INSTALL_ID, name: "feature_used", props: { feature: "split" } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects empty and oversized batches", async () => {
    const env = makeEnv();
    await expect(post(events, env, "/v1/events", { install_id: AGTERM_ID, app: "agterm", events: [] })).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 101 }, () => ({ name: "feature_used", props: { feature: "split" } }));
    await expect(post(events, env, "/v1/events", { install_id: AGTERM_ID, app: "agterm", events: many })).rejects.toMatchObject({ status: 400 });
  });

  it("summarizes each app separately", async () => {
    const env = makeEnv();
    await post(heartbeat, env, "/v1/heartbeat", heartbeatBody());
    await post(heartbeat, env, "/v1/heartbeat", heartbeatBody({ install_id: AGTERM_ID, app: "agterm", app_version: "1.1.8" }));
    await post(event, env, "/v1/event", { install_id: INSTALL_ID, name: "app_mode", props: { mode: "agent" } });
    await post(events, env, "/v1/events", { install_id: AGTERM_ID, app: "agterm", events: [{ name: "feature_used", props: { feature: "split" } }] });

    const agmux = await getSummary(env, "days=7");
    expect(agmux.installsTotal).toBe(1);
    expect(agmux.events.map((e) => e.name)).toEqual(["app_mode"]);

    const agterm = await getSummary(env, "days=7&app=agterm");
    expect(agterm.app).toBe("agterm");
    expect(agterm.installsTotal).toBe(1);
    expect(agterm.todayDau).toBe(1);
    expect(agterm.events.map((e) => e.name)).toEqual(["feature_used"]);
  });
});
