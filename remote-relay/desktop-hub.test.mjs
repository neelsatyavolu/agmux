import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./src/desktop-hub.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function fixture() {
  const context = { exports: {}, crypto: webcrypto, TextEncoder, Date, Map, Set, Uint8Array, JSON };
  vm.runInNewContext(compiled, context);
  let initialized;
  const sockets = [];
  const state = {
    blockConcurrencyWhile(f) { initialized = f(); },
    storage: { get: async () => ({}), put: async () => {} },
    getWebSockets: () => sockets,
    id: { toString: () => 'desktop-test' },
  };
  const hub = new context.exports.DesktopHub(state, {});
  await initialized;
  const socket = () => {
    const ws = {
      sent: [], readyState: 1,
      send(raw) { this.sent.push(JSON.parse(raw)); },
      serializeAttachment(value) { this.attachment = value; },
      deserializeAttachment() { return this.attachment; },
      close() { this.readyState = 2; },
    };
    sockets.push(ws);
    return ws;
  };
  const deliver = (ws, msg) => hub.webSocketMessage(ws, JSON.stringify(msg));
  const desktop = socket();
  await deliver(desktop, { type: 'hello', role: 'desktop', token: 'a'.repeat(32), desktopId: 'desktop-test' });
  return { hub, socket, deliver, desktop };
}

async function pair(f) {
  await f.deliver(f.desktop, { type: 'pair.create' });
  const phone = f.socket();
  await f.deliver(phone, { type: 'pair.submit', code: f.hub.pairCode });
  return phone;
}

test('one pairing code admits only one concurrent redemption', async () => {
  const f = await fixture();
  await f.deliver(f.desktop, { type: 'pair.create' });
  const code = f.hub.pairCode;
  const phones = [f.socket(), f.socket()];
  await Promise.all(phones.map(ws => f.deliver(ws, { type: 'pair.submit', code })));
  assert.equal(f.hub.devices.length, 1);
  assert.equal(phones.flatMap(ws => ws.sent).filter(msg => msg.type === 'pair.ok').length, 1);
});

test('an already attached phone loses access when its token expires', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.hub.devices[0].expiresAt = Date.now() - 1;
  f.desktop.sent = [];
  await f.deliver(phone, { type: 'message.send', threadId: 't1', text: 'expired' });
  assert.equal(f.desktop.sent.some(msg => msg.type === 'message.send'), false);
  assert.equal(phone.readyState, 2);
});

