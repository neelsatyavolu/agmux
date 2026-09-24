#!/usr/bin/env node
/**
 * Node WebSocket hub for agmux mobile remote (same protocol as CF Durable Object).
 * Deployed to Railway — no custom DNS required.
 *
 * Env:
 *   PORT — listen port (Railway injects)
 *   HOST — bind address (default 127.0.0.1; set 0.0.0.0 for Railway/public)
 *   AGMUX_RELAY_DATA — directory for durable auth JSON (default: ./.relay-data)
 *   PAIR_PAGE_ORIGIN — optional, for logs only
 */
import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
// Default loopback. Public deploys (Railway) must set HOST=0.0.0.0 explicitly.
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR =
  process.env.AGMUX_RELAY_DATA || join(process.cwd(), ".relay-data");

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_DESKTOP_SECRET_LEN = 32;
const PAIR_FAIL_LIMIT = 20;
const PAIR_FAIL_WINDOW_MS = 10 * 60 * 1000;
/** Max inbound frame size — keep in step with the CF Durable Object hub. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** desktopId is a hub key — bound length + charset to avoid unbounded hubs. */
const DESKTOP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

try {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* ignore */
}

/** @type {Map<string, DesktopHub>} */
const hubs = new Map();

function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** Constant-time comparison of two hex digest strings (avoids timing leaks). */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function randomPairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

class DesktopHub {
  constructor(desktopId) {
    this.desktopId = desktopId;
    /** @type {import('ws').WebSocket | null} */
    this.desktop = null;
    /** @type {Map<import('ws').WebSocket, { role: string, deviceId?: string }>} */
    this.sessions = new Map();
    /** @type {Map<import('ws').WebSocket, { role: string, deviceId?: string }>} */
    this.phones = new Map();
    /** SHA-256 hex of desktop secret — never the raw secret. */
    this.desktopSecretHash = null;
    this.authLoadFailed = false;
    /** @type {string|null} */
    this.deviceName = null;
    /** @type {string|null} */
    this.desktopAppVersion = null;
    /** @type {string[]} */
    this.desktopCapabilities = [];
    /** @type {Array<{id:string,tokenHash:string,tokenPrefix:string,createdAt:number,lastSeenAt:number,expiresAt:number,label:string}>} */
    this.devices = [];
    this.pairCode = null;
    this.pairExpiresAt = 0;
    /** @type {number[]} */
    this.pairFailTimes = [];
    this.load();
  }

  desktopOnlineMsg() {
    return {
      type: "desktop.online",
      ...(this.deviceName ? { deviceName: this.deviceName } : {}),
      ...(this.desktopAppVersion ? { appVersion: this.desktopAppVersion } : {}),
      capabilities: this.desktopCapabilities.slice(),
    };
  }

  authPath() {
    // Sanitize desktopId for filesystem (UUID-safe).
    const safe = String(this.desktopId).replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(DATA_DIR, `${safe}.json`);
  }

