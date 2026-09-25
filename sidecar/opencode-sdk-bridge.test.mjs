import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';

test('OpenCode bridge sends permission rules through the real SDK on creation and mode changes', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'native-session' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const proc = spawn(process.execPath, [new URL('./opencode-sdk-bridge.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(proc, 'exit');
  const timeout = setTimeout(() => proc.kill(), 5000);
  t.after(async () => {
    clearTimeout(timeout);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  let errors = '';
  proc.stderr.on('data', chunk => errors += chunk);
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  async function request(id, method, params) {
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    for (;;) {
      const line = await lines.next();
      assert.equal(line.done, false, errors);
      const reply = JSON.parse(line.value);
      if (reply.id !== id) continue;
      assert.equal(reply.error, undefined);
      return reply.result;
    }
  }
  await request(1, 'initialize', { serverUrl: `http://127.0.0.1:${server.address().port}` });
  await request(2, 'startSession', { threadId: 'thread', directory: '/fixture', permissionMode: 'normal' });
  await request(3, 'setPermissionMode', { threadId: 'thread', mode: 'full-access' });
  await request(4, 'setPermissionMode', { threadId: 'thread', mode: 'normal' });
  const writes = requests.filter(r => r.method === 'POST' || r.method === 'PATCH');
  assert.equal(writes.length, 3);
  assert.ok(Array.isArray(writes[0].body?.permission), 'session.create must send permission rules');
  assert.deepEqual(writes[1].body, { permission: [{ permission: '*', pattern: '*', action: 'allow' }] });
  assert.deepEqual(writes[2].body, writes[0].body, 'normal mode must restore the original rules');
});

test('OpenCode bridge answers and dismisses questions through the real SDK', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/event')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url.split('?')[0], body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/session') ? { id: 'native-session' } : true));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const proc = spawn(process.execPath, [new URL('./opencode-sdk-bridge.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(proc, 'exit');
  const timeout = setTimeout(() => proc.kill(), 5000);
  t.after(async () => {
    clearTimeout(timeout);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  let errors = '';
  proc.stderr.on('data', chunk => errors += chunk);
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  async function request(id, method, params) {
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    for (;;) {
      const line = await lines.next();
      assert.equal(line.done, false, errors);
      const reply = JSON.parse(line.value);
      if (reply.id !== id) continue;
      assert.equal(reply.error, undefined, JSON.stringify(reply.error));
      return reply.result;
    }
  }
  await request(1, 'initialize', { serverUrl: `http://127.0.0.1:${server.address().port}` });
  await request(2, 'startSession', { threadId: 'thread', directory: '/fixture', permissionMode: 'normal' });
  await request(3, 'respondQuestion', { threadId: 'thread', questionId: 'que_1', answers: [['Yes'], ['a', 'b']] });
  await request(4, 'respondQuestion', { threadId: 'thread', questionId: 'que_2', answers: [] });
  const questions = requests.filter(r => r.path.startsWith('/question'));
  assert.deepEqual(questions, [
    { method: 'POST', path: '/question/que_1/reply', body: { answers: [['Yes'], ['a', 'b']] } },
    { method: 'POST', path: '/question/que_2/reject', body: null },
  ]);
});

test('OpenCode bridge reports a missing executable without exiting and accepts another request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agmux-opencode-startup-'));
  const proc = spawn(process.execPath, [new URL('./opencode-sdk-bridge.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(proc, 'exit');
  const timeout = setTimeout(() => proc.kill(), 5000);
  t.after(async () => {
    clearTimeout(timeout);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  let errors = '';
  proc.stderr.on('data', chunk => errors += chunk);
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  function send(id, method, params) {
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }
  async function response() {
    const line = await lines.next();
    assert.equal(line.done, false, `Bridge exited before responding: ${errors}`);
    return JSON.parse(line.value);
  }

  send(1, 'initialize', { binaryPath: join(root, 'missing-opencode') });
  const failure = await response();
  assert.equal(failure.id, 1);
  assert.match(failure.error.message, /ENOENT/);

  send(2, 'stopSession', { threadId: 'not-started' });
  assert.deepEqual(await response(), { id: 2, result: { ok: true } });
  send(3, 'shutdown');
  assert.deepEqual(await response(), { id: 3, result: { ok: true } });
  assert.deepEqual(await exited, [0, null]);
});
