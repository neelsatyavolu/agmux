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
      // These sessions already agreed to send messages to their agents (App Store 5.1.2).
      window.localStorage.setItem('agmux-remote-ai-consent', '1');
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

const SAMPLE_THREAD = { id: 't9', title: 'Ship it', projectId: 'p', projectName: 'App', provider: 'ClaudeCode', surface: 'chat', processing: false };

test('a tapped notification opens its session once the list arrives', (t) => {
  const { w, sent } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.openThreadWhenReady('t9');
  assert.equal(w.eval('activeThreadId'), null);
  w.handleMsg({ type: 'threads.snapshot', threads: [SAMPLE_THREAD] });
  assert.equal(w.eval('activeThreadId'), 't9');
  assert.ok(sent.some((m) => m.type === 'thread.subscribe' && m.threadId === 't9'));
});

test('a tapped local alert waits for the session list instead of failing closed', (t) => {
  const { w } = paired(t);
  let note;
  w.Notification = class {
    static permission = 'granted';
    constructor() { note = this; }
    close() {}
  };
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.notifyBlocked({ type: 'approval.requested', threadId: 't9', requestId: 'r', toolName: 'Bash' });
  assert.equal(typeof note?.onclick, 'function');
  note.onclick();
  assert.equal(w.eval('activeThreadId'), null);
  assert.equal(w.eval('pendingOpenThread'), 't9');
  w.handleMsg({ type: 'threads.snapshot', threads: [SAMPLE_THREAD] });
  assert.equal(w.eval('activeThreadId'), 't9');
});

test('a cold notification open reads ?thread= once the list arrives', (t) => {
  const { w } = paired(t);
  w.history.replaceState({}, '', '/?thread=t9');
  w.consumeNotificationThread();
  assert.equal(new w.URL(w.location.href).searchParams.get('thread'), null);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.handleMsg({ type: 'threads.snapshot', threads: [SAMPLE_THREAD] });
  assert.equal(w.eval('activeThreadId'), 't9');
});

test('a notification for a deleted session says so', (t) => {
  const { w } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.openThreadWhenReady('gone');
  w.handleMsg({ type: 'threads.snapshot', threads: [{ ...SAMPLE_THREAD, id: 'other' }] });
  assert.equal(w.eval('pendingOpenThread'), null);
  assert.match(w.document.getElementById('toastHost')?.textContent ?? '', /no longer on your Mac/i);
});

test('Allow says when the phone is not connected', (t) => {
  const { w } = paired(t);
  w.handleMsg({ type: 'hello.ok', role: 'phone' });
  w.eval('ws.readyState = 3; pendingApproval = { threadId: "t9", requestId: "r" }; respondApproval("allow")');
  assert.match(w.document.getElementById('toastHost')?.textContent ?? '', /Not connected to your Mac/i);
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
