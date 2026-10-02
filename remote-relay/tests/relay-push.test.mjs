import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto, { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compile = (file) => ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sources = { hub: compile('desktop-hub.ts'), './push': compile('push.ts'), './push-events': compile('push-events.ts') };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUSH_ENV = {
  APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  APNS_KEY_ID: 'KEY1234567',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_TOPIC: 'dev.agmux.remote',
};
const DEVICE_TOKEN = 'ab'.repeat(32);

/** APNs stand-in: records requests and answers from a script of [status, reason]. */
function apns(script = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const [status, reason] = script.shift() ?? [200];
    return { status, json: async () => ({ reason }) };
  };
  return { calls, fetch };
}

async function fixture({ env = PUSH_ENV, script } = {}) {
  const server = apns(script);
  const stored = [];
  const context = { exports: {}, crypto: webcrypto, TextEncoder, Date, Map, Set, Uint8Array, JSON, btoa, atob, fetch: server.fetch };
  context.require = (name) => {
    const mod = { exports: {} };
    vm.runInNewContext(sources[name], { ...context, exports: mod.exports, module: mod });
    return mod.exports;
  };
  vm.runInNewContext(sources.hub, context);
  let initialized;
  const sockets = [];
  const state = {
    blockConcurrencyWhile(f) { initialized = f(); },
    storage: { get: async () => ({}), put: async (_k, v) => { stored.push(JSON.parse(JSON.stringify(v))); } },
    getWebSockets: () => sockets.filter((s) => s.readyState === 1),
    id: { toString: () => 'desktop-test' },
  };
  const hub = new context.exports.DesktopHub(state, { ...env });
  await initialized;
  const socket = () => {
    const ws = {
      sent: [], readyState: 1,
      send(raw) { this.sent.push(JSON.parse(raw)); },
      serializeAttachment(value) { this.attachment = value; },
      deserializeAttachment() { return this.attachment; },
      close() { this.readyState = 3; },
    };
    sockets.push(ws);
    return ws;
  };
  const deliver = (ws, msg) => hub.webSocketMessage(ws, JSON.stringify(msg));
  const desktop = socket();
  await deliver(desktop, { type: 'hello', role: 'desktop', token: 'a'.repeat(32), desktopId: 'desktop-test' });
  await deliver(desktop, { type: 'pair.create' });
  const phone = socket();
  await deliver(phone, { type: 'pair.submit', code: hub.pairCode });
  const hangUp = async (ws) => { ws.readyState = 3; await hub.webSocketClose(ws); };
  return { hub, desktop, phone, deliver, hangUp, server, stored };
}

const snapshot = { type: 'threads.snapshot', threads: [{ id: 't1', title: 'Fix the flaky test', processing: true }] };
const approval = { type: 'approval.requested', threadId: 't1', requestId: 'r1', toolName: 'Bash', detail: 'npm test' };

test('a phone registers for push and is told whether the relay can send', async () => {
  const f = await fixture();
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN, approvals: true, finished: false });
  assert.deepEqual(f.phone.sent.at(-1), { type: 'push.registered', enabled: true });
  const saved = f.stored.at(-1).devices[0].push;
  assert.equal(saved.token, DEVICE_TOKEN);
  assert.equal(saved.env, 'production');
  assert.equal(saved.finished, false);
  assert.equal(f.desktop.sent.some((m) => m.type === 'push.register'), false, 'never forwarded to the Mac');
});

test('an approval reaches a closed app as a signed APNs alert', async () => {
  const f = await fixture();
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  await f.hangUp(f.phone);
  await f.deliver(f.desktop, snapshot);
  await f.deliver(f.desktop, approval);
  await f.hub.pushWork;
  assert.equal(f.server.calls.length, 1);
  const [call] = f.server.calls;
  assert.equal(call.url, `https://api.push.apple.com/3/device/${DEVICE_TOKEN}`);
  assert.equal(call.headers['apns-topic'], 'dev.agmux.remote');
  assert.equal(call.headers['apns-push-type'], 'alert');
  assert.equal(call.headers['apns-collapse-id'], 'ask-r1');
  assert.deepEqual(call.body.aps.alert, { title: 'Approval needed', body: 'Bash · Fix the flaky test' });
  assert.equal(call.body.threadId, 't1');
  const [header, claims, sig] = call.headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM123456');
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('a phone with agmux open in the foreground gets no push; in the background it does', async () => {
  const f = await fixture();
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  await f.deliver(f.desktop, snapshot);
  await f.deliver(f.desktop, approval);
  await f.hub.pushWork;
  assert.equal(f.server.calls.length, 0);
  await f.deliver(f.phone, { type: 'app.state', state: 'background' });
  await f.deliver(f.desktop, { ...approval, requestId: 'r2' });
  await f.hub.pushWork;
  assert.equal(f.server.calls.length, 1);
});

test('finished runs alert once, and only when that switch is on', async () => {
  const f = await fixture();
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN, approvals: false, finished: true });
  await f.hangUp(f.phone);
  await f.deliver(f.desktop, snapshot);
  await f.deliver(f.desktop, approval);
  await f.deliver(f.desktop, { type: 'threads.upsert', thread: { id: 't1', title: 'Fix the flaky test', processing: false } });
  await f.deliver(f.desktop, { type: 'threads.upsert', thread: { id: 't1', title: 'Fix the flaky test', processing: false } });
  await f.hub.pushWork;
  assert.deepEqual(f.server.calls.map((c) => c.body.aps.alert), [{ title: 'Agent finished', body: 'Fix the flaky test' }]);
});

test('a sandbox token is retried there and remembered', async () => {
  const f = await fixture({ script: [[400, 'BadDeviceToken'], [200], [200]] });
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  await f.hangUp(f.phone);
  await f.deliver(f.desktop, approval);
  await f.hub.pushWork;
  assert.deepEqual(f.server.calls.map((c) => new URL(c.url).host), ['api.push.apple.com', 'api.sandbox.push.apple.com']);
  assert.equal(f.stored.at(-1).devices[0].push.env, 'sandbox');
  await f.deliver(f.desktop, { ...approval, requestId: 'r2' });
  await f.hub.pushWork;
  assert.equal(new URL(f.server.calls.at(-1).url).host, 'api.sandbox.push.apple.com');
});

test('a token Apple says is gone is dropped', async () => {
  const f = await fixture({ script: [[410, 'Unregistered']] });
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  await f.hangUp(f.phone);
  await f.deliver(f.desktop, approval);
  await f.hub.pushWork;
  assert.equal(f.stored.at(-1).devices[0].push, undefined);
});

test('without APNs secrets the relay says so and never calls Apple', async () => {
  const f = await fixture({ env: {} });
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  assert.deepEqual(f.phone.sent.at(-1), { type: 'push.registered', enabled: false });
  await f.hangUp(f.phone);
  await f.deliver(f.desktop, approval);
  await f.hub.pushWork;
  assert.equal(f.server.calls.length, 0);
});

test('bad tokens are refused and unregister stops pushes', async () => {
  const f = await fixture();
  await f.deliver(f.phone, { type: 'push.register', token: 'not-a-token' });
  assert.deepEqual(f.phone.sent.at(-1), { type: 'error', message: 'invalid push token' });
  await f.deliver(f.phone, { type: 'push.register', token: DEVICE_TOKEN });
  await f.deliver(f.phone, { type: 'push.unregister' });
  assert.equal(f.stored.at(-1).devices[0].push, undefined);
});
