import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDebugSnapshot, debugStatus, debugRecent, MAX_DEBUG_FILE_BYTES, MAX_DEBUG_OUTPUT_BYTES } from "./agmux-debug.mjs";

const snapshot = (overrides = {}) => ({
  schemaVersion: 1, pid: 123, startedAt: 0, enabled: true, updatedAt: 100_000,
  intervalMs: 5000, retentionSeconds: 600, lastError: null,
  records: Array.from({ length: 120 }, (_, at) => ({ at, backendField: { count: at } })),
  ...overrides,
});

it("reads only valid bounded snapshots, including exact file and record boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "agmux-debug-"));
  const file = join(dir, "diagnostics.json");
  try {
    assert.equal(readDebugSnapshot(file), null);
    const raw = JSON.stringify(snapshot());
    writeFileSync(file, raw + " ".repeat(MAX_DEBUG_FILE_BYTES - Buffer.byteLength(raw)));
    assert.deepEqual(readDebugSnapshot(file), snapshot());
    writeFileSync(file, " ".repeat(MAX_DEBUG_FILE_BYTES + 1));
    assert.throws(() => readDebugSnapshot(file), /exceeds 2 MiB/);
    writeFileSync(file, "{bad");
    assert.throws(() => readDebugSnapshot(file), /Malformed.*JSON/);
    for (const bad of [null, [], snapshot({ schemaVersion: 2 }), snapshot({ pid: 0 }),
      snapshot({ pid: 1.5 }), snapshot({ enabled: "true" }), snapshot({ startedAt: null }),
      snapshot({ updatedAt: "today" }), snapshot({ intervalMs: 1000 }),
      snapshot({ retentionSeconds: 1 }), snapshot({ lastError: {} }),
      snapshot({ records: {} }), snapshot({ records: Array(121).fill({}) }),
      snapshot({ records: [null] })]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => readDebugSnapshot(file), /Malformed.*schema/);
    }
    writeFileSync(file, JSON.stringify(snapshot()).replace('"updatedAt":100000', '"updatedAt":1e400'));
    assert.throws(() => readDebugSnapshot(file), /Malformed.*schema/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("distinguishes unavailable, disabled, fresh and stale without leaking records or extra fields", () => {
  assert.deepEqual([debugStatus(null).available, debugStatus(null).enabled], [false, null]);
  assert.equal(debugStatus(snapshot(), 130_000).stale, false);
  assert.equal(debugStatus(snapshot(), 130_001).stale, true);
  const disabled = debugStatus(snapshot({ enabled: false, extra: "hidden" }), 999_999);
  assert.equal(disabled.available, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.stale, false);
  assert.equal(disabled.recordCount, 120);
  assert.equal("records" in disabled, false);
  assert.equal("extra" in disabled, false);
});

it("returns the ordered tail, defaults to 12, caps at 30 and preserves disabled records", () => {
  assert.deepEqual(debugRecent(snapshot()).records, snapshot().records.slice(-12));
  assert.equal(debugRecent(snapshot(), 30).records.length, 30);
  assert.deepEqual(debugRecent(snapshot({ enabled: false }), 1).records, snapshot().records.slice(-1));
  assert.deepEqual(debugRecent(null).records, []);
  for (const limit of [0, 31, 1.5, null, "12", NaN]) {
    assert.throws(() => debugRecent(snapshot(), limit), /limit/);
  }
});

it("bounds escaped UTF-8 tool output and explicitly drops oldest records", () => {
  const data = snapshot({ lastError: '"'.repeat(100_000), records: Array.from({ length: 30 }, (_, at) => ({ at, text: '😀"\\'.repeat(1000) })) });
  const recent = debugRecent(data, 30);
  assert.equal(recent.truncated, true);
  assert.equal(recent.lastErrorTruncated, true);
  assert.ok(recent.records.length > 0);
  assert.deepEqual(recent.records, data.records.slice(recent.droppedOldestRecords));
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(recent) }] })) <= MAX_DEBUG_OUTPUT_BYTES);
  const huge = debugRecent(snapshot({ records: [{ text: "x".repeat(100_000) }] }));
  assert.deepEqual(huge.records, []);
  assert.equal(huge.droppedOldestRecords, 1);
  assert.equal(huge.truncated, true);
});
