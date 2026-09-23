import type { PairedDevice, WireMessage } from "./protocol";

export interface Env {
  DESKTOP_HUB: DurableObjectNamespace;
}

type Role = "desktop" | "phone";

interface SessionMeta {
  role: Role;
  /** Device id when role is phone. */
  deviceId?: string;
}

/** Persisted on each hibernatable WebSocket so maps can rebuild after DO wake.
 * Never stores raw phone tokens or desktop secrets — only role + deviceId
 * (+ session-scoped desktop caps so phone re-hello after DO hibernation
 * still sees `images` etc. while the Mac WS is still open). */
interface WsAttachment {
  desktopName?: string | null;
  role?: Role;
  deviceId?: string;
  /** Desktop feature flags from hello — survives DO hibernation with the socket. */
  capabilities?: string[];
  appVersion?: string | null;
}

/** Durable paired phone — never stores the raw bearer token. */
interface StoredDevice {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string;
}

interface AuthStore {
  /** SHA-256 hex of desktop secret (preferred). */
  desktopSecretHash?: string;
  /** @deprecated Legacy plaintext; migrated to desktopSecretHash on load. */
  desktopSecret?: string;
  desktopName?: string;
  deviceName?: string;
  /** Legacy plaintext tokens (migrated on load). */
  phoneTokens?: string[];
  devices?: StoredDevice[];
  /** Active pair code — persisted so it survives DO hibernation. */
  pairCode?: string | null;
  pairExpiresAt?: number;
}

/** Phone bearer tokens expire 90 days after pair (re-pair required). */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_DESKTOP_SECRET_LEN = 32;
const PAIR_FAIL_LIMIT = 20;
const PAIR_FAIL_WINDOW_MS = 10 * 60 * 1000;
/** Application frame budget shared with the phone and desktop. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * One Durable Object per desktop. Holds the desktop socket + phone sockets,
 * pair codes, and fan-out. Does not persist chat transcripts.
 */
