import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('native build uses the canonical PWA even when the legacy checkout exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agmux-remote-sync-'));
  try {
    const shell = join(dir, 'repo/remote-mobile');
    const canonical = join(dir, 'repo/remote-relay/public');
    const legacy = join(dir, 'xanom-website/public/remote');
    mkdirSync(join(shell, 'scripts'), { recursive: true });
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    copyFileSync(new URL('./sync-web.mjs', import.meta.url), join(shell, 'scripts/sync-web.mjs'));
    writeFileSync(join(canonical, 'app.html'), '<html><head></head><body>current remote</body></html>');
    writeFileSync(join(legacy, 'app.html'), '<html><head></head><body>outdated remote</body></html>');
    execFileSync(process.execPath, [join(shell, 'scripts/sync-web.mjs')]);
    assert.match(readFileSync(join(shell, 'www/index.html'), 'utf8'), /current remote/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shell-only bridge is injected into www once, never shipped in the canonical page', () => {
  const canonicalHtml = readFileSync(new URL('../../remote-relay/public/app.html', import.meta.url), 'utf8');
  assert.doesNotMatch(canonicalHtml, /<script src="native-bridge\.js"/);
  assert.doesNotMatch(canonicalHtml, /data-shell=/);
  const dir = mkdtempSync(join(tmpdir(), 'agmux-remote-sync-'));
  try {
    const shell = join(dir, 'repo/remote-mobile');
    const canonical = join(dir, 'repo/remote-relay/public');
    mkdirSync(join(shell, 'scripts'), { recursive: true });
    mkdirSync(canonical, { recursive: true });
    copyFileSync(new URL('./sync-web.mjs', import.meta.url), join(shell, 'scripts/sync-web.mjs'));
    writeFileSync(join(shell, 'native-bridge.js'), '// bridge');
    writeFileSync(join(canonical, 'app.html'), '<html lang="en"><head></head><body><script>// mentions native-bridge.js in a comment</script></body></html>');
    writeFileSync(join(canonical, 'design.html'), 'preview');
    execFileSync(process.execPath, [join(shell, 'scripts/sync-web.mjs')]);
    for (const file of ['index.html', 'app.html']) {
      const html = readFileSync(join(shell, 'www', file), 'utf8');
      assert.equal(html.match(/<script src="native-bridge\.js"/g)?.length, 1);
      assert.match(html, /<html data-shell="capacitor" lang="en">/);
    }
    assert.equal(existsSync(join(shell, 'www/design.html')), false);
    assert.equal(readFileSync(join(shell, 'www/native-bridge.js'), 'utf8'), '// bridge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
