import { describe, expect, it } from "vitest";
import { recordEvent, upsertHeartbeat } from "../src/ingest";
import { parseHeartbeat } from "../src/validate";
import { heartbeatBody, INSTALL_ID, makeEnv } from "./helpers/d1";

describe("install ingestion", () => {
  it.each(["heartbeat-first", "event-first", "two-events"])(
    "accepts concurrent first requests: %s",
    async (order) => {
      const env = makeEnv();
      const beat = () => upsertHeartbeat(env, parseHeartbeat(heartbeatBody()));
      const event = () => recordEvent(env, INSTALL_ID, "thread_created", { provider: "Codex" });
      const requests = order === "heartbeat-first" ? [beat(), event()]
        : order === "event-first" ? [event(), beat()] : [event(), event()];
      const results = await Promise.allSettled(requests);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const installs = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
      expect(installs?.n).toBe(1);
      const events = await env.DB.prepare("SELECT count FROM daily_events").first<{ count: number }>();
      expect(events?.count).toBe(order === "two-events" ? 2 : 1);
      const dims = await env.DB.prepare("SELECT count FROM daily_event_dims").first<{ count: number }>();
      expect(dims?.count).toBe(events?.count);
    },
  );

  it("fills missing first version after an event and preserves it on upgrade", async () => {
    const env = makeEnv();
    await recordEvent(env, INSTALL_ID, "app_mode", { mode: "agent" });
    await env.DB.prepare("UPDATE installs SET first_seen_at = '2026-08-01T00:00:00Z'").run();
    await upsertHeartbeat(env, parseHeartbeat(heartbeatBody()));
    await upsertHeartbeat(env, parseHeartbeat(heartbeatBody({ app_version: "4.0.3" })));
    const install = await env.DB.prepare("SELECT first_seen_at, first_app_version, last_app_version FROM installs").first();
    expect(install).toEqual({
      first_seen_at: "2026-08-01T00:00:00Z",
      first_app_version: "4.0.2",
      last_app_version: "4.0.3",
    });
  });
});