export class DesktopHub {
  private state: DurableObjectState;
  private desktop: WebSocket | null = null;
  private phones = new Map<WebSocket, SessionMeta>();
  private sessions = new Map<WebSocket, SessionMeta>();
  /** SHA-256 hex of the desktop secret — never the raw secret. */
  private desktopSecretHash: string | null = null;
  /**
   * Human desktop id from `?desktopId=` (idFromName key). Never use
   * `state.id.toString()` for client reconnect — that is an opaque hex id
   * and would route phones to a *different* DO after pair.ok.
   */
  private desktopName: string | null = null;
  /** Friendly Mac display name (ComputerName), not the desktopId. */
  private deviceName: string | null = null;
  /** Desktop app version from hello (not durable — session only). */
  private desktopAppVersion: string | null = null;
  /** Desktop feature flags from hello (e.g. images). Session only. */
  private desktopCapabilities: string[] = [];
  private devices: StoredDevice[] = [];
  private pairCode: string | null = null;
  private pairExpiresAt = 0;
  private pairFailTimes: number[] = [];

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Restore durable secrets / devices across DO hibernation
    this.state.blockConcurrencyWhile(async () => {
      const stored = (await this.state.storage.get<AuthStore>("auth")) ?? {};
      // Hydrate secret + devices into memory WITHOUT persisting: a persist that
      // runs before devices are loaded would write devices:[] over real stored
      // devices (and a persist before the secret is loaded would drop it).
      this.desktopSecretHash = await this.hydrateDesktopSecret(stored);
      if (stored.desktopName) this.desktopName = stored.desktopName;
      if (stored.deviceName) this.deviceName = stored.deviceName;
      this.devices = await this.hydrateDevices(stored);
      // Restore active pair code; treat an expired code as absent.
      if (
        stored.pairCode &&
        typeof stored.pairCode === "string" &&
        stored.pairExpiresAt &&
        stored.pairExpiresAt > Date.now()
      ) {
        this.pairCode = stored.pairCode;
        this.pairExpiresAt = stored.pairExpiresAt;
      }
      // Both secret + devices are now loaded — scrub any legacy plaintext in a
      // single write that cannot clobber the other field.
      const hadLegacyPlaintext =
        Boolean(stored.desktopSecret) ||
        (Array.isArray(stored.phoneTokens) && stored.phoneTokens.length > 0);
      if (hadLegacyPlaintext) await this.persistAuth();
      // Rebuild in-memory session maps from hibernated WebSockets.
      for (const ws of this.state.getWebSockets()) {
        this.rehydrateSocket(ws);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // Remember the name used in idFromName so pair.ok returns a reconnectable id.
      const name = url.searchParams.get("desktopId");
      if (name) {
        this.desktopName = name;
        const stored = (await this.state.storage.get<AuthStore>("auth")) ?? {};
        await this.state.storage.put("auth", { ...stored, desktopName: name });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      // Attachment survives hibernation; role/deviceId filled in on hello/pair.
      // Never store raw tokens here.
      server.serializeAttachment({
        desktopName: name ?? this.desktopName,
      } satisfies WsAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Closing sockets can still deliver queued frames during the close handshake.
    if (ws.readyState !== 1) return;
    if (typeof message !== "string") return;
    // Reject oversized frames before parsing so a phone can't relay a huge
    // message.send and the desktop can't broadcast a huge snapshot.
    if (message.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      this.send(ws, { type: "error", message: "message too large" });
      return;
    }
    // After hibernation wake, maps may be empty — rehydrate from attachment first.
    this.rehydrateSocket(ws);

    let msg: WireMessage;
    try {
      msg = JSON.parse(message) as WireMessage;
    } catch {
      this.send(ws, { type: "error", message: "invalid json" });
      return;
    }

    // Any handler throw must return an error frame, not escape as an unhandled
    // rejection that leaves the client hanging.
    try {
      switch (msg.type) {
        case "ping":
          // Hub-local liveness (survives peer offline + Worker redeploy races).
          // Do not require session attachment — half-rehydrated sockets still need it.
          this.send(ws, {
            type: "pong",
            ...(typeof msg.id === "string" ? { id: msg.id } : {}),
          });
          return;
        case "hello":
          await this.handleHello(ws, msg);
          return;
        case "pair.create":
          await this.handlePairCreate(ws);
          return;
        case "pair.submit":
          await this.handlePairSubmit(ws, msg.code);
          return;
        case "devices.list":
          await this.handleDevicesList(ws);
          return;
        case "devices.revoke":
          await this.handleRevoke(ws, msg.deviceId ?? "");
          return;
        case "devices.revokeAll":
          await this.handleRevokeAll(ws);
          return;
        default:
          this.forward(ws, msg);
      }
    } catch {
      this.send(ws, { type: "error", message: "internal error" });
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.detach(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.detach(ws);
  }

  /**
   * Rebuild sessions/desktop/phones from WebSocket attachment after DO
   * hibernation (in-memory maps are empty; sockets stay open).
   * Attachments hold only role + deviceId — not raw bearers.
   */
  private rehydrateSocket(ws: WebSocket): SessionMeta | undefined {
    if (ws.readyState !== 1) return undefined;
    const existing = this.sessions.get(ws);
    if (existing?.role === "phone") {
      const device = this.devices.find((d) => d.id === existing.deviceId);
      if (!device || this.isExpired(device)) {
        this.detach(ws);
        try { ws.close(4003, "expired or revoked"); } catch { /* closed */ }
        return undefined;
      }
    }
    if (existing) return existing;

    let att: WsAttachment | null = null;
    try {
      att = (ws.deserializeAttachment() as WsAttachment | null) ?? null;
    } catch {
      att = null;
    }
    if (!att?.role) return undefined;

    if (att.role === "desktop") {
      // Desktop must already have enrolled a secret hash; attachment is DO-managed.
      if (!this.desktopSecretHash) return undefined;
      const meta: SessionMeta = { role: "desktop" };
      this.sessions.set(ws, meta);
      this.desktop = ws;
      if (att.desktopName) this.desktopName = att.desktopName;
      // Restore session-scoped caps from attachment so a phone re-hello after
      // DO hibernation does not get an empty capabilities list while the Mac
      // socket is still open (in-memory maps were wiped on wake).
      if (Array.isArray(att.capabilities)) {
        this.desktopCapabilities = att.capabilities
          .map((c) => String(c))
          .filter(Boolean);
      }
      if (att.appVersion && String(att.appVersion).trim()) {
        this.desktopAppVersion = String(att.appVersion).trim();
      }
      return meta;
    }

    if (att.role === "phone") {
      const device = att.deviceId
        ? this.devices.find((d) => d.id === att.deviceId)
        : undefined;
      if (!device || this.isExpired(device)) {
        try { ws.serializeAttachment({}); } catch { /* closed */ }
        try { ws.close(4003, "expired or revoked"); } catch { /* closed */ }
        return undefined;
      }
      const meta: SessionMeta = {
        role: "phone",
        deviceId: device.id,
      };
      this.sessions.set(ws, meta);
      this.phones.set(ws, meta);
      return meta;
    }
    return undefined;
  }

  private attachSession(ws: WebSocket, meta: SessionMeta) {
    this.sessions.set(ws, meta);
    try {
      const prev = (ws.deserializeAttachment() as WsAttachment | null) ?? {};
      const att: WsAttachment = {
        desktopName: this.desktopName ?? prev.desktopName ?? null,
        role: meta.role,
        deviceId: meta.deviceId,
        // Deliberately omit any token/secret fields.
      };
      // Persist desktop caps on the desktop socket so DO hibernation keeps them.
      if (meta.role === "desktop") {
        att.capabilities = this.desktopCapabilities.slice();
        att.appVersion = this.desktopAppVersion;
      }
      ws.serializeAttachment(att);
    } catch {
      /* attachment optional if socket already closed */
    }
  }

  private detach(ws: WebSocket) {
    // After DO hibernation the in-memory maps are empty. Read the attachment
    // BEFORE clearing it so a closing Mac still fans out desktop.offline.
    let meta = this.sessions.get(ws);
    if (!meta) {
      try {
        const att = (ws.deserializeAttachment() as WsAttachment | null) ?? null;
        if (att?.role) {
          meta = { role: att.role, deviceId: att.deviceId };
        }
      } catch {
        /* closed */
      }
    }
    // A queued frame or hibernation wake must never restore a detached role.
    try { ws.serializeAttachment({}); } catch { /* closed */ }
    this.sessions.delete(ws);
    this.phones.delete(ws);
    if (this.desktop === ws || meta?.role === "desktop") {
      this.desktop = null;
      // Only clear caps when the Mac actually disconnects — not on phone
      // reconnect / DO wake while the desktop socket is still open.
      this.desktopCapabilities = [];
      this.desktopAppVersion = null;
      this.broadcastPhones({ type: "desktop.offline" });
      return;
    }
    // A phone left — tell the desktop so it stops refreshing timelines that
    // nobody is looking at.
    if (meta?.role === "phone" && this.desktop) {
      this.sendDevicesSnapshot(this.desktop, ws);
    }
  }

  private async persistAuth() {
    this.pruneExpiredDevices();
    await this.state.storage.put("auth", {
      desktopSecretHash: this.desktopSecretHash ?? undefined,
      desktopName: this.desktopName ?? undefined,
      deviceName: this.deviceName ?? undefined,
      devices: this.devices,
      pairCode: this.pairCode ?? undefined,
      pairExpiresAt: this.pairExpiresAt || undefined,
      // Never re-write legacy plaintext desktopSecret or phoneTokens.
    } satisfies AuthStore);
  }

  /**
   * Compute the current secret hash from storage (migrating legacy plaintext
   * to a hash). Pure — the caller persists once after all fields are loaded so
   * a scrub write never clobbers not-yet-hydrated devices.
   */
  private async hydrateDesktopSecret(
    stored: AuthStore,
  ): Promise<string | null> {
    if (stored.desktopSecretHash && typeof stored.desktopSecretHash === "string") {
      return stored.desktopSecretHash;
    }
    if (stored.desktopSecret && typeof stored.desktopSecret === "string") {
      return await hashToken(stored.desktopSecret);
    }
    return null;
  }

  private async hydrateDevices(stored: AuthStore): Promise<StoredDevice[]> {
    const now = Date.now();
    const out: StoredDevice[] = [];
    if (Array.isArray(stored.devices)) {
      for (const d of stored.devices) {
        if (!d?.id || !d?.tokenHash) continue;
        if (d.expiresAt && d.expiresAt <= now) continue;
        out.push({
          id: d.id,
          tokenHash: d.tokenHash,
          tokenPrefix: d.tokenPrefix || d.id.slice(0, 8),
          createdAt: d.createdAt || now,
          lastSeenAt: d.lastSeenAt || d.createdAt || now,
          expiresAt: d.expiresAt || now + TOKEN_TTL_MS,
          label: d.label || "Phone",
        });
      }
    }
    // Migrate legacy plaintext tokens → hashed devices (one-time).
    if (Array.isArray(stored.phoneTokens) && stored.phoneTokens.length > 0) {
      for (const t of stored.phoneTokens) {
        if (!t || typeof t !== "string") continue;
        const hash = await hashToken(t);
        if (out.some((d) => d.tokenHash === hash)) continue;
        out.push({
          id: crypto.randomUUID(),
          tokenHash: hash,
          tokenPrefix: t.slice(0, 8),
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + TOKEN_TTL_MS,
          label: "Phone",
        });
      }
      // Caller persists once after all fields are hydrated (constructor), so
      // the plaintext-token scrub cannot race a half-loaded secret/devices.
    }
    return out;
  }

  private pruneExpiredDevices() {
    const now = Date.now();
    this.devices = this.devices.filter((d) => d.expiresAt > now);
  }

  private isExpired(d: StoredDevice): boolean {
    return d.expiresAt <= Date.now();
  }

  private async findDeviceByTokenAsync(
    token: string,
  ): Promise<StoredDevice | undefined> {
    this.pruneExpiredDevices();
    const hash = await hashToken(token);
    return this.devices.find(
      (d) => timingSafeEqualHex(d.tokenHash, hash) && !this.isExpired(d),
    );
  }

  private publicDevices(): PairedDevice[] {
    this.pruneExpiredDevices();
    return this.devices.map((d) => ({
      id: d.id,
      tokenPrefix: d.tokenPrefix,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: d.expiresAt,
      label: d.label,
    }));
  }

  /**
   * Phone sockets attached right now. Counted from `getWebSockets()` rather
   * than the `phones` Map so a hibernation wake (empty maps, live sockets)
   * doesn't report zero and stop the desktop from serving them.
   */
  private countOnlinePhones(exclude?: WebSocket): number {
    let n = 0;
    for (const sock of this.state.getWebSockets()) {
      if (sock === exclude) continue;
      const meta = this.rehydrateSocket(sock);
      if (meta?.role === "phone") n++;
    }
    return n;
  }

  /** `exclude` is a socket that is going away — don't count it as present. */
  private sendDevicesSnapshot(ws?: WebSocket | null, exclude?: WebSocket) {
    const msg: WireMessage = {
      type: "devices.snapshot",
      devices: this.publicDevices(),
      phonesOnline: this.countOnlinePhones(exclude),
    };
    if (ws) {
      this.send(ws, msg);
    } else if (this.desktop) {
      this.send(this.desktop, msg);
    }
  }

  private desktopOnlineMsg(): WireMessage {
    return {
      type: "desktop.online",
      ...(this.deviceName ? { deviceName: this.deviceName } : {}),
      ...(this.desktopAppVersion ? { appVersion: this.desktopAppVersion } : {}),
      // Always send capabilities (even empty) so the phone can clear a stale
      // "images" gate when a newer Mac is replaced by an older reconnect.
      capabilities: this.desktopCapabilities.slice(),
    };
  }

  private async handleHello(
    ws: WebSocket,
    msg: Extract<WireMessage, { type: "hello" }>,
  ) {
    if (msg.role === "desktop") {
      const token = String(msg.token || "").trim();
      if (token.length < MIN_DESKTOP_SECRET_LEN) {
        this.send(ws, {
          type: "error",
          message: "invalid desktop token (too short)",
        });
        try {
          ws.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      const presentedHash = await hashToken(token);
      if (ws.readyState !== 1) return;
      // First hello from a real Mac sets secret hash; later hellos must match.
      // Desktop id is only published after the Mac has connected (pair URL /
      // Settings when online), so an attacker cannot pre-claim a known id
      // before this registration.
      // Do NOT mutate desktopName/deviceName until authentication succeeds — a
      // rejected hello must not poison identity that a later persist would save
      // or that pair.ok would echo back.
      const firstEnroll = !this.desktopSecretHash;
      if (firstEnroll) {
        this.desktopSecretHash = presentedHash;
      } else if (!timingSafeEqualHex(presentedHash, this.desktopSecretHash!)) {
        this.send(ws, {
          type: "error",
          message:
            "invalid desktop token — use Reset remote identity on the Mac if this is your machine",
        });
        try {
          ws.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      // Authenticated — now safe to adopt identity from the hello payload.
      // Prefer desktopId from hello payload when present (same as query name).
      if (msg.desktopId) {
        this.desktopName = msg.desktopId;
      }
      // Friendly Mac name for the phone footer (e.g. "Neel's MacBook Pro").
      if (msg.deviceName && String(msg.deviceName).trim()) {
        this.deviceName = String(msg.deviceName).trim();
      }
      // Capabilities / version are session-scoped (not durable). Old desktops
      // omit them → empty list so phones hide gated UI (image attach).
      if (msg.appVersion && String(msg.appVersion).trim()) {
        this.desktopAppVersion = String(msg.appVersion).trim();
      } else {
        this.desktopAppVersion = null;
      }
      this.desktopCapabilities = Array.isArray(msg.capabilities)
        ? msg.capabilities.map((c) => String(c)).filter(Boolean)
        : [];
      if (firstEnroll || msg.deviceName) {
        await this.persistAuth();
      }
      if (this.desktop && this.desktop !== ws) {
        try {
          this.desktop.close(4000, "replaced");
        } catch {
          /* ignore */
        }
        try { this.desktop.serializeAttachment({}); } catch { /* closed */ }
        this.sessions.delete(this.desktop);
      }
      this.desktop = ws;
      this.attachSession(ws, { role: "desktop" });
      this.send(ws, { type: "hello.ok", role: "desktop" });
      this.sendDevicesSnapshot(ws);
      this.broadcastPhones(this.desktopOnlineMsg());
      return;
    }

    if (msg.role === "phone") {
      const token = String(msg.token || "").trim();
      const device = await this.findDeviceByTokenAsync(token);
      if (ws.readyState !== 1) return;
      if (!device) {
        this.send(ws, {
          type: "error",
          message: "invalid phone token",
        });
        try {
          ws.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      device.lastSeenAt = Date.now();
      await this.persistAuth();
      const meta: SessionMeta = {
        role: "phone",
        deviceId: device.id,
      };
      this.phones.set(ws, meta);
      this.attachSession(ws, meta);
      this.send(ws, { type: "hello.ok", role: "phone" });
      if (this.desktop) {
        this.send(ws, this.desktopOnlineMsg());
        this.sendDevicesSnapshot(this.desktop);
      } else {
        this.send(ws, { type: "desktop.offline" });
      }
      return;
    }

    this.send(ws, { type: "error", message: "unknown role" });
  }

  private async handlePairCreate(ws: WebSocket) {
    const meta = this.sessions.get(ws) ?? this.rehydrateSocket(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    // Only after the Mac has registered its secret.
    if (!this.desktopSecretHash) {
      this.send(ws, {
        type: "error",
        message: "desktop not enrolled — reconnect remote control",
      });
      return;
    }
    const code = randomPairCode();
    this.pairCode = code;
    this.pairExpiresAt = Date.now() + 10 * 60 * 1000;
    this.pairFailTimes = [];
    // Persist so the code survives DO hibernation until redeemed/expired.
    await this.persistAuth();
    this.send(ws, {
      type: "pair.created",
      code,
      expiresAt: this.pairExpiresAt,
    });
  }

  private async handleDevicesList(ws: WebSocket) {
    const meta = this.sessions.get(ws) ?? this.rehydrateSocket(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    this.sendDevicesSnapshot(ws);
  }

  private async handleRevoke(ws: WebSocket, deviceId: string) {
    const meta = this.sessions.get(ws) ?? this.rehydrateSocket(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    if (!deviceId) return;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    await this.persistAuth();
    this.closePhoneSockets((id) => id === deviceId);
    this.sendDevicesSnapshot(ws);
  }

  private async handleRevokeAll(ws: WebSocket) {
    const meta = this.sessions.get(ws) ?? this.rehydrateSocket(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    this.devices = [];
    // Kill switch must also void any outstanding pair code, otherwise a code
    // minted before "disable remote" stays redeemable (handlePairSubmit only
    // requires desktopSecretHash).
    this.pairCode = null;
    this.pairExpiresAt = 0;
    await this.persistAuth();
    this.closePhoneSockets(() => true);
    this.sendDevicesSnapshot(ws);
  }

  /**
   * Close phone sockets, including hibernated ones that are in
   * `getWebSockets()` but not yet in the in-memory `phones` Map.
   */
  private closePhoneSockets(match: (deviceId: string | undefined) => boolean) {
    for (const sock of this.state.getWebSockets()) {
      let deviceId: string | undefined;
      const mapped = this.sessions.get(sock) ?? this.phones.get(sock);
      if (mapped?.role === "phone") {
        deviceId = mapped.deviceId;
      } else {
        try {
          const att = (sock.deserializeAttachment() as WsAttachment | null) ?? null;
          if (att?.role === "phone") deviceId = att.deviceId;
          else continue;
        } catch {
          continue;
        }
      }
      if (!match(deviceId)) continue;
      try { sock.close(4003, "revoked"); } catch { /* ignore */ }
      try { sock.serializeAttachment({}); } catch { /* closed */ }
      this.phones.delete(sock);
      this.sessions.delete(sock);
    }
  }

  private async handlePairSubmit(ws: WebSocket, code: string) {
    // Rate-limit only failed attempts (windowed).
    const now = Date.now();
    this.pairFailTimes = this.pairFailTimes.filter(
      (t) => now - t < PAIR_FAIL_WINDOW_MS,
    );
    if (this.pairFailTimes.length >= PAIR_FAIL_LIMIT) {
      this.send(ws, {
        type: "pair.fail",
        reason: "too many attempts — try again later",
      });
      return;
    }
    // Hash before validating/consuming the code: no async gap may separate a
    // successful check from consuming this one-time code (or a revoke).
    const phoneToken =
      crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "");
    const tokenHash = await hashToken(phoneToken);
    if (ws.readyState !== 1) return;
    const normalized = String(code ?? "").trim().toUpperCase();
    if (
      !this.pairCode ||
      this.pairCode !== normalized ||
      Date.now() > this.pairExpiresAt
    ) {
      this.pairFailTimes.push(now);
      if (this.pairFailTimes.length >= PAIR_FAIL_LIMIT) {
        this.pairCode = null;
        this.pairExpiresAt = 0;
        await this.persistAuth();
        this.send(ws, {
          type: "pair.fail",
          reason: "too many attempts — generate a new code on the Mac",
        });
        return;
      }
      this.send(ws, { type: "pair.fail", reason: "invalid or expired code" });
      return;
    }
    // Successful pair — clear fail window.
    this.pairFailTimes = [];
    // Desktop must already have enrolled (pair.create requires secret).
    if (!this.desktopSecretHash) {
      this.send(ws, {
        type: "pair.fail",
        reason: "desktop not online — enable remote on the Mac first",
      });
      return;
    }

    const pairedAt = Date.now();
    const device: StoredDevice = {
      id: crypto.randomUUID(),
      tokenHash,
      tokenPrefix: phoneToken.slice(0, 8),
      createdAt: pairedAt,
      lastSeenAt: pairedAt,
      expiresAt: pairedAt + TOKEN_TTL_MS,
      label: "Phone",
    };
    this.devices.push(device);
    // one-time code
    this.pairCode = null;
    this.pairExpiresAt = 0;
    await this.persistAuth();

    // MUST return the human desktop name (idFromName key), not state.id hex.
    const desktopId = this.desktopName || this.state.id.toString();
    const meta: SessionMeta = {
      role: "phone",
      deviceId: device.id,
    };
    this.phones.set(ws, meta);
    this.attachSession(ws, meta);
    this.send(ws, {
      type: "pair.ok",
      phoneToken,
      desktopId,
      deviceId: device.id,
    });
    if (this.desktop) {
      this.send(ws, this.desktopOnlineMsg());
      this.sendDevicesSnapshot(this.desktop);
    }
  }

  private forward(ws: WebSocket, msg: WireMessage) {
    const meta = this.rehydrateSocket(ws);
    if (!meta) {
      // Transient after wake without attachment — ask client to re-hello.
      // Do NOT say "invalid phone token" (that force-unpairs the PWA).
      this.send(ws, { type: "error", message: "session expired — re-hello" });
      return;
    }

    const phoneToDesktop = new Set([
      "threads.list",
      "thread.subscribe",
      "thread.read",
      "thread.create",
      "thread.setConfig",
      "models.list",
      "message.send",
      "turn.interrupt",
      "approval.respond",
      "userInput.respond",
    ]);
    const desktopToPhone = new Set([
      "threads.snapshot",
      "threads.upsert",
      "thread.created",
      "message.accepted",
      "timeline.snapshot",
      "timeline.append",
      "timeline.patch",
      "status",
      "approval.requested",
      "approval.resolved",
      "userInput.requested",
      "userInput.resolved",
      "models.snapshot",
      "error",
    ]);

    if (meta.role === "phone" && phoneToDesktop.has(msg.type)) {
      // Prefer live desktop; fall back to rehydrate if map lost mid-wake.
      let desk = this.desktop;
      if (!desk) {
        for (const candidate of this.state.getWebSockets()) {
          const m = this.rehydrateSocket(candidate);
          if (m?.role === "desktop") {
            desk = candidate;
            break;
          }
        }
      }
      if (!desk || desk.readyState !== 1) {
        this.send(ws, {
          type: "error", message: "desktop offline",
          ...((msg.type === "message.send" || msg.type === "thread.create") && msg.requestId
            ? { requestId: msg.requestId } : {}),
          ...(msg.type === "message.send" ? { threadId: msg.threadId } : {}),
        });
        return;
      }
      this.send(desk, msg);
      return;
    }

    if (meta.role === "desktop" && desktopToPhone.has(msg.type)) {
      this.broadcastPhones(msg);
      return;
    }

    this.send(ws, { type: "error", message: `cannot forward ${msg.type}` });
  }

  private broadcastPhones(msg: WireMessage) {
    // Include hibernated phone sockets not yet rehydrated into phones Map.
    if (this.phones.size === 0) {
      for (const sock of this.state.getWebSockets()) {
        this.rehydrateSocket(sock);
      }
    }
    for (const phone of this.phones.keys()) {
      if (this.rehydrateSocket(phone)?.role === "phone") this.send(phone, msg);
    }
  }

  private send(ws: WebSocket, msg: WireMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed */
    }
  }
}

function randomPairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Constant-time comparison of two hex digest strings (avoids timing leaks). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
