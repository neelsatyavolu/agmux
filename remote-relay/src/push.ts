/**
 * Apple Push Notification service client for the iPhone app.
 * Token-based auth (ES256 JWT from the team's .p8 key), HTTP/2 via fetch.
 * Secrets: APNS_KEY (the .p8 contents) is a Worker secret; ids are vars.
 */

export interface PushEnv {
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

export type ApnsEnvironment = "production" | "sandbox";

/** What a phone registered for push. Stored with its paired device. */
export interface PushRegistration {
  token: string;
  env: ApnsEnvironment;
  approvals: boolean;
  finished: boolean;
  updatedAt: number;
}

export interface PushAlert {
  title: string;
  body: string;
  threadId?: string;
  /** Replaces an earlier notification with the same id (max 64 bytes). */
  collapseId?: string;
}

export type PushOutcome =
  | { result: "sent"; env: ApnsEnvironment }
  | { result: "gone" }
  | { result: "error"; status: number; reason: string };

const HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
/** Apple rejects tokens older than an hour; refresh well before. */
const JWT_TTL_MS = 50 * 60 * 1000;
const DEVICE_TOKEN_RE = /^[0-9a-f]{32,200}$/i;

export function isDeviceToken(token: unknown): token is string {
  return typeof token === "string" && DEVICE_TOKEN_RE.test(token);
}

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class ApnsClient {
  private jwt: { value: string; at: number } | null = null;

  constructor(
    private readonly env: PushEnv,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  get configured(): boolean {
    return Boolean(this.env.APNS_KEY && this.env.APNS_KEY_ID && this.env.APNS_TEAM_ID && this.env.APNS_TOPIC);
  }

  private async token(force = false): Promise<string> {
    if (!force && this.jwt && Date.now() - this.jwt.at < JWT_TTL_MS) return this.jwt.value;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(this.env.APNS_KEY ?? ""),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const data = `${b64url(JSON.stringify({ alg: "ES256", kid: this.env.APNS_KEY_ID }))}.${b64url(
      JSON.stringify({ iss: this.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }),
    )}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(data));
    this.jwt = { value: `${data}.${b64url(sig)}`, at: Date.now() };
    return this.jwt.value;
  }

  private async post(env: ApnsEnvironment, deviceToken: string, alert: PushAlert, freshJwt = false) {
    const headers: Record<string, string> = {
      authorization: `bearer ${await this.token(freshJwt)}`,
      "apns-topic": this.env.APNS_TOPIC ?? "",
      "apns-push-type": "alert",
      "apns-priority": "10",
    };
    if (alert.collapseId) headers["apns-collapse-id"] = alert.collapseId.slice(0, 64);
    const payload = {
      aps: { alert: { title: alert.title, body: alert.body }, sound: "default", ...(alert.threadId ? { "thread-id": alert.threadId } : {}) },
      ...(alert.threadId ? { threadId: alert.threadId } : {}),
    };
    const res = await this.fetchImpl(`${HOSTS[env]}/3/device/${deviceToken}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    let reason = "";
    if (res.status !== 200) {
      try { reason = String(((await res.json()) as { reason?: string }).reason ?? ""); } catch { /* empty body */ }
    }
    return { status: res.status, reason };
  }

  /**
   * Sends one alert. A token from the other environment (TestFlight/App Store
   * use production, Xcode debug builds use sandbox) is retried there once.
   */
  async send(reg: PushRegistration, alert: PushAlert): Promise<PushOutcome> {
    if (!this.configured) return { result: "error", status: 0, reason: "not configured" };
    const order: ApnsEnvironment[] = reg.env === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];
    let last = { status: 0, reason: "" };
    for (const env of order) {
      let r = await this.post(env, reg.token, alert);
      if (r.status === 403 && r.reason === "ExpiredProviderToken") r = await this.post(env, reg.token, alert, true);
      if (r.status === 200) return { result: "sent", env };
      last = r;
      if (r.status === 410) return { result: "gone" };
      if (!(r.status === 400 && r.reason === "BadDeviceToken")) break;
    }
    if (last.status === 400 && last.reason === "BadDeviceToken") return { result: "gone" };
    return { result: "error", ...last };
  }
}
