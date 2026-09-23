import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapper } from './opencode-event-mapper.mjs';

test('text Part → assistant_text event with delta', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm1',
    part: { id: 'p1', type: 'text', text: 'Hello world' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].delta, 'Hello world');
  assert.equal(events[0].partId, 'p1');
});

test('text Part second update emits only new delta', () => {
  const m = createMapper();
  m.mapPartUpdate({ sessionID: 's1', messageID: 'm1', part: { id: 'p1', type: 'text', text: 'Hello' } });
  const events = m.mapPartUpdate({ sessionID: 's1', messageID: 'm1', part: { id: 'p1', type: 'text', text: 'Hello world' } });
  assert.equal(events[0].delta, ' world');
});

test('reasoning Part → thinking event', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 'r1', type: 'reasoning', text: 'thinking...' },
  });
  assert.equal(events[0].type, 'thinking');
});

test('tool Part with state running → tool_use event', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } },
  });
  assert.equal(events[0].type, 'tool_use');
  assert.equal(events[0].toolName, 'bash');
  assert.deepEqual(events[0].input, { command: 'ls' });
});

test('tool Part with state completed → tool_result event', () => {
  const m = createMapper();
  m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } },
  });
  const events = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'bash', state: { status: 'completed', output: 'file1\nfile2' } },
  });
  assert.equal(events[0].type, 'tool_result');
  assert.equal(events[0].output, 'file1\nfile2');
});

test('permission_request bash → command_execution_approval', () => {
  const m = createMapper();
  const events = m.mapPermissionRequest({
    id: 'perm1', sessionID: 's1', permission: 'bash', pattern: '*', metadata: { command: 'rm foo' },
  });
  assert.equal(events[0].type, 'permission_request');
  assert.equal(events[0].permissionId, 'perm1');
  assert.equal(events[0].kind, 'command_execution_approval');
});

test('permission_request edit → file_change_approval', () => {
  const m = createMapper();
  const events = m.mapPermissionRequest({ id: 'p2', sessionID: 's1', permission: 'edit', pattern: '*', metadata: {} });
  assert.equal(events[0].kind, 'file_change_approval');
});

test('permission_request maps OpenCode v2 patterns and always suggestions', () => {
  const m = createMapper();
  const events = m.mapPermissionRequest({
    id: 'p3',
    sessionID: 's1',
    permission: 'bash',
    patterns: ['git status *', 'git *'],
    always: ['git status *'],
    metadata: { command: 'git status --short' },
  });
  assert.equal(events[0].type, 'permission_request');
  assert.equal(events[0].permissionId, 'p3');
  assert.equal(events[0].pattern, 'git status *');
  assert.deepEqual(events[0].patterns, ['git status *', 'git *']);
  assert.deepEqual(events[0].always, ['git status *']);
});

test('subtask Part → subtask event with agent and prompt', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm1',
    part: {
      id: 'st1',
      type: 'subtask',
      agent: 'search',
      prompt: 'Find all TypeScript files',
      description: 'File discovery',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'subtask');
  assert.equal(events[0].agent, 'search');
  assert.equal(events[0].prompt, 'Find all TypeScript files');
  assert.equal(events[0].description, 'File discovery');
  assert.equal(events[0].subtaskModel, 'anthropic/claude-sonnet-4-5');
});

test('step-finish Part → usage_update event with tokens and cost', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm1',
    part: {
      id: 'sf1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0.0234,
      tokens: {
        input: 1500,
        output: 800,
        reasoning: 200,
        cache: { read: 5000, write: 500 },
        total: 7500,
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'usage_update');
  assert.equal(events[0].cost, 0.0234);
  assert.equal(events[0].tokens.input, 1500);
  assert.equal(events[0].tokens.output, 800);
  assert.equal(events[0].tokens.cacheRead, 5000);
  assert.equal(events[0].tokens.cacheWrite, 500);
  assert.equal(events[0].tokens.total, 7500);
});

test('step-finish Part with missing fields defaults to zero', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm1',
    part: { id: 'sf2', type: 'step-finish', reason: 'stop' },
  });
  assert.equal(events[0].type, 'usage_update');
  assert.equal(events[0].cost, 0);
  assert.equal(events[0].tokens.input, 0);
  assert.equal(events[0].tokens.output, 0);
  assert.equal(events[0].tokens.cacheRead, 0);
});

test('user-role text Part is dropped (user bubble renders separately)', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm-user',
    role: 'user',
    part: { id: 'p-user', type: 'text', text: 'Hello there' },
  });
  assert.deepEqual(events, []);
});

test('assistant-role text Part still emits assistant_text', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm-asst',
    role: 'assistant',
    part: { id: 'p-asst', type: 'text', text: 'Hi back' },
  });
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].delta, 'Hi back');
});

test('user-role reasoning Part is dropped', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1',
    messageID: 'm-user',
    role: 'user',
    part: { id: 'r-user', type: 'reasoning', text: 'I was thinking...' },
  });
  assert.deepEqual(events, []);
});

test('tool Part with empty input suppresses tool_use until input populates', () => {
  const m = createMapper();
  // First sighting: running, no input yet — suppress (nothing to render).
  const first = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'edit', state: { status: 'running', input: {} } },
  });
  assert.equal(first.length, 0);

  // Second sighting: still running, input now populated — emit once.
  const second = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'edit', state: { status: 'running', input: { filePath: '/a.txt' } } },
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].type, 'tool_use');
  assert.deepEqual(second[0].input, { filePath: '/a.txt' });

  // Third sighting: latched, no re-emit.
  const third = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't1', type: 'tool', tool: 'edit', state: { status: 'running', input: { filePath: '/a.txt' } } },
  });
  assert.equal(third.length, 0);
});

test('tool Part reaching terminal with empty input latches and emits tool_result', () => {
  const m = createMapper();
  const events = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't-err', type: 'tool', tool: 'edit', state: { status: 'error', input: {}, output: '' } },
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'tool_use');
  assert.equal(events[1].type, 'tool_result');
  assert.equal(events[1].isError, true);
  // Next sighting should NOT re-emit tool_use (latched), but tool_result still emits.
  const again = m.mapPartUpdate({
    sessionID: 's1', messageID: 'm1',
    part: { id: 't-err', type: 'tool', tool: 'edit', state: { status: 'error', input: {}, output: '' } },
  });
  assert.equal(again.length, 1);
  assert.equal(again[0].type, 'tool_result');
});
