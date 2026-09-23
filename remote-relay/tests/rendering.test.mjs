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
