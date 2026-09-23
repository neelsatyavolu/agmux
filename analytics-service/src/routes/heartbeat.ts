import type { Env } from "../env";
import { badRequest, empty, readJson } from "../http";
import { upsertHeartbeat } from "../ingest";
import { parseHeartbeat } from "../validate";

export async function heartbeat(req: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(req);
  let payload;
  try {
    payload = parseHeartbeat(body);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Invalid heartbeat.");
  }
  await upsertHeartbeat(env, payload);
  return empty(204);
}
