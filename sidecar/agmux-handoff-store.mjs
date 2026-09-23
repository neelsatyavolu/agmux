/**
 * Project session handoffs — short rolling summaries + transcript paths.
 * Source of truth: $AGMUX_HANDOFF_STORE (default ./handoffs.json)
 * Markdown projection: $AGMUX_SESSIONS_MD (default ./.agmux/SESSIONS.md)
 *
 * Handoffs are optional context for agents (not required like project memory).
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const MAX_SESSIONS = 40;
export const MAX_STORE_BYTES = 8 * 1024 * 1024;
export const LOCK_RETRY_MS = 5_000;
export const LOCK_STALE_MS = 30_000;
const TITLE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 4_000;
const SUMMARY_PRECEDENCE = { extractive: 1, auto: 2, agent: 3 };
const LOCK_CONTENTION_CODES = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"]);
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

export function nowIso() {
  return new Date().toISOString();
}

export function emptyHandoffStore(projectId = "") {
  return {
    version: 1,
    revision: 0,
    projectId:
      projectId || process.env.AGMUX_PROJECT_ID || process.env.AGMUX_THREAD_ID || "",
    updatedAt: nowIso(),
    sessions: [],
  };
}

export function resolveHandoffPaths(env = process.env) {
  const storePath =
    env.AGMUX_HANDOFF_STORE || join(process.cwd(), "handoffs.json");
  const mdPath =
    env.AGMUX_SESSIONS_MD || join(process.cwd(), ".agmux", "SESSIONS.md");
  const projectId = env.AGMUX_PROJECT_ID || env.AGMUX_THREAD_ID || "";
  return { storePath, mdPath, projectId };
}

export function loadHandoffStore(storePath, projectId = "") {
  if (!existsSync(storePath)) {
    return emptyHandoffStore(projectId);
  }
  try {
    const bytes = readFileSync(storePath);
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new Error("handoff store is too large (maximum 8 MiB)");
    }
    const raw = bytes.toString("utf8");
    const parsed = JSON.parse(raw);
    return validateHandoffStore(parsed, projectId);
  } catch (error) {
    writeRecoveryCopy(storePath);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid handoff store ${storePath}: ${detail}`);
  }
}

function atomicWrite(path, content) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function charCount(value) {
  return [...value].length;
}

function requireString(value, field, { empty = false, max = null } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (max != null && charCount(value) > max) {
    throw new Error(`${field} exceeds ${max} Unicode characters`);
  }
}

function validateSession(session, index) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error(`sessions[${index}] must be an object`);
  }
  requireString(session.id, `sessions[${index}].id`);
  requireString(session.title, `sessions[${index}].title`, { max: TITLE_MAX_CHARS });
  requireString(session.summary, `sessions[${index}].summary`, { empty: true, max: SUMMARY_MAX_CHARS });
  requireString(session.source ?? "", `sessions[${index}].source`, { empty: true });
  requireString(session.createdAt, `sessions[${index}].createdAt`);
  requireString(session.updatedAt, `sessions[${index}].updatedAt`);
  return { ...session, source: session.source ?? "" };
}

function validateHandoffStore(parsed, projectId = "") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("store must be an object");
  if (parsed.version !== 1) throw new Error(`unsupported handoff store version: ${parsed.version}`);
  const revision = parsed.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("revision must be a non-negative integer");
  }
  const storedProjectId = parsed.projectId || "";
  if (typeof storedProjectId !== "string") throw new Error("projectId must be a string");
  if (projectId && storedProjectId && storedProjectId !== projectId) {
    throw new Error(`handoff store projectId mismatch: expected ${projectId}, found ${storedProjectId}`);
  }
  requireString(parsed.updatedAt, "updatedAt");
  if (!Array.isArray(parsed.sessions)) throw new Error("sessions must be an array");
  const ids = new Set();
  const sessions = parsed.sessions.map((session, index) => {
    const valid = validateSession(session, index);
    if (ids.has(valid.id)) throw new Error(`duplicate handoff session id: ${valid.id}`);
    ids.add(valid.id);
    return valid;
  });
  return { ...parsed, version: 1, revision, projectId: storedProjectId || projectId, sessions };
}

function writeRecoveryCopy(storePath) {
  if (!existsSync(storePath)) return null;
  const recoveryPath = `${storePath}.recovery-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  try {
    copyFileSync(storePath, recoveryPath);
    return recoveryPath;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  // PID reuse is indistinguishable here, so a reused live PID deliberately fails closed.
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function lockOptions(options = {}) {
  return {
    retryMs: options.retryMs ?? LOCK_RETRY_MS,
    staleMs: options.staleMs ?? LOCK_STALE_MS,
    leaseMs: options.leaseMs ?? LOCK_STALE_MS,
    isProcessAlive: options.isProcessAlive ?? processIsAlive,
    onReclaimGuardAcquiredForTest: options.onReclaimGuardAcquiredForTest,
    onRecoveryClaimRenamedForReleaseForTest:
      options.onRecoveryClaimRenamedForReleaseForTest,
  };
}

function safeOwnedTarget(path, rolePath = path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    const target = readlinkSync(path);
    if (target !== basename(target) || !target.startsWith(`${basename(rolePath)}.owner-`)) return null;
    const targetPath = join(dirname(path), target);
    if (!lstatSync(targetPath).isDirectory()) return null;
    return targetPath;
  } catch { return null; }
}

function pathPresent(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function readLockOwner(path, rolePath = path) {
  try {
    const isSymlink = lstatSync(path).isSymbolicLink();
    const targetPath = isSymlink ? safeOwnedTarget(path, rolePath) : null;
    if (isSymlink && !targetPath) return null;
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (targetPath && (typeof owner?.token !== "string" || !basename(targetPath).endsWith(`-${owner.token}`))) return null;
    return owner;
  } catch { return null; }
}

function publishOwnedPath(path, token, onRenamedForReleaseForTest) {
  const targetName = `${basename(path)}.owner-${process.pid}-${token}`;
  const targetPath = join(dirname(path), targetName);
  mkdirSync(targetPath);
  try {
    writeFileSync(join(targetPath, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: nowIso(), token }));
    if (readLockOwner(targetPath)?.token !== token) {
      const error = new Error("lock owner target changed during initialization"); error.code = "EEXIST"; throw error;
    }
    symlinkSync(targetName, path, "dir");
    const lock = { lockPath: path, token, onRenamedForReleaseForTest };
    if (!lockIsOwned(lock)) {
      const error = new Error("lock ownership changed during publication"); error.code = "EEXIST"; throw error;
    }
    return lock;
  } catch (error) {
    if (!existsSync(path) && readLockOwner(targetPath)?.token === token) rmSync(targetPath, { recursive: true, force: true });
    throw error;
  }
}

function acquireStoreLock(storePath, inputOptions = {}) {
  const options = lockOptions(inputOptions);
  const lockPath = `${storePath}.lock`;
  const guardPath = `${lockPath}.reclaiming`;
  const deadline = Date.now() + options.retryMs;
  let replacementRace = false;
  while (true) {
    if (!replacementRace) {
      if (pathPresent(guardPath)) {
        reclaimAbandonedGuard(guardPath, options);
      } else {
        try {
          const lock = publishOwnedPath(lockPath, randomUUID());
          if (!pathPresent(guardPath)) {
            cleanupAbandonedOwnerTargets(lockPath, options);
            return lock;
          }
          releaseStoreLock(lock);
        } catch (error) {
          if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error;
          const guard = acquireReclaimGuard(lockPath, options);
          if (guard) {
            try {
              options.onReclaimGuardAcquiredForTest?.({
                release: () => releaseStoreLock(guard),
              });
              if (lockIsOwned(guard)) {
                if (reclaimAbandonedLock(lockPath, options) === "replacement") {
                  replacementRace = true;
                }
                cleanupAbandonedQuarantines(lockPath, options);
              }
            } finally {
              releaseStoreLock(guard);
            }
          }
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${options.retryMs}ms waiting for handoff store lock: ${lockPath}; ` +
          "if its owner crashed, remove the lock only after confirming no agent is active",
      );
    }
    Atomics.wait(sleepArray, 0, 0, 10);
  }
}

function acquireReclaimGuard(lockPath, options) {
  const guardPath = `${lockPath}.reclaiming`;
  try {
    const guard = publishOwnedPath(guardPath, randomUUID());
    cleanupAbandonedOwnerTargets(guardPath, options);
    return guard;
  } catch (error) {
    if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error;
    reclaimAbandonedGuard(guardPath, options);
    return null;
  }
}

function ownerIsExpiredAndDead(owner, options) {
  return ownerIsExpired(owner, options) && !options.isProcessAlive(owner.pid);
}

function ownerIsExpired(owner, options) {
  if (
    !owner ||
    typeof owner.token !== "string" ||
    !owner.token ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.acquiredAt !== "string"
  ) {
    return false;
  }
  const acquiredAt = Date.parse(owner.acquiredAt);
  return Number.isFinite(acquiredAt) && Date.now() - acquiredAt >= options.staleMs;
}

function reclaimAbandonedGuard(guardPath, options) {
  const owner = readLockOwner(guardPath);
  if (!ownerIsExpired(owner, options)) return false;
  const recovery = acquireRecoveryClaim(guardPath, owner.token, options);
  if (!recovery) return false;
  const claimedOwner = readLockOwner(guardPath);
  if (claimedOwner?.token !== owner.token || !ownerIsExpiredAndDead(claimedOwner, options)) {
    releaseStoreLock(recovery);
    return false;
  }
  if (readLockOwner(guardPath)?.token !== owner.token || !lockIsOwned(recovery)) {
    releaseStoreLock(recovery);
    return false;
  }
  const quarantinePath = `${guardPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(guardPath, quarantinePath);
  } catch {
    releaseStoreLock(recovery);
    return false;
  }
  const quarantinedOwner = readLockOwner(quarantinePath, guardPath);
  const quarantinedRecovery = readLockOwner(join(quarantinePath, "recovery"));
  if (
    quarantinedOwner?.token !== owner.token ||
    quarantinedRecovery?.token !== recovery.token
  ) {
    restoreQuarantinedLock(quarantinePath, guardPath);
    return false;
  }
  removeMovedOwnedPath(quarantinePath, guardPath, owner.token);
  return true;
}

function acquireRecoveryClaim(guardPath, parentToken, options) {
  if (readLockOwner(guardPath)?.token !== parentToken) return null;
  const recoveryPath = join(guardPath, "recovery");
  const token = randomUUID();
  try {
    const recovery = publishOwnedPath(recoveryPath, token, options.onRecoveryClaimRenamedForReleaseForTest);
    cleanupAbandonedOwnerTargets(recoveryPath, options);
    if (readLockOwner(guardPath)?.token === parentToken && lockIsOwned(recovery)) return recovery;
    releaseStoreLock(recovery);
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error;
    reclaimAbandonedRecoveryClaim(guardPath, parentToken, options);
    return null;
  }
  return null;
}

function reclaimAbandonedRecoveryClaim(guardPath, parentToken, options) {
  const recoveryPath = join(guardPath, "recovery");
  const owner = readLockOwner(recoveryPath);
  if (
    readLockOwner(guardPath)?.token !== parentToken ||
    !ownerIsExpiredAndDead(owner, options) ||
    readLockOwner(guardPath)?.token !== parentToken ||
    readLockOwner(recoveryPath)?.token !== owner.token
  ) {
    return false;
  }
  const quarantinePath = join(
    guardPath,
    `recovery.quarantine-${process.pid}-${randomUUID()}`,
  );
  try {
    renameSync(recoveryPath, quarantinePath);
  } catch {
    return false;
  }
  const quarantinedOwner = readLockOwner(quarantinePath, recoveryPath);
  if (
    readLockOwner(guardPath)?.token !== parentToken ||
    quarantinedOwner?.token !== owner.token
  ) {
    restoreQuarantinedLock(quarantinePath, recoveryPath);
    return false;
  }
  removeMovedOwnedPath(quarantinePath, recoveryPath, owner.token);
  return true;
}

function reclaimAbandonedLock(lockPath, options) {
  const owner = readLockOwner(lockPath);
  if (!ownerIsExpiredAndDead(owner, options)) return false;

  const quarantinePath = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }
  let quarantinedOwner;
  try {
    quarantinedOwner = readLockOwner(quarantinePath, lockPath);
  } catch {
    restoreQuarantinedLock(quarantinePath, lockPath);
    return "replacement";
  }
  if (quarantinedOwner?.token !== owner.token) {
    restoreQuarantinedLock(quarantinePath, lockPath);
    return "replacement";
  }
  removeMovedOwnedPath(quarantinePath, lockPath, owner.token);
  return true;
}

function cleanupAbandonedQuarantines(lockPath, options) {
  const prefix = `${basename(lockPath)}.quarantine-`;
  let candidates;
  try {
    candidates = readdirSync(dirname(lockPath), { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith(prefix));
  } catch {
    return;
  }
  for (const entry of candidates) {
    const path = join(dirname(lockPath), entry.name);
    const owner = readLockOwner(path, lockPath);
    if (!ownerIsExpiredAndDead(owner, options)) continue;
    const cleanupPath = `${path}.cleanup-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, cleanupPath);
    } catch {
      continue;
    }
    const cleanupOwner = readLockOwner(cleanupPath, lockPath);
    if (cleanupOwner?.token !== owner.token) {
      restoreQuarantinedLock(cleanupPath, path);
      continue;
    }
    removeMovedOwnedPath(cleanupPath, lockPath, owner.token);
  }
  cleanupAbandonedOwnerTargets(lockPath, options);
}

function restoreQuarantinedLock(quarantinePath, lockPath) {
  const owner = readLockOwner(quarantinePath, lockPath);
  if (!owner?.token || existsSync(lockPath)) return;
  try {
    const symlinkTarget = safeOwnedTarget(quarantinePath, lockPath);
    if (symlinkTarget) {
      symlinkSync(basename(symlinkTarget), lockPath, "dir");
      if (readLockOwner(lockPath)?.token === owner.token) unlinkSync(quarantinePath);
      return;
    }
    const targetName = `${basename(lockPath)}.owner-${process.pid}-${owner.token}`;
    const targetPath = join(dirname(lockPath), targetName);
    renameSync(quarantinePath, targetPath);
    try { symlinkSync(targetName, lockPath, "dir"); }
    catch (error) { try { renameSync(targetPath, quarantinePath); } catch {} throw error; }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (!LOCK_CONTENTION_CODES.has(error?.code)) throw error;
  }
}

function removeMovedOwnedPath(movedPath, rolePath, expectedToken) {
  const owner = readLockOwner(movedPath, rolePath);
  if (owner?.token !== expectedToken) return false;
  const targetPath = safeOwnedTarget(movedPath, rolePath);
  if (!targetPath) { rmSync(movedPath, { recursive: true, force: true }); return true; }
  unlinkSync(movedPath);
  if (readLockOwner(targetPath)?.token === expectedToken) rmSync(targetPath, { recursive: true, force: true });
  return true;
}

function cleanupAbandonedOwnerTargets(rolePath, options) {
  const prefix = `${basename(rolePath)}.owner-`;
  let entries;
  try { entries = readdirSync(dirname(rolePath), { withFileTypes: true }); } catch { return; }
  const referenced = new Set();
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try { referenced.add(readlinkSync(join(dirname(rolePath), entry.name))); } catch {}
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || referenced.has(entry.name)) continue;
    const path = join(dirname(rolePath), entry.name);
    const owner = readLockOwner(path);
    if (!ownerIsExpiredAndDead(owner, options) || !entry.name.endsWith(`-${owner.token}`)) continue;
    const cleanup = `${path}.cleanup-${process.pid}-${randomUUID()}`;
    try { renameSync(path, cleanup); } catch { continue; }
    if (readLockOwner(cleanup)?.token === owner.token) rmSync(cleanup, { recursive: true, force: true });
    else restoreQuarantinedLock(cleanup, path);
  }
}

function lockIsOwned(lock) {
  return readLockOwner(lock.lockPath)?.token === lock.token;
}

function releaseStoreLock(lock) {
  if (!lockIsOwned(lock)) return false;
  const releasePath = `${lock.lockPath}.release-${process.pid}-${lock.token}`;
  try {
    renameSync(lock.lockPath, releasePath);
  } catch {
    return false;
  }
  lock.onRenamedForReleaseForTest?.();
  const releasedOwner = readLockOwner(releasePath, lock.lockPath);
  if (!releasedOwner && !existsSync(releasePath)) return false;
  if (releasedOwner?.token !== lock.token) {
    restoreQuarantinedLock(releasePath, lock.lockPath);
    return false;
  }
  return removeMovedOwnedPath(releasePath, lock.lockPath, lock.token);
}

export function renderSessionsMarkdown(store) {
  const sessions = listSessions(store, { limit: MAX_SESSIONS });
  const lines = [];
  lines.push("# agmux Session Handoffs");
  lines.push("");
  lines.push(
    "> Optional prior-session context for agents. Use only when you need history — not every turn.",
  );
  lines.push(
    "> Prefer MCP tools `session_list` / `session_get` on server `agmux-memory`. This file is the projection.",
  );
  lines.push("> Each entry has a short summary and a transcript path you can Read for detail.");
  lines.push("");
  if (store.projectId) {
    lines.push(`- **Project**: \`${store.projectId}\``);
  }
  lines.push(`- **Revision**: ${store.revision ?? 0}`);
  lines.push(`- **Updated**: ${store.updatedAt || nowIso()}`);
  lines.push(`- **Sessions**: ${sessions.length}`);
  lines.push("");

  if (sessions.length === 0) {
    lines.push("_No session handoffs yet. They appear when agents finish turns in this project._");
    lines.push("");
    return lines.join("\n");
  }

  for (const s of sessions) {
    lines.push(`## ${s.title || "(untitled)"}`);
    lines.push("");
    lines.push(`- **id**: \`${s.id}\``);
    if (s.provider) lines.push(`- **provider**: ${s.provider}`);
    if (s.status) lines.push(`- **status**: ${s.status}`);
    if (s.updatedAt) lines.push(`- **updated**: ${s.updatedAt}`);
    if (s.transcriptPath) {
      lines.push(`- **transcript**: \`${s.transcriptPath}\``);
    } else {
      lines.push("- **transcript**: _(none resolved)_");
    }
    lines.push("");
    lines.push(String(s.summary || "").trim() || "_(no summary)_");
    lines.push("");
  }

  return lines.join("\n");
}

export function saveHandoffStoreWithWarning(store, storePath, mdPath) {
  store.sessions = store.sessions
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const validated = validateHandoffStore(store, store.projectId || "");
  const json = JSON.stringify(validated, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_STORE_BYTES) {
    throw new Error("handoff store is too large (maximum 8 MiB)");
  }
  atomicWrite(storePath, json);
  let projectionWarning = null;
  if (mdPath) {
    try {
      atomicWrite(mdPath, renderSessionsMarkdown(store));
    } catch (error) {
      projectionWarning = `handoff JSON committed, but SESSIONS.md projection failed: ${error.message || error}`;
    }
  }
  return { store, projectionWarning };
}

export function saveHandoffStore(store, storePath, mdPath) {
  const candidate = {
    ...store,
    revision: (store.revision ?? 0) + 1,
    updatedAt: nowIso(),
  };
  const outcome = saveHandoffStoreWithWarning(candidate, storePath, mdPath);
  if (outcome.projectionWarning) console.warn(outcome.projectionWarning);
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, candidate);
  return store;
}

/** Newest updated first. */
export function listSessions(store, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 20, MAX_SESSIONS));
  return store.sessions
    .slice()
    .sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(
        String(a.updatedAt || a.createdAt || ""),
      ),
    )
    .slice(0, n);
}

