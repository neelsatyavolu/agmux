import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestartGate } from "./opencode-restart-gate.mjs";

const tick = () => new Promise((r) => setImmediate(r));

test("restarts immediately when no turn is running", async () => {
  let restarts = 0;
  const gate = createRestartGate(async () => { restarts += 1; });
  await gate.request();
  assert.equal(restarts, 1);
  assert.equal(gate.restartPending, false);
});

test("never restarts under a running turn", async () => {
  let restarts = 0;
  const gate = createRestartGate(async () => { restarts += 1; });
  await gate.beginTurn();
  const done = gate.request();
  await tick();
  assert.equal(restarts, 0, "the running turn must finish on the old server");
  gate.endTurn();
  await done;
  assert.equal(restarts, 1);
});

test("turns that don't need the new config keep going while a restart waits", async () => {
  let restarts = 0;
  const gate = createRestartGate(async () => { restarts += 1; });
  await gate.beginTurn(); // turn A
  gate.request();
  await gate.beginTurn(); // turn B, on the current server
  assert.equal(gate.inFlight, 2);
  gate.endTurn();
  await tick();
  assert.equal(restarts, 0);
  gate.endTurn();
  await tick();
  assert.equal(restarts, 1);
});

test("a turn that needs the new config waits for the restart", async () => {
  const order = [];
  const gate = createRestartGate(async () => { order.push("restart"); });
  await gate.beginTurn(); // turn on the old server
  gate.request();
  const local = gate.beginTurn(true).then(() => order.push("local turn"));
  await tick();
  assert.deepEqual(order, []);
  gate.endTurn();
  await local;
  assert.deepEqual(order, ["restart", "local turn"]);
  assert.equal(gate.inFlight, 1);
});

test("requests during a restart get one more restart", async () => {
  let restarts = 0;
  let release;
  const gate = createRestartGate(async () => {
    restarts += 1;
    if (restarts === 1) await new Promise((r) => { release = r; });
  });
  const first = gate.request();
  await tick();
  const second = gate.request();
  release();
  await first;
  await second;
  assert.equal(restarts, 2);
});

test("a failed restart rejects its waiters and the gate keeps working", async () => {
  let fail = true;
  const gate = createRestartGate(async () => {
    if (fail) throw new Error("serve failed");
  });
  await assert.rejects(gate.beginTurn(true), /serve failed/);
  assert.equal(gate.inFlight, 0, "a turn that never started isn't counted");
  fail = false;
  await gate.beginTurn(true);
  assert.equal(gate.inFlight, 1);
});

test("settled waits out a running restart", async () => {
  let release;
  const gate = createRestartGate(() => new Promise((r) => { release = r; }));
  gate.request();
  await tick();
  let settled = false;
  const waiting = gate.settled().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  release();
  await waiting;
  assert.equal(settled, true);
});
