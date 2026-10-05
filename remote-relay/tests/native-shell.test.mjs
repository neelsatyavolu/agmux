import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

function page(file) {
  return new JSDOM(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      // These sessions already agreed to send messages to their agents (App Store 5.1.2).
      window.localStorage.setItem('agmux-remote-ai-consent', '1');
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: value => String(value) };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.WebSocket = Object.assign(class { send() {} close() {} }, { OPEN: 1, CLOSED: 3, CONNECTING: 0 });
    },
  }).window;
}

const loc = (href) => {
  const u = new URL(href);
  return { protocol: u.protocol, hostname: u.hostname, host: u.host };
};

test('Universal Links send only pair links to the iPhone app, served as JSON', () => {
  const aasa = JSON.parse(readFileSync(new URL('../public/.well-known/apple-app-site-association', import.meta.url), 'utf8'));
  const [detail] = aasa.applinks.details;
  assert.deepEqual(detail.appIDs, ['VTQW687WBQ.dev.agmux.remote']);
  assert.deepEqual(detail.components.map(c => c['#']), ['*pair=*']);
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/\.well-known\/apple-app-site-association\n\s+Content-Type: application\/json$/m);
});

for (const file of ['app.html', 'index.html']) {
  test(`${file}: the iPhone app (capacitor://localhost) dials the public relay, not its own host`, () => {
    const w = page(file);
    assert.equal(w.relayWsBase(loc('capacitor://localhost/')), 'wss://remote.agmux.dev/ws');
  });

  test(`${file}: the privacy policy is one tap away when pairing and once paired`, () => {
    const doc = page(file).document;
    for (const scope of ['.pair-secure', '#ovMenuMobile', '#ovMenu']) {
      const link = doc.querySelector(`${scope} a[href="https://agmux.dev/privacy"]`);
      assert.ok(link, `${scope} has a privacy link`);
      assert.equal(link.target, '_blank');
      assert.match(link.textContent, /Privacy policy/);
    }
  });

  test(`${file}: Scan QR code is in the pairing screen but stays hidden until the app enables it`, () => {
    const w = page(file);
    const doc = w.document;
    const scan = doc.querySelector('.pairview #scanBtn');
    assert.ok(scan, 'scan button exists');
    const box = scan.closest('.pair-scan');
    assert.equal(w.getComputedStyle(box).display, 'none');
    doc.getElementById('stage').setAttribute('data-scan', '1');
    assert.equal(w.getComputedStyle(box).display, 'flex');
    assert.ok(doc.querySelector('#scanErr[hidden]'), 'scan error line starts hidden');
  });

  test(`${file}: in the app, scanning comes first and manual entry is a fallback`, () => {
    const w = page(file);
    const doc = w.document;
    const stage = doc.getElementById('stage');
    const shown = (sel) => w.getComputedStyle(doc.querySelector(sel)).display !== 'none';
    // Website: the form is visible and there is no scan or manual button.
    assert.equal(shown('.pair-form'), true);
    assert.equal(shown('#manualBtn'), false);
    // App: scan button first, form tucked away behind "Enter details manually".
    stage.setAttribute('data-scan', '1');
    assert.equal(shown('.pair-scan'), true);
    assert.equal(shown('.pair-form'), false);
    assert.equal(shown('#manualBtn'), true);
    doc.getElementById('manualBtn').click();
    assert.equal(stage.dataset.manual, '1');
    assert.equal(shown('.pair-form'), true);
    assert.equal(shown('#manualBtn'), false);
    // Pairing feedback and errors always show the form.
    stage.setAttribute('data-manual', '0');
    for (const state of ['pairing', 'error', 'success']) {
      stage.setAttribute('data-pair', state);
      assert.equal(shown('.pair-form'), true, `form visible while ${state}`);
    }
    stage.setAttribute('data-pair', 'idle');
    assert.equal(shown('.pair-form'), false);
    // The bridge can open manual entry (scan cancelled into "Enter code instead", or no camera).
    w.showManualPair();
    assert.equal(stage.dataset.manual, '1');
  });

  test(`${file}: web hosts keep their existing relay`, () => {
    const w = page(file);
    assert.equal(w.relayWsBase(loc('https://remote.agmux.dev/')), 'wss://remote.agmux.dev/ws');
    assert.equal(w.relayWsBase(loc('http://localhost:8787/')), 'ws://localhost:8787/ws');
    assert.equal(w.relayWsBase(loc('https://agmux-remote-relay.xanom.workers.dev/')), 'wss://agmux-remote-relay.xanom.workers.dev/ws');
    assert.equal(w.relayWsBase(loc('https://agmux.dev/remote/')), 'wss://agmux-remote-relay.xanom.workers.dev/ws');
  });
}
