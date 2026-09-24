import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function send()') > 0 ? html.lastIndexOf('<script>') + 8 : 0, html.lastIndexOf('</script>'));
const ast = ts.createSourceFile('phone.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functions(...names) {
  return ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text)).map(s => s.getText(ast)).join('\n');
}
function harness(names, extra = {}) {
  let clock = 0, seq = 0;
  const timers = new Map();
  const sent = [];
  const text = { value: 'draft text', style: {} };
  const attrs = { conn: 'connected', draft: '0' };
  const c = vm.createContext({
    console, Date, Map, Set, Math, JSON, TextEncoder, dynamicModelEfforts: {},
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, time: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ws: { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } },
    get: key => attrs[key], set: (key, value) => { attrs[key] = value; },
    document: { getElementById: id => id === 'compText' ? text : null, querySelectorAll: () => [] },
    stage: { getAttribute: key => attrs[key.replace('data-', '')] },
    threads: [{ id: 't', surface: 'chat', processing: false }], activeThreadId: 't',
    msgQueue: [], queueFlushTimers: new Map(), queueInFlight: new Map(), pendingSends: [], timelineUserEntries: new Map(),
    renderQueue() {}, renderIcons() {}, watchPendingTurn() {}, refreshTermBootChrome() {}, refreshComposerChrome() {},
    clearAttachments() {}, desktopHasCap: () => true, attachedImages: [],
    isDraftMode: () => attrs.draft === '1', activeThread() { return c.threads[0]; },
    attachChatPermission: x => x, showToast() {},
    appendOptimisticSend() {}, shouldQueueMessage: t => !!t?.processing,
    draft: { projectId: 'p', provider: 'Grok', pending: false },
    ...extra,
  });
  vm.runInContext(functions(...names), c);
  function advance(ms) {
    const end = clock + ms;
    while (true) {
      const next = [...timers].filter(([,t]) => t.time <= end).sort((a,b) => a[1].time - b[1].time)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].time; next[1].fn();
    }
    clock = end;
  }
  return { c, sent, text, attrs, advance };
}
const queueFns = ['watchPendingTurn', 'remoteCanSend', 'deliverQueuedMessage', 'maybeFlushQueue', 'clearPendingById'];
test('queue sends one follow-up and waits for its turn before consuming the next', () => {
  const h = harness(queueFns);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' }, { id: '2', threadId: 't', text: 'second' });
  h.c.maybeFlushQueue(); h.advance(5000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.c.msgQueue.length, 1);
  h.c.queueInFlight.get('t').accepted = true;
  h.c.threads[0].processing = true; h.c.maybeFlushQueue();
  h.c.threads[0].processing = false; h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(h.sent.length, 2);
});
test('queue retains unsent messages if connection drops during idle confirmation', () => {
  const h = harness(queueFns);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' });
  h.c.maybeFlushQueue(); h.c.ws = null; h.advance(2000);
  assert.equal(h.c.msgQueue.length, 1);
  assert.equal(h.sent.length, 0);
});
test('queue retains a message when socket send throws', () => {
  const h = harness(queueFns);
  h.c.ws.send = () => { throw new Error('offline'); };
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' });
  h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(h.c.msgQueue.length, 1);
  assert.equal(h.c.pendingSends.length, 0);
});
test('draft creation timeout preserves typed text and attachments', () => {
  const h = harness(['send', 'remoteCanSend', 'recoverDraftCreate']);
  h.attrs.draft = '1';
  h.c.send(); h.advance(12000);
  assert.equal(h.text.value, 'draft text');
  assert.equal(h.c.draft.pending, false);
});
test('offline send retains the composer without writing to the socket', () => {
  const h = harness(['send', 'remoteCanSend']);
  h.attrs.conn = 'desktop-offline';
  h.c.send();
  assert.equal(h.text.value, 'draft text');
  assert.equal(h.sent.length, 0);
});
test('model catalog timeout clears each provider independently', () => {
  const h = harness(['ensureProviderModels'], {
    usesLiveModelCatalog: () => true, modelsListFetchedAt: {}, dynamicProviderModels: {},
    modelsListPending: {}, modelsListTimers: {}, MODELS_LIST_TTL_MS: 300000,
    modelsListContext: {}, modelsListRequestId: {}, dynamicModelEfforts: {},
    modelsProjectIdForRequest: () => 'p',
  });
  h.c.ensureProviderModels('OpenCode'); h.c.ensureProviderModels('Cursor'); h.advance(12000);
  assert.equal(h.c.modelsListPending.OpenCode, false);
  assert.equal(h.c.modelsListPending.Cursor, false);
});
test('a different phone creating a chat does not consume this draft or navigate', () => {
  let opened = 0, finished = 0;
  const h = harness(['handleMsg'], {
    hydrateSessionUiFromThread() {}, renderList() {},
    finishDraftCreate() { finished++; }, openThread() { opened++; },
  });
  h.attrs.draft = '1'; h.c.draft.pending = true; h.c.draft.requestId = 'mine'; h.c.draft.pendingText = 'draft';
  h.c.handleMsg({ type: 'thread.created', requestId: 'other', thread: { id: 'new' } });
  assert.equal(finished, 0); assert.equal(opened, 0); assert.equal(h.c.draft.pending, true);
  h.c.handleMsg({ type: 'thread.created', requestId: 'mine', thread: { id: 'own' } });
  assert.equal(finished, 1); assert.equal(opened, 1);
});
test('OpenCode does not advertise an unsupported effort control', () => {
  const h = harness(['effortsFor'], { CLAUDE_EFFORTS: [['low', 'Low'], ['high', 'High']] });
  assert.equal(h.c.effortsFor('OpenCode', 'openai/gpt-5.6-sol').length, 0);
});
test('GPT-6 phone fallback offers Max for both tiers and Ultra only for Sol', () => {
  const h = harness(['effortsFor'], {
    dynamicModelEfforts: {}, CODEX_EFFORTS: [['low', 'Low'], ['max', 'Max'], ['ultra', 'Ultra']],
  });
  assert.deepEqual(Array.from(h.c.effortsFor('Codex', 'gpt-6-sol'), ([effort]) => effort), ['low', 'max', 'ultra']);
  assert.deepEqual(Array.from(h.c.effortsFor('Codex', 'gpt-6-luna'), ([effort]) => effort), ['low', 'max']);
});
test('existing model change clamps an incompatible effort before sending', () => {
  const h = harness(['applyComposerChoice', 'remoteCanSend'], {
    composerSurface: () => 'chat', composerEffort: () => 'ultra',
    effortsFor: () => [['low', 'Low'], ['high', 'High']],
  });
  h.c.threads[0].reasoningEffort = 'ultra';
  h.c.applyComposerChoice('model', 'gpt-5.6-luna');
  assert.equal(h.sent[0].reasoningEffort, 'high');
  assert.equal(h.c.threads[0].reasoningEffort, 'high');
});
test('existing settings stay unchanged when desktop is offline', () => {
  const h = harness(['applyComposerChoice', 'remoteCanSend']);
  h.attrs.conn = 'desktop-offline'; h.c.threads[0].model = 'old-model';
  h.c.applyComposerChoice('model', 'new-model');
  assert.equal(h.c.threads[0].model, 'old-model');
  assert.equal(h.sent.length, 0);
});
test('queue waits for dispatch acknowledgment even after a busy-to-idle transition', () => {
  const h = harness(queueFns);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' }, { id: '2', threadId: 't', text: 'second' });
  h.c.maybeFlushQueue(); h.advance(2000);
  h.c.threads[0].processing = true; h.c.maybeFlushQueue();
  h.c.threads[0].processing = false; h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(h.sent.length, 1);
});
test('dispatch acknowledgment and user echo do not finish a turn before busy state arrives', () => {
  const h = harness([...queueFns, 'handleMessageAccepted']);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' }, { id: '2', threadId: 't', text: 'second' });
  h.c.maybeFlushQueue(); h.advance(2000);
  h.c.pendingSends.splice(0);
  assert.equal(typeof h.c.handleMessageAccepted, 'function');
  h.c.handleMessageAccepted({ requestId: h.sent[0].requestId, threadId: 't' }); h.advance(2000);
  assert.equal(h.sent.length, 1);
  h.c.threads[0].processing = true; h.c.maybeFlushQueue();
  h.c.threads[0].processing = false; h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(h.sent.length, 2);
});
test('a correlated dispatch failure restores the exact message for explicit retry', () => {
  const h = harness([...queueFns, 'handleMessageSendError']);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first', images: [{data: 'abc', mediaType: 'image/png'}] });
  h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(typeof h.c.handleMessageSendError, 'function');
  h.c.handleMessageSendError({ requestId: h.sent[0].requestId, threadId: 't', message: 'provider failed' });
  assert.equal(h.c.msgQueue[0].text, 'first');
  assert.equal(h.c.msgQueue[0].images[0].data, 'abc');
  assert.equal(h.c.msgQueue[0].failed, true);
  h.c.maybeFlushQueue(); h.advance(4000);
  assert.equal(h.sent.length, 1);
});
test('current Claude and Codex models request the desktop catalog', () => {
  const h = harness(['usesLiveModelCatalog']);
  assert.equal(h.c.usesLiveModelCatalog('ClaudeCode'), true);
  assert.equal(h.c.usesLiveModelCatalog('Codex'), true);
});
test('Codex effort options honor the live model capability list', () => {
  const h = harness(['effortsFor'], {
    dynamicModelEfforts: { Codex: { 'gpt-6-astra': ['high', 'ultra'] } },
    CODEX_EFFORTS: [['low', 'Low'], ['high', 'High'], ['ultra', 'Ultra']],
  });
  assert.deepEqual(Array.from(h.c.effortsFor('Codex', 'gpt-6-astra'), x => x[0]), ['high', 'ultra']);
});
test('disconnect marks unacknowledged delivery as unknown and keeps text recoverable', () => {
  const h = harness([...queueFns, 'markPendingDeliveryUnknown']);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' });
  h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(typeof h.c.markPendingDeliveryUnknown, 'function');
  h.c.markPendingDeliveryUnknown();
  assert.equal(h.c.queueInFlight.get('t').uncertain, true);
  assert.equal(h.c.queueInFlight.get('t').text, 'first');
  h.c.maybeFlushQueue(); h.advance(6000);
  assert.equal(h.sent.length, 1);
});
test('explicit retry restores an unknown delivery without an automatic duplicate', () => {
  const h = harness([...queueFns, 'markPendingDeliveryUnknown', 'steerQueued']);
  h.c.msgQueue.push({ id: '1', threadId: 't', text: 'first' });
  h.c.maybeFlushQueue(); h.advance(2000);
  assert.equal(typeof h.c.markPendingDeliveryUnknown, 'function');
  h.c.markPendingDeliveryUnknown();
  h.c.steerQueued(h.sent[0].requestId); h.advance(2000);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].text, 'first');
});
test('desktop disconnect does not discard attached images', () => {
  const h = harness(['setDesktopCapabilities', 'desktopHasCap'], {
    desktopCapabilities: ['images'], attachedImages: [{ data: 'photo' }],
    clearAttachments() { h.c.attachedImages = []; }, refreshAttachChrome() {},
  });
  h.c.setDesktopCapabilities(null);
  assert.equal(h.c.attachedImages.length, 1);
});
test('send refuses unsupported images without silently dropping them', () => {
  const h = harness(['send', 'remoteCanSend'], {
    desktopHasCap: () => false, attachedImages: [{data: 'photo'}],
    clearAttachments() { h.c.attachedImages = []; },
  });
  h.c.send();
  assert.equal(h.c.attachedImages.length, 1);
  assert.equal(h.sent.length, 0);
});
test('repeated prompt text cannot acknowledge a new send from old history', () => {
  const h = harness([...queueFns, 'reconcilePendingsWithEntries', 'pendingTextMatches', 'normalizePendingText', 'stripTempImagePathTokens', 'isImagePlaceholderText'], { timelineUserEntries: new Map() });
  const old = { id: 'old', kind: 'user', text: 'continue' };
  h.c.reconcilePendingsWithEntries('t', [old]);
  h.c.deliverQueuedMessage('t', 'continue', []);
  h.c.reconcilePendingsWithEntries('t', [old]);
  assert.equal(h.c.pendingSends.length, 1);
  h.c.reconcilePendingsWithEntries('t', [old, { ...old, id: 'new' }]);
  assert.equal(h.c.pendingSends.length, 0);
});
test('replayed approvals are deduplicated per thread and request', () => {
  const h = harness(['enqueuePending'], { pendingQueue: [], pendingApproval: null, pendingUserInput: null, showNextPending() {} });
  const request = { type: 'approval.requested', threadId: 'a', requestId: '1' };
  h.c.enqueuePending(request); h.c.enqueuePending(request);
  h.c.enqueuePending({ ...request, threadId: 'b' });
  assert.equal(h.c.pendingQueue.length, 2);
});
test('unknown delivery remains recoverable when retry interrupt fails', () => {
  const h = harness([...queueFns, 'markPendingDeliveryUnknown', 'steerQueued']);
  h.c.deliverQueuedMessage('t', 'keep this', [{data: 'photo', mediaType: 'image/png'}]);
  h.c.markPendingDeliveryUnknown();
  h.c.threads[0].processing = true;
  h.c.ws.send = () => { throw new Error('offline'); };
  h.c.steerQueued(h.sent[0].requestId);
  const recoverable = h.c.queueInFlight.get('t') || h.c.msgQueue[0];
  assert.equal(recoverable?.text, 'keep this');
  assert.equal(recoverable?.images[0].data, 'photo');
});
test('timeline append retains older user IDs when matching repeated prompts', () => {
  const h = harness([...queueFns, 'reconcilePendingsWithEntries', 'pendingTextMatches', 'normalizePendingText', 'stripTempImagePathTokens', 'isImagePlaceholderText']);
  const old = {id: 'old', kind: 'user', text: 'continue'};
  h.c.reconcilePendingsWithEntries('t', [old]);
  h.c.reconcilePendingsWithEntries('t', [{id: 'assistant', kind: 'assistant', text: 'done'}], false);
  h.c.deliverQueuedMessage('t', 'continue', []);
  h.c.reconcilePendingsWithEntries('t', [old]);
  assert.equal(h.c.pendingSends.length, 1);
});
test('queued CJK messages over the UTF-8 frame limit remain recoverable', () => {
  const h = harness(queueFns);
  const message = '漢'.repeat(400000);
  assert.equal(h.c.deliverQueuedMessage('t', message, []), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.c.pendingSends.length, 0);
});
test('direct CJK messages over the UTF-8 frame limit preserve the composer', () => {
  const h = harness(['send', 'remoteCanSend', 'clearPendingById']);
  h.text.value = '漢'.repeat(400000);
  h.c.send();
  assert.equal(h.sent.length, 0);
  assert.equal(h.text.value.length, 400000);
});
test('a temporarily absent catalog thread does not complete an accepted active turn', () => {
  const h = harness(queueFns);
  h.c.queueInFlight.set('t', { requestId: 'pending', accepted: true, started: true });
  h.c.threads = [];
  h.c.maybeFlushQueue();
  assert.equal(h.c.queueInFlight.has('t'), true);
});
test('missing busy state eventually exposes a recoverable delivery without automatic retry', () => {
  const h = harness([...queueFns, 'watchPendingTurn', 'handleMessageAccepted']);
  h.c.deliverQueuedMessage('t', 'keep this', []);
  h.c.handleMessageAccepted({ threadId: 't', requestId: h.sent[0].requestId });
  h.c.pendingSends.splice(0);
  h.c.msgQueue.push({id: 'next', threadId: 't', text: 'next'});
  h.advance(30000);
  assert.equal(h.c.queueInFlight.get('t')?.uncertain, true);
  assert.equal(h.c.queueInFlight.get('t')?.text, 'keep this');
  h.c.maybeFlushQueue(); h.advance(60000);
  assert.equal(h.sent.length, 1);
});
test('a late acknowledgment keeps missing turn state recoverable', () => {
  const h = harness([...queueFns, 'handleMessageAccepted']);
  h.c.deliverQueuedMessage('t', 'keep this', []);
  h.advance(30000);
  h.c.handleMessageAccepted({threadId: 't', requestId: h.sent[0].requestId});
  assert.equal(h.c.queueInFlight.get('t')?.uncertain, true);
});
test('an older watchdog cannot mark a replacement request uncertain', () => {
  const h = harness(queueFns);
  h.c.deliverQueuedMessage('t', 'first', []);
  h.advance(20000);
  h.c.deliverQueuedMessage('t', 'second', []);
  h.advance(10000);
  assert.equal(h.c.queueInFlight.get('t')?.uncertain, undefined);
  assert.equal(h.c.queueInFlight.get('t')?.text, 'second');
});
