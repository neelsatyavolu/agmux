/**
 * Cursor SDK Bridge - one Node process serves all agmux Cursor threads.
 *
 * Protocol:
 *   Request:  { id, method, params }
 *   Response: { id, result } | { id, error: { message } }
 *   Event:    { threadId, type, ...payload }
 *
 * Stdout is reserved for newline-delimited JSON-RPC responses/events.
 * Stderr is reserved for logs.
 */

import { SubagentConversations } from "./subagent-conversations.mjs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCursorUserMessage,
  mapCursorMessageToEvents,
  normalizeCursorModel,
  normalizeCursorTokenUsage,
  serializeCursorModelSelection,
} from "./cursor-protocol-helpers.mjs";

const agentsByThread = new Map();
const ERROR_EVENT_EMITTED = Symbol("cursorBridgeErrorEventEmitted");
const interruptedRuns = new WeakSet();
const interruptedRunIds = new Set();
const emittedRunEnds = new Set();
let activeRequests = 0;
let shutdownRequested = false;
let cursorSdkPromise = null;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function emitToThread(threadId, event) {
  emit({ ...event, threadId });
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
}

function respondError(id, error) {
  process.stdout.write(JSON.stringify({ id, error: { message: stringifyError(error) } }) + "\n");
}

function log(...args) {
  process.stderr.write("[cursor-bridge] " + args.map(String).join(" ") + "\n");
}

async function loadCursorSdk() {
  if (!cursorSdkPromise) {
    cursorSdkPromise = (async () => {
      try {
        return await import("@cursor/sdk");
      } catch (primaryErr) {
        const bridgeDir = dirname(fileURLToPath(import.meta.url));
        const runtimeEntry = join(
          bridgeDir,
          "cursor-sdk-runtime",
          "node_modules",
          "@cursor",
          "sdk",
          "dist",
          "esm",
          "index.js",
        );
        try {
          return await import(pathToFileURL(runtimeEntry).href);
        } catch (fallbackErr) {
          throw new Error(
            `Failed to load @cursor/sdk: ${stringifyError(primaryErr)}; runtime fallback failed: ${stringifyError(fallbackErr)}`,
          );
        }
      }
    })();
  }
  return cursorSdkPromise;
}

