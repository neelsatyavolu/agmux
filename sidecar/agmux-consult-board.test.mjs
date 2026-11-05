import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  agentName, appendInstructions, coordinationInstructions, createBoard, normalizeRemote, projectKey, registerBoardTools,
} from "./agmux-consult-board.mjs";

test("the same repo gets the same key on every teammate's Mac", () => {
  for (const url of ["git@github.com:Acme/Web.git", "https://github.com/acme/web.git", "https://user:tok@github.com/acme/web/",
    "ssh://git@github.com:22/acme/web.git", "https://github.com/acme/web"]) {
    assert.equal(normalizeRemote(url), "github.com/acme/web", url);
  }
  assert.equal(normalizeRemote("not a url"), null);
  assert.equal(projectKey("/x/web", () => "git@github.com:acme/web.git\n"), "github.com/acme/web");
  assert.equal(projectKey("/x/web/src", (args) => { if (args[0] === "remote") throw new Error("no origin"); return "/x/web\n"; }), "folder:web");
  assert.equal(projectKey("/tmp/scratch", () => { throw new Error("no git"); }), "folder:scratch");
});

test("agents are named by their MCP client", () => {
  assert.equal(agentName("claude-code"), "claude");
  assert.equal(agentName("codex-mcp-client"), "codex");
  assert.equal(agentName("Grok Build"), "grok");
  assert.equal(agentName(undefined), null);
});

test("board calls go to the app with this repo's key", async () => {
  const calls = [];
  const request = async (method, params, options) => { calls.push({ method, params, socketPath: options.socketPath }); return { id: "tb_1" }; };
  const board = createBoard({ request, socketPath: "/s", cwd: "/x/web" });
  board.project = () => "github.com/acme/web";
  await board.read("2026-11-04T00:00:00Z");
  await board.post({ kind: "claim", text: "migration 365" });
  await board.update({ id: "tb_1", status: "done" });
  assert.deepEqual(calls.map((c) => c.method), ["board.read", "board.post", "board.update"]);
  assert.ok(calls.every((c) => c.socketPath === "/s"));
});

test("the tools post with the calling agent's name, and the instructions reach the client", async () => {
  const posted = [];
  const board = {
    project: () => "github.com/acme/web",
    read: async () => ({ project: "github.com/acme/web", items: [{ id: "tb_1", kind: "claim", text: "migration 365" }], now: "T" }),
    post: async (fields) => { posted.push(fields); return { id: "tb_2", expires: "E" }; },
    update: async () => ({ ok: true }),
  };
  const server = new McpServer({ name: "consult", version: "test" }, { instructions: "consult's own." });
  registerBoardTools(server, board);
  appendInstructions(server, coordinationInstructions({ teamSessions: true }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "codex-mcp-client", version: "1" });
  await client.connect(clientSide);
  const instructions = client.getInstructions();
  assert.match(instructions, /^consult's own\./);
  for (const tool of ["read_broadcasts", "broadcast", "update_broadcast", "list_sessions", "send_message", "list_team_sessions", "message_team_session"]) {
    assert.ok(instructions.includes(tool), tool);
  }
  assert.ok(!coordinationInstructions({ teamSessions: false }).includes("list_team_sessions"));
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["broadcast", "read_broadcasts", "update_broadcast"]);
  const result = await client.callTool({ name: "broadcast", arguments: { kind: "claim", text: "Taking migration 365", hours: 2 } });
  assert.match(result.content[0].text, /Posted claim tb_2\. It holds until E/);
  assert.deepEqual(posted, [{ kind: "claim", text: "Taking migration 365", agent: "codex", hours: 2 }]);
  const read = await client.callTool({ name: "read_broadcasts", arguments: {} });
  assert.match(read.content[0].text, /migration 365/);
  await client.close();
});
