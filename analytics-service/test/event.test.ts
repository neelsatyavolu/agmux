import { describe, expect, it } from "vitest";
import { event } from "../src/routes/event";
import { INSTALL_ID, makeEnv } from "./helpers/d1";

function post(env: ReturnType<typeof makeEnv>, body: unknown) {
  return event(
    new Request("https://owner.agmux.dev/v1/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /v1/event", () => {
  it("increments allowlisted event + dim", async () => {
    const env = makeEnv();
    const res = await post(env, {
      install_id: INSTALL_ID,
      name: "thread_created",
      props: { provider: "ClaudeCode", interactionMode: "pty", path: "/secret" },
    });
    expect(res.status).toBe(204);
    const ev = await env.DB.prepare("SELECT count FROM daily_events WHERE name = 'thread_created'").first<{
      count: number;
    }>();
    expect(Number(ev?.count)).toBe(1);
    const dim = await env.DB.prepare(
      "SELECT dim_key, dim_value FROM daily_event_dims WHERE name = 'thread_created'",
    ).all<{ dim_key: string; dim_value: string }>();
    expect(dim.results).toEqual(
      expect.arrayContaining([
        { dim_key: "provider", dim_value: "ClaudeCode" },
        { dim_key: "interactionMode", dim_value: "pty" },
      ]),
    );
    expect(dim.results.some((r) => r.dim_value === "/secret")).toBe(false);
  });

  it("rejects unknown event names", async () => {
    const env = makeEnv();
    await expect(
      post(env, { install_id: INSTALL_ID, name: "prompt_submitted", props: {} }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("drops unknown provider values instead of storing them", async () => {
    const env = makeEnv();
    await post(env, {
      install_id: INSTALL_ID,
      name: "thread_created",
      props: { provider: "NotAProvider" },
    });
    const dims = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_event_dims").first<{ n: number }>();
    expect(Number(dims?.n)).toBe(0);
  });
});
