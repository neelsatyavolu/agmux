#!/usr/bin/env node
/**
 * OpenCode SDK Bridge — one Node process serves ALL threads.
 *
 * Protocol: JSON-RPC over stdin/stdout.
 *   Request:  { id, method, params }
 *   Response: { id, result } | { id, error: { message } }
 *   Event:    { event: "...", threadId, ...payload }   (no id)
 *
 * Every per-thread method requires `params.threadId`. Events emitted from a
 * session carry `threadId` so Rust can route to `sdk-event-{threadId}`.
 *
 * Shared architecture (differs from claude-sdk-bridge which is one session per
 * process): OpenCode's `opencode serve` is an HTTP server that already hosts
 * many sessions — spawning a server per thread wastes memory, ports, and auth
 * state. Here one server + one HTTP client is spawned lazily on first
 * `initialize` and shared by every session.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createMapper } from "./opencode-event-mapper.mjs";
import {
  isPermissionRequestEvent,
  isQuestionRequestEvent,
  openCodePermissionReply,
  isBypassPermissionMode,
} from "./opencode-permissions.mjs";
import { buildOpencodeConfig, parseModelSlug } from "./opencode-local-provider.mjs";
import { createRestartGate } from "./opencode-restart-gate.mjs";

// --- Shared process-level state ---
let serverProcess = null;   // `opencode serve` subprocess (null if external URL used)
let serverUrl = null;        // base URL for HTTP client
let client = null;           // OpencodeClient
let globalEventsAbort = null; // AbortController for the global event subscription
let localModels = [];        // locally-installed models the next serve spawn declares
let localModelsKey = "[]";   // JSON fingerprint of localModels
let servedLocalIds = new Set(); // local model ids the running serve was spawned with
let serveOptions = null;     // { binaryPath, serverPassword } for restarts
const sessions = new Map();  // threadId → SessionContext
const openCodeSessionToThread = new Map(); // openCodeSessionId → threadId (for event routing)
const restartGate = createRestartGate(restartServe);

function fingerprintLocalModels(models) {
  return JSON.stringify(Array.isArray(models) ? models : []);
}

function connectClient(url, serverPassword) {
  serverUrl = url;
  client = createOpencodeClient({
    baseUrl: url,
    ...(serverPassword ? {
      headers: { Authorization: "Basic " + Buffer.from(`opencode:${serverPassword}`).toString("base64") },
    } : {}),
    throwOnError: true,
  });
}

async function spawnAndConnect() {
  const spawned = await spawnOpencodeServe(serveOptions.binaryPath, localModels);
  serverProcess = spawned.child;
  servedLocalIds = new Set(localModels.map((m) => m?.id).filter(Boolean));
  connectClient(spawned.url, serveOptions.serverPassword);
  await startGlobalEventSubscription();
}

/**
 * Respawn `opencode serve` with the current `localModels`. Runs through
 * `restartGate`, so no turn is in flight. Chats keep their sessions: OpenCode
 * stores them on disk, so the same session ids resume on the new server and
 * the thread ↔ session routing below stays valid.
 */
async function restartServe() {
  log(`restarting opencode serve for ${localModels.length} local model(s); keeping ${sessions.size} session(s)`);
  try { globalEventsAbort?.abort(); } catch {}
  globalEventsAbort = null;
  try { serverProcess?.kill(); } catch {}
  serverProcess = null;
  client = null;
  // Permission and question prompts belong to turns, and none are running.
  for (const ctx of sessions.values()) {
    ctx.pendingPermissions.clear();
    ctx.pendingQuestions.clear();
  }
  await spawnAndConnect();
}

/**
 * A turn on a `local/<id>` that the next serve declares but the running one
 * doesn't. A model missing from both gains nothing from a restart; it fails
 * with OpenCode's own "model not found".
 */
function needsNewLocalModel(model) {
  const { providerID, modelID } = parseModelSlug(model);
  if (providerID !== "local" || !modelID || servedLocalIds.has(modelID)) return false;
  return localModels.some((m) => m?.id === modelID);
}

