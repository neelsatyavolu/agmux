import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAssistantText, appendAssistantTextDelta } from './opencode-text-merge.mjs';

test('mergeAssistantText returns full delta when previous is empty', () => {
  const result = mergeAssistantText(undefined, 'Hello world');
  assert.equal(result.latestText, 'Hello world');
  assert.equal(result.deltaToEmit, 'Hello world');
});

test('mergeAssistantText emits only new suffix on cumulative snapshot', () => {
  const result = mergeAssistantText('Hello ', 'Hello world');
  assert.equal(result.latestText, 'Hello world');
  assert.equal(result.deltaToEmit, 'world');
});

test('mergeAssistantText keeps previous text when next is a shorter prefix (rollback noise)', () => {
  const result = mergeAssistantText('Hello world', 'Hello');
  assert.equal(result.latestText, 'Hello world');
  assert.equal(result.deltaToEmit, '');
});

test('appendAssistantTextDelta dedupes overlapping suffix', () => {
  const result = appendAssistantTextDelta('Hello wo', 'world');
  assert.equal(result.nextText, 'Hello world');
  assert.equal(result.deltaToEmit, 'rld');
});

test('appendAssistantTextDelta passes through clean delta', () => {
  const result = appendAssistantTextDelta('Hello ', 'world');
  assert.equal(result.nextText, 'Hello world');
  assert.equal(result.deltaToEmit, 'world');
});
