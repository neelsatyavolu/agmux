export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  const e = err instanceof HttpError ? err : new HttpError(500, "Something went wrong on our side.");
  if (!(err instanceof HttpError)) console.error("agmux-owner:", err);
  return new Response(JSON.stringify({ ok: false, error: e.message, code: e.code }), {
    status: e.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const unauthorized = (m = "Sign in to continue.") => new HttpError(401, m, "unauthorized");
export const forbidden = (m = "You don't have access to that.") => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found.") => new HttpError(404, m, "not_found");

export async function readJson<T>(req: Request): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw badRequest("Expected a JSON body.");
  }
  if (parsed === null || typeof parsed !== "object") throw badRequest("Expected a JSON object.");
  return parsed as T;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = "__Host-agmux_owner";

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

export function empty(status: number): Response {
  return new Response(null, { status });
}