// --- I/O helpers (match claude-sdk-bridge.mjs) ---
function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
}
function respondError(id, message) {
  process.stdout.write(JSON.stringify({ id, error: { message: stringifyError(message) } }) + "\n");
}
// Robustly turn anything (string, Error, APIError with structured .body, plain
// object) into a human-readable string. Without this, OpenCode SDK errors
// surface as "[object Object]" in the UI.
function stringifyError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const m = typeof err.message === "string" ? err.message : "";
    const body = err.body ?? err.response ?? null;
    if (body && typeof body === "object") {
      const detail = body.error?.message ?? body.message ?? body.error;
      if (typeof detail === "string" && detail.length) return m ? `${m}: ${detail}` : detail;
      try { return m ? `${m}: ${JSON.stringify(body)}` : JSON.stringify(body); } catch { /* fall through */ }
    }
    return m || err.toString();
  }
  if (typeof err === "object") {
    const o = err;
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
    try { return JSON.stringify(o); } catch { return Object.prototype.toString.call(o); }
  }
  return String(err);
}
function log(...args) {
  process.stderr.write("[opencode-bridge] " + args.map(String).join(" ") + "\n");
}

// --- opencode serve lifecycle ---
async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnOpencodeServe(binaryPath, localModels = []) {
  const port = await findAvailablePort();
  const config = buildOpencodeConfig(localModels, 21434);
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[opencode-serve] ${chunk}`));

  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(() => reject(new Error("opencode serve startup timeout")), 10_000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const line = buf.split("\n").find((l) => l.startsWith("opencode server listening"));
      if (line) {
        const match = line.match(/on\s+(https?:\/\/\S+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`opencode serve exited (code=${code} signal=${signal})`));
    });
  });
  return { url, child };
}

function defaultPermissions(mode) {
  if (isBypassPermissionMode(mode)) {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

async function autoAllowPermission(ctx, permissionId) {
  const reply = "always";
  if (typeof client.permission.reply === "function") {
    await client.permission.reply({
      requestID: permissionId,
      reply,
    });
  } else {
    await client.permission.respond({
      sessionID: ctx.openCodeSessionId,
      permissionID: permissionId,
      response: reply,
    });
  }
}

// --- Global event subscription (one stream → fanned out by sessionID) ---
async function startGlobalEventSubscription() {
  log(`startGlobalEventSubscription called: alreadySubscribed=${!!globalEventsAbort}`);
  if (globalEventsAbort) return; // already subscribed
  globalEventsAbort = new AbortController();
  log(`startGlobalEventSubscription connecting to ${serverUrl}`);
  // The OpenCode SDK's `event.subscribe()` returns a ServerSentEventsResult
  // (`{ stream: AsyncGenerator<...> }`), NOT an async iterable directly.
  // Iterating `result` throws `TypeError: subscription is not async iterable`;
  // we must iterate `result.stream` instead.
  const subscription = await client.event.subscribe(undefined, { signal: globalEventsAbort.signal });
  const eventStream = subscription?.stream ?? subscription;
  log(`startGlobalEventSubscription SSE stream opened (hasStream=${!!subscription?.stream} asyncIter=${!!eventStream?.[Symbol.asyncIterator]})`);
  (async () => {
    let rawCount = 0;
    try {
      for await (const evt of eventStream) {
        rawCount += 1;
        const props = evt?.properties ?? {};
        const sdkSessionId = props.sessionID;
        // Always log every raw event so we can see if the SSE stream is alive
        // and what sessionID each event carries (helps diagnose routing drops).
        log(`RAW evt#${rawCount} type=${evt?.type} sessionID=${sdkSessionId ?? "(none)"} known=${sdkSessionId ? openCodeSessionToThread.has(sdkSessionId) : "-"} mappedThreads=${openCodeSessionToThread.size}`);
        const threadId = sdkSessionId ? openCodeSessionToThread.get(sdkSessionId) : null;
        if (!threadId) {
          // Global/untracked events (e.g. server/installation lifecycle).
          continue;
        }
        const ctx = sessions.get(threadId);
        if (!ctx) { log(`  ! dropped: sessions map missing ctx for thread ${threadId}`); continue; }
        const t = evt.type;
        log(`evt thread=${threadId} type=${t}${props.part?.type ? ` part=${props.part.type}` : ""}`);
        if (t === "message.part.updated" || t === "message.updated" || t === "part.updated") {
          const role = props.info?.role ?? props.role;
          const mapped = ctx.mapper.mapPartUpdate({ ...props, role });
          if (mapped.length) log(`  → emitting ${mapped.length} mapped event(s): ${mapped.map((e) => e.type).join(", ")}`);
          for (const e of mapped) emit({ ...e, threadId });
          // Also surface live token usage from assistant message updates so
          // the context ring appears during streaming, not only after a
          // step-finish Part lands. `message.updated` carries the full
          // assistant Message (with cumulative tokens + cost) — the mapper
          // dedups identical snapshots internally.
          if (t === "message.updated") {
            const usageEvents = ctx.mapper.mapMessageUpdate(props);
            for (const e of usageEvents) emit({ ...e, threadId });
          }
        } else if (isPermissionRequestEvent(t)) {
          for (const e of ctx.mapper.mapPermissionRequest(props)) {
            if (isBypassPermissionMode(ctx.permissionMode)) {
              autoAllowPermission(ctx, e.permissionId).catch((err) => {
                log(`autoAllowPermission failed: ${err?.message ?? err}`);
              });
              continue;
            }
            ctx.pendingPermissions.set(e.permissionId, props);
            emit({ ...e, threadId });
          }
        } else if (isQuestionRequestEvent(t)) {
          for (const e of ctx.mapper.mapQuestionRequest(props)) {
            ctx.pendingQuestions.set(e.questionId, props);
            emit({ ...e, threadId });
          }
        } else if (t === "session.idle" || t === "session.completed") {
          emit({ event: "session.idle", threadId, timestamp: new Date().toISOString() });
        } else if (t === "session.error") {
          emit({ event: "error", threadId, message: props.error ?? "unknown", timestamp: new Date().toISOString() });
        }
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        log("event subscription error:", err?.stack ?? err?.message ?? err);
      }
    } finally {
      log(`event subscription loop ended rawCount=${rawCount}`);
    }
  })();
}

