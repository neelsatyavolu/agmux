/**
 * agmux-room-client tests: request/response framing against a mock Unix
 * socket server, error mapping, and unreachable-socket behavior.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { roomRequest, roomSocketPath } from "./agmux-room-client.mjs";

describe("agmux-room-client", () => {
  let dir;
  let sockPath;
  let server;
  let lastRequest;

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "agmux-room-test-"));
    sockPath = path.join(dir, "room.sock");
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buffer.slice(0, nl));
        lastRequest = req;
        let response;
        if (req.method === "room.context") {
          response = { id: req.id, result: { roomId: "r1", members: [] } };
        } else if (req.method === "room.boom") {
          response = { id: req.id, error: { message: "kaboom" } };
        } else {
          response = { id: req.id, error: { message: `unknown method: ${req.method}` } };
        }
        socket.write(JSON.stringify(response) + "\n");
      });
    });
    await new Promise((resolve) => server.listen(sockPath, resolve));
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves result and sends method/params", async () => {
    const result = await roomRequest(
      "room.context",
      { threadId: "t1" },
      { socketPath: sockPath },
    );
    assert.equal(result.roomId, "r1");
    assert.equal(lastRequest.method, "room.context");
    assert.deepEqual(lastRequest.params, { threadId: "t1" });
    assert.ok(lastRequest.id != null);
  });

  it("rejects with server error message", async () => {
    await assert.rejects(
      roomRequest("room.boom", {}, { socketPath: sockPath }),
      /kaboom/,
    );
  });

  it("rejects fast when the socket does not exist", async () => {
    await assert.rejects(
      roomRequest("room.context", {}, { socketPath: path.join(dir, "missing.sock") }),
      /room RPC unavailable/,
    );
  });

  it("honors AGMUX_ROOM_SOCK override and defaults under ~/.agmux", () => {
    assert.equal(roomSocketPath({ AGMUX_ROOM_SOCK: "/tmp/x.sock" }), "/tmp/x.sock");
    assert.ok(roomSocketPath({}).endsWith(path.join(".agmux", "room.sock")));
  });
});