function stringifyError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const message = typeof err.message === "string" && err.message ? err.message : err.toString();
    const context = [
      err.name && err.name !== "Error" ? err.name : null,
      err.status ? `status ${err.status}` : null,
      err.operation ?? null,
      err.endpoint ?? null,
      err.code ? `code ${err.code}` : null,
    ].filter(Boolean);
    const prefix = context.length > 0 ? `${context.join(" ")}: ` : "";
    const details = err.body ?? err.response ?? err.cause;
    if (details && typeof details === "object") {
      const detailMessage = details.error?.message ?? details.message ?? details.error;
      if (typeof detailMessage === "string" && detailMessage) {
        return prefix + (message ? `${message}: ${detailMessage}` : detailMessage);
      }
      try {
        const json = JSON.stringify(details);
        return prefix + (message ? `${message}: ${json}` : json);
      } catch {
        return prefix + message;
      }
    }
    return prefix + (message || "unknown error");
  }
  if (typeof err === "object") {
    if (typeof err.message === "string" && err.message) return err.message;
    if (typeof err.error === "string" && err.error) return err.error;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

async function loadStoredCredentials() {
  const { FileCredentialStore } = await loadCursorSdk();
  const store = new FileCredentialStore();
  const credentials = await store.load();
  if (!credentials?.apiKey) return null;
  if (
    typeof credentials.apiKeyExpiresAtMs === "number" &&
    credentials.apiKeyExpiresAtMs > 0 &&
    credentials.apiKeyExpiresAtMs <= Date.now()
  ) {
    return null;
  }
  return credentials;
}

/**
 * Resolve auth for SDK calls:
 * 1. CURSOR_API_KEY env
 * 2. ~/.cursor/sdk/auth.json from Cursor.auth.login()
 */
async function resolveApiKey() {
  const envKey = String(process.env.CURSOR_API_KEY ?? "").trim();
  if (envKey) return envKey;
  const stored = await loadStoredCredentials();
  if (stored?.apiKey) return String(stored.apiKey).trim();
  throw new Error(
    "Not signed in to Cursor. Open Settings → Accounts and sign in with Cursor, or set CURSOR_API_KEY.",
  );
}

function normalizePermissionMode(value) {
  const mode = String(value ?? "").trim();
  if (mode === "auto") return "auto";
  if (
    mode === "default" ||
    mode === "acceptEdits" ||
    mode === "supervised"
  ) {
    return "default";
  }
  // full / bypassPermissions / empty → unrestricted local tools
  return "full";
}

function localOptionsForPermission(permissionMode, directory) {
  const local = { cwd: directory };
  if (permissionMode === "auto") {
    local.autoReview = true;
    local.sandboxOptions = { enabled: false };
  } else if (permissionMode === "default") {
    local.autoReview = false;
    local.sandboxOptions = { enabled: true };
  } else {
    local.autoReview = false;
    local.sandboxOptions = { enabled: false };
  }
  return local;
}

function requireString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${name} required`);
  }
  return normalized;
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeModelForStorage(model) {
  return serializeCursorModelSelection(normalizeCursorModel(model));
}

function normalizeModelForSdk(model) {
  return normalizeCursorModel(model);
}

function markRunInterrupted(run) {
  if (!run) return;
  if (typeof run === "object") interruptedRuns.add(run);
  if (run.id) interruptedRunIds.add(String(run.id));
}

function wasRunInterrupted(run) {
  if (!run) return false;
  return interruptedRuns.has(run) || (run.id ? interruptedRunIds.has(String(run.id)) : false);
}

function emitSessionEnded(threadId, reason, run = null) {
  const runId = run?.id ? String(run.id) : null;
  const key = runId ? `${threadId}:${runId}:${reason}` : null;
  if (key && emittedRunEnds.has(key)) return;
  if (key) emittedRunEnds.add(key);
  emitToThread(threadId, { type: "session.ended", reason });
}

function emitThreadError(threadId, err, run = null) {
  emitToThread(threadId, { type: "error", message: stringifyError(err) });
  emitSessionEnded(threadId, "error", run);
  if (err && typeof err === "object") {
    try {
      err[ERROR_EVENT_EMITTED] = true;
    } catch {
      // Some SDK errors may be non-extensible; the event was still emitted.
    }
  }
}

function hasEmittedErrorEvent(err) {
  return !!(err && typeof err === "object" && err[ERROR_EVENT_EMITTED]);
}

function usageFromResult(result) {
  const normalized = normalizeCursorTokenUsage(
    result?.usage ?? result?.message?.usage ?? {},
  );
  return {
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheCreationTokens: normalized.cacheCreationTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    totalCostUsd:
      normalized.totalCostUsd ||
      Number(result?.totalCostUsd ?? result?.total_cost_usd ?? 0) ||
      0,
    numTurns: normalized.numTurns,
  };
}

function resultModelSlug(result, fallbackModel) {
  try {
    return serializeCursorModelSelection(result?.model ?? normalizeModelForSdk(fallbackModel));
  } catch {
    return normalizeModelForStorage(fallbackModel);
  }
}

async function closeAgent(agent) {
  if (!agent) return;
  try {
    if (typeof agent.close === "function") {
      agent.close();
      return;
    }
  } catch (err) {
    log("agent close failed:", stringifyError(err));
  }

  try {
    const asyncDispose = agent[Symbol.asyncDispose];
    if (typeof asyncDispose === "function") {
      await asyncDispose.call(agent);
    }
  } catch (err) {
    log("agent dispose failed:", stringifyError(err));
  }
}

async function closeContext(ctx) {
  if (!ctx) return;
  ctx.subagentConversations?.flush();
  if (ctx.currentRun && typeof ctx.currentRun.cancel === "function") {
    try {
      markRunInterrupted(ctx.currentRun);
      await ctx.currentRun.cancel();
    } catch (err) {
      log("run cancel during close failed:", stringifyError(err));
    }
  }
  await closeAgent(ctx.agent);
}

function requireSession(threadId) {
  const ctx = agentsByThread.get(threadId);
  if (!ctx) {
    throw new Error(`no Cursor session for ${threadId}`);
  }
  return ctx;
}

function normalizeAgentMode(mode) {
  return mode === "plan" ? "plan" : "agent";
}

async function startSession(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const directory = requireString(params.directory, "directory");
  const apiKey = await resolveApiKey();
  const existing = agentsByThread.get(threadId);
  const model = normalizeModelForStorage(params.model ?? existing?.model);
  const mode = normalizeAgentMode(params.mode ?? existing?.mode);
  const permissionMode = normalizePermissionMode(
    params.permissionMode ?? existing?.permissionMode ?? "full",
  );
  const resumeAgentId = optionalString(params.resumeAgentId) ?? optionalString(params.agentId);
  const local = localOptionsForPermission(permissionMode, directory);

  if (
    existing &&
    existing.cwd === directory &&
    existing.permissionMode === permissionMode &&
    existing.mode === mode &&
    (!resumeAgentId || resumeAgentId === existing.agentId)
  ) {
    existing.model = model;
    existing.mode = mode;
    existing.permissionMode = permissionMode;
    emitToThread(threadId, {
      type: "session.started",
      sessionId: existing.agentId,
      agentId: existing.agentId,
      model,
    });
    return { agentId: existing.agentId, model, mode, permissionMode, resumed: true };
  }

  if (existing) {
    agentsByThread.delete(threadId);
  }
  await closeContext(existing);

  const { Agent } = await loadCursorSdk();
  const agent = resumeAgentId
    ? await Agent.resume(resumeAgentId, {
        apiKey,
        model: normalizeModelForSdk(model),
        mode,
        local,
      })
    : await Agent.create({
        apiKey,
        model: normalizeModelForSdk(model),
        mode,
        local,
      });
  const agentId = optionalString(agent.agentId) ?? resumeAgentId;
  if (!agentId) {
    throw new Error("Cursor SDK did not return an agentId");
  }

  agentsByThread.set(threadId, {
    agent,
    agentId,
    cwd: directory,
    model,
    mode,
    permissionMode,
    currentRun: null,
    seenToolStarts: new Set(),
    subagentConversations: new SubagentConversations(threadId, { onError: (err) => log("Subagent capture:", err.message) }),
    sendInFlight: false,
  });

  emitToThread(threadId, {
    type: "session.started",
    sessionId: agentId,
    agentId,
    model,
  });
  return { agentId, model, mode, permissionMode, resumed: !!resumeAgentId };
}

async function sendMessage(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const ctx = requireSession(threadId);
  if (ctx.sendInFlight) {
    throw new Error("Cursor send already in flight for this thread");
  }

  ctx.sendInFlight = true;
  const model = normalizeModelForStorage(params.model ?? ctx.model);
  const mode = normalizeAgentMode(params.mode ?? ctx.mode);
  if (params.permissionMode != null) {
    ctx.permissionMode = normalizePermissionMode(params.permissionMode);
  }
  ctx.model = model;
  ctx.mode = mode;
  ctx.seenToolStarts = new Set();

  const message = buildCursorUserMessage(params.text ?? "", params.images ?? []);
  let run = null;

  try {
    run = await ctx.agent.send(message, {
      model: normalizeModelForSdk(model),
      mode,
      onDelta: ({ update }) => ctx.subagentConversations.cursor(update),
    });
    ctx.currentRun = run;
    // Status only — empty message so chat UI doesn't show a lifecycle line.
    // runId is used by the desktop bridge for session tracking.
    emitToThread(threadId, {
      type: "status",
      status: "running",
      message: "",
      runId: run.id ?? null,
      agentId: ctx.agentId,
    });

    for await (const msg of run.stream()) {
      for (const event of mapCursorMessageToEvents(msg, ctx.seenToolStarts)) {
        emitToThread(threadId, event);
      }
    }

    const result = await run.wait();
    if (result?.status === "cancelled" || wasRunInterrupted(run)) {
      emitSessionEnded(threadId, "interrupted", run);
      return { status: "interrupted", runId: run.id ?? null, agentId: ctx.agentId };
    }

    if (result?.status === "error") {
      const err = new Error(result?.result || `Cursor run failed with status: ${result.status}`);
      emitThreadError(threadId, err, run);
      throw err;
    }

    emitToThread(threadId, {
      type: "turn.completed",
      sessionId: ctx.agentId,
      model: resultModelSlug(result, model),
      modelUsage: null,
      userMessageUuid: null,
      usage: usageFromResult(result),
      result: result?.result ?? null,
      runId: result?.id ?? run.id ?? null,
    });
    return {
      status: result?.status ?? "finished",
      runId: result?.id ?? run.id ?? null,
      agentId: ctx.agentId,
    };
  } catch (err) {
    if (wasRunInterrupted(run)) {
      emitSessionEnded(threadId, "interrupted", run);
      return { status: "interrupted", runId: run.id ?? null, agentId: ctx.agentId };
    }
    if (!hasEmittedErrorEvent(err)) {
      emitThreadError(threadId, err, run);
    }
    throw err;
  } finally {
    ctx.subagentConversations.flush();
    if (ctx.currentRun === run) {
      ctx.currentRun = null;
    }
    ctx.sendInFlight = false;
  }
}

async function interrupt(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const ctx = agentsByThread.get(threadId);
  if (!ctx?.currentRun) return { ok: true };

  const run = ctx.currentRun;
  markRunInterrupted(run);
  if (typeof run.cancel === "function") {
    await run.cancel();
  }
  emitSessionEnded(threadId, "interrupted", run);
  return { ok: true };
}

async function setModel(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const model = normalizeModelForStorage(params.model ?? params.slug);
  const ctx = agentsByThread.get(threadId);
  if (ctx) {
    ctx.model = model;
  }
  return { ok: true, model };
}

/**
 * Update agent mode (agent|plan) and/or permission mode (default|auto|full).
 * Recreates the local agent via resume so sandbox/autoReview take effect.
 */
async function setPermissionMode(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const ctx = agentsByThread.get(threadId);
  const raw = String(params.mode ?? params.permissionMode ?? "").trim();

  let agentMode = ctx?.mode ?? "agent";
  let permissionMode = ctx?.permissionMode ?? "full";

  if (raw === "plan") {
    agentMode = "plan";
  } else if (raw === "agent") {
    agentMode = "agent";
  } else if (raw === "auto") {
    agentMode = "agent";
    permissionMode = "auto";
  } else if (raw === "default" || raw === "acceptEdits" || raw === "supervised") {
    agentMode = "agent";
    permissionMode = "default";
  } else if (raw === "bypassPermissions" || raw === "full") {
    agentMode = "agent";
    permissionMode = "full";
  }

  if (params.agentMode != null) {
    agentMode = normalizeAgentMode(params.agentMode);
  }
  if (params.permissionMode != null && raw !== "plan") {
    permissionMode = normalizePermissionMode(params.permissionMode);
  }

  if (!ctx) {
    return { ok: true, mode: agentMode, permissionMode, recreated: false };
  }

  const needsRecreate =
    ctx.mode !== agentMode || ctx.permissionMode !== permissionMode;
  ctx.mode = agentMode;
  ctx.permissionMode = permissionMode;

  if (!needsRecreate) {
    return {
      ok: true,
      mode: agentMode,
      permissionMode,
      agentId: ctx.agentId,
      recreated: false,
    };
  }

  // Rebuild agent with new local policy while preserving durable agentId.
  const apiKey = await resolveApiKey();
  const previous = ctx;
  agentsByThread.delete(threadId);
  await closeContext(previous);

  const { Agent } = await loadCursorSdk();
  const local = localOptionsForPermission(permissionMode, previous.cwd);
  const agent = await Agent.resume(previous.agentId, {
    apiKey,
    model: normalizeModelForSdk(previous.model),
    mode: agentMode,
    local,
  });
  const agentId = optionalString(agent.agentId) ?? previous.agentId;
  agentsByThread.set(threadId, {
    agent,
    agentId,
    cwd: previous.cwd,
    model: previous.model,
    mode: agentMode,
    permissionMode,
    currentRun: null,
    seenToolStarts: new Set(),
    subagentConversations: new SubagentConversations(threadId, { onError: (err) => log("Subagent capture:", err.message) }),
    sendInFlight: false,
  });

  return {
    ok: true,
    mode: agentMode,
    permissionMode,
    agentId,
    recreated: true,
  };
}

async function authStatus() {
  const { Cursor } = await loadCursorSdk();
  const status = await Cursor.auth.status();
  if (status?.status === "logged-in") {
    return {
      status: "logged-in",
      email: status.email ?? null,
      apiKeyExpiresAtMs: status.apiKeyExpiresAtMs ?? null,
      source: "sdk-login",
    };
  }
  const envKey = String(process.env.CURSOR_API_KEY ?? "").trim();
  if (envKey) {
    // Env key is valid enough to list models; try me() for email.
    try {
      const me = await Cursor.me({ apiKey: envKey });
      return {
        status: "logged-in",
        email: me?.email ?? me?.apiKeyName ?? null,
        apiKeyExpiresAtMs: null,
        source: "env",
      };
    } catch {
      return {
        status: "logged-in",
        email: null,
        apiKeyExpiresAtMs: null,
        source: "env",
      };
    }
  }
  return { status: "logged-out" };
}

async function authLogin(params = {}) {
  const { Cursor } = await loadCursorSdk();
  const result = await Cursor.auth.login({
    openBrowser: params.openBrowser !== false,
    apiKeyName:
      optionalString(params.apiKeyName) ??
      `agmux-${new Date().toISOString().slice(0, 10)}`,
  });
  return {
    status: "logged-in",
    email: result.email ?? null,
    apiKeyExpiresAtMs: result.apiKeyExpiresAtMs ?? null,
    source: "sdk-login",
  };
}

async function authLogout() {
  const { Cursor } = await loadCursorSdk();
  await Cursor.auth.logout();
  return { status: "logged-out" };
}

async function stopSession(params = {}) {
  const threadId = requireString(params.threadId, "threadId");
  const ctx = agentsByThread.get(threadId);
  if (ctx) {
    await closeContext(ctx);
    agentsByThread.delete(threadId);
  }
  return { ok: true };
}

function modelsFromListResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.models)) return result.models;
  return [];
}

function modelItemSelection(item) {
  const id = item?.model?.id ?? item?.id ?? item?.slug ?? item?.name;
  const params = item?.model?.params ?? item?.params;
  return normalizeModelForSdk({ id, params });
}

function normalizeModelVariant(baseModel, variant) {
  const selection = normalizeModelForSdk({
    id: variant?.model?.id ?? variant?.id ?? baseModel.id,
    params: variant?.model?.params ?? variant?.params,
  });
  return {
    slug: serializeCursorModelSelection(selection),
    name: variant?.displayName ?? variant?.name ?? variant?.label ?? serializeCursorModelSelection(selection),
    description: variant?.description ?? "",
  };
}

function normalizeModelParameter(parameter) {
  const id = String(parameter?.id ?? parameter?.key ?? "").trim();
  if (!id) return null;
  const values = Array.isArray(parameter?.values)
    ? parameter.values
        .map((value) => ({
          value: String(value?.value ?? value?.id ?? "").trim(),
          displayName: value?.displayName ?? value?.name ?? value?.label,
        }))
        .filter((value) => value.value)
    : [];
  return {
    id,
    displayName: parameter?.displayName ?? parameter?.name ?? parameter?.label,
    values,
  };
}

async function listModels() {
  const apiKey = await resolveApiKey();
  const { Cursor } = await loadCursorSdk();
  const result = await Cursor.models.list({ apiKey });
  const models = modelsFromListResult(result).map((item) => {
    const selection = modelItemSelection(item);
    const slug = serializeCursorModelSelection(selection);
    const variants = Array.isArray(item?.variants)
      ? item.variants.map((variant) => normalizeModelVariant(selection, variant))
      : [];
    const parameters = Array.isArray(item?.parameters)
      ? item.parameters.map(normalizeModelParameter).filter(Boolean)
      : [];
    return {
      slug,
      name: item?.displayName ?? item?.name ?? item?.label ?? slug,
      description: item?.description ?? "",
      variants,
      parameters,
    };
  });
  return { models };
}

async function shutdown() {
  const contexts = [...agentsByThread.values()];
  agentsByThread.clear();
  await Promise.allSettled(contexts.map(closeContext));
  return { ok: true };
}

async function handleRequest(request) {
  const { id, method, params } = request ?? {};
  const isShutdown = method === "shutdown";
  if (!isShutdown) activeRequests += 1;

  try {
    switch (method) {
      case "startSession":
        return respond(id, await startSession(params));
      case "sendMessage":
        return respond(id, await sendMessage(params));
      case "interrupt":
        return respond(id, await interrupt(params));
      case "setModel":
        return respond(id, await setModel(params));
      case "setPermissionMode":
        return respond(id, await setPermissionMode(params));
      case "stopSession":
        return respond(id, await stopSession(params));
      case "listModels":
        return respond(id, await listModels());
      case "authStatus":
        return respond(id, await authStatus());
      case "authLogin":
        return respond(id, await authLogin(params));
      case "authLogout":
        return respond(id, await authLogout());
      case "shutdown":
        respond(id, await shutdown());
        shutdownRequested = true;
        exitAfterActiveRequests();
        return;
      default:
        return respondError(id, `unknown method: ${method ?? "(missing)"}`);
    }
  } catch (err) {
    log(`${method ?? "request"} failed:`, stringifyError(err));
    return respondError(id, err);
  } finally {
    if (!isShutdown) {
      activeRequests -= 1;
      exitAfterActiveRequests();
    }
  }
}

function exitAfterActiveRequests() {
  if (!shutdownRequested || activeRequests > 0) return;
  setImmediate(() => process.exit(0));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    respondError(null, `invalid JSON request: ${stringifyError(err)}`);
    return;
  }
  void handleRequest(request);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
