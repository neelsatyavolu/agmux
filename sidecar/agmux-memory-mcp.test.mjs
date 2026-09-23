/**
 * Integration test: spawn the MCP server as a real stdio child and exercise
 * initialize → tools/list → tools/call (add/list/get/archive).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "agmux-memory-mcp.mjs");

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const unsolicited = [];
  const messageWaiters = [];
  let stderr = "";
  let nextId = 1;

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (messageWaiters.length > 0) {
      messageWaiters.shift()(msg);
    } else {
      unsolicited.push(msg);
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function stop() {
    child.stdin.end();
    child.kill("SIGTERM");
  }

  function nextMessage() {
    if (unsolicited.length > 0) return Promise.resolve(unsolicited.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for server message")), 5000);
      messageWaiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  return {
    request,
    stop,
    child,
    sendRaw: (line) => child.stdin.write(line + "\n"),
    nextMessage,
    stderr: () => stderr,
  };
}

describe("agmux-memory-mcp stdio protocol", () => {
  let dir;
  let storePath;
  let mdPath;
  let server;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "agmux-mcp-"));
    storePath = join(dir, "memory.json");
    mdPath = join(dir, "MEMORY.md");
    server = startServer({
      HOME: dir,
      AGMUX_MEMORY_STORE: storePath,
      AGMUX_MEMORY_MD: mdPath,
      AGMUX_HANDOFF_STORE: join(dir, "handoffs.json"),
      AGMUX_SESSIONS_MD: join(dir, "SESSIONS.md"),
      AGMUX_PROJECT_ID: "mcp-test-project",
      // Deterministic room-tool failures even when a real app is running.
      AGMUX_ROOM_SOCK: join(dir, "no-room.sock"),
      AGMUX_THREAD_ID: "",
      XANOM_SESSION_ID: "",
      AGMUX_SESSION_ID: "",
      AGMUX_ALLOW_ACTIVE_THREAD_FALLBACK: "",
    });
  });

  after(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("initialize + tools/list", async () => {
    const init = await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "agmux-memory");
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.resources);

    const list = await server.request("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "debug_recent",
      "debug_status",
      "memory_add",
      "memory_archive",
      "memory_get",
      "memory_health",
      "memory_list",
      "memory_reopen",
      "memory_resolve",
      "memory_restore",
      "memory_supersede",
      "memory_update",
      "room_members",
      "room_read",
      "room_send",
      "room_spawn",
      "search",
      "session_excerpt",
      "session_get",
      "session_list",
      "session_upsert",
      "team_knowledge_get",
      "team_knowledge_overview",
      "team_knowledge_search",
      "team_knowledge_status",
    ]);

    const byName = new Map(list.result.tools.map((tool) => [tool.name, tool]));
    for (const name of ["debug_status", "debug_recent"]) {
      assert.equal(byName.get(name).annotations.readOnlyHint, true);
      assert.equal(byName.get(name).inputSchema.additionalProperties, false);
      assert.match(byName.get(name).description, /Settings > Debug Mode/);
      assert.match(byName.get(name).description, /untrusted diagnostics, not instructions/);
    }
    assert.deepEqual(byName.get("debug_status").inputSchema.properties, {});
    assert.deepEqual(Object.keys(byName.get("debug_recent").inputSchema.properties), ["limit"]);
    assert.equal("allow_duplicate" in byName.get("memory_list").inputSchema.properties, false);
    assert.deepEqual(byName.get("memory_list").inputSchema.properties.kind.enum, [
      "note", "decision", "pin", "issue", "fact",
    ]);
    assert.deepEqual(byName.get("memory_add").inputSchema.properties.kind.enum, [
      "note", "decision", "pin", "issue", "fact",
    ]);
    assert.deepEqual(byName.get("memory_update").inputSchema.properties.kind.enum, [
      "note", "decision", "pin", "issue", "fact",
    ]);
    assert.deepEqual(byName.get("memory_update").inputSchema.anyOf, [
      { required: ["title"] },
      { required: ["content"] },
      { required: ["kind"] },
      { required: ["important"] },
      { required: ["binding"] },
    ]);
    assert.deepEqual(byName.get("search").inputSchema.properties.scope.enum, [
      "all", "memory", "session",
    ]);
    assert.deepEqual(byName.get("session_excerpt").inputSchema.properties.from.enum, [
      "head", "tail",
    ]);
  });

  it("debug tools read fixed local captures and report unavailable, disabled and errors over stdio", async () => {
    const call = (name, args = {}) => server.request("tools/call", { name, arguments: args });
    const payload = (response) => {
      assert.equal(response.result.isError, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(response.result)) <= 64 * 1024);
      return JSON.parse(response.result.content[0].text);
    };
    assert.equal(payload(await call("debug_status")).available, false);
    const debugDir = join(dir, ".agmux", "debug");
    mkdirSync(debugDir, { recursive: true });
    const file = join(debugDir, "diagnostics.json");
    const capture = {
      schemaVersion: 1, pid: 123, startedAt: 0, enabled: false, updatedAt: 0,
      intervalMs: 5000, retentionSeconds: 600, lastError: null,
      records: Array.from({ length: 40 }, (_, at) => ({ at, processes: { count: at } })),
    };
    const original = JSON.stringify(capture);
    writeFileSync(file, original);
    const status = payload(await call("debug_status"));
    assert.equal(status.available, true);
    assert.equal(status.enabled, false);
    assert.equal(status.stale, false);
    assert.equal(status.recordCount, 40);
    assert.equal("records" in status, false);
    assert.deepEqual(payload(await call("debug_recent")).records, capture.records.slice(-12));
    assert.deepEqual(payload(await call("debug_recent", { limit: 30 })).records, capture.records.slice(-30));
    assert.equal(readFileSync(file, "utf8"), original);
    for (const [name, args] of [["debug_status", { path: file }], ["debug_status", { limit: 1 }],
      ["debug_recent", { filePath: file }], ...[0, 31, 1.5, "12", null].map((limit) => ["debug_recent", { limit }])]) {
      assert.equal((await call(name, args)).result.isError, true);
    }
    writeFileSync(file, JSON.stringify({ ...capture, enabled: true }));
    assert.equal(payload(await call("debug_status")).stale, true);
    writeFileSync(file, JSON.stringify({ ...capture, records: Array.from({ length: 30 }, (_, at) => ({ at, text: '"😀'.repeat(2000) })) }));
    assert.equal(payload(await call("debug_recent", { limit: 30 })).truncated, true);
    for (const contents of ["{bad", JSON.stringify({ ...capture, enabled: "yes" }), " ".repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(file, contents);
      for (const name of ["debug_status", "debug_recent"]) {
        assert.equal((await call(name)).result.isError, true);
      }
    }
    rmSync(debugDir, { recursive: true });
  });

  it("room tools error helpfully without identity or socket", async () => {
    // No AGMUX_THREAD_ID in the server env and no thread_id arg → identity error.
    const noId = await server.request("tools/call", {
      name: "room_send",
      arguments: { to: "main", message: "hi" },
    });
    assert.equal(noId.result.isError, true);
    assert.match(noId.result.content[0].text, /thread_id|AGMUX_THREAD_ID/);

    // With identity but no app socket → unreachable error, not a crash.
    const noSock = await server.request("tools/call", {
      name: "room_members",
      arguments: { thread_id: "t-test" },
    });
    assert.equal(noSock.result.isError, true);
    assert.match(noSock.result.content[0].text, /room RPC unavailable/);
  });

  it("starts cleanly and exposes the MEMORY.md resource", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotMatch(server.stderr(), /startup materialize failed|is not defined/i);

    const list = await server.request("resources/list", {});
    assert.equal(list.result.resources[0].uri, "agmux-memory://MEMORY.md");
    assert.equal(list.result.resources[0].name, "Project MEMORY.md");
    const read = await server.request("resources/read", { uri: "agmux-memory://MEMORY.md" });
    assert.match(read.result.contents[0].text, /agmux Project Memory/);

    const unknown = await server.request("resources/read", { uri: "agmux-memory://SESSIONS.md" });
    assert.equal(unknown.error.code, -32602);
  });

  it("validates enums and bounded integers at the protocol boundary", async () => {
    for (const [name, args, pattern] of [
      ["memory_list", { kind: "memo" }, /kind/i],
      ["memory_add", { title: "Bad kind", content: "x", kind: "memo" }, /kind/i],
      ["memory_add", { title: "Empty kind", content: "x", kind: "" }, /kind/i],
      ["search", { query: "hello world", scope: "everywhere" }, /scope/i],
      ["session_excerpt", { id: "missing", from: "middle" }, /from/i],
      ["memory_list", { limit: 1.5 }, /integer/i],
      ["session_list", { limit: 0 }, /integer/i],
      ["session_excerpt", { id: "missing", max_chars: 12001 }, /integer/i],
    ]) {
      const response = await server.request("tools/call", { name, arguments: args });
      assert.equal(response.result.isError, true, name);
      assert.match(response.result.content[0].text, pattern, name);
    }
  });

  it("reports store health without exposing candidate secret values", async () => {
    const response = await server.request("tools/call", {
      name: "memory_health",
      arguments: {},
    });
    assert.equal(response.result.isError, undefined);
    const health = JSON.parse(response.result.content[0].text);
    assert.equal(typeof health.revision, "number");
    assert.equal(typeof health.activeEntries, "number");
    assert.ok(Array.isArray(health.findings));
  });

  it("returns standard JSON-RPC errors for malformed and invalid requests", async () => {
    server.sendRaw("{not-json");
    const parse = await server.nextMessage();
    assert.equal(parse.error.code, -32700);
    assert.equal(parse.id, null);

    const invalid = await server.request(undefined, {});
    assert.equal(invalid.error.code, -32600);
  });

  it("memory_add → list → get → archive", async () => {
    const add = await server.request("tools/call", {
      name: "memory_add",
      arguments: {
        title: "Shared fact",
        content: "All providers see this",
        kind: "fact",
        important: true,
      },
    });
    assert.equal(add.result.isError, undefined);
    assert.match(add.result.content[0].text, /Added memory/);
    assert.match(add.result.content[0].text, /\[IMPORTANT\]/);
    assert.match(add.result.content[0].text, /created: \d{4}-\d{2}-\d{2}T/);

    // Projection file written
    assert.ok(existsSync(mdPath));
    const md = readFileSync(mdPath, "utf8");
    assert.match(md, /Shared fact/);
    assert.match(md, /## Important/);
    assert.match(md, /binding\*\*: false \(attention only\)/);
    assert.match(md, /\*\*created\*\*:/);
    assert.match(md, /\*\*updated\*\*:/);

    const listed = await server.request("tools/call", {
      name: "memory_list",
      arguments: {},
    });
    assert.match(listed.result.content[0].text, /Shared fact/);
    assert.match(listed.result.content[0].text, /\[IMPORTANT\]/);
    assert.match(listed.result.content[0].text, /created /);
    assert.match(listed.result.content[0].text, /timestamps UTC/i);
    // Extract id from list output: (`uuid`)
    const idMatch = listed.result.content[0].text.match(/`([0-9a-f-]{36})`/i);
    assert.ok(idMatch, "should include entry id");
    const id = idMatch[1];

    const got = await server.request("tools/call", {
      name: "memory_get",
      arguments: { id },
    });
    const parsed = JSON.parse(got.result.content[0].text);
    assert.equal(parsed.title, "Shared fact");
    assert.equal(parsed.kind, "fact");
    assert.equal(parsed.important, true);
    assert.ok(parsed.createdAt);
    assert.ok(parsed.updatedAt);

    const arch = await server.request("tools/call", {
      name: "memory_archive",
      arguments: { id },
    });
    assert.match(arch.result.content[0].text, /Archived/);

    const listed2 = await server.request("tools/call", {
      name: "memory_list",
      arguments: {},
    });
    assert.match(listed2.result.content[0].text, /No memory entries/);
  });

  it("memory_add validation error surfaces as isError", async () => {
    const res = await server.request("tools/call", {
      name: "memory_add",
      arguments: { title: "", content: "x" },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /title/i);
  });

  it("rejects id-only memory_update without changing the store revision", async () => {
    const add = await server.request("tools/call", {
      name: "memory_add",
      arguments: {
        title: "Update needs fields",
        content: "unchanged",
        kind: "fact",
      },
    });
    const id = add.result.content[0].text.match(/`([0-9a-f-]{36})`/i)[1];
    const before = JSON.parse(readFileSync(storePath, "utf8"));

    const update = await server.request("tools/call", {
      name: "memory_update",
      arguments: { id },
    });
    assert.equal(update.result.isError, true);
    assert.match(update.result.content[0].text, /at least one.*title.*content.*kind.*important.*binding/i);

    const after = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(after.revision, before.revision);
    assert.equal(after.entries.find((entry) => entry.id === id).updatedAt,
      before.entries.find((entry) => entry.id === id).updatedAt);
  });

  it("derives agent authorship and rejects lower-authority mutations", async () => {
    const add = await server.request("tools/call", {
      name: "memory_add",
      arguments: {
        title: "Cannot spoof source",
        content: "agent-authored content",
        kind: "fact",
        source: "user",
      },
    });
    const id = add.result.content[0].text.match(/`([0-9a-f-]{36})`/i)[1];
    const got = await server.request("tools/call", {
      name: "memory_get",
      arguments: { id },
    });
    const entry = JSON.parse(got.result.content[0].text);
    assert.equal(entry.source, "agent");
    assert.equal(entry.authority, "agent");
    assert.equal(entry.binding, false);

    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    const stored = raw.entries.find((candidate) => candidate.id === id);
    stored.source = "user";
    stored.authority = "user";
    writeFileSync(storePath, JSON.stringify(raw, null, 2) + "\n");

    const update = await server.request("tools/call", {
      name: "memory_update",
      arguments: { id, content: "agent overwrite" },
    });
    assert.equal(update.result.isError, true);
    assert.match(update.result.content[0].text, /user authority/i);
  });

  it("supports restore, resolve/reopen, and supersede lifecycle tools", async () => {
    const add = async (title, kind = "decision") => {
      await server.request("tools/call", {
        name: "memory_add",
        arguments: { title, content: `${title} content`, kind },
      });
      const listed = await server.request("tools/call", {
        name: "memory_list",
        arguments: { limit: 40 },
      });
      const line = listed.result.content[0].text
        .split("\n")
        .find((candidate) => candidate.includes(title));
      return line.match(/`([0-9a-f-]{36})`/i)[1];
    };

    const oldId = await add("Lifecycle old");
    const newId = await add("Lifecycle new");
    const supersede = await server.request("tools/call", {
      name: "memory_supersede",
      arguments: { id: newId, target_ids: [oldId] },
    });
    assert.match(supersede.result.content[0].text, /supersedes 1 entries/);

    const issueId = await add("Lifecycle issue", "issue");
    const resolved = await server.request("tools/call", {
      name: "memory_resolve",
      arguments: { id: issueId },
    });
    assert.match(resolved.result.content[0].text, /Resolved issue/);
    const reopened = await server.request("tools/call", {
      name: "memory_reopen",
      arguments: { id: issueId },
    });
    assert.match(reopened.result.content[0].text, /Reopened issue/);

    await server.request("tools/call", {
      name: "memory_archive",
      arguments: { id: issueId },
    });
    const restored = await server.request("tools/call", {
      name: "memory_restore",
      arguments: { id: issueId },
    });
    assert.match(restored.result.content[0].text, /Restored memory/);
  });

  it("paginates memory_list with bounded output", async () => {
    for (let i = 0; i < 3; i++) {
      await server.request("tools/call", {
        name: "memory_add",
        arguments: { title: `Page ${i}`, content: `content ${i}`, kind: "note" },
      });
    }
    const first = await server.request("tools/call", {
      name: "memory_list",
      arguments: { kind: "note", limit: 2, offset: 0 },
    });
    assert.match(first.result.content[0].text, /showing 1-2 of 3/i);
    assert.ok(first.result.content[0].text.length < 16_000);
    const second = await server.request("tools/call", {
      name: "memory_list",
      arguments: { kind: "note", limit: 2, offset: 2 },
    });
    assert.match(second.result.content[0].text, /showing 3-3 of 3/i);
  });

  it("session_list is empty when no handoffs", async () => {
    const res = await server.request("tools/call", {
      name: "session_list",
      arguments: {},
    });
    assert.equal(res.result.isError, undefined);
    assert.match(res.result.content[0].text, /No session handoffs/i);
  });

  it("session_upsert creates then updates same session", async () => {
    const create = await server.request("tools/call", {
      name: "session_upsert",
      arguments: {
        id: "thread-abc",
        title: "Spinner fix",
        summary: "Investigating hang on stop.",
      },
    });
    assert.equal(create.result.isError, undefined);
    assert.match(create.result.content[0].text, /Created session handoff/);

    const update = await server.request("tools/call", {
      name: "session_upsert",
      arguments: {
        id: "thread-abc",
        summary: "Fixed hang; spinner clears after real Stop.",
      },
    });
    assert.equal(update.result.isError, undefined);
    assert.match(update.result.content[0].text, /Updated session handoff/);
    assert.match(update.result.content[0].text, /Fixed hang/);

    const get = await server.request("tools/call", {
      name: "session_get",
      arguments: { id: "thread-abc" },
    });
    const text = get.result.content[0].text;
    // session_get may append progressive-disclosure guidance after the JSON body.
    const jsonPart = text.includes("\n\nNext:")
      ? text.slice(0, text.indexOf("\n\nNext:"))
      : text;
    const parsed = JSON.parse(jsonPart);
    assert.equal(parsed.id, "thread-abc");
    assert.match(parsed.summary, /Fixed hang/);
    assert.equal(parsed.title, "Spinner fix");
    assert.match(text, /session_excerpt/);
  });

  it("surfaces projection warnings for every MCP mutation", async () => {
    const warningDir = mkdtempSync(join(tmpdir(), "agmux-mcp-warnings-"));
    const badMemoryProjection = join(warningDir, "MEMORY.md");
    const badSessionProjection = join(warningDir, "SESSIONS.md");
    mkdirSync(badMemoryProjection);
    mkdirSync(badSessionProjection);
    const warningServer = startServer({
      AGMUX_MEMORY_STORE: join(warningDir, "memory.json"),
      AGMUX_MEMORY_MD: badMemoryProjection,
      AGMUX_HANDOFF_STORE: join(warningDir, "handoffs.json"),
      AGMUX_SESSIONS_MD: badSessionProjection,
      AGMUX_PROJECT_ID: "mcp-warning-test",
      AGMUX_THREAD_ID: "warning-thread",
    });
    const call = (name, arguments_) => warningServer.request("tools/call", {
      name,
      arguments: arguments_,
    });
    const assertWarning = (response) => {
      assert.equal(response.result.isError, undefined, response.result.content[0].text);
      assert.match(response.result.content[0].text, /Warning: .*projection/i);
    };
    const add = async (title, kind = "note") => {
      const response = await call("memory_add", { title, content: `${title} body`, kind });
      assertWarning(response);
      return response.result.content[0].text.match(/`([0-9a-f-]{36})`/i)[1];
    };

    try {
      const factId = await add("Warning fact", "fact");
      assertWarning(await call("memory_update", { id: factId, content: "updated" }));
      assertWarning(await call("memory_archive", { id: factId }));
      assertWarning(await call("memory_restore", { id: factId }));

      const issueId = await add("Warning issue", "issue");
      assertWarning(await call("memory_resolve", { id: issueId }));
      assertWarning(await call("memory_reopen", { id: issueId }));

      const oldId = await add("Warning old");
      const newId = await add("Warning new");
      assertWarning(await call("memory_supersede", { id: newId, target_ids: [oldId] }));
      assertWarning(await call("session_upsert", { summary: "warning handoff" }));
    } finally {
      warningServer.stop();
      rmSync(warningDir, { recursive: true, force: true });
    }
  });
});
