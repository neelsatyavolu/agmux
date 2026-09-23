import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore, loadStore, saveStore, addEntry } from "./agmux-memory-store.mjs";
import {
  emptyHandoffStore,
  loadHandoffStore,
  saveHandoffStore,
  upsertSession,
} from "./agmux-handoff-store.mjs";
import {
  searchProject,
  formatSearchHits,
  sessionExcerpt,
  formatSessionExcerpt,
  ftsTokenize,
} from "./agmux-search.mjs";

describe("agmux-search", () => {
  let dir;
  let env;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agmux-search-"));
    const mem = join(dir, "memory.json");
    const md = join(dir, "MEMORY.md");
    const hand = join(dir, "handoffs.json");
    const smd = join(dir, "SESSIONS.md");
    env = {
      AGMUX_MEMORY_STORE: mem,
      AGMUX_MEMORY_MD: md,
      AGMUX_HANDOFF_STORE: hand,
      AGMUX_SESSIONS_MD: smd,
      AGMUX_PROJECT_ID: "p1",
      AGMUX_TRANSCRIPT_ROOTS: JSON.stringify([dir]),
    };

    const store = emptyStore("p1");
    addEntry(store, {
      title: "Canvas terminal",
      content: "Use Canvas not WebGL because of DPR on WKWebView",
      kind: "decision",
    });
    addEntry(store, {
      title: "Unrelated note",
      content: "cats and dogs",
      kind: "note",
    });
    saveStore(store, mem, md);

    const hs = emptyHandoffStore("p1");
    upsertSession(hs, {
      id: "t1",
      title: "Spinner hang fix",
      summary: "False complete toast then hung spinner after Stop",
      provider: "Grok",
      transcriptPath: join(dir, "transcript.jsonl"),
    });
    saveHandoffStore(hs, hand, smd);

    writeFileSync(
      join(dir, "transcript.jsonl"),
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ type: "msg", i, text: `line ${i} spinner stop hang` }),
      ).join("\n") + "\n",
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("FTS search finds memory and sessions with ranking", () => {
    const { hits } = searchProject({ query: "spinner hang", env });
    assert.ok(hits.some((h) => h.type === "session" && h.id === "t1"));
    assert.ok(hits[0].score > 0);
    const { hits: memHits } = searchProject({ query: "WKWebView Canvas", scope: "memory", env });
    assert.ok(memHits.some((h) => h.type === "memory"));
    assert.ok(formatSearchHits(memHits, "WKWebView").includes("FTS"));
  });

  it("requires complete short-query coverage and majority long-query coverage", () => {
    const store = emptyStore("p1");
    addEntry(store, { title: "Both", content: "alpha beta", kind: "fact" });
    addEntry(store, { title: "One", content: "alpha only", kind: "fact" });
    addEntry(store, { title: "Majority", content: "alpha beta gamma", kind: "fact" });
    addEntry(store, { title: "Minority", content: "alpha beta", kind: "fact" });
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);

    const short = searchProject({ query: "alpha beta", scope: "memory", env });
    assert.deepEqual(short.hits.map((hit) => hit.title).sort(), ["Both", "Majority", "Minority"]);
    const long = searchProject({ query: "alpha beta gamma delta", scope: "memory", env });
    assert.deepEqual(long.hits.map((hit) => hit.title), ["Majority"]);
  });

  it("uses bounded phrase, title, proximity, trusted-importance, and recency boosts", () => {
    const store = emptyStore("p1");
    const phrase = addEntry(store, {
      title: "Body phrase",
      content: "memory retrieval quality",
      kind: "fact",
      source: "agent",
    });
    const title = addEntry(store, {
      title: "Memory retrieval quality",
      content: "terms appear in the title",
      kind: "fact",
      source: "agent",
    });
    const scattered = addEntry(store, {
      title: "Scattered",
      content: `memory ${"filler ".repeat(30)}retrieval ${"filler ".repeat(30)}quality`,
      kind: "fact",
      source: "user",
      important: true,
    });
    phrase.updatedAt = "2026-01-02T00:00:00.000Z";
    title.updatedAt = "2026-01-01T00:00:00.000Z";
    scattered.updatedAt = "2026-12-31T00:00:00.000Z";
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);

    const result = searchProject({ query: "memory retrieval quality", scope: "memory", env });
    assert.equal(result.hits[0].id, title.id, "exact title phrase should be strongest");
    assert.equal(result.hits[1].id, phrase.id, "adjacent body phrase should beat scattered terms");
    assert.ok(result.hits.every((hit) => hit.score < 20), "all boosts must remain bounded");
  });

  it("does not treat agent-authored importance as a trusted ranking boost", () => {
    const store = emptyStore("p1");
    const trusted = addEntry(store, {
      title: "Trusted alpha",
      content: "alpha",
      kind: "fact",
      source: "user",
      important: true,
    });
    const review = addEntry(store, {
      title: "Review alpha",
      content: "alpha",
      kind: "fact",
      source: "agent",
      important: true,
    });
    trusted.updatedAt = "2026-01-01T00:00:00.000Z";
    review.updatedAt = "2026-12-31T00:00:00.000Z";
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);

    const result = searchProject({ query: "alpha", scope: "memory", env });
    assert.equal(result.hits[0].id, trusted.id);
  });

  it("session_excerpt returns bounded tail", () => {
    const result = sessionExcerpt({ id: "t1", maxChars: 200, from: "tail", env });
    assert.equal(result.ok, true);
    assert.ok(result.excerpt.length <= 250);
    assert.ok(formatSessionExcerpt(result).includes("excerpt"));
  });

  it("tokenizes camelCase and path components", () => {
    const tokens = ftsTokenize("sessionStateMachine src/components/MemoryMainPanel.tsx");
    for (const expected of ["session", "state", "machine", "memory", "main", "panel"]) {
      assert.ok(tokens.includes(expected), `${expected} missing from ${tokens.join(", ")}`);
    }
  });

  it("centers previews around the matching term", () => {
    const { storePath, projectId } = {
      storePath: env.AGMUX_MEMORY_STORE,
      projectId: env.AGMUX_PROJECT_ID,
    };
    const store = emptyStore(projectId);
    addEntry(store, {
      title: "Late match",
      content: `${"prefix ".repeat(80)}uniqueNeedle near the end`,
      kind: "fact",
    });
    saveStore(store, storePath, env.AGMUX_MEMORY_MD);
    const result = searchProject({ query: "uniqueNeedle", scope: "memory", env });
    assert.match(result.hits[0].preview, /uniqueNeedle/i);
    assert.ok(result.hits[0].preview.length <= 241);
  });

  it("rejects transcript paths outside configured roots and symlink escapes", () => {
    const outside = mkdtempSync(join(tmpdir(), "agmux-search-outside-"));
    try {
      const secret = join(outside, "secret.jsonl");
      writeFileSync(secret, "do not expose", "utf8");
      const handoffs = emptyHandoffStore("p1");
      upsertSession(handoffs, { id: "outside", title: "Outside", summary: "x", transcriptPath: secret });
      const linked = join(dir, "linked.jsonl");
      symlinkSync(secret, linked);
      upsertSession(handoffs, { id: "linked", title: "Linked", summary: "x", transcriptPath: linked });
      saveHandoffStore(handoffs, env.AGMUX_HANDOFF_STORE, env.AGMUX_SESSIONS_MD);

      assert.equal(sessionExcerpt({ id: "outside", env }).ok, false);
      assert.match(sessionExcerpt({ id: "outside", env }).note, /outside allowed transcript roots/i);
      assert.equal(sessionExcerpt({ id: "linked", env }).ok, false);
      assert.match(sessionExcerpt({ id: "linked", env }).note, /outside allowed transcript roots/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("uses stable cursors and rejects them after a revision-only store update", () => {
    const store = emptyStore("p1");
    addEntry(store, { title: "First canvas", content: "canvas terminal", kind: "fact" });
    addEntry(store, { title: "Second canvas", content: "canvas renderer", kind: "fact" });
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);
    const first = searchProject({ query: "canvas", limit: 1, scope: "memory", env });
    assert.equal(first.hits.length, 1);
    assert.ok(first.nextCursor);
    const second = searchProject({ query: "canvas", limit: 1, scope: "memory", cursor: first.nextCursor, env });
    assert.equal(second.hits.length, 1);
    const raw = JSON.parse(readFileSync(env.AGMUX_MEMORY_STORE, "utf8"));
    raw.revision += 1;
    writeFileSync(env.AGMUX_MEMORY_STORE, `${JSON.stringify(raw, null, 2)}\n`);
    assert.throws(
      () => searchProject({ query: "canvas", limit: 1, scope: "memory", cursor: first.nextCursor, env }),
      /stale cursor/i,
    );
  });

  it("invalidates cursors after a handoff revision-only update", () => {
    const handoffs = emptyHandoffStore("p1");
    upsertSession(handoffs, { id: "one", title: "First spinner", summary: "spinner hang" });
    upsertSession(handoffs, { id: "two", title: "Second spinner", summary: "spinner stop" });
    saveHandoffStore(handoffs, env.AGMUX_HANDOFF_STORE, env.AGMUX_SESSIONS_MD);
    const first = searchProject({ query: "spinner", limit: 1, scope: "session", env });
    assert.ok(first.nextCursor);
    const raw = JSON.parse(readFileSync(env.AGMUX_HANDOFF_STORE, "utf8"));
    raw.revision += 1;
    writeFileSync(env.AGMUX_HANDOFF_STORE, `${JSON.stringify(raw, null, 2)}\n`);

    assert.throws(
      () => searchProject({ query: "spinner", limit: 1, scope: "session", cursor: first.nextCursor, env }),
      /stale cursor/i,
    );
  });

  it("invalidates a memory-scoped cursor after a handoff mutation", () => {
    const store = loadStore(env.AGMUX_MEMORY_STORE, "p1");
    addEntry(store, { title: "First scoped canvas", content: "canvas one", kind: "fact" });
    addEntry(store, { title: "Second scoped canvas", content: "canvas two", kind: "fact" });
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);
    const first = searchProject({ query: "canvas", limit: 1, scope: "memory", env });
    assert.ok(first.nextCursor);

    const handoffs = loadHandoffStore(env.AGMUX_HANDOFF_STORE, "p1");
    upsertSession(handoffs, { id: "changed", title: "Changed", summary: "cross-store mutation" });
    saveHandoffStore(handoffs, env.AGMUX_HANDOFF_STORE, env.AGMUX_SESSIONS_MD);

    assert.throws(
      () => searchProject({ query: "canvas", limit: 1, scope: "memory", cursor: first.nextCursor, env }),
      /stale cursor/i,
    );
  });

  it("invalidates a session-scoped cursor after a memory mutation", () => {
    const handoffs = loadHandoffStore(env.AGMUX_HANDOFF_STORE, "p1");
    upsertSession(handoffs, { id: "one", title: "First scoped spinner", summary: "spinner one" });
    upsertSession(handoffs, { id: "two", title: "Second scoped spinner", summary: "spinner two" });
    saveHandoffStore(handoffs, env.AGMUX_HANDOFF_STORE, env.AGMUX_SESSIONS_MD);
    const first = searchProject({ query: "spinner", limit: 1, scope: "session", env });
    assert.ok(first.nextCursor);

    const store = loadStore(env.AGMUX_MEMORY_STORE, "p1");
    addEntry(store, { title: "Changed memory", content: "cross-store mutation", kind: "fact" });
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);

    assert.throws(
      () => searchProject({ query: "spinner", limit: 1, scope: "session", cursor: first.nextCursor, env }),
      /stale cursor/i,
    );
  });

  it("validates a stale cursor before returning an empty scoped result", () => {
    const store = emptyStore("p1");
    addEntry(store, { title: "First removable canvas", content: "canvas one", kind: "fact" });
    addEntry(store, { title: "Second removable canvas", content: "canvas two", kind: "fact" });
    saveStore(store, env.AGMUX_MEMORY_STORE, env.AGMUX_MEMORY_MD);
    const first = searchProject({ query: "canvas", limit: 1, scope: "memory", env });
    assert.ok(first.nextCursor);

    const raw = JSON.parse(readFileSync(env.AGMUX_MEMORY_STORE, "utf8"));
    raw.revision += 1;
    raw.entries = [];
    writeFileSync(env.AGMUX_MEMORY_STORE, `${JSON.stringify(raw, null, 2)}\n`);

    assert.throws(
      () => searchProject({ query: "canvas", limit: 1, scope: "memory", cursor: first.nextCursor, env }),
      /stale cursor/i,
    );
  });
});