  load() {
    const path = this.authPath();
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (!raw || (raw.desktopSecretHash
        ? typeof raw.desktopSecretHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.desktopSecretHash)
        : typeof raw.desktopSecret !== "string" || !raw.desktopSecret)) {
        throw new Error("invalid saved desktop identity");
      }
      let migrated = false;
      if (raw.desktopSecretHash) {
        this.desktopSecretHash = raw.desktopSecretHash;
        // Drop legacy plaintext if both present.
        if (raw.desktopSecret) migrated = true;
      } else if (raw.desktopSecret) {
        this.desktopSecretHash = hashToken(raw.desktopSecret);
        migrated = true;
      }
      const now = Date.now();
      const devices = [];
      if (Array.isArray(raw.devices)) {
        for (const d of raw.devices) {
          if (!d?.id || !d?.tokenHash) continue;
          if (d.expiresAt && d.expiresAt <= now) continue;
          devices.push({
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
      // Migrate legacy plaintext tokens.
      if (Array.isArray(raw.phoneTokens)) {
        for (const t of raw.phoneTokens) {
          if (!t) continue;
          const h = hashToken(t);
          if (devices.some((d) => d.tokenHash === h)) continue;
          devices.push({
            id: randomUUID(),
            tokenHash: h,
            tokenPrefix: String(t).slice(0, 8),
            createdAt: now,
            lastSeenAt: now,
            expiresAt: now + TOKEN_TTL_MS,
            label: "Phone",
          });
        }
        if (raw.phoneTokens.length > 0) migrated = true;
      }
      this.devices = devices;
      // Rewrite without plaintext secrets/tokens after migration.
      if (migrated) {
        this.persist();
      }
    } catch (e) {
      if (e?.code === 'ENOENT') return;
      // Existing but unreadable auth is not a fresh desktop. Never let a new
      // secret claim this known identity after a disk error or damaged file.
      this.authLoadFailed = true;
      console.warn(`[relay] load auth ${this.desktopId}:`, e?.message || e);
    }
  }

  persist() {
    const now = Date.now();
    this.devices = this.devices.filter((d) => d.expiresAt > now);
    const path = this.authPath();
    const tmp = `${path}.${process.pid}.tmp`;
    const body = JSON.stringify(
      {
        desktopSecretHash: this.desktopSecretHash ?? undefined,
        devices: this.devices,
      },
      null,
      2,
    );
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      console.warn(`[relay] persist auth ${this.desktopId}:`, e?.message || e);
    }
  }

  send(ws, msg) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }

  activeSession(ws) {
    if (ws.readyState !== 1) return undefined;
    const meta = this.sessions.get(ws);
    if (meta?.role === "phone" && !this.devices.some(d =>
      d.id === meta.deviceId && d.expiresAt > Date.now())) {
      this.detach(ws);
      try { ws.close(4003, "expired or revoked"); } catch { /* closed */ }
      return undefined;
    }
    return meta;
  }

  broadcastPhones(msg) {
    for (const phone of this.phones.keys()) {
      if (this.activeSession(phone)?.role === "phone") this.send(phone, msg);
    }
  }

  publicDevices() {
    const now = Date.now();
    this.devices = this.devices.filter((d) => d.expiresAt > now);
    return this.devices.map((d) => ({
      id: d.id,
      tokenPrefix: d.tokenPrefix,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: d.expiresAt,
      label: d.label,
    }));
  }

  sendDevicesSnapshot(ws) {
    const devices = this.publicDevices();
    const liveDeviceIds = new Set(devices.map(d => d.id));
    const phonesOnline = [...this.phones].filter(([phone, meta]) =>
      phone.readyState === 1 && liveDeviceIds.has(meta.deviceId)).length;
    this.send(ws || this.desktop, {
      type: "devices.snapshot",
      devices,
      phonesOnline,
    });
  }

  findDeviceByToken(token) {
    const now = Date.now();
    this.devices = this.devices.filter((d) => d.expiresAt > now);
    const h = hashToken(token);
    return this.devices.find((d) => timingSafeEqualHex(d.tokenHash, h));
  }

  detach(ws) {
    const meta = this.sessions.get(ws);
    this.sessions.delete(ws);
    this.phones.delete(ws);
    if (this.desktop === ws) {
      this.desktop = null;
      // Only clear caps when the Mac disconnects — phone reconnect must keep
      // last known capabilities while the desktop socket is still open.
      this.desktopCapabilities = [];
      this.desktopAppVersion = null;
      this.broadcastPhones({ type: "desktop.offline" });
    }
    if (meta?.role === "phone" && this.desktop) {
      this.sendDevicesSnapshot(this.desktop);
    }
    // Drop idle hubs from memory; saved auth reloads on the next connection.
    if (this.sessions.size === 0 && !this.pairCode && hubs.get(this.desktopId) === this) {
      hubs.delete(this.desktopId);
    }
  }

