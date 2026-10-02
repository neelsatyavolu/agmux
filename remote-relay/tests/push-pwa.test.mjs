import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const TOKEN = 'ab'.repeat(32);

/** A paired phone page whose socket records what it sends. */
function paired(t, file = 'app.html') {
  const notifications = [];
  const dom = new JSDOM(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.localStorage.setItem('agmux-remote-auth', JSON.stringify({ phoneToken: 'p', desktopId: 'd' }));
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: (value) => String(value) };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.WebSocket = Object.assign(class { send() {} close() {} }, { OPEN: 1, CLOSED: 3, CONNECTING: 0 });
      window.confirm = () => true;
      window.Notification = class {
        static permission = 'granted';
        constructor(title) { notifications.push(title); }
        close() {}
      };
    },
  });
  const w = dom.window;
  t.after(() => w.close());
  const raw = [];
  w.eval('ws = { readyState: 1, send(raw) { window.__sent.push(raw); }, close() { this.readyState = 3; } }');
  w.__sent = raw;
  // Parse here, not in the page, so objects compare by value.
  const sent = { find: (f) => raw.map((r) => JSON.parse(r)).find(f), filter: (f) => raw.map((r) => JSON.parse(r)).filter(f),
    some: (f) => raw.map((r) => JSON.parse(r)).some(f), get length() { return raw.length; } };
  w.document.hasFocus = () => false;
  return { w, sent, notifications };
}

for (const file of ['app.html', 'index.html']) {
  test(`${file}: the push token and alert choices reach the relay on connect`, (t) => {
    const { w, sent } = paired(t, file);
    w.setPushToken(TOKEN);
    assert.equal(sent.length, 0, 'not before the relay says hello');
    w.handleMsg({ type: 'hello.ok', role: 'phone' });
    assert.deepEqual(sent.find((m) => m.type === 'push.register'), { type: 'push.register', token: TOKEN, approvals: true, finished: true });
    assert.equal(w.localStorage.getItem('agmux-remote-push'), TOKEN);
  });
}

test('changing a Settings switch updates the relay', (t) => {
  const { w, sent } = paired(t);
  w.setPushToken(TOKEN);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.setPref('notifyFinished', false);
  assert.deepEqual(sent.filter((m) => m.type === 'push.register').at(-1), { type: 'push.register', token: TOKEN, approvals: true, finished: false });
});

test('once the relay pushes, the page stops showing its own alerts', (t) => {
  const { w, notifications } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.notifyFinished({ id: 't', title: 'A' });
  assert.equal(notifications.length, 1);
  w.handleMsg({ type: 'push.registered', enabled: true });
  w.notifyFinished({ id: 't', title: 'A' });
  w.notifyBlocked({ type: 'approval.requested', threadId: 't', requestId: 'r' });
  assert.equal(notifications.length, 1);
  w.renderPrefs();
  assert.match(w.document.getElementById('prefsNotifNote').textContent, /even when the app is closed/);
});

test('Forget this Mac stops pushes for this phone', (t) => {
  const { w, sent } = paired(t);
  w.setPushToken(TOKEN);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.unlink();
  assert.ok(sent.some((m) => m.type === 'push.unregister'));
});

test('a tapped notification opens its session once the list arrives', (t) => {
  const { w, sent } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.openThreadWhenReady('t9');
  assert.equal(w.eval('activeThreadId'), null);
  w.handleMsg({ type: 'threads.snapshot', threads: [{ id: 't9', title: 'Ship it', projectId: 'p', projectName: 'App', provider: 'ClaudeCode', surface: 'chat', processing: false }] });
  assert.equal(w.eval('activeThreadId'), 't9');
  assert.ok(sent.some((m) => m.type === 'thread.subscribe' && m.threadId === 't9'));
});

test('an older relay without push support shows no error', (t) => {
  const { w } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.handleMsg({ type: 'error', message: 'cannot forward push.register' });
  w.handleMsg({ type: 'error', message: 'cannot forward app.state' });
  assert.equal(w.document.getElementById('toastHost')?.textContent ?? '', '');
  // The guard is not hiding every error.
  w.handleMsg({ type: 'error', message: 'desktop offline' });
  assert.match(w.document.getElementById('toastHost')?.textContent ?? '', /desktop offline/i);
});
