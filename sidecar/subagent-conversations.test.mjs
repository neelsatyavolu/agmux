import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentConversations } from './subagent-conversations.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agmux-child-'));
  const capture = new SubagentConversations('thread-1', { root });
  t.after(() => { capture.flush(); rmSync(root, { recursive: true, force: true }); });
  return { capture, root };
}
const launch = (id = 'launch-1') => ({ type: 'assistant', message: { id: 'parent', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'Inspect the parser' } }] } });

test('Claude reconciles streamed and final child text and preserves tool result, isolated by launch', (t) => {
  const { capture, root } = fixture(t);
  capture.claude(launch());
  capture.claude({ type: 'stream_event', parent_tool_use_id: 'launch-1', event: { type: 'message_start', message: { id: 'message-1' } } });
  capture.claude({ type: 'stream_event', parent_tool_use_id: 'launch-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found' } } });
  capture.claude({ type: 'assistant', parent_tool_use_id: 'launch-1', message: { id: 'message-1', content: [{ type: 'text', text: 'Found the parser' }, { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/src/parser.ts' } }] } });
  capture.claude({ type: 'user', parent_tool_use_id: 'launch-1', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'source code' }] } });
  capture.claude(launch('launch-2'));
  capture.claude({ type: 'system', subtype: 'task_started', tool_use_id: 'launch-1', task_id: 'agent-one', task_type: 'local_agent' });
  capture.claude({ type: 'system', subtype: 'task_notification', tool_use_id: 'launch-1', task_id: 'agent-one', status: 'completed' });
  capture.flush();
  const data = JSON.parse(readFileSync(join(root, 'thread-1/subagent-conversations/launch-1.json')));
  assert.equal(data.childId, 'agent-one');
  assert.equal(data.status, 'completed');
  assert.deepEqual(data.items.map(i => i.type), ['user', 'assistant', 'tool']);
  assert.equal(data.items[1].text, 'Found the parser');
  assert.equal(data.items[2].toolResult, 'source code');
  assert.equal(data.items[2].pending, false);
  assert.equal(capture.get('launch-2').status, 'running');
});

test('Cursor raw task deltas retain thinking, text, tool I/O and background lifecycle', (t) => {
  const { capture } = fixture(t);
  capture.cursor({ type: 'tool-call-started', callId: 'task-1', toolCall: { type: 'task', args: { prompt: 'Inspect' } } });
  const child = taskUpdate => capture.cursor({ type: 'tool-call-delta', callId: 'task-1', taskUpdate });
  child({ type: 'thinking-delta', text: 'Look at tests' });
  child({ type: 'text-delta', text: 'Reading' });
  child({ type: 'tool-call-started', callId: 'shell-1', toolCall: { type: 'shell', args: { command: 'pwd' } } });
  child({ type: 'tool-call-completed', callId: 'shell-1', toolCall: { type: 'shell', args: { command: 'pwd' }, result: { status: 'success', value: { stdout: '/project' } } } });
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'success', value: { agentId: 'agent-1', isBackground: true } } } });
  assert.equal(capture.get('task-1').status, 'running');
  assert.equal(capture.get('task-1').childId, 'agent-1');
  assert.deepEqual(capture.get('task-1').items.map(i => i.type), ['user', 'thinking', 'assistant', 'tool']);
  assert.match(capture.get('task-1').items[3].toolResult, /project/);
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'error', error: 'failed' } } });
  assert.equal(capture.get('task-1').status, 'failed');
});

test('capture rejects unsafe filenames and reloads snapshots without duplicate assignment', (t) => {
  const { capture, root } = fixture(t);
  capture.claude(launch('../bad'));
  capture.claude(launch());
  capture.flush();
  assert.deepEqual(readdirSync(join(root, 'thread-1/subagent-conversations')), ['launch-1.json']);
  const resumed = new SubagentConversations('thread-1', { root });
  resumed.claude(launch());
  resumed.flush();
  assert.equal(resumed.get('launch-1').items.length, 1);
});

