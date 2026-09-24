import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

for (const file of ['app.html', 'index.html']) {
  test(`${file} initializes the complete phone UI without JavaScript errors`, () => {
    const errors = [];
    const console = new VirtualConsole();
    console.on('jsdomError', error => {
      // jsdom does not implement all of the existing modern CSS syntax.
      if (error.type !== 'css-parsing') errors.push(error.message);
    });
    const dom = new JSDOM(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), {
      url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
      virtualConsole: console,
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.ResizeObserver = class { observe() {} disconnect() {} };
        window.scrollTo = () => {};
      },
    });
    try {
      assert.deepEqual(errors, []);
      assert.ok(dom.window.document.getElementById('compText'));
      assert.ok(dom.window.document.getElementById('apprQuestions'));
      assert.equal(typeof dom.window.renderEntries, 'function');
      dom.window.renderEntries([
        { id: 'u1', kind: 'user', text: '<script>bad()</script>', ts: Date.now() },
        { id: 't1', kind: 'tool', toolName: 'Edit', lead: 'Edited', subject: 'file.txt', body: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, status: 'ok' },
        { id: 'a1', kind: 'assistant', text: 'Finished.', ts: Date.now() },
      ], true);
      assert.equal(dom.window.document.querySelector('#thread script'), null);
      assert.match(dom.window.document.getElementById('thread').textContent, /Finished/);
      assert.deepEqual(errors, []);
    } finally { dom.window.close(); }
  });
}

test('root and app routes ship the same remote UI', () => {
  assert.equal(
    readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'),
    readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'),
  );
});

function loadPhone() {
  return new JSDOM(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.CSS = { escape: value => String(value) };
    },
  });
}

test('assistant markdown renders headings, quotes, rules, numbered lists and labelled code blocks', () => {
  const { window: w } = loadPhone();
  try {
    const root = w.document.createElement('div');
    root.innerHTML = w.formatAiText([
      '# Title', '### Sub', '> quoted **text**', '', '---', '', '3. third', '4. fourth', '',
      'a ~~gone~~ word', '', '```ts', 'const x = "<b>";', '```',
    ].join('\n'));
    assert.ok(root.querySelector('.ai-h.ai-h1'));
    assert.ok(root.querySelector('.ai-h.ai-h3'));
    assert.equal(root.querySelector('blockquote.mdquote strong').textContent, 'text');
    assert.ok(root.querySelector('hr.mdhr'));
    assert.equal(root.querySelector('ol.mdlist').getAttribute('start'), '3');
    assert.equal(root.querySelector('del').textContent, 'gone');
    assert.equal(root.querySelector('.mdcode .mdc-head span').textContent, 'ts');
    assert.ok(root.querySelector('.mdcode .mdc-copy'));
    assert.equal(root.querySelector('.mdcode code').textContent, 'const x = "<b>";');
    assert.equal(root.querySelector('.mdcode b'), null, 'code stays escaped');
  } finally { w.close(); }
});

test('code block Copy button copies the code text', async () => {
  const { window: w } = loadPhone();
  try {
    let copied = null;
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } } });
    w.renderEntries([{ id: 'a1', kind: 'assistant', text: '```\necho hi\n```', ts: 1 }], true);
    w.document.querySelector('#thread .mdc-copy').click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(copied, 'echo hi');
    assert.equal(w.document.querySelector('#thread .mdc-copy span').textContent, 'Copied');
  } finally { w.close(); }
});

test('session rows show time beside the title and patch meta, time and diff in place', () => {
  const { window: w } = loadPhone();
  try {
    w.eval(`ws = {readyState: 1, send() {}}; set('paired', '1'); set('conn', 'connected');`);
    const lastActive = new Date(Date.now() - 5 * 60000).toISOString();
    const thread = { id: 'a', title: 'A', projectId: 'p', projectName: 'App', provider: 'ClaudeCode', surface: 'chat', lastActive };
    w.handleMsg({ type: 'threads.snapshot', threads: [thread] });
    const row = w.document.querySelector('.srow');
    assert.equal(row.querySelector('.sb-top .sb-time').textContent, '5m');
    assert.equal(row.querySelector('.sb-bot .sb-mt').textContent, 'Chat');
    w.handleMsg({ type: 'threads.snapshot', threads: [{ ...thread, surface: 'terminal', linesAdded: 3, linesRemoved: 1 }] });
    assert.equal(w.document.querySelector('.srow'), row, 'row is patched, not rebuilt');
    assert.equal(row.querySelector('.sb-mt').textContent, 'Terminal');
    assert.equal(row.querySelector('.sb-bot .diff').textContent.replace(/\s/g, ''), '+3/-1');
  } finally { w.close(); }
});

test('older desktop catalogs and timelines still render', () => {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => { if (error.type !== 'css-parsing') errors.push(error.message); });
  const { window: w } = new JSDOM(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'), {
    url: 'https://agmux.dev/remote/app.html', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: console,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.scrollTo = () => {};
      window.CSS = { escape: value => String(value) };
    },
  });
  try {
    w.eval(`ws = {readyState: 1, send() {}}; set('paired', '1'); set('conn', 'connected');`);
    // Older builds: SQLite naive timestamps, no surface/model/project, unknown provider.
    w.handleMsg({ type: 'threads.snapshot', threads: [
      { id: 'old', title: 'Old', provider: 'ClaudeCode', lastActive: '2026-01-02 03:04:05', status: 'Idle' },
      { id: 'bare', provider: 'SomethingNew' },
    ] });
    assert.equal(w.document.querySelectorAll('.srow').length, 2);
    assert.match(w.document.querySelector('[data-id="old"] .sb-time').textContent, /\S/);
    assert.equal(w.document.querySelector('[data-id="bare"] .sb-ttl').textContent, 'Untitled');
    w.openThread('old');
    // Older timelines: no ts, tools without lead/status/body.
    w.handleMsg({ type: 'timeline.snapshot', threadId: 'old', entries: [
      { id: 'u', kind: 'user', text: 'hi' },
      { id: 't', kind: 'tool', toolName: 'Bash' },
      { id: 'x', kind: 'mystery', text: 'ignored' },
      { id: 'a', kind: 'assistant', text: 'done' },
    ] });
    assert.equal(w.document.querySelectorAll('#thread .turn-user').length, 1);
    assert.match(w.document.querySelector('#thread .tools').textContent, /Bash/);
    assert.match(w.document.getElementById('thread').textContent, /done/);
    assert.deepEqual(errors, []);
  } finally { w.close(); }
});
