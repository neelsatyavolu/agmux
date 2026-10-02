import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

/** A paired, connected phone page with one open chat session. */
function chat(t, { consent = false, file = 'app.html' } = {}) {
  const dom = new JSDOM(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.localStorage.setItem('agmux-remote-auth', JSON.stringify({ phoneToken: 'p', desktopId: 'd' }));
      if (consent) window.localStorage.setItem('agmux-remote-ai-consent', '1');
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: (value) => String(value) };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.WebSocket = Object.assign(class { send() {} close() {} }, { OPEN: 1, CLOSED: 3, CONNECTING: 0 });
    },
  });
  const w = dom.window;
  t.after(() => w.close());
  const raw = [];
  w.__sent = raw;
  w.eval(`ws = { readyState: 1, send(raw) { window.__sent.push(raw); }, close() {} };
    set('paired', '1'); set('conn', 'connected'); desktopCapabilities = ['message-ack'];`);
  w.handleMsg({ type: 'threads.snapshot', threads: [{ id: 'a', title: 'A', projectId: 'p', projectName: 'App', provider: 'ClaudeCode', surface: 'chat', processing: false }] });
  w.openThread('a');
  const sends = () => raw.map((r) => JSON.parse(r)).filter((m) => m.type === 'message.send');
  const type = (text) => {
    const input = w.document.getElementById('compText');
    input.value = text;
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  return { w, doc: w.document, stage: w.document.getElementById('stage'), sends, type };
}

for (const file of ['app.html', 'index.html']) {
  test(`${file}: the first message asks before anything goes to the agents`, (t) => {
    const { doc, stage, sends, type } = chat(t, { file });
    type('Fix the build');
    doc.getElementById('sendBtn').click();
    assert.equal(stage.dataset.consent, '1');
    assert.equal(sends().length, 0);
    assert.match(doc.querySelector('.consent').textContent, /AI providers/);
    assert.equal(doc.getElementById('compText').value, 'Fix the build', 'the message stays in the box');
  });
}

test('Continue sends the message and is remembered', (t) => {
  const { w, doc, stage, sends, type } = chat(t);
  type('Fix the build');
  doc.getElementById('sendBtn').click();
  doc.getElementById('consentContinue').click();
  assert.notEqual(stage.dataset.consent, '1');
  assert.deepEqual(sends().map((m) => m.text), ['Fix the build']);
  assert.equal(w.localStorage.getItem('agmux-remote-ai-consent'), '1');
  type('And run the tests');
  doc.getElementById('sendBtn').click();
  // No second prompt; the message leaves the box (sent or queued behind the first turn).
  assert.notEqual(stage.dataset.consent, '1');
  assert.equal(doc.getElementById('compText').value, '');
});

test('Not now sends nothing', (t) => {
  const { doc, stage, sends, type } = chat(t);
  type('Fix the build');
  doc.getElementById('sendBtn').click();
  doc.getElementById('consentCancel').click();
  assert.notEqual(stage.dataset.consent, '1');
  assert.equal(sends().length, 0);
});

test('consent can be withdrawn in Settings, and the next send asks again', (t) => {
  const { w, doc, stage, sends, type } = chat(t, { consent: true });
  w.openPrefs();
  const sw = doc.getElementById('prefAiConsent');
  assert.equal(sw.checked, true);
  sw.checked = false;
  sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.localStorage.getItem('agmux-remote-ai-consent'), null);
  w.closePrefs();
  type('Hello');
  doc.getElementById('sendBtn').click();
  assert.equal(stage.dataset.consent, '1');
  assert.equal(sends().length, 0);
});
