import { test } from "node:test";
import assert from "node:assert/strict";
import { claude } from "consult-mcp/dist/adapters/claude.js";
import { pinPermissionMode, withPinnedPermissionMode } from "./agmux-consult-claude.mjs";

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("a forked session runs in the default permission mode with the prompt last", () => {
  const adapter = withPinnedPermissionMode(claude);
  const inv = adapter.fork("SRC", { agent: "claude", question: "q", cwd: "/repo" }, "PROMPT", []);
  assert.equal(valueAfter(inv.args, "--permission-mode"), "default");
  assert.ok(inv.args.includes("--restricted"));
  assert.equal(valueAfter(inv.args, "--resume"), "SRC");
  assert.equal(inv.args.at(-1), "PROMPT");
});

test("an invocation that already names a mode is left alone", () => {
  const inv = { command: "claude", args: ["-p", "--permission-mode", "plan", "P"] };
  assert.equal(pinPermissionMode(inv), inv);
});