test('Claude child approval waits and resumes without changing a sibling', (t) => {
  const { capture } = fixture(t);
  capture.claude(launch());
  capture.claude(launch('launch-2'));
  capture.claude({type:'system',subtype:'task_started',tool_use_id:'launch-1',task_id:'agent-1'});
  capture.waiting('read-1', 'agent-1', true);
  assert.equal(capture.get('launch-1').status, 'waiting');
  assert.equal(capture.get('launch-2').status, 'running');
  capture.waiting('read-1', 'agent-1', false);
  assert.equal(capture.get('launch-1').status, 'running');
});

test('capture bounds long tool output and flags the partial transcript', (t) => {
  const { capture } = fixture(t);
  capture.claude(launch());
  capture.claude({type:'user',parent_tool_use_id:'launch-1',message:{content:[{type:'tool_result',tool_use_id:'big-output',content:'x'.repeat(100000)}]}});
  assert.equal(capture.get('launch-1').items[1].toolResult.length, 64000);
  assert.match(capture.get('launch-1').unavailableReason, /trimmed/);
});

test('oversized capture trims in bounded serialization work and preserves assignment and latest activity', (t) => {
  const { capture, root } = fixture(t);
  capture.claude(launch());
  const record = capture.get('launch-1');
  let visits = 0;
  for (let n = 0; n < 90; n++) {
    capture.item(record, {
      id: `output-${n}`, type: 'assistant', text: 'x'.repeat(64000),
      toJSON() { visits++; return { id: this.id, type: this.type, text: this.text }; },
    });
  }
  capture.flush();
  const saved = readFileSync(join(root, 'thread-1/subagent-conversations/launch-1.json'), 'utf8');
  const data = JSON.parse(saved);
  assert.ok(saved.length <= 4 * 1024 * 1024);
  assert.equal(data.items[0].id, 'assignment');
  assert.equal(data.items.at(-1).id, 'output-89');
  assert.match(data.unavailableReason, /trimmed/);
  assert.ok(visits <= 90 * 4, `serialized message bodies ${visits} times`);
});

test('Cursor child question waits until its tool result arrives', (t) => {
  const { capture } = fixture(t);
  const question = type => capture.cursor({type:'tool-call-delta',callId:'task-1',taskUpdate:{type,callId:'question-1',toolCall:{type:'askQuestion',args:{question:'Which parser?'}}}});
  question('tool-call-started');
  assert.equal(capture.get('task-1').status,'waiting');
  question('tool-call-completed');
  assert.equal(capture.get('task-1').status,'running');
});

test('Claude keeps a foreground child answer when no child stream was forwarded', (t) => {
  const { capture } = fixture(t);
  capture.claude(launch());
  capture.claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch-1', content: [{ type: 'text', text: 'The parser is correct.' }] }] } });
  assert.equal(capture.get('launch-1').items.at(-1).text, 'The parser is correct.');
  assert.equal(capture.get('launch-1').items.at(-1).type, 'assistant');
});

test('Claude background placeholder is excluded but its terminal notification is retained once', (t) => {
  const { capture } = fixture(t);
  capture.claude(launch());
  capture.claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch-1', content: 'Agent launched asynchronously. agentId: child-1' }] } });
  assert.equal(capture.get('launch-1').items.length, 1);
  const notification = { type: 'system', subtype: 'task_notification', task_id: 'child-1', status: 'failed', summary: 'Could not read the parser.' };
  capture.claude(notification);
  capture.claude(notification);
  assert.equal(capture.get('launch-1').items.length, 2);
  assert.equal(capture.get('launch-1').items.at(-1).text, 'Could not read the parser.');
  assert.equal(capture.get('launch-1').status, 'failed');
});

test('Claude terminal fallback does not duplicate an already captured answer', (t) => {
  const { capture } = fixture(t);
  capture.claude(launch());
  capture.claude({ type: 'assistant', parent_tool_use_id: 'launch-1', message: { id: 'answer', content: [{ type: 'text', text: 'Done.' }] } });
  capture.claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch-1', content: 'Done.' }] } });
  assert.equal(capture.get('launch-1').items.filter(item => item.type === 'assistant').length, 1);
});