export function getSession(store, id) {
  if (!id) return null;
  return (
    store.sessions.find((s) => s.id === id) ||
    store.sessions.find((s) => s.threadId === id) ||
    store.sessions.find((s) => s.providerSessionId === id) ||
    null
  );
}

export function sanitizeHandoffText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function genericTitle(title) {
  return /^(session|untitled session|new .+ thread)$/i.test(String(title || "").trim());
}

function deriveTitle(summary) {
  const words = sanitizeHandoffText(summary).split(/\s+/).filter(Boolean).slice(0, 8);
  const title = words.join(" ").replace(/[.,;:!?]+$/, "");
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

export function upsertSession(store, input) {
  const id = String(input.id || "").trim();
  if (!id) throw new Error("id is required");
  let title = input.title == null ? "" : sanitizeHandoffText(input.title);
  const summary = input.summary == null ? "" : sanitizeHandoffText(input.summary);
  if (genericTitle(title)) title = deriveTitle(summary) || title;
  if (title && charCount(title) > TITLE_MAX_CHARS) throw new Error("title exceeds 200 Unicode characters");
  if (summary && charCount(summary) > SUMMARY_MAX_CHARS) throw new Error("summary exceeds 4000 Unicode characters");
  const ts = nowIso();
  const existing = getSession(store, id);
  const incomingSource = String(input.source || "").trim();
  if (existing) {
    const before = JSON.stringify(existing);
    const mayReplaceSummary = (SUMMARY_PRECEDENCE[incomingSource] || 0) >=
      (SUMMARY_PRECEDENCE[existing.source] || 0);
    if (mayReplaceSummary && title) {
      existing.title = title;
    }
    if (summary) {
      // Agent always wins; auto/extractive never clobber agent.
      if (mayReplaceSummary) {
        existing.summary = summary;
        if (incomingSource) existing.source = incomingSource;
      }
    } else if (mayReplaceSummary && incomingSource) {
      existing.source = incomingSource;
    }
    if (input.transcriptPath != null) {
      existing.transcriptPath = String(input.transcriptPath || "").trim();
    }
    if (input.provider != null) existing.provider = String(input.provider);
    if (input.status != null) existing.status = String(input.status);
    if (input.cwd != null) existing.cwd = String(input.cwd || "");
    if (input.threadId != null) existing.threadId = String(input.threadId || "");
    if (input.providerSessionId != null) {
      existing.providerSessionId = String(input.providerSessionId || "");
    }
    if (JSON.stringify(existing) !== before) existing.updatedAt = ts;
    return existing;
  }

  const entry = {
    id,
    threadId: String(input.threadId || id),
    providerSessionId: String(input.providerSessionId || ""),
    provider: String(input.provider || "unknown"),
    title: title || deriveTitle(summary) || "Untitled session",
    summary,
    transcriptPath: String(input.transcriptPath || "").trim(),
    status: String(input.status || "active"),
    cwd: String(input.cwd || ""),
    source: incomingSource || "agent",
    createdAt: ts,
    updatedAt: ts,
  };
  store.sessions.push(entry);
  return entry;
}

export function formatSessionListLine(s) {
  const preview = String(s.summary || "")
    .replace(/\s+/g, " ")
    .slice(0, 140);
  const pathHint = s.transcriptPath
    ? `transcript: ${s.transcriptPath}`
    : "transcript: (none)";
  return `- **${s.title || "(untitled)"}** (\`${s.id}\`) · ${s.provider || "?"} · ${s.status || "?"} · updated ${s.updatedAt || "?"}\n  ${preview || "(no summary)"}\n  ${pathHint}`;
}

/** Current session id for agent upserts (spawn injects AGMUX_THREAD_ID). */
export function currentSessionId(env = process.env) {
  const direct = String(
    env.AGMUX_THREAD_ID || env.XANOM_SESSION_ID || env.AGMUX_SESSION_ID || "",
  ).trim();
  if (direct) return direct;
  // Multi-thread servers (Codex app-server): last active thread written by Rust.
  const allowFallback = /^(1|true|yes|on)$/i.test(
    String(env.AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK || "").trim(),
  );
  const file = String(env.AGMUX_ACTIVE_THREAD_FILE || "").trim();
  if (file && allowFallback) {
    try {
      const maxAge = Number(env.AGMUX_ACTIVE_THREAD_MAX_AGE_MS);
      const ageMs = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 30_000;
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs <= ageMs) {
        return String(readFileSync(file, "utf8") || "").trim().split("\n")[0] || "";
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** Load → mutate → save handoff store (agent session_upsert). */
export function withHandoffStore(env, mutator, inputLockOptions = {}) {
  const { storePath, mdPath, projectId } = resolveHandoffPaths(env);
  const options = lockOptions(inputLockOptions);
  const lock = acquireStoreLock(storePath, options);
  const startedAt = Date.now();
  try {
    const store = loadHandoffStore(storePath, projectId);
    const before = JSON.stringify(store);
    const result = mutator(store);
    if (Date.now() - startedAt >= options.leaseMs) {
      throw new Error("handoff mutation exceeded the 30s lock lease");
    }
    const changed = JSON.stringify(store) !== before;
    let projectionWarning;
    if (changed) {
      store.revision = (store.revision ?? 0) + 1;
      store.updatedAt = nowIso();
      ({ projectionWarning } = saveHandoffStoreWithWarning(store, storePath, mdPath));
    } else {
      try {
        atomicWrite(mdPath, renderSessionsMarkdown(store));
        projectionWarning = null;
      } catch (error) {
        projectionWarning = `SESSIONS.md projection repair failed: ${error.message || error}`;
      }
    }
    return {
      store,
      result,
      changed,
      revision: store.revision,
      storePath,
      mdPath,
      projectionWarning,
    };
  } finally {
    releaseStoreLock(lock);
  }
}