  handleMessage(ws, raw) {
    if (ws.readyState !== 1) return;
    if (this.authLoadFailed) {
      this.send(ws, { type: "error", message: "relay authentication storage unavailable" });
      try { ws.close(1011, "authentication storage unavailable"); } catch { /* closed */ }
      return;
    }
    // Reject oversized frames before parsing (raw is a Buffer/string).
    if (raw && raw.length > MAX_MESSAGE_BYTES) {
      this.send(ws, { type: "error", message: "message too large" });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.send(ws, { type: "error", message: "invalid json" });
      return;
    }

    // Any handler throw must return an error frame, not crash the process as an
    // uncaught exception in the ws 'message' listener.
    try {
      switch (msg.type) {
        case "ping":
          this.send(ws, {
            type: "pong",
            ...(typeof msg.id === "string" ? { id: msg.id } : {}),
          });
          return;
        case "hello":
          this.handleHello(ws, msg);
          return;
        case "pair.create":
          this.handlePairCreate(ws);
          return;
        case "pair.submit":
          this.handlePairSubmit(ws, msg.code || "");
          return;
        case "devices.list":
          this.handleDevicesList(ws);
          return;
        case "devices.revoke":
          this.handleRevoke(ws, msg.deviceId || "");
          return;
        case "devices.revokeAll":
          this.handleRevokeAll(ws);
          return;
        default:
          this.forward(ws, msg);
      }
    } catch {
      this.send(ws, { type: "error", message: "internal error" });
    }
  }

