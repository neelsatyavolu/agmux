import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPermissionRequestEvent,
  isQuestionRequestEvent,
  openCodePermissionReply,
  isBypassPermissionMode,
} from './opencode-permissions.mjs';

test('recognizes current and legacy OpenCode permission request events', () => {
  assert.equal(isPermissionRequestEvent('permission.asked'), true);
  assert.equal(isPermissionRequestEvent('permission.updated'), true);
  assert.equal(isPermissionRequestEvent('permission.requested'), true);
  assert.equal(isPermissionRequestEvent('permission.replied'), false);
});

test('recognizes current and legacy OpenCode question request events', () => {
  assert.equal(isQuestionRequestEvent('question.asked'), true);
  assert.equal(isQuestionRequestEvent('question.updated'), true);
  assert.equal(isQuestionRequestEvent('question.requested'), true);
  assert.equal(isQuestionRequestEvent('question.replied'), false);
});

test('maps agmux permission decisions to official OpenCode replies', () => {
  assert.equal(openCodePermissionReply('accept'), 'once');
  assert.equal(openCodePermissionReply('acceptForSession'), 'always');
  assert.equal(openCodePermissionReply('decline'), 'reject');
  assert.equal(openCodePermissionReply('anything-else'), 'reject');
});

test('recognizes bypass permission modes', () => {
  assert.equal(isBypassPermissionMode('full'), true);
  assert.equal(isBypassPermissionMode('full-access'), true);
  assert.equal(isBypassPermissionMode('bypassPermissions'), true);
  assert.equal(isBypassPermissionMode('auto'), true);
  assert.equal(isBypassPermissionMode('normal'), false);
  assert.equal(isBypassPermissionMode('default'), false);
});
