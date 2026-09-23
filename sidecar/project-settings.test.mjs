import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  readProjectSettings,
  writeProjectSettings,
  addToolToProjectSettings,
  loadProjectAllowedTools,
} from "./project-settings.mjs";

async function scratchDir() {
  return mkdtemp(join(tmpdir(), "xanom-settings-"));
}

test("readProjectSettings: returns empty object when file is missing", async () => {
  const dir = await scratchDir();
  try {
    const settings = await readProjectSettings(dir);
    assert.deepEqual(settings, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readProjectSettings: returns empty object on malformed JSON", async () => {
  const dir = await scratchDir();
  try {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.local.json"),
      "{not json",
      "utf-8",
    );
    const settings = await readProjectSettings(dir);
    assert.deepEqual(settings, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readProjectSettings: parses valid JSON", async () => {
  const dir = await scratchDir();
  try {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "settings.local.json"),
      JSON.stringify({ allowedTools: ["Read"], theme: "dark" }),
      "utf-8",
    );
    const settings = await readProjectSettings(dir);
    assert.deepEqual(settings.allowedTools, ["Read"]);
    assert.equal(settings.theme, "dark");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeProjectSettings: creates .claude/ if missing", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, { allowedTools: ["Bash"] });
    const raw = await readFile(
      join(dir, ".claude", "settings.local.json"),
      "utf-8",
    );
    assert.match(raw, /"Bash"/);
    assert.ok(raw.endsWith("\n"), "should end with newline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeProjectSettings: writes pretty-printed JSON", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, { a: 1, b: 2 });
    const raw = await readFile(
      join(dir, ".claude", "settings.local.json"),
      "utf-8",
    );
    assert.match(raw, /\n  "a": 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addToolToProjectSettings: adds a new tool and reports change", async () => {
  const dir = await scratchDir();
  try {
    const { changed, settings } = await addToolToProjectSettings(dir, "Read");
    assert.equal(changed, true);
    assert.deepEqual(settings.allowedTools, ["Read"]);
    const stored = await readProjectSettings(dir);
    assert.deepEqual(stored.allowedTools, ["Read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addToolToProjectSettings: no-op when tool already present", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, { allowedTools: ["Read", "Edit"] });
    const before = await readFile(
      join(dir, ".claude", "settings.local.json"),
      "utf-8",
    );
    const { changed } = await addToolToProjectSettings(dir, "Edit");
    assert.equal(changed, false);
    const after = await readFile(
      join(dir, ".claude", "settings.local.json"),
      "utf-8",
    );
    assert.equal(after, before, "file should not be rewritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addToolToProjectSettings: preserves unrelated keys", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, {
      allowedTools: ["Read"],
      theme: "dark",
      nested: { x: 1 },
    });
    await addToolToProjectSettings(dir, "Bash");
    const stored = await readProjectSettings(dir);
    assert.deepEqual(stored.allowedTools, ["Read", "Bash"]);
    assert.equal(stored.theme, "dark");
    assert.deepEqual(stored.nested, { x: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addToolToProjectSettings: handles non-array allowedTools gracefully", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, { allowedTools: "not-an-array" });
    const { changed, settings } = await addToolToProjectSettings(dir, "Read");
    assert.equal(changed, true);
    assert.deepEqual(settings.allowedTools, ["Read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectAllowedTools: returns empty set when file missing", async () => {
  const dir = await scratchDir();
  try {
    const set = await loadProjectAllowedTools(dir);
    assert.equal(set.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectAllowedTools: skips non-string entries and empty strings", async () => {
  const dir = await scratchDir();
  try {
    await writeProjectSettings(dir, {
      allowedTools: ["Read", "", 42, null, "Edit"],
    });
    const set = await loadProjectAllowedTools(dir);
    assert.deepEqual([...set].sort(), ["Edit", "Read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectAllowedTools: round-trips add → load", async () => {
  const dir = await scratchDir();
  try {
    await addToolToProjectSettings(dir, "Bash");
    await addToolToProjectSettings(dir, "Read");
    await addToolToProjectSettings(dir, "Bash"); // duplicate
    const set = await loadProjectAllowedTools(dir);
    assert.deepEqual([...set].sort(), ["Bash", "Read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
