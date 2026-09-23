import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "agmux-memory-cli.mjs");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agmux-memory-cli-"));
  const badMemoryProjection = join(dir, "MEMORY.md");
  const badSessionProjection = join(dir, "SESSIONS.md");
  mkdirSync(badMemoryProjection);
  mkdirSync(badSessionProjection);
  return {
    dir,
    env: {
      ...process.env,
      AGMUX_MEMORY_STORE: join(dir, "memory.json"),
      AGMUX_MEMORY_MD: badMemoryProjection,
      AGMUX_HANDOFF_STORE: join(dir, "handoffs.json"),
      AGMUX_SESSIONS_MD: badSessionProjection,
      AGMUX_PROJECT_ID: "cli-test",
      AGMUX_THREAD_ID: "cli-thread",
    },
  };
}

function run(env, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

function idFrom(result) {
  const match = result.stdout.match(/`([0-9a-f-]{36})`/i);
  assert.ok(match, result.stdout || result.stderr);
  return match[1];
}

function assertWarning(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}\n${result.stderr}`, /Warning: .*projection/i);
}

describe("agmux-memory CLI boundary", () => {
  it("rejects unsupported flags, enums, and unbounded integers", () => {
    const { dir, env } = fixture();
    try {
      for (const args of [
        ["add", "--title", "x", "--content", "y", "--source", "user"],
        ["add", "--title", "x", "--content", "y", "--allow-duplicate"],
        ["add", "--title", "x", "--content", "y", "--kind", "memo"],
        ["add", "--title", "x", "--content", "y", "--kind"],
        ["search", "hello", "--scope", "everywhere"],
        ["search", "hello", "--limit", "1.5"],
        ["sessions", "--limit", "0"],
        ["session-excerpt", "missing", "--from", "middle"],
        ["session-excerpt", "missing", "--max-chars", "12001"],
      ]) {
        const result = run(env, ...args);
        assert.notEqual(result.status, 0, args.join(" "));
        assert.match(result.stderr, /unknown flag|kind|scope|integer|from|max-chars/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces projection warnings for every memory mutation and session-upsert", () => {
    const { dir, env } = fixture();
    try {
      const added = run(env, "add", "--title", "Fact", "--content", "body", "--kind", "fact", "--important");
      assertWarning(added);
      const factId = idFrom(added);
      assertWarning(run(env, "update", factId, "--content", "updated"));
      assertWarning(run(env, "archive", factId));
      assertWarning(run(env, "restore", factId));

      const issue = run(env, "add", "--title", "Issue", "--content", "body", "--kind", "issue");
      assertWarning(issue);
      const issueId = idFrom(issue);
      assertWarning(run(env, "resolve", issueId));
      assertWarning(run(env, "reopen", issueId));

      const oldEntry = run(env, "add", "--title", "Old", "--content", "old");
      const newEntry = run(env, "add", "--title", "New", "--content", "new");
      assertWarning(oldEntry);
      assertWarning(newEntry);
      assertWarning(run(env, "supersede", idFrom(newEntry), idFrom(oldEntry)));
      assertWarning(run(env, "session-upsert", "--summary", "finished"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates important agent memories as attention-only unless --binding is set", () => {
    const { dir, env } = fixture();
    try {
      const add = run(env, "add", "--title", "Review", "--content", "body", "--important");
      const get = run(env, "get", idFrom(add));
      assert.equal(get.status, 0, get.stderr);
      const entry = JSON.parse(get.stdout);
      assert.equal(entry.source, "agent");
      assert.equal(entry.authority, "agent");
      assert.equal(entry.binding, false);

      const health = run(env, "health");
      assert.equal(health.status, 0, health.stderr);
      assert.equal(JSON.parse(health.stdout).needsReviewCount, 1);

      const bound = run(env, "add", "--title", "Hard", "--content", "must", "--binding");
      const boundEntry = JSON.parse(run(env, "get", idFrom(bound)).stdout);
      assert.equal(boundEntry.binding, true);
      assert.equal(boundEntry.bindingConfirmedBy, "agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