test('a replaced desktop cannot reclaim routing through its old attachment', async () => {
  const f = await fixture();
  const old = f.desktop;
  const replacement = f.socket();
  await f.deliver(replacement, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  await f.deliver(old, { type: 'threads.snapshot', threads: [] });
  assert.equal(f.hub.desktop, replacement);
});

test('a queued hello from a replaced desktop cannot displace the replacement', async () => {
  const f = await fixture();
  const replacement = f.socket();
  await f.deliver(replacement, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  await f.deliver(f.desktop, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  assert.equal(f.hub.desktop, replacement);
  assert.equal(replacement.readyState, 1);
});

test('frame budget counts UTF-8 bytes before forwarding', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.desktop.sent = [];
  phone.sent = [];
  await f.deliver(phone, { type: 'message.send', threadId: 't1', text: '界'.repeat(400000) });
  assert.equal(f.desktop.sent.some(msg => msg.type === 'message.send'), false);
  assert.equal(phone.sent.at(-1)?.message, 'message too large');
});

test('desktop disconnect during authentication cannot replace a live connection', async () => {
  const f = await fixture();
  const replacement = f.socket();
  const hello = f.deliver(replacement, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  replacement.close();
  await hello;
  assert.equal(f.hub.desktop, f.desktop);
  assert.equal(f.desktop.readyState, 1);
});

test('phone disconnect during pairing leaves its one-time code redeemable', async () => {
  const f = await fixture();
  await f.deliver(f.desktop, { type: 'pair.create' });
  const code = f.hub.pairCode;
  const phone = f.socket();
  const submission = f.deliver(phone, { type: 'pair.submit', code });
  phone.close();
  await submission;
  assert.equal(f.hub.devices.length, 0);
  assert.equal(f.hub.pairCode, code);
});

test('offline create/send failures retain the originating request id', async () => {
  const f = await fixture();
  const phone = await pair(f);
  await f.hub.webSocketClose(f.desktop);
  for (const type of ['thread.create', 'message.send']) {
    phone.sent = [];
    await f.deliver(phone, { type, requestId: 'phone-a-1', threadId: 't1', text: 'hello', provider: 'Grok', projectId: 'p1' });
    const error = phone.sent.find(msg => msg.type === 'error');
    assert.equal(error?.requestId, 'phone-a-1');
  }
});

test('expired phone cannot receive desktop transcripts either', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.hub.devices[0].expiresAt = Date.now() - 1;
  phone.sent = [];
  await f.deliver(f.desktop, { type: 'timeline.snapshot', threadId: 't1', entries: [] });
  assert.equal(phone.sent.some(msg => msg.type === 'timeline.snapshot'), false);
});

test('revoke closes a hibernated phone missing from the phones map', async () => {
  const f = await fixture();
  const phone = await pair(f);
  const deviceId = f.hub.devices[0].id;
  f.hub.phones.clear();
  f.hub.sessions.delete(phone);
  await f.deliver(f.desktop, { type: 'devices.revoke', deviceId });
  assert.equal(phone.readyState, 2);
  assert.equal(f.hub.devices.length, 0);
});

test('desktop close after hibernation still notifies phones', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.hub.sessions.clear();
  f.hub.phones.clear();
  f.hub.desktop = null;
  phone.sent = [];
  f.desktop.readyState = 2;
  await f.hub.webSocketClose(f.desktop);
  assert.equal(phone.sent.some(msg => msg.type === 'desktop.offline'), true);
});

test('revokeAll closes hibernated phone sockets', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.hub.phones.clear();
  f.hub.sessions.delete(phone);
  await f.deliver(f.desktop, { type: 'devices.revokeAll' });
  assert.equal(phone.readyState, 2);
  assert.equal(f.hub.devices.length, 0);
});

test('phone cannot revoke devices or impersonate desktop transcript messages', async () => {
  const f = await fixture();
  const phone = await pair(f);
  const other = await pair(f);
  other.sent = [];
  await f.deliver(phone, { type: 'devices.revokeAll' });
  await f.deliver(phone, { type: 'timeline.snapshot', threadId: 't1', entries: [] });
  assert.equal(f.hub.devices.length, 2);
  assert.equal(other.sent.length, 0);
  assert.equal(phone.sent.filter(m => m.type === 'error').length, 2);
});

test('catalog chunk sequence metadata survives relay forwarding', async () => {
  const f = await fixture();
  const phone = await pair(f);
  const frame = { type: 'threads.snapshot', threads: [], snapshotId: 'snapshot-1', chunkIndex: 0, chunkCount: 2 };
  await f.deliver(f.desktop, frame);
  assert.deepEqual(phone.sent.at(-1), frame);
});

test('desktop-offline replies carry the request and thread they answer', async () => {
  const f = await fixture();
  const phone = await pair(f);
  f.desktop.readyState = 3;
  phone.sent = [];
  await f.deliver(phone, { type: 'approval.respond', threadId: 't1', requestId: 'a1', decision: 'allow' });
  await f.deliver(phone, { type: 'models.list', provider: 'Cursor', requestId: 'm1' });
  const errors = phone.sent.filter(msg => msg.type === 'error');
  assert.deepEqual(errors.map(e => [e.message, e.requestId, e.threadId]), [
    ['desktop offline', 'a1', 't1'],
    ['desktop offline', 'm1', undefined],
  ]);
});
