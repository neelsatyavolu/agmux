import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const clineBin = process.env.AGMUX_TEST_CLINE_BIN;
function invoke(root, extra = {}, envOverrides = {}) {
  return spawnSync(process.execPath, [resolve('src-tauri/src/process/cline_precreate.mjs')], {
    input: JSON.stringify({ clineBin, cwd: root, provider: 'openai', model: 'gpt-4o', ...extra }),
    encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: root, CLINE_DIR: root,
      CLINE_DATA_DIR: join(root, 'data'), CLINE_SESSION_DATA_DIR: join(root, 'data', 'sessions'), ...envOverrides },
  });
}
test('native empty creation persists distinct IDs and contains no invented prompt', { skip: !clineBin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-cline-precreate-test-'));
  try {
    const first = invoke(root);
    assert.equal(first.status, 0, first.stderr);
    const a = JSON.parse(first.stdout);
    const second = invoke(root);
    assert.equal(second.status, 0, second.stderr);
    const b = JSON.parse(second.stdout);
    assert.notEqual(a.sessionId, b.sessionId);
    for (const result of [a, b]) {
      const base = join(root, 'data', 'sessions', result.sessionId, result.sessionId);
      const manifest = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
      const messages = JSON.parse(readFileSync(`${base}.messages.json`, 'utf8'));
      assert.equal(manifest.session_id, result.sessionId);
      assert.equal(manifest.status, 'idle');
      assert.equal(manifest.prompt, undefined);
      assert.deepEqual(messages.messages, []);
    }
    const bad = invoke(root, { sessionId: a.sessionId });
    assert.notEqual(bad.status, 0, 'caller cannot select/import an existing ID');
    assert.equal(bad.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid binary fails closed without creation evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-cline-precreate-reject-'));
  try {
    mkdirSync(join(root, 'data'));
    const result = invoke(root, { clineBin: '/nonexistent/cline', model: '' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unconfigured creation uses native Cline defaults without saving credentials', { skip: !clineBin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-cline-onboarding-test-'));
  try {
    const result = invoke(root, { provider: undefined, model: undefined });
    assert.equal(result.status, 0, result.stderr);
    const created = JSON.parse(result.stdout);
    assert.equal(created.provider, 'cline');
    assert.ok(created.model.length > 0);
    assert.equal(existsSync(join(root, 'data', 'settings', 'providers.json')), false);
    const base = join(root, 'data', 'sessions', created.sessionId, created.sessionId);
    assert.deepEqual(JSON.parse(readFileSync(`${base}.messages.json`, 'utf8')).messages, []);
    assert.equal(JSON.parse(readFileSync(`${base}.json`, 'utf8')).prompt, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('compatible differently-versioned package works; missing capability fails closed', { skip: !clineBin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-cline-capability-test-'));
  try {
    const pkg = join(root, 'cli');
    const sdk = join(pkg, 'node_modules', '@cline', 'sdk');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(sdk, { recursive: true });
    const binary = join(pkg, 'bin', 'cline');
    writeFileSync(binary, '');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'cline', version: '999.1.0' }));
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@cline/sdk', version: '999.2.0', type: 'module', exports: { '.': { import: './entry.mjs' } } }));
    const actual = join(dirname(dirname(realpathSync(clineBin))), 'node_modules/@cline/sdk/dist/index.js');
    writeFileSync(join(sdk, 'entry.mjs'), `export * from ${JSON.stringify(actual)};`);
    const result = invoke(root, { clineBin: binary });
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(sdk, 'entry.mjs'), 'export const resolveSessionBackend = undefined;');
    const unsupported = invoke(root, { clineBin: binary });
    assert.notEqual(unsupported.status, 0);
    assert.equal(unsupported.stdout, '');
    writeFileSync(join(sdk, 'entry.mjs'), `
      export * from ${JSON.stringify(actual)};
      import { resolveSessionBackend as nativeBackend } from ${JSON.stringify(actual)};
      export async function resolveSessionBackend(options) {
        const backend = await nativeBackend(options);
        const read = backend.readSessionManifest.bind(backend);
        backend.readSessionManifest = id => {
          const value = read(id);
          return value ? { ...value, session_id: 'different-native-id' } : value;
        };
        return backend;
      }
    `);
    const mismatched = invoke(root, { clineBin: binary });
    assert.notEqual(mismatched.status, 0, 'incompatible native identity cannot become creation evidence');
    assert.equal(mismatched.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native session-root precedence matches helper environment including blank overrides', { skip: !clineBin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-cline-roots-test-'));
  try {
    const config = join(root, 'config');
    const data = join(root, 'explicit-data');
    const sessions = join(root, 'explicit-sessions');
    for (const [env, expected] of [
      [{ CLINE_DIR: config, CLINE_DATA_DIR: data, CLINE_SESSION_DATA_DIR: `  ${sessions}  ` }, sessions],
      [{ CLINE_DIR: config, CLINE_DATA_DIR: data, CLINE_SESSION_DATA_DIR: '  ' }, join(data, 'sessions')],
      [{ CLINE_DIR: config, CLINE_DATA_DIR: ' ', CLINE_SESSION_DATA_DIR: '' }, join(config, 'data', 'sessions')],
      [{ CLINE_DIR: '', CLINE_DATA_DIR: '', CLINE_SESSION_DATA_DIR: '' }, join(root, '.cline', 'data', 'sessions')],
    ]) {
      const result = invoke(root, {}, env);
      assert.equal(result.status, 0, result.stderr);
      const { sessionId } = JSON.parse(result.stdout);
      assert.ok(existsSync(join(expected, sessionId, `${sessionId}.json`)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
