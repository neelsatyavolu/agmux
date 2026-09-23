import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const paths = ['../public/app.html', '../public/index.html', '../../remote-mobile/www/app.html', '../../remote-mobile/www/index.html'];
for (const path of paths) {
  const html = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const ast = ts.createSourceFile('phone.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = ast.statements.filter(s => ts.isFunctionDeclaration(s) && ['buildSessionTimeline', 'jumpToSessionTurn'].includes(s.name?.text)).map(s => s.getText(ast)).join('\n');
  test(`${path}: all provider feeds retain turn identity and per-turn outcomes`, () => {
    const context = vm.createContext({});
    vm.runInContext(code, context);
    for (const provider of ['ClaudeCode', 'Codex', 'Grok', 'Cursor', 'OpenCode', 'Gemini', 'Pi', 'Droid', 'Kimi', 'Cline', 'Hermes', 'MLX']) {
      const rows = context.buildSessionTimeline([
        { id: '1', kind: 'user', text: 'continue', provider },
        { id: '2', kind: 'assistant', text: 'Fixed **scrolling**.' },
        { id: '3', kind: 'user', text: 'continue' },
        { id: '4', kind: 'assistant', text: 'Added summaries.' },
        { id: '5', kind: 'user', state: 'queued', text: 'pending' },
      ]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, '3');
      assert.equal(rows[0].summary, 'Added summaries.');
      assert.equal(rows[1].summary, 'Fixed scrolling.');
    }
  });
  test(`${path}: jump scrolls the matching prompt and disables bottom following`, () => {
    let scrolled = false;
    const menu = { open: true };
    const context = vm.createContext({ stickChatToBottom: true, document: {
      querySelectorAll: () => [{ dataset: {entryId:'target'}, scrollIntoView() { scrolled = true; } }],
      getElementById: () => menu,
    }});
    vm.runInContext(code, context);
    assert.equal(context.jumpToSessionTurn('missing'), false);
    assert.equal(context.jumpToSessionTurn('target'), true);
    assert.equal(scrolled, true);
    assert.equal(context.stickChatToBottom, false);
    assert.equal(menu.open, false);
  });
}
