/**
 * Client for the agmux room RPC socket (`~/.agmux/room.sock`).
 *
 * One-shot request/response over a Unix socket, newline-delimited JSON:
 * `{id, method, params}` → `{id, result}` | `{id, error: {message}}`.
 * Used by the agmux-memory MCP server to expose room_* tools to agents.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";

export function roomSocketPath(env = process.env) {
  if (env.AGMUX_ROOM_SOCK && String(env.AGMUX_ROOM_SOCK).trim()) {
    return String(env.AGMUX_ROOM_SOCK).trim();
  }
  return path.join(os.homedir(), ".agmux", "room.sock");
}

let nextId = 1;

/**
 * Send one RPC request and resolve its result (or reject with the error).
 * Rejects with a friendly message when the app socket is unreachable.
 */
export function roomRequest(method, params, options = {}) {
  const socketPath = options.socketPath || roomSocketPath();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const id = nextId++;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`room RPC timeout after ${timeoutMs}ms (${method})`));
    }, timeoutMs);

    const socket = net.createConnection(socketPath);

    socket.on("error", (e) => {
      const unreachable = e?.code === "ENOENT" || e?.code === "ECONNREFUSED";
      finish(
        reject,
        unreachable
          ? new Error("room RPC unavailable — is the agmux desktop app running?")
          : new Error(`room RPC connection failed: ${e?.message || e}`),
      );
    });

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        finish(reject, new Error(`room RPC bad response: ${e?.message || e}`));
        return;
      }
      if (msg?.error) {
        finish(reject, new Error(String(msg.error.message || "room RPC error")));
        return;
      }
      finish(resolve, msg?.result ?? null);
    });

    socket.on("close", () => {
      finish(reject, new Error("room RPC connection closed before a response arrived"));
    });
  });
}
