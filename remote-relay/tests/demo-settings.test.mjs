import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens the phone page with no pairing; every real socket attempt is recorded. */
function phone(file = 'app.html', storage = {}) {
  const sockets = [];
  const notifications = [];
  const dom = new JSDOM(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: (value) => String(value) };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.WebSocket = Object.assign(class { constructor(url) { sockets.push(url); } send() {} close() {} }, { OPEN: 1, CLOSED: 3, CONNECTING: 0 });
      window.confirm = () => true;
      window.Notification = class {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title, opts) { notifications.push({ title, ...opts }); }
        close() {}
      };
    },
  });
  const w = dom.window;
  w.eval('demoPace = 0.02');
  return { w, doc: w.document, stage: w.document.getElementById('stage'), sockets, notifications };
}

for (const file of ['app.html', 'index.html']) {
  test(`${file}: Try a demo shows sample sessions without pairing or connecting`, async (t) => {
    const { w, doc, stage, sockets } = phone(file);
    t.after(() => w.close());
    doc.getElementById('demoBtn').click();
    await sleep(60);
    assert.equal(stage.dataset.paired, '1');
    assert.equal(stage.dataset.demo, '1');
    assert.match(doc.getElementById('sideList').textContent, /Fix the flaky checkout test/);
    assert.match(doc.getElementById('connPillMobile').textContent, /Demo/);
    assert.deepEqual(sockets, []);
    assert.equal(w.localStorage.getItem('agmux-remote-auth'), null);
  });
}

test('demo approval: allowing runs the tests and the agent reports back', async (t) => {
  const { w, doc, stage } = phone();
  t.after(() => w.close());
  doc.getElementById('demoBtn').click();
  await sleep(40);
  w.openThread('demo-tests');
  await sleep(60);
  assert.equal(stage.dataset.approval, '1');
  assert.match(doc.getElementById('apprDetail').textContent, /npm test -- checkout\.spec\.ts/);
  doc.getElementById('allowBtn').click();
  await sleep(250);
  assert.notEqual(stage.dataset.approval, '1');
  assert.match(doc.body.textContent, /All 24 checkout tests pass/);
});

test('demo chat: a sent message gets a reply that explains the demo', async (t) => {
  const { w, doc } = phone();
  t.after(() => w.close());
  doc.getElementById('demoBtn').click();
  await sleep(40);
  w.openThread('demo-orders');
  await sleep(40);
  const input = doc.getElementById('compText');
  input.value = 'Make that change';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  doc.getElementById('sendBtn').click();
  await sleep(250);
  assert.match(doc.body.textContent, /Make that change/);
  assert.match(doc.body.textContent, /This is a demo, so nothing ran on a Mac/);
});

test('Exit demo returns to pairing without asking and without saving anything', async (t) => {
  const { w, doc, stage, sockets } = phone();
  t.after(() => w.close());
  let asked = false;
  w.confirm = () => { asked = true; return true; };
  doc.getElementById('demoBtn').click();
  await sleep(40);
  assert.match(doc.querySelector('#ovMenuMobile [data-act="unlink"]').textContent, /Exit demo/);
  w.unlink();
  assert.equal(asked, false);
  assert.equal(stage.dataset.paired, '0');
  assert.equal(stage.dataset.demo, '0');
  assert.match(doc.querySelector('#ovMenuMobile [data-act="unlink"]').textContent, /Forget this Mac/);
  assert.deepEqual(sockets, []);
  assert.equal(w.localStorage.getItem('agmux-remote-auth'), null);
});

test('Settings opens from the menu and remembers notification choices', async (t) => {
  const { w, doc, stage } = phone();
  t.after(() => w.close());
  doc.getElementById('demoBtn').click();
  await sleep(40);
  doc.querySelector('#ovMenuMobile [data-act="settings"]').click();
  assert.equal(stage.dataset.prefs, '1');
  assert.equal(doc.getElementById('prefsNotifState').textContent, 'On');
  const finished = doc.getElementById('prefFinished');
  assert.equal(finished.checked, true);
  finished.checked = false;
  finished.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(JSON.parse(w.localStorage.getItem('agmux-remote-prefs')).notifyFinished, false);
  doc.getElementById('prefsClose').click();
  assert.equal(stage.dataset.prefs, '0');
});

test('the running demo session finishes on its own', async (t) => {
  const { w, doc } = phone();
  t.after(() => w.close());
  doc.getElementById('demoBtn').click();
  await sleep(40);
  assert.equal(w.eval("threads.find((x) => x.id === 'demo-dark').processing"), true);
  await sleep(200);
  assert.equal(w.eval("threads.find((x) => x.id === 'demo-dark').processing"), false);
  w.openThread('demo-dark');
  await sleep(40);
  assert.match(doc.body.textContent, /Added a Theme row to Settings/);
});

test('notifications follow the Settings switches', async (t) => {
  const { w, notifications } = phone('app.html', { 'agmux-remote-prefs': JSON.stringify({ notifyApprovals: false }) });
  t.after(() => w.close());
  w.document.hasFocus = () => false;
  w.notifyBlocked({ type: 'approval.requested', threadId: 't', requestId: 'r', toolName: 'Bash' });
  assert.equal(notifications.length, 0);
  w.notifyFinished({ id: 't', title: 'Fix the build' });
  assert.deepEqual(notifications.map((n) => [n.title, n.body]), [['Agent finished', 'Fix the build']]);
});

test('a session that stops working while in the background notifies once', async (t) => {
  const { w, doc, notifications } = phone();
  t.after(() => w.close());
  w.document.hasFocus = () => false;
  doc.getElementById('demoBtn').click();
  await sleep(40);
  w.handleMsg({ type: 'threads.upsert', thread: { id: 'demo-dark', title: 'Add a dark mode switch', provider: 'Codex', projectId: 'p-mobile', surface: 'chat', processing: false } });
  w.handleMsg({ type: 'threads.upsert', thread: { id: 'demo-dark', title: 'Add a dark mode switch', provider: 'Codex', projectId: 'p-mobile', surface: 'chat', processing: false } });
  assert.deepEqual(notifications.map((n) => n.title), ['Agent finished']);
});