  handleHello(ws, msg) {
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
      const presentedHash = hashToken(token);
      if (!this.desktopSecretHash) {
        this.desktopSecretHash = presentedHash;
        this.persist();
      } else if (!timingSafeEqualHex(presentedHash, this.desktopSecretHash)) {
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
      if (this.desktop && this.desktop !== ws) {
        try {
          this.desktop.close(4000, "replaced");
        } catch {
          /* ignore */
        }
        this.sessions.delete(this.desktop);
      }
      this.desktop = ws;
      // Sessions hold role only — never raw desktop secret.
      this.sessions.set(ws, { role: "desktop" });
      if (msg.deviceName && String(msg.deviceName).trim()) {
        this.deviceName = String(msg.deviceName).trim();
      }
      this.desktopAppVersion =
        msg.appVersion && String(msg.appVersion).trim()
          ? String(msg.appVersion).trim()
          : null;
      this.desktopCapabilities = Array.isArray(msg.capabilities)
        ? msg.capabilities.map((c) => String(c)).filter(Boolean)
        : [];
      this.send(ws, { type: "hello.ok", role: "desktop" });
      this.sendDevicesSnapshot(ws);
      this.broadcastPhones(this.desktopOnlineMsg());
      return;
    }

    if (msg.role === "phone") {
      const token = String(msg.token || "").trim();
      const device = this.findDeviceByToken(token);
      if (!device) {
        this.send(ws, { type: "error", message: "invalid phone token" });
        try {
          ws.close(4001, "unauthorized");
        } catch {
          /* ignore */
        }
        return;
      }
      device.lastSeenAt = Date.now();
      this.persist();
      // Sessions hold role + deviceId only — never raw phone token.
      const meta = { role: "phone", deviceId: device.id };
      this.phones.set(ws, meta);
      this.sessions.set(ws, meta);
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

  handlePairCreate(ws) {
    const meta = this.sessions.get(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    if (!this.desktopSecretHash) {
      this.send(ws, {
        type: "error",
        message: "desktop not enrolled — reconnect remote control",
      });
      return;
    }
    this.pairCode = randomPairCode();
    this.pairExpiresAt = Date.now() + 10 * 60 * 1000;
    this.pairFailTimes = [];
    this.send(ws, {
      type: "pair.created",
      code: this.pairCode,
      expiresAt: this.pairExpiresAt,
    });
  }

  handleDevicesList(ws) {
    const meta = this.sessions.get(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    this.sendDevicesSnapshot(ws);
  }

  handleRevoke(ws, deviceId) {
    const meta = this.sessions.get(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    if (!deviceId) return;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    this.persist();
    for (const [pws, pmeta] of this.phones) {
      if (pmeta.deviceId === deviceId) {
        try {
          pws.close(4003, "revoked");
        } catch {
          /* ignore */
        }
        this.phones.delete(pws);
        this.sessions.delete(pws);
      }
    }
    this.sendDevicesSnapshot(ws);
  }

  handleRevokeAll(ws) {
    const meta = this.sessions.get(ws);
    if (!meta || meta.role !== "desktop") {
      this.send(ws, { type: "error", message: "desktop only" });
      return;
    }
    this.devices = [];
    // Kill switch must also void any outstanding pair code so a code minted
    // before "disable remote" cannot still be redeemed.
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.persist();
    for (const [pws] of this.phones) {
      try {
        pws.close(4003, "revoked");
      } catch {
        /* ignore */
      }
      this.sessions.delete(pws);
    }
    this.phones.clear();
    this.sendDevicesSnapshot(ws);
  }

  handlePairSubmit(ws, code) {
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
    const normalized = String(code).trim().toUpperCase();
    if (
      !this.pairCode ||
      this.pairCode !== normalized ||
      Date.now() > this.pairExpiresAt
    ) {
      this.pairFailTimes.push(now);
      if (this.pairFailTimes.length >= PAIR_FAIL_LIMIT) {
        this.pairCode = null;
        this.pairExpiresAt = 0;
        this.send(ws, {
          type: "pair.fail",
          reason: "too many attempts — generate a new code on the Mac",
        });
        return;
      }
      this.send(ws, { type: "pair.fail", reason: "invalid or expired code" });
      return;
    }
    this.pairFailTimes = [];
    if (!this.desktopSecretHash) {
      this.send(ws, {
        type: "pair.fail",
        reason: "desktop not online — enable remote on the Mac first",
      });
      return;
    }
    const phoneToken =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const created = Date.now();
    const device = {
      id: randomUUID(),
      tokenHash: hashToken(phoneToken),
      tokenPrefix: phoneToken.slice(0, 8),
      createdAt: created,
      lastSeenAt: created,
      expiresAt: created + TOKEN_TTL_MS,
      label: "Phone",
    };
    this.devices.push(device);
    this.pairCode = null;
    this.pairExpiresAt = 0;
    this.persist();
    const meta = { role: "phone", deviceId: device.id };
    this.phones.set(ws, meta);
    this.sessions.set(ws, meta);
    this.send(ws, {
      type: "pair.ok",
      phoneToken,
      desktopId: this.desktopId,
      deviceId: device.id,
    });
    if (this.desktop) {
      this.send(ws, this.desktopOnlineMsg());
      this.sendDevicesSnapshot(this.desktop);
    }
  }

  forward(ws, msg) {
    const meta = this.activeSession(ws);
    if (!meta) {
      this.send(ws, { type: "error", message: "not authenticated" });
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
      if (!this.desktop || this.desktop.readyState !== 1) {
        this.send(ws, {
          type: "error", message: "desktop offline",
          // Echo correlation so the phone can release the exact pending action
          // (send, create, approval, question, model catalog).
          ...(typeof msg.requestId === "string" ? { requestId: msg.requestId } : {}),
          ...(typeof msg.threadId === "string" ? { threadId: msg.threadId } : {}),
        });
        return;
      }
      this.send(this.desktop, msg);
      return;
    }
    if (meta.role === "desktop" && desktopToPhone.has(msg.type)) {
      this.broadcastPhones(msg);
      return;
    }
    this.send(ws, { type: "error", message: `cannot forward ${msg.type}` });
  }
}

function getHub(desktopId) {
  let hub = hubs.get(desktopId);
  if (!hub) {
    hub = new DesktopHub(desktopId);
    hubs.set(desktopId, hub);
  }
  return hub;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "agmux-remote-relay",
        hubs: hubs.size,
        host: HOST,
        pairPage: "https://remote.agmux.dev",
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

// maxPayload rejects oversized frames before they are buffered.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const desktopId = url.searchParams.get("desktopId");
  if (!desktopId || !DESKTOP_ID_RE.test(desktopId)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const hub = getHub(desktopId);
    ws.on("message", (data) => hub.handleMessage(ws, data));
    ws.on("close", () => hub.detach(ws));
    ws.on("error", () => hub.detach(ws));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[agmux-remote-relay] listening on ${HOST}:${PORT}`);
  console.log(`[agmux-remote-relay] durable auth dir: ${DATA_DIR}`);
});