function requireSession(id, threadId) {
  if (!threadId) {
    respondError(id, "threadId required");
    return null;
  }
  const ctx = sessions.get(threadId);
  if (!ctx) {
    respondError(id, `no session for ${threadId}`);
    return null;
  }
  return ctx;
}

// --- Request dispatcher ---
async function handleRequest({ id, method, params }) {
  let turnStarted = false;
  try {
    if (method === "sendMessage" && sessions.has(params?.threadId)) {
      // Count the turn so a serve restart can't cut it off; a turn on a
      // just-installed local model first waits for the restart that adds it.
      await restartGate.beginTurn(needsNewLocalModel(sessions.get(params.threadId).model));
      turnStarted = true;
    } else if (method !== "initialize" && method !== "stop" && method !== "shutdown") {
      // `client` is briefly swapped out while serve restarts.
      await restartGate.settled();
    }
    switch (method) {
      case "initialize": {
        // `localModels` are baked into OPENCODE_CONFIG_CONTENT at serve spawn.
        // If the installed set changes after the first initialize (model
        // download, first local install after a cloud-only session), serve
        // needs a restart — returning alreadyInitialized freezes the old set.
        const { binaryPath, serverUrl: externalUrl, serverPassword } = params ?? {};
        const nextModels = Array.isArray(params?.localModels) ? params.localModels : [];
        const nextKey = fingerprintLocalModels(nextModels);

        if (client) {
          const modelsChanged = nextKey !== localModelsKey;
          // External URL mode has no OPENCODE_CONFIG_CONTENT we control, so
          // we can't redeclare providers — only self-spawned serve can restart.
          if (!modelsChanged || !serverProcess || externalUrl) {
            respond(id, { serverUrl, alreadyInitialized: true });
            return;
          }
          // Restart without dropping anyone: the gate waits for running turns
          // to finish, and sessions carry over (see restartServe). Not awaited
          // — a turn on a newly installed model waits for it in sendMessage.
          log(`localModels changed (${localModels.length} → ${nextModels.length}); restart queued behind ${restartGate.inFlight} running turn(s)`);
          localModels = nextModels;
          localModelsKey = nextKey;
          if (binaryPath) serveOptions = { binaryPath, serverPassword };
          restartGate.request().catch((err) => log(`opencode serve restart failed: ${stringifyError(err)}`));
          respond(id, { serverUrl, alreadyInitialized: true });
          return;
        }

        localModels = nextModels;
        localModelsKey = nextKey;
        if (externalUrl) {
          connectClient(externalUrl, serverPassword);
          await startGlobalEventSubscription();
        } else {
          if (!binaryPath) {
            respondError(id, "binaryPath or serverUrl required");
            return;
          }
          serveOptions = { binaryPath, serverPassword };
          await spawnAndConnect();
        }
        respond(id, { serverUrl });
        return;
      }

      case "startSession": {
        if (!client) return respondError(id, "bridge not initialized");
        const { threadId, directory, model, agent, permissionMode, resumeSessionId } = params ?? {};
        if (!threadId) return respondError(id, "threadId required");
        // Idempotent re-start: the bridge is a shared singleton and its
        // `sessions` Map persists across React component mount/unmount
        // cycles. When the user navigates away from an OpenCode thread and
        // back, OpenCodeSdkSessionView remounts and calls startSession
        // again — we treat that as a no-op re-use, re-emit session.started
        // so the new mount unlocks its input, and return the existing
        // sessionId. Creating a second underlying OpenCode session here
        // would silently fork the conversation.
        const existingCtx = sessions.get(threadId);
        if (existingCtx) {
          if (permissionMode) existingCtx.permissionMode = permissionMode;
          log(`startSession thread=${threadId} — already active, re-using sessionId=${existingCtx.openCodeSessionId}`);
          emit({ event: "session.started", threadId, sessionId: existingCtx.openCodeSessionId });
          respond(id, { sessionId: existingCtx.openCodeSessionId });
          return;
        }

        log(`startSession thread=${threadId} dir=${directory} model=${model} mode=${permissionMode ?? "normal"} resume=${resumeSessionId ?? "(new)"}`);
        let openCodeSessionId = resumeSessionId;
        if (!openCodeSessionId) {
          const created = await client.session.create({
            directory,
            permission: defaultPermissions(permissionMode ?? "normal"),
          });
          openCodeSessionId = created.data?.id;
          if (!openCodeSessionId) return respondError(id, "session.create returned no id");
          log(`  → session.create returned id=${openCodeSessionId}`);
        }

        const ctx = {
          threadId,
          openCodeSessionId,
          directory,
          model,
          agent,
          permissionMode: permissionMode ?? "normal",
          mapper: createMapper(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
        };
        sessions.set(threadId, ctx);
        openCodeSessionToThread.set(openCodeSessionId, threadId);
        emit({ event: "session.started", threadId, sessionId: openCodeSessionId });
        respond(id, { sessionId: openCodeSessionId });
        return;
      }

      case "sendMessage": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        const { text, attachments } = params;
        const { providerID, modelID, variant } = parseModelSlug(ctx.model);
        if (!providerID || !modelID) return respondError(id, `invalid model slug: ${ctx.model}`);
        const parts = [{ type: "text", text }];
        for (const a of attachments ?? []) {
          if (a.path) {
            parts.push({
              type: "file",
              mime: a.mimeType ?? "application/octet-stream",
              filename: a.name ?? "file",
              url: pathToFileURL(a.path).href,
            });
          } else if (a.dataUrl) {
            // Pasted / uploaded images: pass the data URL through directly.
            parts.push({
              type: "file",
              mime: a.mimeType ?? "application/octet-stream",
              filename: a.name ?? "image",
              url: a.dataUrl,
            });
          }
        }
        log(`sendMessage thread=${ctx.threadId} session=${ctx.openCodeSessionId} provider=${providerID} model=${modelID}${variant ? ` variant=${variant}` : ""} textLen=${text?.length ?? 0} parts=${parts.length}`);

        // --- Pre-turn snapshot of existing message IDs ---
        // Resumed threads already have historical messages (tool calls,
        // reasoning, text) that the FRONTEND has already materialized via
        // `getHistory`. The mapper's dedup Set (`seenToolStart`) is empty on
        // a freshly-started bridge process, so re-mapping those historical
        // parts during polling would emit fresh `tool_use` events that the
        // frontend — which has no tool_use dedup — would append as
        // duplicates. Snapshot existing message IDs up front and skip them
        // in `replayAllMessages` so we only emit events for messages
        // CREATED by the current turn.
        const preTurnMessageIds = new Set();
        try {
          const initialSnap = await client.session.messages({
            sessionID: ctx.openCodeSessionId,
            directory: ctx.directory,
          });
          const initialList = Array.isArray(initialSnap?.data) ? initialSnap.data
                            : Array.isArray(initialSnap) ? initialSnap
                            : [];
          for (const entry of initialList) {
            const mid = entry?.info?.id;
            if (mid) preTurnMessageIds.add(mid);
          }
          log(`  pre-turn snapshot: ${preTurnMessageIds.size} existing message(s) will be skipped by poll/replay`);
        } catch (e) {
          log(`  ! pre-turn snapshot failed: ${e?.message ?? e}`);
        }

        // --- Live-replay polling ---
        // Some OpenCode providers (MiniMax, openai, opencode-go observed) don't
        // emit `message.part.updated` events during a turn — all content
        // appears in one final burst, and intermediate assistant messages
        // (containing tool calls) are dropped entirely because `prompt()`'s
        // return value only surfaces the FINAL assistant message's parts.
        //
        // Fix: poll `session.messages()` every POLL_INTERVAL_MS during the
        // turn and run every part through the mapper. The mapper dedupes via
        // `textByPartId` / `seenToolStart`, so it's idempotent with any SSE
        // events that DID arrive and with the final replay below. This
        // captures tool calls + intermediate reasoning that SSE skipped.
        const POLL_INTERVAL_MS = 700;
        const replayAllMessages = async () => {
          try {
            const snap = await client.session.messages({
              sessionID: ctx.openCodeSessionId,
              directory: ctx.directory,
            });
            const list = Array.isArray(snap?.data) ? snap.data
                        : Array.isArray(snap) ? snap
                        : [];
            for (const entry of list) {
              const mid = entry?.info?.id;
              if (!mid) continue;
              // Skip messages that existed BEFORE this turn started —
              // the frontend already rendered them via getHistory, and
              // re-emitting them would dup.
              if (preTurnMessageIds.has(mid)) continue;
              const role = entry?.info?.role;
              for (const part of entry.parts ?? []) {
                const mapped = ctx.mapper.mapPartUpdate({ part, messageID: mid, role });
                for (const e of mapped) emit({ ...e, threadId: ctx.threadId });
              }
            }
          } catch (e) {
            log(`  ! replayAllMessages failed: ${e?.message ?? e}`);
          }
        };
        let pollActive = true;
        const pollPromise = (async () => {
          let ticks = 0;
          while (pollActive) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            if (!pollActive) break;
            ticks += 1;
            await replayAllMessages();
          }
          log(`  poll loop stopped thread=${ctx.threadId} ticks=${ticks}`);
        })();

        const t0 = Date.now();
        try {
          // Use `prompt` (blocking) rather than `promptAsync` (fire-and-forget)
          // so that provider/model errors surface back through the RPC response
          // instead of the turn silently failing server-side with no session.error
          // event. Intermediate assistant text / tool events still stream via
          // the SSE subscription and the poll loop concurrently; `prompt` just
          // resolves once the turn completes (or errors).
          const result = await client.session.prompt({
            sessionID: ctx.openCodeSessionId,
            directory: ctx.directory,
            model: { providerID, modelID },
            // UI stores `provider/model#variant`; pass variant top-level so
            // OpenCode selects the reasoning/effort profile without treating
            // `#high` as part of modelID.
            ...(variant ? { variant } : {}),
            ...(ctx.agent ? { agent: ctx.agent } : {}),
            parts,
          });
          const body = result?.data ?? result ?? {};
          const respMessageId = body?.info?.id ?? body?.id ?? body?.messageID ?? null;
          log(`sendMessage resolved thread=${ctx.threadId} elapsed=${Date.now() - t0}ms messageId=${respMessageId ?? "(none)"}`);

          // Stop the poll loop and do one final full-session replay. This
          // catches anything the last poll tick missed AND picks up
          // intermediate assistant messages (tool calls, earlier reasoning)
          // that `prompt()`'s return value doesn't expose — its `parts` only
          // contains the FINAL assistant message's parts, losing all
          // tool_use blocks from prior steps in a multi-step turn.
          pollActive = false;
          await pollPromise;
          await replayAllMessages();

          // Mark the turn complete so the UI clears "thinking…".
          emit({ event: "session.idle", threadId: ctx.threadId, timestamp: new Date().toISOString() });
        } catch (err) {
          pollActive = false;
          await pollPromise.catch(() => {});
          const msg = err?.message ?? err?.error?.message ?? String(err);
          log(`sendMessage FAILED thread=${ctx.threadId} elapsed=${Date.now() - t0}ms err=${msg}`);
          // Best-effort final replay even on error — a partial turn may
          // still have tool calls / reasoning worth rendering.
          await replayAllMessages();
          // Surface as a user-visible error event so the UI can render it
          // instead of hanging on "thinking…".
          emit({ event: "error", threadId: ctx.threadId, message: `Turn failed: ${msg}`, timestamp: new Date().toISOString() });
          respondError(id, msg);
          return;
        }
        respond(id, { ok: true });
        return;
      }

      case "respondPermission": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        const { permissionId, decision } = params;
        const reply = openCodePermissionReply(decision);
        if (typeof client.permission.reply === "function") {
          await client.permission.reply({
            requestID: permissionId,
            reply,
          });
        } else {
          await client.permission.respond({
            sessionID: ctx.openCodeSessionId,
            permissionID: permissionId,
            response: reply,
          });
        }
        ctx.pendingPermissions.delete(permissionId);
        respond(id, { ok: true });
        return;
      }

      case "respondQuestion": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        const { questionId, answers } = params;
        await client.question.respond({
          sessionID: ctx.openCodeSessionId,
          questionID: questionId,
          answers,
        });
        ctx.pendingQuestions.delete(questionId);
        respond(id, { ok: true });
        return;
      }

      case "interrupt": {
        const ctx = sessions.get(params?.threadId);
        if (!ctx) return respond(id, { ok: true });
        await client.session.abort({ sessionID: ctx.openCodeSessionId });
        respond(id, { ok: true });
        return;
      }

      case "setModel": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        ctx.model = params.model ?? ctx.model;
        respond(id, { ok: true });
        return;
      }

      case "setAgent": {
        // Update the active agent (e.g., "build", "plan", "general") on the
        // session ctx. Sent per-turn via `sendMessage`'s `agent` field so
        // switching mid-session takes effect on the next user turn without
        // creating a new OpenCode session.
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        const next = params?.agent;
        ctx.agent = (typeof next === "string" && next.length > 0) ? next : undefined;
        log(`setAgent thread=${ctx.threadId} agent=${ctx.agent ?? "(none)"}`);
        respond(id, { ok: true });
        return;
      }

      case "setPermissionMode": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        const mode = params?.mode ?? params?.permissionMode ?? "normal";
        ctx.permissionMode = mode;
        log(`setPermissionMode thread=${ctx.threadId} mode=${mode}`);
        if (isBypassPermissionMode(mode)) {
          for (const permissionId of ctx.pendingPermissions.keys()) {
            autoAllowPermission(ctx, permissionId).catch((err) => {
              log(`autoAllowPermission failed: ${err?.message ?? err}`);
            });
          }
          ctx.pendingPermissions.clear();
        }
        try {
          if (typeof client?.session?.update === "function") {
            await client.session.update({
              sessionID: ctx.openCodeSessionId,
              directory: ctx.directory,
              permission: defaultPermissions(mode),
            });
          }
        } catch (err) {
          log(`session.update permissions skipped: ${err?.message ?? err}`);
        }
        respond(id, { ok: true, mode });
        return;
      }

      case "getHistory": {
        const ctx = requireSession(id, params?.threadId);
        if (!ctx) return;
        // Pass `directory` so the OpenCode server scopes the lookup to the
        // session's workspace. Without it, multi-workspace setups can return
        // messages from a sibling project (or fail outright). Mirrors the
        // pattern used by sendMessage / replayAllMessages above.
        const result = await client.session.messages({
          sessionID: ctx.openCodeSessionId,
          directory: ctx.directory,
        });
        respond(id, { messages: result.data ?? [] });
        return;
      }

      case "listModels": {
        if (!client) return respondError(id, "bridge not initialized");
        const dir = params?.directory;
        const [providers, agents] = await Promise.all([
          client.provider.list({ directory: dir }),
          client.app.agents({ directory: dir }),
        ]);
        const list = providers.data ?? { all: [], connected: [] };
        const connected = new Set(list.connected ?? []);
        // Surface ALL models from ALL providers in OpenCode's catalog so users
        // can browse the full set (anthropic, openai, openrouter→minimax/qwen,
        // deepseek, groq, etc.). Connected providers sort first; un-authed
        // providers are flagged so the UI can render a "needs auth" hint.
        const models = [];
        for (const p of list.all ?? []) {
          const providerConnected = connected.has(p.id);
          for (const m of Object.values(p.models ?? {})) {
            models.push({
              slug: `${p.id}/${m.id}`,
              name: `${p.name} · ${m.name}`,
              providerName: p.name,
              providerID: p.id,
              modelID: m.id,
              connected: providerConnected,
              variants: Object.keys(m.variants ?? {}),
            });
          }
        }
        models.sort((a, b) => {
          if (a.connected !== b.connected) return a.connected ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        respond(id, {
          models,
          agents: (agents.data ?? []).filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all")),
          directory: dir,
        });
        return;
      }

      case "listAgents": {
        if (!client) return respondError(id, "bridge not initialized");
        const result = await client.app.agents({ directory: params?.directory });
        respond(id, (result.data ?? []).filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all")));
        return;
      }

      case "listAuthMethods": {
        if (!client) return respondError(id, "bridge not initialized");
        const dir = params?.directory;
        const [authResult, listResult] = await Promise.all([
          client.provider.auth({ directory: dir }),
          client.provider.list({ directory: dir }),
        ]);
        const connected = new Set(listResult.data?.connected ?? []);
        const declaredMethods = authResult.data ?? {};
        const allProviders = listResult.data?.all ?? [];

        // Merge: every provider from `list()` is surfaced. If the provider
        // declares explicit auth methods in `auth()`, use those. Otherwise
        // default to a plain API-key method — most OpenCode providers
        // (anthropic, google, openrouter, groq, deepseek, etc.) accept an
        // API key even if they don't show up in provider.auth().
        const providers = [];
        const seen = new Set();
        for (const p of allProviders) {
          const providerID = p.id;
          seen.add(providerID);
          const declared = declaredMethods[providerID]?.methods;
          const methods = Array.isArray(declared) && declared.length > 0
            ? declared
            : [{ type: "apiKey", label: "Use API key" }];
          providers.push({
            providerID,
            name: p.name ?? providerID,
            isConnected: connected.has(providerID),
            // Expose env vars OpenCode expects for this provider so the UI can
            // hint when "Save key" succeeds but `connected` stays false because
            // the provider needs an env var (e.g. OLLAMA_HOST) instead.
            envVars: Array.isArray(p.env) ? p.env : [],
            methods,
          });
        }
        // Include any providers from auth() that weren't in list() (edge case).
        for (const [providerID, info] of Object.entries(declaredMethods)) {
          if (seen.has(providerID)) continue;
          providers.push({
            providerID,
            name: providerID,
            isConnected: connected.has(providerID),
            methods: info.methods ?? [{ type: "apiKey", label: "Use API key" }],
          });
        }
        // Sort: connected first, then alphabetical by name.
        providers.sort((a, b) => {
          if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        respond(id, providers);
        return;
      }

      case "oauthAuthorize": {
        if (!client) return respondError(id, "bridge not initialized");
        const { providerID, method, inputs } = params ?? {};
        if (!providerID) return respondError(id, "providerID required");
        const result = await client.provider.oauth.authorize({
          providerID,
          ...(method !== undefined ? { method } : {}),
          ...(inputs ? { inputs } : {}),
        });
        respond(id, result.data ?? {});
        return;
      }

      case "oauthCallback": {
        if (!client) return respondError(id, "bridge not initialized");
        const { providerID, method, code } = params ?? {};
        if (!providerID || !code) return respondError(id, "providerID and code required");
        const result = await client.provider.oauth.callback({
          providerID,
          ...(method !== undefined ? { method } : {}),
          code,
        });
        respond(id, result.data ?? {});
        return;
      }

      case "removeAuth": {
        if (!client) return respondError(id, "bridge not initialized");
        const { providerID } = params ?? {};
        if (!providerID) return respondError(id, "providerID required");
        await client.auth.remove({ providerID });
        respond(id, { ok: true });
        return;
      }

      case "setApiKey": {
        if (!client) return respondError(id, "bridge not initialized");
        const { providerID, apiKey } = params ?? {};
        if (!providerID || !apiKey) return respondError(id, "providerID and apiKey required");
        // OpenCode's Auth discriminator is "oauth" | "api" | "wellknown" — NOT
        // "apiKey". Sending the wrong literal produces a Zod invalid_union
        // error from the server.
        await client.auth.set({ providerID, auth: { type: "api", key: apiKey } });
        // Re-check whether the provider now appears in `connected`. If it
        // doesn't, surface the gap to the UI so the user gets concrete
        // guidance instead of silent "still disconnected".
        let nowConnected = false;
        let envVars = [];
        try {
          const dir = params?.directory;
          const listResult = await client.provider.list(dir ? { directory: dir } : {});
          const connected = new Set(listResult.data?.connected ?? []);
          nowConnected = connected.has(providerID);
          const provider = (listResult.data?.all ?? []).find((p) => p.id === providerID);
          envVars = Array.isArray(provider?.env) ? provider.env : [];
        } catch (e) {
          log(`setApiKey post-check failed for ${providerID}:`, stringifyError(e));
        }
        log(`setApiKey ${providerID}: stored, connected=${nowConnected}, envVars=${envVars.join(",") || "(none)"}`);
        respond(id, { ok: true, connected: nowConnected, envVars });
        return;
      }

      case "stopSession": {
        const threadId = params?.threadId;
        if (!threadId) return respondError(id, "threadId required");
        const ctx = sessions.get(threadId);
        if (ctx) {
          try { await client.session.abort({ sessionID: ctx.openCodeSessionId }); } catch {}
          openCodeSessionToThread.delete(ctx.openCodeSessionId);
          sessions.delete(threadId);
        }
        respond(id, { ok: true });
        return;
      }

      case "stop":
      case "shutdown": {
        try { globalEventsAbort?.abort(); } catch {}
        for (const ctx of sessions.values()) {
          try { if (client) await client.session.abort({ sessionID: ctx.openCodeSessionId }); } catch {}
        }
        sessions.clear();
        openCodeSessionToThread.clear();
        try { serverProcess?.kill(); } catch {}
        respond(id, { ok: true });
        if (method === "shutdown") setTimeout(() => process.exit(0), 50);
        return;
      }

      default:
        respondError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    log(`Error handling ${method}:`, err?.stack ?? err?.message ?? err);
    respondError(id, stringifyError(err));
  } finally {
    if (turnStarted) restartGate.endTurn();
  }
}

// --- readline loop ---
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (err) { return respondError(null, `parse error: ${err.message}`); }
  if (typeof msg.id !== "number" && typeof msg.id !== "string") return;
  handleRequest(msg);
});

function shutdownSync() {
  try { globalEventsAbort?.abort(); } catch {}
  try { serverProcess?.kill(); } catch {}
}
process.on("SIGTERM", () => { shutdownSync(); process.exit(0); });
process.on("SIGINT",  () => { shutdownSync(); process.exit(0); });
