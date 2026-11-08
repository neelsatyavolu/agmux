import type { Env } from "../env";
import { badRequest, empty, readJson } from "../http";
import { recordEvents } from "../ingest";
import { parseEventBatch } from "../validate";

/** POST /v1/events: a client's batch of allowlisted events (agterm sends every few minutes). */
export async function events(req: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(req);
  let payload;
  try {
    payload = parseEventBatch(body);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Invalid events.");
  }
  await recordEvents(env, payload.installId, payload.app, payload.events);
  return empty(204);
}