test('Cursor completed native steps reconcile partial streamed text and preserve tool output', (t) => {
  const { capture } = fixture(t);
  capture.cursor({ type: 'tool-call-started', callId: 'task-1', toolCall: { type: 'task', args: { prompt: 'Inspect' } } });
  capture.cursor({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'text-delta', text: 'Read' } });
  const completed = { type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'success', value: { agentId: 'agent-1', isBackground: false, conversationSteps: [
    { thinkingMessage: { text: 'Check the source.' } },
    { assistantMessage: { text: 'Reading the parser.' } },
    { toolCall: { id: 'read-1', readToolCall: { args: { path: 'parser.ts' }, result: { success: { content: 'source code' } } } } },
    { assistantMessage: { text: 'The parser is correct.' } },
  ] } } } };
  capture.cursor(completed);
  capture.cursor(completed);
  const record = capture.get('task-1');
  assert.deepEqual(record.items.map(item => item.type), ['user', 'thinking', 'assistant', 'tool', 'assistant']);
  assert.equal(record.items[2].text, 'Reading the parser.');
  assert.equal(record.items[3].toolName, 'read');
  assert.match(record.items[3].toolResult, /source code/);
  assert.equal(record.items[3].pending, false);
  assert.equal(record.status, 'completed');
});

test('Cursor task failure preserves its error even after child commentary', (t) => {
  const { capture } = fixture(t);
  capture.cursor({ type: 'tool-call-delta', callId: 'task-1', taskUpdate: { type: 'text-delta', text: 'Reading source.' } });
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'error', error: 'Permission denied.' } } });
  assert.equal(capture.get('task-1').items.at(-1).text, 'Permission denied.');
  assert.equal(capture.get('task-1').status, 'failed');
});

test('Cursor malformed native tool steps do not hide valid adjacent messages', (t) => {
  const { capture } = fixture(t);
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'success', value: { isBackground: false, conversationSteps: [
    { toolCall: { shellToolCall: null } },
    { toolCall: { shellToolCall: 'invalid' } },
    { toolCall: { shellToolCall: [] } },
    { assistantMessage: { text: 'Valid final answer.' } },
  ] } } } });
  assert.deepEqual(capture.get('task-1').items.map(item => item.text), ['Valid final answer.']);
});

test('Cursor structured task errors display the message', (t) => {
  const { capture } = fixture(t);
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'error', error: { message: 'Permission denied.', code: 'ACCESS_DENIED' } } } });
  assert.equal(capture.get('task-1').items.at(-1).text, 'Permission denied.');
});

test('Cursor native read failures retain readable reasons and error status', (t) => {
  const { capture } = fixture(t);
  const failures = [
    ['error', { path: 'parser.ts', error: 'Read failed.' }, 'Read failed.'],
    ['rejected', { path: 'parser.ts', reason: 'User declined.' }, 'User declined.'],
    ['fileNotFound', { path: 'missing.ts' }, 'File not found: missing.ts'],
    ['permissionDenied', { path: 'private.ts' }, 'Permission denied: private.ts'],
    ['invalidFile', { path: 'parser.ts', reason: 'Not a regular file.' }, 'Not a regular file.'],
  ];
  capture.cursor({ type: 'tool-call-completed', callId: 'task-1', toolCall: { type: 'task', args: {}, result: { status: 'success', value: { isBackground: false,
    conversationSteps: failures.map(([kind, data], n) => ({ toolCall: { id: `read-${n}`, readToolCall: { args: { path: data.path }, result: { [kind]: data } } } })),
  } } } });
  const items = capture.get('task-1').items;
  for (const [index, [, , expected]] of failures.entries()) {
    assert.equal(items[index].isError, true);
    assert.equal(items[index].pending, false);
    assert.equal(items[index].toolResult, expected);
  }
});
