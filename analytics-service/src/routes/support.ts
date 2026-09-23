import { devEnabled, type Env } from "../env";
import { badRequest, HttpError, json, notFound, forbidden } from "../http";
import { sha256 } from "../crypto";

const MAX_BODY = 15 * 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
function field(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw badRequest("Invalid report fields.");
  return value.trim();
}
async function boundedJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) throw new HttpError(413, "Report is too large.");
  const reader = req.body?.getReader();
  if (!reader) throw badRequest("Missing report.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, "Report is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw badRequest("Invalid report JSON."); }
}

export async function submitSupport(req: Request, env: Env): Promise<Response> {
  // Count before reading attachment bodies. Store a rotating hash, never the raw IP.
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = await sha256(`${hour}:${req.headers.get("cf-connecting-ip") ?? "local"}`);
  const rate = await env.DB.prepare("INSERT INTO support_rate (key, hour, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < 5 RETURNING count").bind(key, hour).first();
  if (!rate) throw new HttpError(429, "Too many reports. Please try again in an hour.");
  await env.DB.prepare("DELETE FROM support_rate WHERE hour < ?").bind(hour - 1).run();
  const body = await boundedJson(req);
  const kind = field(body.kind, 20, true);
  if (!["bug", "crash", "question", "feedback"].includes(kind)) throw badRequest("Choose a report type.");
  const title = field(body.title, 160, true);
  const description = field(body.description, 20000, true);
  const email = field(body.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address.");
  const appVersion = field(body.appVersion, 80);
  const system = field(body.system, 300);
  if (!Array.isArray(body.attachments) || body.attachments.length > 5) throw badRequest("Attach up to five files.");
  let total = 0;
  const attachments = body.attachments.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw badRequest("Invalid attachment.");
    const file = raw as Record<string, unknown>;
    const name = field(file.name, 200, true).replace(/[\x00-\x1f\x7f/\\]/g, "_");
    const encoded = field(file.data, Math.ceil(MAX_FILE / 3) * 4);
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw badRequest("Invalid attachment data.");
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); } catch { throw badRequest("Invalid attachment data."); }
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL) throw badRequest("Files must be under 5 MB each and 10 MB combined.");
    return { name, bytes, id: crypto.randomUUID() };
  });
  if (attachments.length && !env.SUPPORT_FILES) throw new HttpError(503, "Attachments are temporarily unavailable. Your report has not been sent.");
  const id = crypto.randomUUID();
  const uploaded: string[] = [];
  try {
    for (const file of attachments) {
      const key = `${id}/${file.id}`;
      await env.SUPPORT_FILES!.put(key, file.bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      uploaded.push(key);
    }
    const metadata = attachments.map(({ name, id: fileId, bytes }) => ({ name, id: fileId, size: bytes.length }));
    await env.DB.prepare("INSERT INTO support_reports (id, created_at, kind, title, description, email, app_version, system, attachments, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')")
      .bind(id, new Date().toISOString(), kind, title, description, email, appVersion, system, JSON.stringify(metadata)).run();
  } catch (error) {
    if (uploaded.length) await env.SUPPORT_FILES!.delete(uploaded).catch(() => {});
    throw error;
  }
  return json({ id }, { status: 201 });
}

export async function listSupport(req: Request, env: Env): Promise<Response> {
  const before = new URL(req.url).searchParams.get("before") ?? "9999";
  const rows = await env.DB.prepare("SELECT * FROM support_reports WHERE created_at < ? ORDER BY created_at DESC LIMIT 50").bind(before).all();
  return json(rows.results, { headers: { "cache-control": "no-store" } });
}
export async function updateSupport(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get("origin");
  // Wrangler rewrites the browser origin to the Worker route in local mode.
  // Production accepts only the configured owner origin; bearer clients may
  // omit Origin but cannot use a foreign browser origin to bypass this check.
  const expected = new URL(devEnabled(env) ? req.url : env.APP_ORIGIN).origin;
  if (origin ? origin !== expected : !req.headers.get("authorization")?.startsWith("Bearer ")) throw forbidden();
  const body = await boundedJson(req);
  const status = field(body.status, 20);
  if (!["open", "resolved"].includes(status)) throw badRequest("Invalid status.");
  const id = new URL(req.url).pathname.split("/").pop()!;
  await env.DB.prepare("UPDATE support_reports SET status = ? WHERE id = ?").bind(status, id).run();
  return json({ id, status });
}
export async function downloadSupport(req: Request, env: Env): Promise<Response> {
  const parts = new URL(req.url).pathname.split("/");
  const id = parts[4], fileId = parts[5];
  const report = await env.DB.prepare("SELECT attachments FROM support_reports WHERE id = ?").bind(id).first<{ attachments: string }>();
  const file = report && (JSON.parse(report.attachments) as { id: string; name: string }[]).find(f => f.id === fileId);
  if (!file || !env.SUPPORT_FILES) throw notFound();
  const object = await env.SUPPORT_FILES.get(`${id}/${fileId}`);
  if (!object) throw notFound();
  return new Response(object.body, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
}
