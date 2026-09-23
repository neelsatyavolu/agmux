import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  utimesSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyHandoffStore,
  loadHandoffStore,
  saveHandoffStore,
  upsertSession,
  listSessions,
  getSession,
  renderSessionsMarkdown,
  formatSessionListLine,
  currentSessionId,
  withHandoffStore,
} from "./agmux-handoff-store.mjs";

describe("agmux-handoff-store", () => {
  let dir;
  let storePath;
  let mdPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agmux-handoff-"));
    storePath = join(dir, "handoffs.json");
    mdPath = join(dir, ".agmux", "SESSIONS.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts and lists newest first", () => {
    let store = emptyHandoffStore("p1");
    upsertSession(store, {
      id: "a",
      title: "Older",
      summary: "first",
      provider: "ClaudeCode",
    });
    // force older timestamp
    store.sessions[0].updatedAt = "2020-01-01T00:00:00.000Z";
    upsertSession(store, {
      id: "b",
      title: "Newer",
      summary: "second",
      provider: "Grok",
      transcriptPath: "/tmp/b.jsonl",
    });
    saveHandoffStore(store, storePath, mdPath);
    store = loadHandoffStore(storePath, "p1");
    const list = listSessions(store, { limit: 10 });
    assert.equal(list[0].id, "b");
    assert.equal(list[1].id, "a");
    assert.ok(existsSync(mdPath));
    const md = readFileSync(mdPath, "utf8");
    assert.match(md, /Newer/);
    assert.match(md, /\/tmp\/b\.jsonl/);
  });

  it("getSession matches thread or provider ids", () => {
    const store = emptyHandoffStore("p1");
    upsertSession(store, {
      id: "thread-1",
      threadId: "thread-1",
      providerSessionId: "prov-xyz",
      title: "T",
      summary: "s",
    });
    assert.equal(getSession(store, "prov-xyz")?.id, "thread-1");
    assert.equal(getSession(store, "thread-1")?.title, "T");
  });

  it("formatSessionListLine includes path hint", () => {
    const line = formatSessionListLine({
      id: "x",
      title: "Demo",
      summary: "hello world",
      provider: "Codex",
      status: "active",
      updatedAt: "2026-01-01T00:00:00.000Z",
      transcriptPath: "/abs/path.jsonl",
    });
    assert.match(line, /Demo/);
    assert.match(line, /\/abs\/path\.jsonl/);
  });

  it("renderSessionsMarkdown notes optional read path", () => {
    const md = renderSessionsMarkdown(emptyHandoffStore("p"));
    assert.match(md, /Optional|session_list/);
  });

  it("upsertSession updates summary in place when source is agent", () => {
    const store = emptyHandoffStore("p1");
    upsertSession(store, { id: "t1", title: "A", summary: "v1", source: "agent" });
    upsertSession(store, { id: "t1", summary: "v2 final", source: "agent" });
    assert.equal(store.sessions.length, 1);
    assert.equal(getSession(store, "t1").summary, "v2 final");
    assert.equal(getSession(store, "t1").title, "A");
  });

  it("extractive upsert does not clobber agent summary", () => {
    const store = emptyHandoffStore("p1");
    upsertSession(store, {
      id: "t1",
      title: "A",
      summary: "agent text",
      source: "agent",
    });
    upsertSession(store, {
      id: "t1",
      title: "Extractive title",
      summary: "**Session:** scrap",
      source: "extractive",
    });
    assert.equal(getSession(store, "t1").summary, "agent text");
    assert.equal(getSession(store, "t1").title, "A");
    assert.equal(getSession(store, "t1").source, "agent");
  });

  it("fails closed on malformed JSON and preserves a recovery copy", async () => {
    const original = Buffer.from('{"version":1,"sessions":[');
    writeFileSync(storePath, original);
    await assert.rejects(
      upsertThroughStore({ id: "new", title: "new", summary: "new" }),
      /invalid|malformed|parse/i,
    );
    assert.deepEqual(readFileSync(storePath), original);
    const recoveries = readdirSync(dir).filter((name) => name.startsWith("handoffs.json.recovery-"));
    assert.equal(recoveries.length, 1);
    assert.deepEqual(readFileSync(join(dir, recoveries[0])), original);
  });

  it("serializes concurrent Node handoff writers", async () => {
    const modulePath = fileURLToPath(new URL("./agmux-handoff-store.mjs", import.meta.url));
    const script = `
      import { withHandoffStore, upsertSession } from ${JSON.stringify(modulePath)};
      withHandoffStore(process.env, store => upsertSession(store, {
        id: process.argv[1], title: process.argv[1], summary: process.argv[1]
      }));
    `;
    const children = Array.from({ length: 12 }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, `session-${i}`], {
          env: { ...process.env, ...handoffEnv() },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
      }),
    );
    await Promise.all(children);
    assert.equal(loadHandoffStore(storePath, "p1").sessions.length, 12);
  });

  it("waits for a reclaim guard before attempting canonical acquisition", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: "active-handoff-reclaimer",
    }));

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(existsSync(storePath), false);
    assert.equal(existsSync(guardPath), true);
  });

  it("recovers an abandoned reclaim guard", async () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    const abandonedPid = await exitedPid();
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-reclaimer",
    }));

    const outcome = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "recovered", title: "Recovered guard", summary: "written" }),
    fastLockOptions());

    assert.equal(outcome.changed, true);
    assert.equal(existsSync(guardPath), false);
    assert.equal(readdirSync(dir).some((name) => name.includes("reclaiming.quarantine-")), false);
  });

  it("recovers a reclaim guard after its recovery claimant crashes", async () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    const recoveryPath = join(guardPath, "recovery");
    const [guardPid, recoveryPid] = await Promise.all([exitedPid(), exitedPid()]);
    mkdirSync(recoveryPath, { recursive: true });
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: guardPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-reclaimer",
    }));
    writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
      pid: recoveryPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-recovery",
    }));

    const outcome = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "recovered", title: "Recovered claimant", summary: "written" }),
    fastLockOptions());

    assert.equal(outcome.changed, true);
    assert.equal(existsSync(guardPath), false);
    assert.equal(readdirSync(dir).some((name) => name.includes("quarantine-")), false);
  });

  it("preserves a live replacement recovery claim", async () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    const recoveryPath = join(guardPath, "recovery");
    const [guardPid, recoveryPid] = await Promise.all([exitedPid(), exitedPid()]);
    mkdirSync(recoveryPath, { recursive: true });
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: guardPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "observed-handoff-reclaimer",
    }));
    writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
      pid: recoveryPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "observed-handoff-recovery",
    }));
    let replaced = false;
    const isProcessAlive = () => {
      if (!replaced) {
        replaced = true;
        writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token: "replacement-handoff-recovery",
        }));
        return false;
      }
      return true;
    };

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    assert.equal(replaced, true);
    assert.equal(readLockToken(guardPath), "observed-handoff-reclaimer");
    assert.equal(readLockToken(recoveryPath), "replacement-handoff-recovery");
    assert.equal(readdirSync(guardPath).some((name) => name.includes("quarantine-")), false);
  });

  it("lets the live reclaim-guard owner withdraw during a recovery attempt", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-lock",
    }));
    let hookCalled = false;
    let ownerReleased = false;
    withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "outer", title: "Outer", summary: "after withdrawal" }),
    fastLockOptions({
      isProcessAlive: () => false,
      onReclaimGuardAcquiredForTest: ({ release }) => {
        hookCalled = true;
        withHandoffStore(handoffEnv(), (store) =>
          upsertSession(store, { id: "inner", title: "Inner", summary: "during recovery" }),
        fastLockOptions({
          staleMs: 0,
          isProcessAlive: () => {
            ownerReleased = release() || ownerReleased;
            return false;
          },
        }));
      },
    }));

    assert.equal(hookCalled, true);
    assert.equal(ownerReleased, true);
    assert.deepEqual(loadHandoffStore(storePath, "p1").sessions.map((session) => session.title).sort(), ["Inner", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("tolerates parent withdrawal after moving its recovery claim for release", async () => {
    const lockPath = `${storePath}.lock`;
    const abandonedPid = await exitedPid();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-lock",
    }));
    let hookCalled = false;
    let ownerReleased = false;
    withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "outer", title: "Outer", summary: "after withdrawal" }),
    fastLockOptions({
      isProcessAlive: () => false,
      onReclaimGuardAcquiredForTest: ({ release }) => {
        if (hookCalled) return;
        hookCalled = true;
        withHandoffStore(handoffEnv(), (store) =>
          upsertSession(store, { id: "inner", title: "Inner", summary: "during recovery release" }),
        fastLockOptions({
          staleMs: 0,
          isProcessAlive: (pid) => pid === process.pid,
          onRecoveryClaimRenamedForReleaseForTest: () => {
            ownerReleased = release() || ownerReleased;
          },
        }));
      },
    }));

    assert.equal(hookCalled, true);
    assert.equal(ownerReleased, true);
    assert.deepEqual(loadHandoffStore(storePath, "p1").sessions.map((session) => session.title).sort(), ["Inner", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("does not move or delete a live replacement reclaim guard", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "observed-handoff-reclaimer",
    }));
    let replaced = false;
    const isProcessAlive = () => {
      if (!replaced) {
        replaced = true;
        writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token: "replacement-handoff-reclaimer",
        }));
        return false;
      }
      return true;
    };

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    assert.equal(readLockToken(guardPath), "replacement-handoff-reclaimer");
    assert.equal(existsSync(join(guardPath, "recovery")), false);
    assert.equal(readdirSync(dir).some((name) => name.includes("reclaiming.quarantine-")), false);
  });

  it("does not let a contender write while a reclaimer holds the guard", async () => {
    const lockPath = `${storePath}.lock`;
    const waitingPath = join(dir, "contender-waiting");
    const abandonedPid = await exitedPid();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-handoff-lock",
    }));
    const modulePath = fileURLToPath(new URL("./agmux-handoff-store.mjs", import.meta.url));
    const script = `
      import { writeFileSync } from "node:fs";
      import { withHandoffStore, upsertSession } from ${JSON.stringify(modulePath)};
      withHandoffStore(
        process.env,
        store => upsertSession(store, { id: "B", title: "B", summary: "entered" }),
        { staleMs: 0, isProcessAlive: (pid) => {
          if (pid === Number(process.argv[2])) {
            writeFileSync(process.argv[1], "waiting");
            return true;
          }
          return false;
        } },
      );
    `;
    let contender;
    let ownerReleased = false;
    withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "outer", title: "Outer", summary: "after contender" }),
    fastLockOptions({
      onReclaimGuardAcquiredForTest: ({ release }) => {
        if (contender) return;
        contender = spawn(
          process.execPath,
          ["--input-type=module", "-e", script, waitingPath, String(process.pid)],
          { env: { ...process.env, ...handoffEnv() }, stdio: ["ignore", "pipe", "pipe"] },
        );
        waitForPathSync(waitingPath);
        assert.equal(existsSync(storePath), false);
        assert.equal(readLockToken(lockPath), "abandoned-handoff-lock");
        ownerReleased = release();
      },
    }));

    await childExit(contender);
    assert.equal(ownerReleased, true);
    assert.deepEqual(loadHandoffStore(storePath, "p1").sessions.map((session) => session.title).sort(), ["B", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("reclaims an expired lock owned by an absent process", async () => {
    const lockPath = `${storePath}.lock`;
    const abandonedPid = await exitedPid();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "abandoned-handoff-lock",
    }));

    const outcome = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "recovered", title: "Recovered", summary: "written" }),
    fastLockOptions());

    assert.equal(outcome.changed, true);
    assert.equal(loadHandoffStore(storePath, "p1").sessions[0].title, "Recovered");
    assert.equal(existsSync(lockPath), false);
  });

  it("does not reclaim an expired lock owned by the current process", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "active-handoff-lock",
    }));

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(existsSync(lockPath), true);
  });

  it("does not reclaim a malformed expired lock", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "{ambiguous");

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(existsSync(lockPath), true);
  });

  it("never deletes a replacement lock with a different owner token", () => {
    const lockPath = `${storePath}.lock`;
    const displacedPath = `${lockPath}.displaced`;
    withHandoffStore(handoffEnv(), (store) => {
      renameSync(lockPath, displacedPath);
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "replacement-handoff-lock",
      }));
      return upsertSession(store, { id: "race", title: "Race", summary: "safe release" });
    });

    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.token, "replacement-handoff-lock");
    assert.equal(existsSync(displacedPath), true);
  });

  it("restores a raced replacement token to the canonical lock and times out", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "observed-handoff-lock",
    }));
    const isProcessAlive = () => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "raced-handoff-lock",
      }));
      return false;
    };
    assert.throws(
      () => withHandoffStore(handoffEnv(), (store) =>
        upsertSession(store, { id: "raced", title: "Raced", summary: "replacement retained" }),
      fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );

    const quarantines = readdirSync(dir).filter((name) =>
      name.startsWith("handoffs.json.lock.quarantine-"));
    assert.equal(quarantines.length, 0);
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.token, "raced-handoff-lock");
    assert.equal(existsSync(storePath), false);
  });

  it("treats a regular-file lock path as ambiguous contention", () => {
    const lockPath = `${storePath}.lock`;
    writeFileSync(lockPath, "ambiguous lock path");

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "ambiguous lock path");
  });

  it("does not acquire over an empty canonical lock directory", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.deepEqual(readdirSync(lockPath), []);
  });

  it("does not acquire over an empty recovery claim directory", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: 424_252,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "dead-handoff-guard-with-empty-recovery",
    }));
    mkdirSync(join(guardPath, "recovery"));

    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
      /timed out/i,
    );
    assert.deepEqual(readdirSync(join(guardPath, "recovery")), []);
  });

  it("does not acquire beneath dangling reclaim-guard symlinks", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    for (const target of [
      "handoffs.json.lock.reclaiming.owner-424253-missing",
      "foreign-missing-handoff-guard",
    ]) {
      symlinkSync(target, guardPath);
      assert.throws(
        () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
        /timed out/i,
      );
      assert.equal(readlinkSync(guardPath), target);
      assert.equal(existsSync(storePath), false);
      unlinkSync(guardPath);
    }
  });

  it("refuses symlink chains for main, guard, and recovery owner targets", () => {
    const owner = { pid: 424_263, acquiredAt: "2000-01-01T00:00:00.000Z", token: "chain-token" };
    const assertChainedRoleBlocks = (rolePath, targetName, targetRelative, outsidePath) => {
      mkdirSync(outsidePath);
      writeFileSync(join(outsidePath, "owner.json"), JSON.stringify(owner));
      symlinkSync(targetRelative, join(dirname(rolePath), targetName));
      symlinkSync(targetName, rolePath);
      assert.throws(
        () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
        /timed out/i,
      );
      assert.equal(readlinkSync(rolePath), targetName);
      assert.equal(existsSync(join(outsidePath, "owner.json")), true);
    };

    const lockPath = `${storePath}.lock`;
    assertChainedRoleBlocks(
      lockPath,
      "handoffs.json.lock.owner-424263-chain-token",
      "outside-main-owner",
      join(dir, "outside-main-owner"),
    );
    unlinkSync(lockPath);
    unlinkSync(join(dir, "handoffs.json.lock.owner-424263-chain-token"));

    const guardPath = `${lockPath}.reclaiming`;
    assertChainedRoleBlocks(
      guardPath,
      "handoffs.json.lock.reclaiming.owner-424263-chain-token",
      "outside-guard-owner",
      join(dir, "outside-guard-owner"),
    );
    unlinkSync(guardPath);
    unlinkSync(join(dir, "handoffs.json.lock.reclaiming.owner-424263-chain-token"));

    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({ ...owner, token: "parent-token" }));
    const recoveryPath = join(guardPath, "recovery");
    assertChainedRoleBlocks(
      recoveryPath,
      "recovery.owner-424263-chain-token",
      "../outside-recovery-owner",
      join(dir, "outside-recovery-owner"),
    );
  });

  it("publishes a verified symlink lock and removes its owner target on release", () => {
    const lockPath = `${storePath}.lock`;
    let ownerTarget;
    withHandoffStore(handoffEnv(), (store) => {
      assert.equal(lstatSync(lockPath).isSymbolicLink(), true);
      const relativeTarget = readlinkSync(lockPath);
      assert.match(relativeTarget, /^handoffs\.json\.lock\.owner-\d+-[0-9a-f-]+$/);
      ownerTarget = join(dir, relativeTarget);
      assert.equal(existsSync(join(ownerTarget, "owner.json")), true);
      return upsertSession(store, { id: "symlink", title: "Symlink", summary: "published atomically" });
    });
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(ownerTarget), false);
  });

  it("cleans stale unpublished and published owner targets without following malicious symlinks", () => {
    const lockPath = `${storePath}.lock`;
    const orphan = join(dir, "handoffs.json.lock.owner-424256-dead-orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "owner.json"), JSON.stringify({
      pid: 424_256, acquiredAt: "2000-01-01T00:00:00.000Z", token: "dead-orphan",
    }));
    withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false }));
    assert.equal(existsSync(orphan), false);

    const published = join(dir, "handoffs.json.lock.owner-424257-dead-published");
    mkdirSync(published);
    writeFileSync(join(published, "owner.json"), JSON.stringify({
      pid: 424_257, acquiredAt: "2000-01-01T00:00:00.000Z", token: "dead-published",
    }));
    symlinkSync("handoffs.json.lock.owner-424257-dead-published", lockPath);
    withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false }));
    assert.equal(existsSync(published), false);

    const foreign = join(dir, "foreign-handoff-lock");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "owner.json"), JSON.stringify({
      pid: 424_258, acquiredAt: "2000-01-01T00:00:00.000Z", token: "foreign",
    }));
    symlinkSync("foreign-handoff-lock", lockPath);
    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
      /timed out/i,
    );
    assert.equal(readlinkSync(lockPath), "foreign-handoff-lock");
    assert.equal(existsSync(join(foreign, "owner.json")), true);

    unlinkSync(lockPath);
    const mismatched = join(dir, "handoffs.json.lock.owner-424259-name-token");
    mkdirSync(mismatched);
    writeFileSync(join(mismatched, "owner.json"), JSON.stringify({
      pid: 424_259, acquiredAt: "2000-01-01T00:00:00.000Z", token: "different-owner-token",
    }));
    symlinkSync(basename(mismatched), lockPath);
    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
      /timed out/i,
    );
    assert.equal(readlinkSync(lockPath), basename(mismatched));
    assert.equal(existsSync(join(mismatched, "owner.json")), true);
  });

  it("preserves both locks when a canonical lock appears before quarantine restore", async () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "observed-handoff-lock",
    }));
    const racer = canonicalLockRacer(lockPath, "canonical-handoff-lock");
    await racer.ready;
    const isProcessAlive = () => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "quarantined-handoff-lock",
        padding: "x".repeat(4_000_000),
      }));
      return false;
    };
    assert.throws(
      () => withHandoffStore(handoffEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    await racer.exited;

    const canonical = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    const quarantines = readdirSync(dir).filter((name) =>
      name.startsWith("handoffs.json.lock.quarantine-"));
    assert.equal(canonical.token, "canonical-handoff-lock");
    assert.equal(quarantines.length, 1);
    const quarantined = JSON.parse(
      readFileSync(join(dir, quarantines[0], "owner.json"), "utf8"),
    );
    assert.equal(quarantined.token, "quarantined-handoff-lock");
  });

  it("defaults legacy revision to zero and increments only changed upserts", () => {
    const legacy = emptyHandoffStore("p1");
    delete legacy.revision;
    writeFileSync(storePath, JSON.stringify(legacy));
    assert.equal(loadHandoffStore(storePath, "p1").revision, 0);

    const added = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "stable", title: "Stable", summary: "value", source: "agent" }));
    assert.equal(added.changed, true);
    assert.equal(added.revision, 1);

    const before = loadHandoffStore(storePath, "p1");
    const unchanged = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "stable", title: "Stable", summary: "value", source: "agent" }));
    const after = loadHandoffStore(storePath, "p1");
    assert.equal(unchanged.changed, false);
    assert.equal(after.revision, before.revision);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.sessions[0].updatedAt, before.sessions[0].updatedAt);
  });

  it("repairs a failed projection without replaying or incrementing the mutation", () => {
    mkdirSync(join(dir, ".agmux"));
    mkdirSync(mdPath);
    const first = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "once", title: "Once", summary: "once", source: "agent" }));
    assert.match(first.projectionWarning, /SESSIONS\.md|projection/i);
    assert.equal(first.revision, 1);

    rmSync(mdPath, { recursive: true });
    const repaired = withHandoffStore(handoffEnv(), (store) =>
      upsertSession(store, { id: "once", title: "Once", summary: "once", source: "agent" }));
    const after = loadHandoffStore(storePath, "p1");
    assert.equal(repaired.changed, false);
    assert.equal(repaired.projectionWarning, null);
    assert.equal(after.revision, 1);
    assert.equal(after.sessions.length, 1);
    assert.match(readFileSync(mdPath, "utf8"), /Once/);
  });

  it("validates version, project id, duplicate ids, and required session shapes", () => {
    const session = {
      id: "same", title: "Title", summary: "Summary", source: "agent",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const cases = [
      [{ version: 2, projectId: "p1", updatedAt: "x", sessions: [] }, /version/i],
      [{ version: 1, projectId: "other", updatedAt: "x", sessions: [] }, /project/i],
      [{ version: 1, projectId: "p1", updatedAt: "x", sessions: [session, session] }, /duplicate/i],
      [{ version: 1, projectId: "p1", updatedAt: "x", sessions: [{ ...session, summary: 1 }] }, /summary/i],
    ];
    for (const [value, error] of cases) {
      writeFileSync(storePath, JSON.stringify(value));
      assert.throws(() => loadHandoffStore(storePath, "p1"), error);
    }
  });

  it("enforces Unicode title and handoff-summary boundaries", () => {
    const store = emptyHandoffStore("p1");
    assert.doesNotThrow(() => upsertSession(store, {
      id: "ok", title: "😀".repeat(200), summary: "x".repeat(4_000),
    }));
    assert.throws(() => upsertSession(store, {
      id: "title", title: "😀".repeat(201), summary: "x",
    }), /200/);
    assert.throws(() => upsertSession(store, {
      id: "summary", title: "ok", summary: "x".repeat(4_001),
    }), /4000|4,000/);
  });

  it("rejects handoff stores larger than 8 MiB", () => {
    writeFileSync(storePath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => loadHandoffStore(storePath, "p1"), /8 MiB|too large/i);
  });

  it("applies agent > auto > extractive summary precedence", () => {
    const store = emptyHandoffStore("p1");
    upsertSession(store, { id: "t", title: "T", summary: "extractive", source: "extractive" });
    upsertSession(store, { id: "t", title: "T", summary: "auto", source: "auto" });
    upsertSession(store, { id: "t", title: "T", summary: "extractive again", source: "extractive" });
    assert.equal(getSession(store, "t").summary, "auto");
    assert.equal(getSession(store, "t").source, "auto");
  });

  it("guards active-thread fallback and requires a fresh opt-in file", () => {
    const active = join(dir, "active-thread-id");
    writeFileSync(active, "thread-from-file\n");
    assert.equal(currentSessionId({ AGMUX_ACTIVE_THREAD_FILE: active }), "");
    assert.equal(currentSessionId({
      AGMUX_ACTIVE_THREAD_FILE: active,
      AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK: "1",
    }), "thread-from-file");
    const stale = new Date(Date.now() - 31_000);
    utimesSync(active, stale, stale);
    assert.equal(currentSessionId({
      AGMUX_ACTIVE_THREAD_FILE: active,
      AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK: "1",
    }), "");
    assert.equal(currentSessionId({
      AGMUX_ACTIVE_THREAD_FILE: active,
      AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK: "1",
      AGMUX_ACTIVE_THREAD_MAX_AGE_MS: "7200000",
    }), "thread-from-file");
  });

  it("sanitizes control sequences and derives a useful generic title", () => {
    const store = emptyHandoffStore("p1");
    upsertSession(store, {
      id: "ansi",
      title: "New Grok Thread",
      summary: "\u001b[31mFix the spinner after Stop and verify the completion notification.\u001b[0m",
      source: "agent",
    });
    const session = getSession(store, "ansi");
    assert.doesNotMatch(session.summary, /\u001b|\[31m/);
    assert.notEqual(session.title, "New Grok Thread");
    assert.match(session.title, /Fix the spinner/i);
  });

  it("retains source history beyond the 40-session projection", () => {
    const store = emptyHandoffStore("p1");
    for (let i = 0; i < 45; i++) {
      upsertSession(store, { id: `s${i}`, title: `Session ${i}`, summary: `Summary ${i}` });
    }
    saveHandoffStore(store, storePath, mdPath);
    assert.equal(loadHandoffStore(storePath, "p1").sessions.length, 45);
    assert.equal((readFileSync(mdPath, "utf8").match(/^## /gm) || []).length, 40);
  });

  function handoffEnv() {
    return {
      AGMUX_HANDOFF_STORE: storePath,
      AGMUX_SESSIONS_MD: mdPath,
      AGMUX_PROJECT_ID: "p1",
    };
  }

  function fastLockOptions(overrides = {}) {
    return { retryMs: 60, staleMs: 30, ...overrides };
  }

  function childExit(child) {
    return new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
    });
  }

  function exitedPid() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", ""]);
      const pid = child.pid;
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(pid) : reject(new Error(`exit ${code}`)));
    });
  }

  function readLockToken(lockPath) {
    return JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token;
  }

  function waitForPathSync(path) {
    const deadline = Date.now() + 2_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }

  async function upsertThroughStore(input) {
    const { withHandoffStore } = await import("./agmux-handoff-store.mjs");
    return withHandoffStore(handoffEnv(), (store) => upsertSession(store, input));
  }

  function canonicalLockRacer(lockPath, token) {
    const script = `
      import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
      const lockPath = process.argv[1];
      const token = process.argv[2];
      const stagedPath = lockPath + ".racer-" + process.pid;
      mkdirSync(stagedPath);
      writeFileSync(stagedPath + "/owner.json", JSON.stringify({
        pid: process.pid, acquiredAt: new Date().toISOString(), token
      }));
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 2_000;
      while (existsSync(lockPath) && Date.now() < deadline) {}
      if (existsSync(lockPath)) throw new Error("canonical lock never became available");
      renameSync(stagedPath, lockPath);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, lockPath, token], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", resolve);
    });
    const exited = new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
    });
    return { ready, exited };
  }
});
