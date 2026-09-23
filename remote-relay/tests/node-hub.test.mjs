import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
// Exercise the real hub without binding a port or writing auth to disk.
const hubSource = source.slice(source.indexOf('function hashToken'), source.indexOf('function getHub'));

function fixture(authFile, authError) {
  const context = {
    createHash, randomBytes, randomUUID, timingSafeEqual, Buffer, Date, Map, Set, JSON,
    join, DATA_DIR: '/unused', TOKEN_TTL_MS: 90 * 24 * 60 * 60 * 1000,
    MIN_DESKTOP_SECRET_LEN: 32, PAIR_FAIL_LIMIT: 20, PAIR_FAIL_WINDOW_MS: 600000,
    MAX_MESSAGE_BYTES: 1024 * 1024, process: { pid: 1 },
    existsSync: () => authFile !== undefined,
    readFileSync: () => {
      if (authError) throw Object.assign(new Error(authError), { code: authError });
      if (authFile === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return authFile;
    },
    writeFileSync() {}, renameSync() {}, console: { warn() {} },
  };
  vm.runInNewContext(hubSource + '\nglobalThis.Hub = DesktopHub;', context);
  const hub = new context.Hub('desktop-test');
  const socket = () => ({
    readyState: 1, sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close() { this.readyState = 2; },
  });
  const deliver = (ws, msg) => hub.handleMessage(ws, Buffer.from(JSON.stringify(msg)));
  const desktop = socket();
  deliver(desktop, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  const pair = () => {
    deliver(desktop, { type: 'pair.create' });
    const phone = socket();
    deliver(phone, { type: 'pair.submit', code: hub.pairCode });
    return phone;
  };
  return { hub, socket, deliver, desktop, pair };
}

test('Node relay ignores a queued hello from a replaced desktop', () => {
  const f = fixture();
  const replacement = f.socket();
  f.deliver(replacement, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  f.deliver(f.desktop, { type: 'hello', role: 'desktop', token: 'a'.repeat(32) });
  assert.equal(f.hub.desktop, replacement);
  assert.equal(replacement.readyState, 1);
});

test('Node relay reports live phones on pair and disconnect', () => {
  const f = fixture();
  assert.equal(f.desktop.sent.at(-1).phonesOnline, 0);
  const phone = f.pair();
  assert.equal(f.desktop.sent.at(-1).phonesOnline, 1);
  f.hub.detach(phone);
  assert.equal(f.desktop.sent.at(-1).phonesOnline, 0);
});

test('Node relay counts only live, unexpired phone sockets', () => {
  const f = fixture();
  const expired = f.pair();
  const closed = f.pair();
  f.hub.devices.find(d => d.id === f.hub.sessions.get(expired).deviceId).expiresAt = Date.now() - 1;
  closed.readyState = 2;
  f.deliver(f.desktop, { type: 'devices.list' });
  assert.equal(f.desktop.sent.at(-1).phonesOnline, 0);
});

test('Node relay expires phone tokens before forwarding or broadcasting', () => {
  const f = fixture();
  const phone = f.pair();
  f.hub.devices[0].expiresAt = Date.now() - 1;
  phone.sent = [];
  f.desktop.sent = [];
  f.deliver(phone, { type: 'message.send', threadId: 't', text: 'expired' });
  f.deliver(f.desktop, { type: 'timeline.snapshot', threadId: 't', entries: [] });
  assert.equal(f.desktop.sent.some(m => m.type === 'message.send'), false);
  assert.equal(phone.sent.some(m => m.type === 'timeline.snapshot'), false);
});

test('Node relay cannot re-enroll a desktop when its saved auth is corrupt', () => {
  for (const auth of ['{broken', '{}', '{"desktopSecretHash":42}', '{"desktopSecretHash":"broken"}']) {
    const f = fixture(auth);
    assert.equal(f.hub.desktop, null, auth);
    assert.equal(f.desktop.sent.some(m => m.type === 'hello.ok'), false);
    assert.equal(f.desktop.sent.at(-1)?.message, 'relay authentication storage unavailable');
    assert.equal(f.desktop.readyState, 2);
  }
});

test('Node relay retains valid hashed and legacy saved desktop identities', () => {
  for (const auth of [
    { desktopSecretHash: createHash('sha256').update('a'.repeat(32)).digest('hex') },
    { desktopSecret: 'a'.repeat(32), phoneTokens: [] },
  ]) {
    const f = fixture(JSON.stringify(auth));
    assert.equal(f.hub.desktop, f.desktop);
    assert.equal(f.desktop.sent.some(m => m.type === 'hello.ok'), true);
  }
});

test('Node relay does not mistake inaccessible auth storage for a new desktop', () => {
  const f = fixture(undefined, 'EACCES');
  assert.equal(f.hub.desktop, null);
  assert.equal(f.desktop.sent.some(m => m.type === 'hello.ok'), false);
  assert.equal(f.desktop.readyState, 2);
});
