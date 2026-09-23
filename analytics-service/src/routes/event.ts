import type { Env } from "../env";
import { badRequest, empty, readJson } from "../http";
import { recordEvent } from "../ingest";
import { parseEvent } from "../validate";

export async function event(req: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(req);
  let payload;
  try {
    payload = parseEvent(body);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "Invalid event.");
  }
  await recordEvent(env, payload.installId, payload.name, payload.dims);
  return empty(204);
}
