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
  emptyStore,
  loadStore,
  saveStore,
  saveStoreWithWarning,
  addEntry,
  updateEntry,
  archiveEntry,
  restoreEntry,
  resolveEntry,
  reopenEntry,
  supersedeEntry,
  listEntries,
  getEntry,
  renderMemoryMarkdown,
  renderMemorySnapshot,
  memoryHealth,
  confirmBinding,
  revokeBinding,
  withStore,
  formatEntryListLine,
  MAX_ACTIVE_ENTRIES,
} from "./agmux-memory-store.mjs";

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/memory-contract.json", import.meta.url)), "utf8"),
);

describe("agmux-memory-store", () => {
  let dir;
  let storePath;
  let mdPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agmux-mem-"));
    storePath = join(dir, "memory.json");
    mdPath = join(dir, ".agmux", "MEMORY.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty and renders placeholder", () => {
    const store = emptyStore("project-abc");
    const md = renderMemoryMarkdown(store);
    assert.match(md, /agmux Project Memory/);
    assert.match(md, /No memory entries/);
    assert.match(md, /project-abc/);
  });

  it("add → save → load roundtrip and projects markdown", () => {
    let store = emptyStore("p1");
    const e = addEntry(store, {
      title: "Use SQLite",
      content: "memory.json is source of truth",
      kind: "decision",
      source: "user",
    });
    saveStore(store, storePath, mdPath);

    assert.ok(existsSync(storePath));
    assert.ok(existsSync(mdPath));

    store = loadStore(storePath, "p1");
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].id, e.id);
    assert.equal(store.entries[0].kind, "decision");

    const md = readFileSync(mdPath, "utf8");
    assert.match(md, /Use SQLite/);
    assert.match(md, /## Decisions/);
    assert.match(md, /memory\.json is source of truth/);
    assert.match(md, /\*\*created\*\*:/);
    assert.match(md, /\*\*updated\*\*:/);
  });

  it("persists, projects, and returns the same normalized compatible store", () => {
    const legacy = structuredClone(contract.legacyStore);
    const outcome = saveStoreWithWarning(legacy, storePath, mdPath);
    assert.equal(outcome.store, legacy);
    assert.equal(legacy.revision, 0);
    assert.equal(legacy.entries[0].authority, "user");
    assert.equal(legacy.entries[0].binding, true);
    assert.deepEqual(loadStore(storePath, "p1"), legacy);
    const md = readFileSync(mdPath, "utf8");
    assert.match(md, /\*\*Revision\*\*: 0/);
    assert.match(md, /\*\*authority\*\*: user/);
    assert.match(md, /\*\*binding\*\*: true/);
  });

  it("does not mutate caller revision or timestamp when save validation or persistence fails", () => {
    const invalid = emptyStore("p1");
    invalid.entries.push({ kind: "invalid" });
    const invalidBefore = structuredClone(invalid);
    assert.throws(() => saveStore(invalid, storePath, mdPath));
    assert.deepEqual(invalid, invalidBefore);

    const unwritable = emptyStore("p1");
    addEntry(unwritable, { title: "Valid", content: "value" });
    const unwritableBefore = structuredClone(unwritable);
    mkdirSync(storePath);
    assert.throws(() => saveStore(unwritable, storePath, mdPath));
    assert.deepEqual(unwritable, unwritableBefore);
  });

  it("list lines include created/updated timestamps", () => {
    const store = emptyStore("t");
    const e = addEntry(store, {
      title: "When",
      content: "has a time",
      kind: "fact",
    });
    const line = formatEntryListLine(e);
    assert.match(line, /created /);
    assert.match(line, /T\d{2}:\d{2}:\d{2}/); // ISO time fragment
    assert.match(line, /\[fact\] When/);
    const listed = listEntries(store);
    assert.equal(listed[0].id, e.id);
    assert.ok(listed[0].createdAt);
  });

  it("update and archive", () => {
    const store = emptyStore("t1");
    const e = addEntry(store, { title: "A", content: "one", kind: "note" });
    updateEntry(store, e.id, { title: "B", content: "two" });
    assert.equal(getEntry(store, e.id).title, "B");
    archiveEntry(store, e.id);
    assert.equal(listEntries(store).length, 0);
    assert.equal(listEntries(store, { includeArchived: true }).length, 1);
  });

  it("rejects unsupported mutation kinds", () => {
    const store = emptyStore("t1");
    assert.throws(() => addEntry(store, { title: "x", content: "y", kind: "WAT" }), /kind/i);
    const e = addEntry(store, { title: "valid", content: "value", kind: "note" });
    assert.throws(() => updateEntry(store, e.id, { kind: "WAT" }), /kind/i);
    for (const invalid of ["", null, false, 0]) {
      assert.throws(
        () => addEntry(store, { title: `invalid ${String(invalid)}`, content: "value", kind: invalid }),
        /kind/i,
      );
      assert.throws(() => updateEntry(store, e.id, { kind: invalid }), /kind/i);
    }
    assert.equal(addEntry(store, { title: "omitted", content: "value" }).kind, "note");
  });

  it("withStore mutates and persists via env paths", () => {
    const env = {
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_PROJECT_ID: "env-project",
    };
    const { result } = withStore(env, (store) =>
      addEntry(store, { title: "From MCP", content: "hello", kind: "fact", source: "agent" }),
    );
    assert.ok(result.id);
    const reloaded = loadStore(storePath, "env-project");
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0].title, "From MCP");
    assert.match(readFileSync(mdPath, "utf8"), /## Facts/);
  });

  it("rejects empty title/content", () => {
    const store = emptyStore("t");
    assert.throws(() => addEntry(store, { title: " ", content: "x" }), /title/);
    assert.throws(() => addEntry(store, { title: "x", content: " " }), /content/);
  });

  it("pins sort before notes in markdown", () => {
    const store = emptyStore("t");
    addEntry(store, { title: "Note", content: "n", kind: "note" });
    addEntry(store, { title: "Pin", content: "p", kind: "pin" });
    const md = renderMemoryMarkdown(store);
    assert.ok(md.indexOf("## Pins") < md.indexOf("## Notes"));
  });

  it("uses UTF-8 bytewise entry ids as a deterministic tie-breaker", () => {
    const store = emptyStore("t");
    const entries = [
      ["Upper", "A-entry"],
      ["Lower", "a-entry"],
      ["Zulu", "z-entry"],
      ["Accent", "é-entry"],
    ].map(([title, id]) => {
      const entry = addEntry(store, { title, content: title, kind: "fact" });
      entry.id = id;
      return entry;
    });
    for (const entry of store.entries) {
      entry.createdAt = "2026-01-01T00:00:00.000Z";
      entry.updatedAt = "2026-01-01T00:00:00.000Z";
    }

    const first = renderMemorySnapshot(store);
    store.entries.reverse();
    const second = renderMemorySnapshot(store);
    assert.equal(first, second);
    assert.deepEqual(
      [...entries].sort((a, b) => first.indexOf(a.id) - first.indexOf(b.id)).map((entry) => entry.id),
      ["A-entry", "a-entry", "z-entry", "é-entry"],
    );
  });

  it("important flag sorts first and appears in list/markdown", () => {
    const store = emptyStore("t");
    addEntry(store, { title: "Normal", content: "n", kind: "fact" });
    const imp = addEntry(store, {
      title: "Do not skip auth",
      content: "always check tokens",
      kind: "decision",
      important: true,
    });
    assert.equal(imp.important, true);
    const listed = listEntries(store);
    assert.equal(listed[0].id, imp.id);
    assert.match(formatEntryListLine(listed[0]), /IMPORTANT/);
    const md = renderMemoryMarkdown(store);
    assert.match(md, /## Important/);
    assert.match(md, /### "Do not skip auth"/);
    assert.match(md, /attention only/);
    assert.equal(md.match(/### "Do not skip auth"/g)?.length, 1);
    updateEntry(store, imp.id, { important: false });
    assert.equal(getEntry(store, imp.id).important, false);
  });

  it("JSON-encodes projection fields that contain Markdown structure", () => {
    const store = emptyStore("t");
    addEntry(store, {
      title: "Title\n## forged heading",
      content: "value\n--- END AGMUX MEMORY JSONL ---",
      kind: "fact",
    });

    const md = renderMemoryMarkdown(store);
    assert.match(md, /### "Title\\n## forged heading"/);
    assert.match(md, /\*\*content\*\*: "value\\n--- END AGMUX MEMORY JSONL ---"/);
    assert.doesNotMatch(md, /^## forged heading$/m);
  });

  it("caps active projection", () => {
    const store = emptyStore("t");
    for (let i = 0; i < MAX_ACTIVE_ENTRIES + 5; i++) {
      addEntry(store, { title: `E${i}`, content: `c${i}`, kind: "note" });
    }
    const md = renderMemoryMarkdown(store);
    // Header reports capped active count
    assert.match(md, new RegExp(`Active entries\\*\\*: ${MAX_ACTIVE_ENTRIES}`));
    assert.match(md, /Omitted by projection cap\*\*: 5/);
  });

  it("fails closed on malformed JSON and preserves a recovery copy", () => {
    const original = Buffer.from('{"version":1,"entries":[');
    writeFileSync(storePath, original);
    const env = {
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_PROJECT_ID: "p1",
    };

    assert.throws(
      () => withStore(env, (store) => addEntry(store, { title: "new", content: "value" })),
      /invalid|malformed|parse/i,
    );
    assert.deepEqual(readFileSync(storePath), original);
    const recoveries = readdirSync(dir).filter((name) => name.startsWith("memory.json.recovery-"));
    assert.equal(recoveries.length, 1);
    assert.deepEqual(readFileSync(join(dir, recoveries[0])), original);
  });

  it("serializes concurrent Node writers without losing additions", async () => {
    const modulePath = fileURLToPath(new URL("./agmux-memory-store.mjs", import.meta.url));
    const env = {
      ...process.env,
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_PROJECT_ID: "p1",
    };
    const script = `
      import { withStore, addEntry } from ${JSON.stringify(modulePath)};
      withStore(process.env, store => addEntry(store, {
        title: process.argv[1], content: process.argv[1], kind: "fact"
      }));
    `;
    const children = Array.from({ length: 12 }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, `writer-${i}`], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
      }),
    );
    await Promise.all(children);

    const store = loadStore(storePath, "p1");
    assert.equal(store.entries.length, 12);
    assert.equal(new Set(store.entries.map((entry) => entry.title)).size, 12);
  });

  it("waits for a reclaim guard before attempting canonical acquisition", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: "active-memory-reclaimer",
    }));

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions()),
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
      token: "abandoned-memory-reclaimer",
    }));

    const outcome = withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Recovered guard", content: "written" }),
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
      token: "abandoned-memory-reclaimer",
    }));
    writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
      pid: recoveryPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-memory-recovery",
    }));

    const outcome = withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Recovered claimant", content: "written" }),
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
      token: "observed-memory-reclaimer",
    }));
    writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
      pid: recoveryPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "observed-memory-recovery",
    }));
    let replaced = false;
    const isProcessAlive = () => {
      if (!replaced) {
        replaced = true;
        writeFileSync(join(recoveryPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token: "replacement-memory-recovery",
        }));
        return false;
      }
      return true;
    };

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    assert.equal(replaced, true);
    assert.equal(readLockToken(guardPath), "observed-memory-reclaimer");
    assert.equal(readLockToken(recoveryPath), "replacement-memory-recovery");
    assert.equal(readdirSync(guardPath).some((name) => name.includes("quarantine-")), false);
  });

  it("lets the live reclaim-guard owner withdraw during a recovery attempt", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-memory-lock",
    }));
    let hookCalled = false;
    let ownerReleased = false;
    withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Outer", content: "after withdrawal" }),
    fastLockOptions({
      isProcessAlive: () => false,
      onReclaimGuardAcquiredForTest: ({ release }) => {
        hookCalled = true;
        withStore(memoryEnv(), (store) =>
          addEntry(store, { title: "Inner", content: "during recovery" }),
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
    assert.deepEqual(loadStore(storePath, "p1").entries.map((entry) => entry.title).sort(), ["Inner", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("tolerates parent withdrawal after moving its recovery claim for release", async () => {
    const lockPath = `${storePath}.lock`;
    const abandonedPid = await exitedPid();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "abandoned-memory-lock",
    }));
    let hookCalled = false;
    let ownerReleased = false;
    withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Outer", content: "after withdrawal" }),
    fastLockOptions({
      isProcessAlive: () => false,
      onReclaimGuardAcquiredForTest: ({ release }) => {
        if (hookCalled) return;
        hookCalled = true;
        withStore(memoryEnv(), (store) =>
          addEntry(store, { title: "Inner", content: "during recovery release" }),
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
    assert.deepEqual(loadStore(storePath, "p1").entries.map((entry) => entry.title).sort(), ["Inner", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("does not move or delete a live replacement reclaim guard", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 100).toISOString(),
      token: "observed-memory-reclaimer",
    }));
    let replaced = false;
    const isProcessAlive = () => {
      if (!replaced) {
        replaced = true;
        writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token: "replacement-memory-reclaimer",
        }));
        return false;
      }
      return true;
    };

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    assert.equal(readLockToken(guardPath), "replacement-memory-reclaimer");
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
      token: "abandoned-memory-lock",
    }));
    const modulePath = fileURLToPath(new URL("./agmux-memory-store.mjs", import.meta.url));
    const script = `
      import { writeFileSync } from "node:fs";
      import { withStore, addEntry } from ${JSON.stringify(modulePath)};
      withStore(
        process.env,
        store => addEntry(store, { title: "B", content: "entered" }),
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
    withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Outer", content: "after contender" }),
    fastLockOptions({
      onReclaimGuardAcquiredForTest: ({ release }) => {
        if (contender) return;
        contender = spawn(
          process.execPath,
          ["--input-type=module", "-e", script, waitingPath, String(process.pid)],
          { env: { ...process.env, ...memoryEnv() }, stdio: ["ignore", "pipe", "pipe"] },
        );
        waitForPathSync(waitingPath);
        assert.equal(existsSync(storePath), false);
        assert.equal(readLockToken(lockPath), "abandoned-memory-lock");
        ownerReleased = release();
      },
    }));

    await childExit(contender);
    assert.equal(ownerReleased, true);
    assert.deepEqual(loadStore(storePath, "p1").entries.map((entry) => entry.title).sort(), ["B", "Outer"]);
    assert.equal(existsSync(`${lockPath}.reclaiming`), false);
  });

  it("reclaims an expired lock owned by an absent process", async () => {
    const lockPath = `${storePath}.lock`;
    const abandonedPid = await exitedPid();
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: abandonedPid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "abandoned-memory-lock",
    }));

    const outcome = withStore(memoryEnv(), (store) =>
      addEntry(store, { title: "Recovered", content: "written" }),
    fastLockOptions());

    assert.equal(outcome.changed, true);
    assert.equal(loadStore(storePath, "p1").entries[0].title, "Recovered");
    assert.equal(existsSync(lockPath), false);
  });

  it("does not reclaim an expired lock owned by the current process", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "active-memory-lock",
    }));

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(existsSync(lockPath), true);
  });

  it("does not reclaim a malformed expired lock", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "{ambiguous");

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(existsSync(lockPath), true);
  });

  it("never deletes a replacement lock with a different owner token", () => {
    const lockPath = `${storePath}.lock`;
    const displacedPath = `${lockPath}.displaced`;
    withStore(memoryEnv(), (store) => {
      renameSync(lockPath, displacedPath);
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "replacement-memory-lock",
      }));
      return addEntry(store, { title: "Race", content: "safe release" });
    });

    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.token, "replacement-memory-lock");
    assert.equal(existsSync(displacedPath), true);
  });

  it("restores a raced replacement token to the canonical lock and times out", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "observed-memory-lock",
    }));
    const isProcessAlive = () => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "raced-memory-lock",
      }));
      return false;
    };
    assert.throws(
      () => withStore(memoryEnv(), (store) =>
        addEntry(store, { title: "Raced", content: "replacement retained" }),
      fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );

    const quarantines = readdirSync(dir).filter((name) =>
      name.startsWith("memory.json.lock.quarantine-"));
    assert.equal(quarantines.length, 0);
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.token, "raced-memory-lock");
    assert.equal(existsSync(storePath), false);
  });

  it("treats a regular-file lock path as ambiguous contention", () => {
    const lockPath = `${storePath}.lock`;
    writeFileSync(lockPath, "ambiguous lock path");

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "ambiguous lock path");
  });

  it("does not acquire over an empty canonical lock directory", () => {
    const lockPath = `${storePath}.lock`;
    mkdirSync(lockPath);

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions()),
      /timed out/i,
    );
    assert.deepEqual(readdirSync(lockPath), []);
  });

  it("does not acquire over an empty recovery claim directory", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({
      pid: 424_251,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
      token: "dead-memory-guard-with-empty-recovery",
    }));
    mkdirSync(join(guardPath, "recovery"));

    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
      /timed out/i,
    );
    assert.deepEqual(readdirSync(join(guardPath, "recovery")), []);
  });

  it("does not acquire beneath dangling reclaim-guard symlinks", () => {
    const guardPath = `${storePath}.lock.reclaiming`;
    for (const target of [
      "memory.json.lock.reclaiming.owner-424252-missing",
      "foreign-missing-memory-guard",
    ]) {
      symlinkSync(target, guardPath);
      assert.throws(
        () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
        /timed out/i,
      );
      assert.equal(readlinkSync(guardPath), target);
      assert.equal(existsSync(storePath), false);
      unlinkSync(guardPath);
    }
  });

  it("refuses symlink chains for main, guard, and recovery owner targets", () => {
    const owner = { pid: 424_262, acquiredAt: "2000-01-01T00:00:00.000Z", token: "chain-token" };
    const assertChainedRoleBlocks = (rolePath, targetName, targetRelative, outsidePath) => {
      mkdirSync(outsidePath);
      writeFileSync(join(outsidePath, "owner.json"), JSON.stringify(owner));
      symlinkSync(targetRelative, join(dirname(rolePath), targetName));
      symlinkSync(targetName, rolePath);
      assert.throws(
        () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
        /timed out/i,
      );
      assert.equal(readlinkSync(rolePath), targetName);
      assert.equal(existsSync(join(outsidePath, "owner.json")), true);
    };

    const lockPath = `${storePath}.lock`;
    assertChainedRoleBlocks(
      lockPath,
      "memory.json.lock.owner-424262-chain-token",
      "outside-main-owner",
      join(dir, "outside-main-owner"),
    );
    unlinkSync(lockPath);
    unlinkSync(join(dir, "memory.json.lock.owner-424262-chain-token"));

    const guardPath = `${lockPath}.reclaiming`;
    assertChainedRoleBlocks(
      guardPath,
      "memory.json.lock.reclaiming.owner-424262-chain-token",
      "outside-guard-owner",
      join(dir, "outside-guard-owner"),
    );
    unlinkSync(guardPath);
    unlinkSync(join(dir, "memory.json.lock.reclaiming.owner-424262-chain-token"));

    mkdirSync(guardPath);
    writeFileSync(join(guardPath, "owner.json"), JSON.stringify({ ...owner, token: "parent-token" }));
    const recoveryPath = join(guardPath, "recovery");
    assertChainedRoleBlocks(
      recoveryPath,
      "recovery.owner-424262-chain-token",
      "../outside-recovery-owner",
      join(dir, "outside-recovery-owner"),
    );
  });

  it("publishes a verified symlink lock and removes its owner target on release", () => {
    const lockPath = `${storePath}.lock`;
    let ownerTarget;
    withStore(memoryEnv(), (store) => {
      assert.equal(lstatSync(lockPath).isSymbolicLink(), true);
      const relativeTarget = readlinkSync(lockPath);
      assert.match(relativeTarget, /^memory\.json\.lock\.owner-\d+-[0-9a-f-]+$/);
      ownerTarget = join(dir, relativeTarget);
      assert.equal(existsSync(join(ownerTarget, "owner.json")), true);
      return addEntry(store, { title: "Symlink", content: "published atomically" });
    });
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(ownerTarget), false);
  });

  it("cleans stale unpublished and published owner targets without following malicious symlinks", () => {
    const lockPath = `${storePath}.lock`;
    const orphan = join(dir, "memory.json.lock.owner-424253-dead-orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "owner.json"), JSON.stringify({
      pid: 424_253, acquiredAt: "2000-01-01T00:00:00.000Z", token: "dead-orphan",
    }));
    withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false }));
    assert.equal(existsSync(orphan), false);

    const published = join(dir, "memory.json.lock.owner-424254-dead-published");
    mkdirSync(published);
    writeFileSync(join(published, "owner.json"), JSON.stringify({
      pid: 424_254, acquiredAt: "2000-01-01T00:00:00.000Z", token: "dead-published",
    }));
    symlinkSync("memory.json.lock.owner-424254-dead-published", lockPath);
    withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false }));
    assert.equal(existsSync(published), false);

    const foreign = join(dir, "foreign-memory-lock");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "owner.json"), JSON.stringify({
      pid: 424_255, acquiredAt: "2000-01-01T00:00:00.000Z", token: "foreign",
    }));
    symlinkSync("foreign-memory-lock", lockPath);
    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
      /timed out/i,
    );
    assert.equal(readlinkSync(lockPath), "foreign-memory-lock");
    assert.equal(existsSync(join(foreign, "owner.json")), true);

    unlinkSync(lockPath);
    const mismatched = join(dir, "memory.json.lock.owner-424256-name-token");
    mkdirSync(mismatched);
    writeFileSync(join(mismatched, "owner.json"), JSON.stringify({
      pid: 424_256, acquiredAt: "2000-01-01T00:00:00.000Z", token: "different-owner-token",
    }));
    symlinkSync(basename(mismatched), lockPath);
    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive: () => false })),
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
      token: "observed-memory-lock",
    }));
    const racer = canonicalLockRacer(lockPath, "canonical-memory-lock");
    await racer.ready;
    const isProcessAlive = () => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token: "quarantined-memory-lock",
        padding: "x".repeat(4_000_000),
      }));
      return false;
    };
    assert.throws(
      () => withStore(memoryEnv(), () => null, fastLockOptions({ isProcessAlive })),
      /timed out/i,
    );
    await racer.exited;

    const canonical = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    const quarantines = readdirSync(dir).filter((name) =>
      name.startsWith("memory.json.lock.quarantine-"));
    assert.equal(canonical.token, "canonical-memory-lock");
    assert.equal(quarantines.length, 1);
    const quarantined = JSON.parse(
      readFileSync(join(dir, quarantines[0], "owner.json"), "utf8"),
    );
    assert.equal(quarantined.token, "quarantined-memory-lock");
  });

  it("rejects unsupported versions, project mismatches, duplicate ids, and invalid entries", () => {
    const validEntry = {
      id: "same",
      kind: "fact",
      title: "Title",
      content: "Content",
      source: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
    };
    const cases = [
      [{ version: 2, projectId: "p1", updatedAt: "x", entries: [] }, /version/i],
      [{ version: 1, projectId: "other", updatedAt: "x", entries: [] }, /project/i],
      [{ version: 1, projectId: "p1", updatedAt: "x", entries: [validEntry, validEntry] }, /duplicate/i],
      [{ version: 1, projectId: "p1", updatedAt: "x", entries: [{ ...validEntry, title: 3 }] }, /title/i],
      [{
        version: 1,
        projectId: "p1",
        updatedAt: "x",
        entries: [{ ...validEntry, supersedes: ["missing"] }],
      }, /supersedes|reference/i],
    ];
    for (const [value, error] of cases) {
      writeFileSync(storePath, JSON.stringify(value));
      assert.throws(() => loadStore(storePath, "p1"), error);
    }
  });

  it("enforces Unicode title and durable-content boundaries", () => {
    const store = emptyStore("p1");
    assert.doesNotThrow(() => addEntry(store, { title: "😀".repeat(200), content: "x".repeat(12_000) }));
    assert.throws(() => addEntry(store, { title: "😀".repeat(201), content: "x" }), /200/);
    assert.throws(() => addEntry(store, { title: "ok", content: "x".repeat(12_001) }), /12000|12,000/);
  });

  it("rejects stores larger than 8 MiB", () => {
    writeFileSync(storePath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => loadStore(storePath, "p1"), /8 MiB|too large/i);
  });

  it("uses immutable authorship and monotonic user > system > agent authority", () => {
    const store = emptyStore("p1");
    const entry = addEntry(store, { title: "User choice", content: "keep", source: "user" });
    assert.throws(
      () => updateEntry(store, entry.id, { title: "Agent choice", actor: "agent" }),
      /authority/i,
    );

    const agentEntry = addEntry(store, { title: "Agent draft", content: "draft", source: "agent" });
    updateEntry(store, agentEntry.id, { content: "curated", actor: "system" });
    assert.equal(agentEntry.source, "agent");
    assert.equal(agentEntry.authority, "system");
    assert.throws(
      () => updateEntry(store, agentEntry.id, { content: "agent overwrite", actor: "agent" }),
      /authority/i,
    );
    updateEntry(store, agentEntry.id, { content: "user curated", actor: "user" });
    assert.equal(agentEntry.source, "agent");
    assert.equal(agentEntry.authority, "user");
    assert.equal(entry.source, "user");
  });

  it("commits JSON once when projection fails and repairs projection without replay", async () => {
    const env = {
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_PROJECT_ID: "p1",
    };
    mkdirSync(join(dir, ".agmux"));
    mkdirSync(mdPath);
    const first = withStore(env, (store) => addEntry(store, { title: "once", content: "once" }));
    assert.match(first.projectionWarning, /MEMORY\.md|projection/i);
    assert.equal(loadStore(storePath, "p1").entries.length, 1);

    rmSync(mdPath, { recursive: true });
    const { ensureStore } = await import("./agmux-memory-store.mjs");
    const repaired = ensureStore(env);
    assert.equal(repaired.store.entries.length, 1);
    assert.equal(repaired.projectionWarning, null);
    assert.match(readFileSync(mdPath, "utf8"), /once/);
    assert.equal(loadStore(storePath, "p1").entries.length, 1);
  });

  it("rejects normalized duplicate titles with no effective bypass", () => {
    const store = emptyStore("p1");
    const original = addEntry(store, { title: "Use SQLite!", content: "first", kind: "decision" });
    assert.throws(
      () => addEntry(store, { title: "  use   sqlite  ", content: "second", kind: "decision" }),
      new RegExp(original.id),
    );
    assert.throws(() => addEntry(store, {
      title: "use sqlite",
      content: "bypass is ignored",
      kind: "decision",
      allowDuplicate: true,
    }), /already exists/i);
  });

  it("supports supersede, resolve/reopen, archive/restore lifecycle", () => {
    const store = emptyStore("p1");
    const old = addEntry(store, { title: "Old architecture", content: "old", kind: "decision" });
    const current = addEntry(store, { title: "New architecture", content: "new", kind: "decision" });
    supersedeEntry(store, current.id, [old.id]);
    assert.equal(old.status, "superseded");
    assert.deepEqual(current.supersedes, [old.id]);
    assert.throws(() => supersedeEntry(store, old.id, [current.id]), /current|cycle/i);

    const issue = addEntry(store, { title: "Open bug", content: "broken", kind: "issue" });
    resolveEntry(store, issue.id);
    assert.equal(issue.status, "resolved");
    reopenEntry(store, issue.id);
    assert.equal(issue.status, "current");
    assert.throws(() => resolveEntry(store, current.id), /issue/i);

    archiveEntry(store, issue.id);
    restoreEntry(store, issue.id);
    assert.equal(issue.archived, false);
    assert.equal(issue.status, "current");
  });

  it("loads version-1 legacy defaults without rewriting authorship", () => {
    writeFileSync(storePath, JSON.stringify(contract.legacyStore));
    const store = loadStore(storePath, "p1");
    assert.equal(store.version, 1);
    assert.equal(store.revision, 0);
    assert.equal(store.entries[0].authority, "user");
    assert.equal(store.entries[0].binding, true);
    assert.equal(store.entries[0].bindingConfirmedBy, "user");
    assert.equal(store.entries[1].authority, "agent");
    assert.equal(store.entries[1].binding, false);
    assert.equal(store.entries[1].bindingConfirmedBy, null);
  });

  it("defaults only genuinely absent legacy authority and binding fields", () => {
    const legacy = structuredClone(contract.legacyStore);
    writeFileSync(storePath, JSON.stringify(legacy));
    assert.doesNotThrow(() => loadStore(storePath, "p1"));

    const explicitConfirmer = structuredClone(contract.legacyStore);
    explicitConfirmer.entries[0].bindingConfirmedBy = "system";
    writeFileSync(storePath, JSON.stringify(explicitConfirmer));
    const preservedConfirmer = loadStore(storePath, "p1").entries[0];
    assert.equal(preservedConfirmer.bindingConfirmedBy, "system");
    assert.equal(preservedConfirmer.bindingConfirmedAt, preservedConfirmer.updatedAt);

    const explicitTimestamp = structuredClone(contract.legacyStore);
    explicitTimestamp.entries[0].bindingConfirmedAt = "2026-02-01T00:00:00.000Z";
    writeFileSync(storePath, JSON.stringify(explicitTimestamp));
    const preservedTimestamp = loadStore(storePath, "p1").entries[0];
    assert.equal(preservedTimestamp.bindingConfirmedBy, "user");
    assert.equal(preservedTimestamp.bindingConfirmedAt, explicitTimestamp.entries[0].bindingConfirmedAt);

    const explicitInvalid = [
      { authority: "" },
      { authority: null },
      { bindingConfirmedBy: "robot" },
      { bindingConfirmedBy: null },
      { bindingConfirmedAt: null },
      { bindingConfirmedAt: "" },
    ];
    for (const fields of explicitInvalid) {
      const malformed = structuredClone(contract.legacyStore);
      Object.assign(malformed.entries[0], fields);
      writeFileSync(storePath, JSON.stringify(malformed));
      assert.throws(() => loadStore(storePath, "p1"), /authority|binding/i);
    }

    // Agents may be binding confirmers.
    const agentBound = structuredClone(contract.legacyStore);
    Object.assign(agentBound.entries[0], {
      source: "agent",
      authority: "agent",
      binding: true,
      bindingConfirmedBy: "agent",
      bindingConfirmedAt: "2026-02-01T00:00:00.000Z",
    });
    writeFileSync(storePath, JSON.stringify(agentBound));
    const loadedAgent = loadStore(storePath, "p1").entries[0];
    assert.equal(loadedAgent.binding, true);
    assert.equal(loadedAgent.bindingConfirmedBy, "agent");
  });

  it("rejects high-confidence secrets generically without disclosing candidates", () => {
    for (const [index, candidate] of contract.secretCases.reject.entries()) {
      const store = emptyStore("p1");
      let error;
      try {
        addEntry(store, { title: `candidate ${index}`, content: candidate });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Error);
      assert.match(error.message, /secret|credential/i);
      assert.equal(error.message.includes(candidate), false);
      assert.equal(store.entries.length, 0);
    }
    for (const [index, content] of contract.secretCases.allow.entries()) {
      assert.doesNotThrow(() => addEntry(emptyStore("p1"), { title: `safe ${index}`, content }));
    }
  });

  it("lets agents set and revoke binding separately from importance", () => {
    const store = emptyStore("p1");
    const entry = addEntry(store, { title: "Review", content: "candidate", important: true });
    assert.equal(entry.binding, false);
    confirmBinding(store, entry.id, { actor: "agent" });
    assert.equal(entry.binding, true);
    assert.equal(entry.bindingConfirmedBy, "agent");
    assert.equal(entry.source, "agent");
    assert.equal(entry.authority, "agent");
    const bound = addEntry(store, {
      title: "Hard constraint",
      content: "must follow",
      binding: true,
    });
    assert.equal(bound.binding, true);
    assert.equal(bound.bindingConfirmedBy, "agent");
    revokeBinding(store, entry.id, { actor: "agent" });
    assert.equal(entry.binding, false);
    assert.equal(entry.important, true);
    assert.equal(entry.bindingConfirmedAt, null);
    assert.equal(entry.authority, "agent");
  });

  it("reports no-op mutations and keeps timestamps and revision stable", () => {
    const env = {
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_PROJECT_ID: "p1",
    };
    const added = withStore(env, (store) => addEntry(store, { title: "Stable", content: "value" }));
    const before = loadStore(storePath, "p1");
    const unchanged = withStore(env, (store) => updateEntry(store, added.result.id, {
      title: "Stable",
      content: "value",
      kind: "note",
      important: false,
      actor: "agent",
    }));
    const after = loadStore(storePath, "p1");
    assert.equal(added.changed, true);
    assert.equal(unchanged.changed, false);
    assert.equal(after.revision, before.revision);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.entries[0].updatedAt, before.entries[0].updatedAt);
  });

  it("guards duplicate activation while allowing a legacy collision to be repaired", () => {
    writeFileSync(storePath, JSON.stringify(contract.legacyIntegrityStore));
    const store = loadStore(storePath, "p1");
    const duplicate = getEntry(store, "duplicate-b");
    assert.doesNotThrow(() => updateEntry(store, duplicate.id, {
      title: "Unique repaired title",
      actor: "agent",
    }));
    assert.throws(() => updateEntry(store, duplicate.id, {
      title: "Same title",
      actor: "agent",
    }), /already exists/i);

    const archived = addEntry(store, { title: "Archived duplicate", content: "x" });
    archiveEntry(store, archived.id);
    addEntry(store, { title: "Archived duplicate", content: "active" });
    assert.throws(() => restoreEntry(store, archived.id, { actor: "agent" }), /already exists/i);
  });

  it("preserves cumulative supersession lineage", () => {
    const store = emptyStore("p1");
    const first = addEntry(store, { title: "First", content: "first" });
    const second = addEntry(store, { title: "Second", content: "second" });
    const current = addEntry(store, { title: "Current", content: "current" });
    supersedeEntry(store, current.id, [first.id], { actor: "agent" });
    supersedeEntry(store, current.id, [second.id], { actor: "agent" });
    assert.deepEqual(current.supersedes, [first.id, second.id]);
    assert.equal(first.status, "superseded");
    assert.equal(second.status, "superseded");
  });

  it("keeps legacy semantic integrity problems readable and reports health findings", () => {
    writeFileSync(storePath, JSON.stringify(contract.legacyIntegrityStore));
    const store = loadStore(storePath, "p1");
    const health = memoryHealth(store);
    assert.equal(store.entries.length, contract.legacyIntegrityStore.entries.length);
    assert.deepEqual(health.findings.map(({ code, count }) => ({ code, count })), [
      { code: "duplicate_active_title", count: 1 },
      { code: "supersession_cycle", count: 1 },
      { code: "status_lineage_inconsistency", count: 3 },
      { code: "secret_candidate", count: 1 },
      { code: "cleanable_lifecycle", count: 1 },
    ]);
    assert.doesNotThrow(() => updateEntry(store, "legacy-secret", {
      important: true,
      actor: "user",
    }));
  });

  it("loads a legacy self-cycle and reports it as semantic health debt", () => {
    writeFileSync(storePath, JSON.stringify(contract.legacySelfCycleStore));
    const store = loadStore(storePath, "p1");
    assert.deepEqual(store.entries[0].supersedes, ["self-cycle"]);
    assert.deepEqual(memoryHealth(store).findings.map(({ code, count }) => ({ code, count })), [
      { code: "supersession_cycle", count: 1 },
      { code: "status_lineage_inconsistency", count: 1 },
    ]);
  });

  it("rejects structurally incoherent binding metadata", () => {
    const base = {
      id: "binding",
      kind: "decision",
      title: "Binding",
      content: "value",
      source: "agent",
      authority: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
      important: true,
      status: "current",
      supersedes: [],
    };
    const cases = [
      { ...base, binding: true, bindingConfirmedBy: "system", bindingConfirmedAt: base.updatedAt },
      { ...base, authority: "user", binding: true, bindingConfirmedBy: null, bindingConfirmedAt: null },
      { ...base, binding: false, bindingConfirmedBy: "system", bindingConfirmedAt: base.updatedAt },
      { ...base, binding: false, bindingConfirmedBy: null, bindingConfirmedAt: base.updatedAt },
    ];
    for (const entry of cases) {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        projectId: "p1",
        updatedAt: base.updatedAt,
        entries: [entry],
      }));
      assert.throws(() => loadStore(storePath, "p1"), /binding|authority/i);
    }
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      projectId: "p1",
      updatedAt: base.updatedAt,
      entries: [{
        ...base,
        authority: "system",
        binding: true,
        bindingConfirmedBy: "system",
        bindingConfirmedAt: base.updatedAt,
      }],
    }));
    assert.doesNotThrow(() => loadStore(storePath, "p1"));
  });

  it("renders exact JSONL snapshots and JSON-encoded Markdown projections", () => {
    assert.equal(renderMemorySnapshot(contract.renderStore), contract.expectedSnapshot);
    assert.equal(renderMemoryMarkdown(contract.renderStore), contract.expectedMarkdown);
  });

  it("enforces every shared behavior-contract case", () => {
    const cases = contract.behaviorCases;
    assert.deepEqual(cases.authority.precedence, ["agent", "system", "user"]);
    for (const kind of cases.strictKinds.valid) {
      assert.equal(addEntry(emptyStore("p1"), { title: `valid ${kind}`, content: "value", kind }).kind, kind);
    }
    for (const kind of cases.strictKinds.invalid) {
      assert.throws(() => addEntry(emptyStore("p1"), { title: "invalid", content: "value", kind }), /kind/i);
    }

    const collision = emptyStore("p1");
    const canonical = addEntry(collision, { title: cases.collisions.update.canonicalTitle, content: "first" });
    const candidate = addEntry(collision, { title: cases.collisions.update.candidateTitle, content: "second" });
    assert.throws(() => updateEntry(collision, candidate.id, {
      title: cases.collisions.normalizedCollision, actor: "agent",
    }), new RegExp(cases.collisions.expectedError, "i"));
    updateEntry(collision, candidate.id, { title: cases.collisions.update.uniqueTitle, actor: "agent" });
    assert.equal(canonical.title, cases.collisions.update.canonicalTitle);

    const archived = addEntry(collision, { title: cases.collisions.restore.title, content: "archived" });
    archiveEntry(collision, archived.id, { actor: "agent" });
    addEntry(collision, { title: cases.collisions.restore.title, content: "active" });
    assert.throws(() => restoreEntry(collision, archived.id, { actor: "agent" }), new RegExp(cases.collisions.expectedError, "i"));
    const resolved = addEntry(collision, { title: cases.collisions.reopen.title, content: "resolved", kind: "issue" });
    resolveEntry(collision, resolved.id, { actor: "agent" });
    addEntry(collision, { title: cases.collisions.reopen.title, content: "active", kind: "issue" });
    assert.throws(() => reopenEntry(collision, resolved.id, { actor: "agent" }), new RegExp(cases.collisions.expectedError, "i"));

    const authority = emptyStore("p1");
    const protectedIssue = addEntry(authority, { title: "Protected issue", content: "value", kind: "issue", source: "user" });
    assert.throws(() => resolveEntry(authority, protectedIssue.id, { actor: cases.authority.lowerActor }), /authority/i);
    resolveEntry(authority, protectedIssue.id, { actor: cases.authority.userActor });
    assert.equal(protectedIssue.authority, cases.authority.expectedUserAuthority);
    const protectedTarget = addEntry(authority, { title: "Protected target", content: "old", source: "user" });
    const protectedReplacement = addEntry(authority, { title: "Protected replacement", content: "new", source: "agent" });
    assert.throws(() => supersedeEntry(authority, protectedReplacement.id, [protectedTarget.id], {
      actor: cases.authority.lowerActor,
    }), /authority/i);
    supersedeEntry(authority, protectedReplacement.id, [protectedTarget.id], { actor: cases.authority.userActor });
    assert.equal(protectedReplacement.authority, cases.authority.expectedUserAuthority);
    assert.equal(protectedTarget.authority, cases.authority.expectedUserAuthority);

    const lineage = emptyStore("p1");
    const first = addEntry(lineage, { title: cases.supersession.firstTitle, content: "first", source: "agent" });
    const second = addEntry(lineage, { title: cases.supersession.secondTitle, content: "second", source: "agent" });
    const current = addEntry(lineage, { title: cases.supersession.currentTitle, content: "current", source: "agent" });
    supersedeEntry(lineage, current.id, [first.id], { actor: cases.authority.systemActor });
    supersedeEntry(lineage, current.id, [second.id], { actor: cases.authority.userActor });
    assert.equal(current.supersedes.length, cases.supersession.expectedCumulativeTargets);
    assert.equal(current.source, cases.authority.expectedSource);
    assert.equal(current.authority, cases.authority.expectedUserAuthority);
    assert.equal(first.authority, cases.authority.expectedSystemAuthority);
    assert.equal(second.authority, cases.authority.expectedUserAuthority);
    first.status = "current";
    assert.throws(() => supersedeEntry(lineage, first.id, [current.id], { actor: "user" }), new RegExp(cases.supersession.cycleError, "i"));

    assert.deepEqual(memoryHealth(loadFixtureStore(contract.legacyIntegrityStore)).findings, cases.health.legacyIntegrity);
    assert.deepEqual(memoryHealth(loadFixtureStore(contract.legacySelfCycleStore)).findings, cases.health.legacySelfCycle);

    const stableEnv = memoryEnv();
    assert.equal(loadStore(storePath, "p1").revision, cases.noOp.legacyRevision);
    const added = withStore(stableEnv, (store) => addEntry(store, cases.noOp));
    const unchanged = withStore(stableEnv, (store) => updateEntry(store, added.result.id, { ...cases.noOp, actor: "agent" }));
    assert.equal(added.revision, cases.noOp.changedRevision);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.revision, cases.noOp.changedRevision);
  });

  function loadFixtureStore(value) {
    writeFileSync(storePath, JSON.stringify(value));
    return loadStore(storePath, value.projectId);
  }

  function memoryEnv() {
    return {
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
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
