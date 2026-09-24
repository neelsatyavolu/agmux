import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

/** Records every socket the page opens instead of dialing the relay. */
class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.all.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

function phone() {
  FakeSocket.all = [];
  const dom = new JSDOM(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: value => String(value) };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.WebSocket = Object.assign(FakeSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0 });
      window.confirm = () => true;
    },
  });
  return dom;
}

function connected(w) {
  w.eval(`
    ws = {readyState: 1, send() {}};
    set('paired', '1');
    set('conn', 'connected');
    desktopCapabilities = ['images', 'message-ack'];
  `);
  w.handleMsg({ type: 'threads.snapshot', threads: [
    { id: 'a', title: 'A', projectId: 'p', projectName: 'My App', provider: 'ClaudeCode', surface: 'chat', processing: false },
    { id: 'b', title: 'B', projectId: 'p', projectName: 'My App', provider: 'ClaudeCode', surface: 'chat', processing: false },
  ] });
}

test('new-chat project picker, chip and chat head show the human project name', () => {
  const w = phone().window;
  try {
    connected(w);
    assert.deepEqual([...w.ncProjects()].map(p => p.name), ['My App']);
    assert.equal(w.projectIdForGroupName('My App', []), 'p');
    w.openNewChat();
    assert.equal(w.document.getElementById('projectChipLbl').textContent, 'My App');
    assert.equal(w.document.getElementById('chProj').textContent, 'My App');
    w.openCompMenu('project');
    const items = [...w.document.querySelectorAll('#compMenu .cm-item span')].map(el => el.textContent);
    assert.deepEqual(items, ['My App']);
    assert.doesNotMatch(w.document.body.textContent, /%5B/);
  } finally { w.close(); }
});

test('temp image paths from both the agmux and legacy xanom dirs are stripped', () => {
  const w = phone().window;
  try {
    assert.equal(w.stripTempImagePathTokens('"/Users/x/.agmux/tmp/a b.png" /Users/x/.xanom/tmp/c.png look'), 'look');
  } finally { w.close(); }
});

test('every desktop provider gets its own label and a non-Claude avatar', () => {
  const types = readFileSync(new URL('../../src/lib/types.ts', import.meta.url), 'utf8');
  const union = /export type Provider =([^;]+);/.exec(types)[1];
  const providers = [...union.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.ok(providers.length >= 12);
  const w = phone().window;
  try {
    for (const p of providers) {
      const label = w.shortProvider(p);
      const icon = w.providerIconSrc(p);
      assert.ok(label, `${p} has a label`);
      if (p === 'ClaudeCode') continue;
      assert.notEqual(label, 'Claude', `${p} label`);
      assert.notEqual(icon, 'icons/claude.svg', `${p} avatar`);
      if (icon.startsWith('icons/')) assert.ok(existsSync(new URL(`../public/${icon}`, import.meta.url)), `${icon} exists`);
      else assert.match(icon, /^data:image\/svg\+xml,/, `${p} letter avatar`);
    }
    assert.equal(w.shortProvider('Somethingnew'), 'Somethingnew');
    assert.match(w.providerIconSrc('Somethingnew'), /^data:image\/svg\+xml,/);
  } finally { w.close(); }
});

test('an iOS deep link that rewrites the hash after boot pairs exactly once', () => {
  const w = phone().window;
  try {
    assert.equal(FakeSocket.all.length, 0);
    w.history.replaceState({}, '', '/#pair=abcd1234&desktopId=desk-1');
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    assert.equal(FakeSocket.all.length, 1);
    assert.match(FakeSocket.all[0].url, /desktopId=desk-1/);
    assert.equal(w.location.hash, '', 'one-time code is stripped from the address bar');
    FakeSocket.all[0].onopen();
    assert.deepEqual(FakeSocket.all[0].sent, [{ type: 'pair.submit', code: 'ABCD1234' }]);
    assert.equal(w.document.getElementById('stage').dataset.pair, 'pairing');
  } finally { w.close(); }
});

test('pairing surfaces an error when the socket closes before an answer', () => {
  const w = phone().window;
  try {
    w.document.getElementById('fDesk').value = 'desk-1';
    w.document.getElementById('fCode').value = 'ABCD1234';
    w.doPair();
    FakeSocket.all[0].onclose();
    assert.equal(w.document.getElementById('stage').dataset.pair, 'error');
    assert.match(w.document.getElementById('errText').textContent, /closed before pairing/);
  } finally { w.close(); }
});

test('a revoked phone (close 4003) unpairs immediately', () => {
  const w = phone().window;
  try {
    w.eval(`auth = {phoneToken: 'tok', desktopId: 'desk-1'};`);
    w.connectPhone();
    const sock = FakeSocket.all.at(-1);
    sock.onclose({ code: 4003 });
    const stage = w.document.getElementById('stage');
    assert.equal(stage.dataset.paired, '0');
    assert.equal(FakeSocket.all.length, 1, 'no reconnect attempts');
    assert.match(w.document.getElementById('errText').textContent, /revoked on your Mac/);
  } finally { w.close(); }
});

test('session list shows loading, Mac-offline and empty states, and unlink clears rows', () => {
  const w = phone().window;
  try {
    const list = () => w.document.getElementById('sideList').textContent;
    assert.equal(w.document.getElementById('sCount').textContent, '0');
    w.eval(`ws = {readyState: 1, send() {}}; set('paired', '1');`);
    w.setConn('connected');
    assert.match(list(), /Loading sessions/);
    w.setConn('desktop-offline');
    assert.match(list(), /Your Mac is offline/);
    w.setConn('connected');
    w.handleMsg({ type: 'threads.snapshot', threads: [] });
    assert.match(list(), /No sessions yet/);
    connected(w);
    assert.equal(w.document.querySelectorAll('.srow').length, 2);
    w.unlink();
    assert.equal(w.document.querySelectorAll('.srow').length, 0);
    assert.equal(w.document.getElementById('sCount').textContent, '0');
  } finally { w.close(); }
});

test('a load error for another thread does not replace the open timeline', () => {
  const w = phone().window;
  try {
    connected(w);
    w.openThread('a');
    const stage = w.document.getElementById('stage');
    assert.equal(stage.dataset.loading, '1');
    w.handleMsg({ type: 'error', message: 'desktop offline', threadId: 'b' });
    assert.equal(stage.dataset.loading, '1');
    assert.match(w.document.getElementById('toastHost').textContent, /desktop offline/);
    w.handleMsg({ type: 'error', message: 'history failed', threadId: 'a' });
    assert.equal(stage.dataset.loading, '0');
    assert.match(w.document.getElementById('thread').textContent, /history failed/);
  } finally { w.close(); }
});

test('offline sends, attach errors and approval buttons give visible feedback', () => {
  const w = phone().window;
  try {
    connected(w);
    w.openThread('a');
    w.setConn('offline');
    w.document.getElementById('compText').value = 'hello';
    w.send();
    assert.match(w.document.getElementById('toastHost').textContent, /Not connected to your Mac/);
    assert.equal(w.document.getElementById('compText').value, 'hello');
    assert.equal(typeof w.toast, 'undefined');
    w.showUserInputSheet({ threadId: 'a', requestId: 'r', questions: [] });
    assert.equal(w.document.querySelector('#allowBtn .lbl').textContent, 'Submit');
    assert.equal(w.document.querySelector('#allowBtn kbd').textContent, '⌘⏎');
    assert.equal(w.document.querySelector('#denyBtn kbd').textContent, '⌘⌫');
  } finally { w.close(); }
});
