#!/usr/bin/env node
// Mobile-remote wire smoke test — talks to the REAL desktop app through the
// production relay, exactly like the phone PWA does.
//
// One-time pairing (generate a code in agmux → Settings → Remote control):
//   node scripts/remote-smoke.mjs --desktop <desktopId> --pair <CODE>
// The phone token is cached in ~/.xanom/remote-smoke-auth.json for later runs.
//
// Read-only sweep (catalog + one timeline per provider/surface combo):
//   node scripts/remote-smoke.mjs
//
// Actions:
//   node scripts/remote-smoke.mjs --send <threadId> "reply with just: ok"
//   node scripts/remote-smoke.mjs --interrupt <threadId>
//   node scripts/remote-smoke.mjs --create <ClaudeCode|Codex|Grok> <projectId>
//   node scripts/remote-smoke.mjs --set-config <threadId> <model|-> <effort|->
//
// Full six-mode send/stop verification (sends a trivial prompt to the NEWEST
// thread of each provider+surface combo, waits for timeline growth, then
// interrupts) — costs a few provider tokens per combo, so it's opt-in:
//   node scripts/remote-smoke.mjs --exercise

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RELAY = "wss://agmux-remote-relay.xanom.workers.dev/ws";
const AUTH_PATH = path.join(os.homedir(), ".xanom", "remote-smoke-auth.json");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args.slice(i + 1);
};

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  fs.mkdirSync(path.dirname(AUTH_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
}

function connect(desktopId) {
  const url = `${RELAY}?desktopId=${encodeURIComponent(desktopId)}`;
  return new WebSocket(url);
}

function openSocket(desktopId) {
  return new Promise((resolve, reject) => {
    const ws = connect(desktopId);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message || "connect failed"}`)), { once: true });
  });
}

function nextMessage(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

async function pair(desktopId, code) {
  const ws = await openSocket(desktopId);
  ws.send(JSON.stringify({ type: "pair.submit", code }));
  const msg = await nextMessage(ws, (m) => m.type === "pair.ok" || m.type === "pair.fail" || m.type === "error", 10000, "pair result");
  ws.close();
  if (msg.type !== "pair.ok") throw new Error(`pair failed: ${JSON.stringify(msg)}`);
  saveAuth({ desktopId, phoneToken: msg.phoneToken });
  console.log(`paired ✓ token cached at ${AUTH_PATH}`);
}

async function phoneSession() {
  const auth = loadAuth();
  if (!auth?.phoneToken) {
    throw new Error("not paired — run with --desktop <id> --pair <CODE> first");
  }
  const ws = await openSocket(auth.desktopId);
  ws.send(JSON.stringify({ type: "hello", role: "phone", token: auth.phoneToken, desktopId: auth.desktopId }));
  await nextMessage(ws, (m) => m.type === "hello.ok", 8000, "hello.ok");
  return ws;
}

async function fetchCatalog(ws) {
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "threads.list" }));
  const snap = await nextMessage(ws, (m) => m.type === "threads.snapshot", 30000, "threads.snapshot");
  const ms = Date.now() - t0;
  return { threads: snap.threads || [], ms };
}

async function fetchTimeline(ws, threadId) {
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "thread.subscribe", threadId }));
  const snap = await nextMessage(
    ws,
    (m) => (m.type === "timeline.snapshot" && m.threadId === threadId) || m.type === "error",
    30000,
    `timeline ${threadId.slice(0, 8)}`,
  );
  const ms = Date.now() - t0;
  if (snap.type === "error") return { error: snap.message, ms };
  return { entries: snap.entries || [], emptyHint: snap.emptyHint, ms };
}

function comboKey(t) {
  return `${t.provider}/${t.surface}`;
}

async function sweep(ws) {
  const { threads, ms } = await fetchCatalog(ws);
  console.log(`catalog: ${threads.length} threads in ${ms}ms`);
  const running = threads.filter((t) => t.processing);
  console.log(`running: ${running.length}${running.length ? " — " + running.map((t) => `${t.title} (${t.provider})`).join(", ") : ""}`);
  for (const t of threads.slice(0, 8)) {
    console.log(`  ${t.id.slice(0, 8)}  ${String(t.title).slice(0, 34).padEnd(34)} ${comboKey(t).padEnd(20)} ${t.model || "-"}  ${t.lastActive}`);
  }
  const combos = new Map();
  for (const t of threads) {
    if (!combos.has(comboKey(t))) combos.set(comboKey(t), t);
  }
  console.log(`\ntimelines (newest per combo):`);
  for (const [key, t] of combos) {
    const r = await fetchTimeline(ws, t.id);
    if (r.error) console.log(`  ${key.padEnd(22)} ${t.id.slice(0, 8)}  ERROR: ${r.error}`);
    else console.log(`  ${key.padEnd(22)} ${t.id.slice(0, 8)}  ${String(r.entries.length).padStart(3)} entries in ${r.ms}ms${r.entries.length === 0 ? `  hint: ${r.emptyHint || "-"}` : ""}`);
  }
  return threads;
}

async function exercise(ws, threads) {
  const combos = new Map();
  for (const t of threads) {
    if (!combos.has(comboKey(t))) combos.set(comboKey(t), t);
  }
  for (const [key, t] of combos) {
    process.stdout.write(`send ${key} → ${t.id.slice(0, 8)} … `);
    const before = await fetchTimeline(ws, t.id);
    ws.send(JSON.stringify({ type: "message.send", threadId: t.id, text: "Reply with just: ok" }));
    const err = await Promise.race([
      nextMessage(ws, (m) => m.type === "error", 6000, "err").catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 6000)),
    ]);
    if (err) {
      console.log(`SEND ERROR: ${err.message}`);
      continue;
    }
    // Wait up to 30s for the timeline to grow past the pre-send size.
    let grew = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const now = await fetchTimeline(ws, t.id);
      if ((now.entries?.length || 0) > (before.entries?.length || 0)) {
        grew = true;
        break;
      }
    }
    console.log(grew ? "message appeared ✓" : "no timeline growth after 30s ✗");
    ws.send(JSON.stringify({ type: "turn.interrupt", threadId: t.id }));
    console.log(`  interrupt sent for ${t.id.slice(0, 8)}`);
  }
}

/// Full verification: read sweep, then chats via fresh phone-created threads
/// (no pollution of real sessions) and terminals via the newest real thread
/// per provider — send → verify timeline growth → interrupt.
async function verify(ws, projectId) {
  const threads = await sweep(ws);
  console.log("\n── chat surfaces (fresh threads via thread.create) ──");
  for (const provider of ["ClaudeCode", "Codex", "Grok"]) {
    process.stdout.write(`create ${provider} chat … `);
    ws.send(JSON.stringify({ type: "thread.create", provider, projectId }));
    let created;
    try {
      created = await nextMessage(
        ws,
        (m) => (m.type === "thread.created") || (m.type === "error" && /create/i.test(m.message || "")),
        30000,
        "thread.created",
      );
    } catch (e) {
      console.log(`✗ ${e.message}`);
      continue;
    }
    if (created.type === "error") {
      console.log(`✗ ${created.message}`);
      continue;
    }
    const tid = created.thread.id;
    process.stdout.write(`${tid.slice(0, 8)} ✓  send … `);
    await sendAndVerify(ws, tid, 60);
  }
  console.log("\n── terminal surfaces (newest idle thread per provider) ──");
  for (const provider of ["ClaudeCode", "Codex", "Grok"]) {
    // Never poke a session with an open turn (could be the agent running this
    // very script) — pick the newest idle terminal instead.
    const t = threads.find(
      (x) => x.provider === provider && x.surface === "terminal" && !x.processing,
    );
    if (!t) {
      console.log(`${provider}/terminal: none in catalog`);
      continue;
    }
    process.stdout.write(`send ${provider}/terminal → ${t.id.slice(0, 8)} (${String(t.title).slice(0, 28)}) … `);
    await sendAndVerify(ws, t.id, 90, true);
  }
}

async function sendAndVerify(ws, threadId, maxWaitSec, interruptAfter = false) {
  const before = await fetchTimeline(ws, threadId).catch(() => ({ entries: [] }));
  const baseline = before.entries?.length || 0;
  ws.send(JSON.stringify({ type: "message.send", threadId, text: "Reply with just: ok" }));
  const err = await Promise.race([
    nextMessage(ws, (m) => m.type === "error", 5000, "err").catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  if (err) {
    console.log(`SEND ERROR: ${err.message}`);
    return;
  }
  let grew = false;
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const now = await fetchTimeline(ws, threadId).catch(() => null);
    if (now && (now.entries?.length || 0) > baseline) {
      grew = true;
      console.log(`timeline ${baseline} → ${now.entries.length} ✓`);
      break;
    }
  }
  if (!grew) console.log(`no growth after ${maxWaitSec}s ✗`);
  if (interruptAfter || grew) {
    ws.send(JSON.stringify({ type: "turn.interrupt", threadId }));
    console.log(`  interrupt sent → ${threadId.slice(0, 8)}`);
  }
}

const main = async () => {
  const pairArgs = flag("--pair");
  const deskArgs = flag("--desktop");
  if (pairArgs) {
    const desktopId = deskArgs?.[0] || loadAuth()?.desktopId;
    if (!desktopId) throw new Error("--pair needs --desktop <id>");
    await pair(desktopId, pairArgs[0].toUpperCase());
    return;
  }

  const ws = await phoneSession();
  try {
    const send = flag("--send");
    const intr = flag("--interrupt");
    const create = flag("--create");
    const setCfg = flag("--set-config");

    if (send) {
      ws.send(JSON.stringify({ type: "message.send", threadId: send[0], text: send[1] || "Reply with just: ok" }));
      console.log("sent; watching timeline for 20s…");
      const r = await fetchTimeline(ws, send[0]);
      console.log(`timeline now ${r.entries?.length ?? "?"} entries`);
      await new Promise((r2) => setTimeout(r2, 20000));
      const r2 = await fetchTimeline(ws, send[0]);
      console.log(`after 20s: ${r2.entries?.length ?? "?"} entries`);
    } else if (intr) {
      ws.send(JSON.stringify({ type: "turn.interrupt", threadId: intr[0] }));
      console.log("interrupt sent");
    } else if (create) {
      ws.send(JSON.stringify({ type: "thread.create", provider: create[0], projectId: create[1] }));
      const msg = await nextMessage(ws, (m) => m.type === "thread.created" || m.type === "error", 20000, "thread.created");
      console.log(JSON.stringify(msg, null, 2));
    } else if (setCfg) {
      const [tid, model, effort] = setCfg;
      const msg = { type: "thread.setConfig", threadId: tid };
      if (model && model !== "-") msg.model = model;
      if (effort && effort !== "-") msg.reasoningEffort = effort;
      ws.send(JSON.stringify(msg));
      console.log("setConfig sent; next catalog snapshot reflects it");
      const { threads } = await fetchCatalog(ws);
      const t = threads.find((x) => x.id === tid);
      console.log(`thread now model=${t?.model} effort=${t?.reasoningEffort ?? "-"}`);
    } else if (flag("--verify")) {
      const projectId = flag("--verify")[0];
      if (!projectId) throw new Error("--verify <projectId>");
      await verify(ws, projectId);
    } else {
      const threads = await sweep(ws);
      if (args.includes("--exercise")) await exercise(ws, threads);
    }
  } finally {
    ws.close();
  }
};

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
