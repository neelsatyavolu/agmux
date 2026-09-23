import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
