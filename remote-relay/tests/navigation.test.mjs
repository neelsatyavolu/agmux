import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

function phone() {
  const dom = new JSDOM(readFileSync(new URL('../public/app.html', import.meta.url), 'utf8'), {
    url: 'https://remote.agmux.dev/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.CSS = { escape: value => String(value) };
      window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
      window.ResizeObserver = class {observe() {} disconnect() {}};
      window.scrollTo = () => {};
    },
  });
  dom.window.eval(`
    ws = {readyState: 1, send() {}};
    threads = ['a', 'b'].map(id => ({id, name: id, projectId: 'p', projectName: 'Project', provider: 'ClaudeCode', surface: 'chat', processing: false}));
    set('conn', 'connected');
    desktopCapabilities = ['images', 'message-ack'];
  `);
  return dom;
}

test('task groups retain task context, isolate names and keep actions on the original session', () => {
  const dom = phone(), w = dom.window;
  try {
    const task = {id: 'task-agent', title: 'Implement', projectId: 'p', projectName: 'Project', provider: 'ClaudeCode', surface: 'chat', processing: false, taskId: 'task-one', taskName: 'Fix <bug>', worktreeBranch: 'fix/bug'};
    w.handleMsg({type: 'threads.snapshot', threads: [task,
      {...task, id: 'other-task-agent', taskId: 'task-two'},
      {...task, id: 'other-project-agent', projectId: 'p2', taskId: 'task-three'},
      {id: 'regular', title: 'Regular', projectId: 'p', projectName: 'Project', provider: 'ClaudeCode', surface: 'chat'},
    ]});
    assert.equal(w.document.querySelectorAll('.pgroup').length, 4);
    const group = w.document.querySelector('[data-id="task-agent"]').closest('.pgroup');
    assert.match(group.querySelector('.pgroup-name').textContent, /Project.*Task: Fix <bug>/);
    assert.equal(group.querySelector('[data-new-project]'), null, 'task header must not create a project-root chat');
    assert.equal(group.querySelector('bug'), null, 'task names must be escaped');
    w.eval('window.sent = []; ws.send = raw => window.sent.push(JSON.parse(raw));');
    w.openThread('task-agent');
    assert.match(w.document.getElementById('chProj').textContent, /Project.*Task: Fix <bug>.*fix\/bug/);
    assert.equal(w.sent.find(m => m.type === 'thread.subscribe')?.threadId, 'task-agent');
    w.document.getElementById('compText').value = 'continue the task';
    w.send();
    assert.equal(w.sent.find(m => m.type === 'message.send')?.threadId, 'task-agent');
    w.handleMsg({type: 'threads.upsert', thread: {...task, taskName: 'Renamed task', worktreeBranch: 'fix/new'}});
    assert.match(w.document.getElementById('chProj').textContent, /Renamed task.*fix\/new/);
    w.document.querySelector('.side-search input').value = 'fix/new';
    w.renderList();
    assert.equal(w.document.querySelectorAll('.srow').length, 1);
    assert.equal(w.document.querySelector('.srow').dataset.id, 'task-agent');
  } finally { w.close(); }
});

test('task model catalogs use the session and reject stale results from another workspace', () => {
  const dom = phone(), w = dom.window;
  try {
    w.eval(`threads.forEach(t => { t.provider = 'OpenCode'; t.taskId = 'task-' + t.id; });
      window.sent = []; ws.send = raw => window.sent.push(JSON.parse(raw));`);
    w.openThread('a');
    w.ensureProviderModels('OpenCode');
    const first = w.sent.filter(m => m.type === 'models.list').at(-1);
    assert.equal(first.threadId, 'a');
    assert.ok(first.requestId);
    w.handleMsg({type: 'models.snapshot', provider: 'OpenCode', requestId: first.requestId, models: [{slug: 'a-only'}]});
    w.openThread('b');
    w.ensureProviderModels('OpenCode');
    const second = w.sent.filter(m => m.type === 'models.list').at(-1);
    assert.equal(second.threadId, 'b');
    assert.notEqual(second.requestId, first.requestId);
    w.handleMsg({type: 'models.snapshot', provider: 'OpenCode', requestId: second.requestId, models: [{slug: 'b-only'}]});
    w.handleMsg({type: 'models.snapshot', provider: 'OpenCode', requestId: first.requestId, models: [{slug: 'a-only'}]});
    assert.equal(w.modelsForProvider('OpenCode')[0][0], 'b-only');
    w.openNewChat({projectId: 'p'});
    w.ensureProviderModels('OpenCode');
    const draftRequest = w.sent.filter(m => m.type === 'models.list').at(-1);
    assert.equal(draftRequest.projectId, 'p');
    assert.equal(draftRequest.threadId, undefined);
  } finally { w.close(); }
});

for (const [provider, surfaces] of [
  ['ClaudeCode', ['chat', 'terminal']], ['Codex', ['chat', 'terminal']],
  ['Grok', ['chat', 'terminal']], ['Gemini', ['chat', 'terminal']],
  ['OpenCode', ['chat', 'terminal']], ['Cursor', ['chat']],
  ...['Pi', 'Kimi', 'Droid', 'Cline', 'Hermes'].map(p => [p, ['terminal']]),
]) for (const surface of surfaces) {
  test(`${provider} task ${surface} keeps send, queue, stop and approvals scoped to its agent`, () => {
    const dom = phone(), w = dom.window;
    try {
      w.handleMsg({type: 'threads.snapshot', threads: [
        {id: 'task-agent', title: 'Task agent', provider, surface, projectId: 'p', projectName: 'Project', taskId: 'task', taskName: 'Task', worktreeBranch: 'feature', processing: false},
        {id: 'other', provider, surface, projectId: 'p', processing: false},
      ]});
      w.eval('window.sent = []; ws.send = raw => window.sent.push(JSON.parse(raw));');
      w.openThread('task-agent');
      w.document.getElementById('compText').value = 'continue';
      w.send();
      assert.equal(w.sent.find(m => m.type === 'message.send')?.threadId, 'task-agent');
      w.handleMsg({type: 'status', threadId: 'task-agent', processing: true});
      w.document.getElementById('compText').value = 'next';
      w.send();
      assert.equal(w.eval("msgQueue.find(m => m.threadId === 'task-agent')?.text"), 'next');
      w.document.getElementById('stopBtn').click();
      assert.equal(w.sent.at(-1).type, 'turn.interrupt');
      assert.equal(w.sent.at(-1).threadId, 'task-agent');
      w.handleMsg({type: 'approval.requested', threadId: 'task-agent', requestId: 'approval-task', toolName: 'Bash', detail: 'Continue?'});
      w.respondApproval('allow');
      const approval = w.sent.find(m => m.type === 'approval.respond');
      assert.equal(approval?.threadId, 'task-agent');
      assert.equal(approval?.requestId, 'approval-task');
      assert.equal(w.sent.some(m => m.type === 'thread.create'), false);
    } finally { w.close(); }
  });
}
test('legacy desktop creation without request ids preserves the first prompt', () => {
  const dom = phone(), w = dom.window;
  try {
    w.eval("desktopCapabilities = ['images'];");
    w.openNewChat({projectId: 'p'});
    w.document.getElementById('compText').value = 'legacy first prompt';
    w.send();
    const provider = w.eval('draft.provider');
    w.handleMsg({type: 'thread.created', thread: {id: 'unrelated', provider, projectId: 'other', surface: 'chat'}});
    assert.equal(w.eval('draft.pending'), true);
    w.handleMsg({type: 'thread.created', thread: {id: 'legacy', provider, projectId: 'p', surface: 'chat'}});
    assert.equal(w.eval('activeThreadId'), 'legacy');
    assert.equal(w.eval("msgQueue.find(m => m.threadId === 'legacy')?.text"), 'legacy first prompt');
    assert.equal(w.eval('draft.pending'), false);
  } finally { w.close(); }
});
test('current desktops must echo the pending creation request id', () => {
  const dom = phone(), w = dom.window;
  try {
    w.openNewChat({projectId: 'p'});
    w.document.getElementById('compText').value = 'my first prompt';
    w.send();
    const thread = {id: 'another-phone', provider: w.eval('draft.provider'), projectId: 'p', surface: 'chat'};
    for (const requestId of [undefined, 'another-request']) {
      w.handleMsg({type: 'thread.created', requestId, thread});
      assert.equal(w.eval('draft.pending'), true);
      assert.equal(w.eval('msgQueue.length'), 0);
    }
  } finally { w.close(); }
});
test('diff rendering preserves header-like changed lines and raw file contents', () => {
  const dom = phone(), w = dom.window;
  try {
    const diff = 'diff --git a/a.txt b/a.txt\nindex abc..def 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n---flag\n+++counter\n context';
    const parsed = Array.from(w.parseDiffLines(diff, 'modify'));
    assert.deepEqual(parsed.map(line => [line.kind, line.text]), [
      ['header', '@@ -1,2 +1,2 @@'], ['del', '---flag'], ['add', '+++counter'], ['context', ' context'],
    ]);
    const raw = 'index = 1\ndiff = 2\n*** Begin example';
    assert.deepEqual(Array.from(w.parseDiffLines(raw, 'create'), line => line.text), raw.split('\n'));
  } finally { w.close(); }
});
for (const reconnect of ['phone', 'desktop']) {
  test(`${reconnect} reconnect drops requests resolved on the Mac while the phone was offline`, () => {
    const dom = phone(), w = dom.window;
    try {
      w.handleMsg({type: 'approval.requested', threadId: 'a', requestId: 'old', toolName: 'Bash'});
      w.setConn('offline');
      // The Mac resolved "old" during the outage; only the still-pending
      // question is replayed after the new hello / threads.list request.
      if (reconnect === 'phone') w.handleMsg({type: 'hello.ok'});
      w.handleMsg({type: 'desktop.online', capabilities: ['message-ack', 'images']});
      w.handleMsg({type: 'userInput.requested', threadId: 'b', requestId: 'current', questions: [{id: 'q', question: 'Continue?'}]});
      assert.equal(w.eval('pendingApproval'), null);
      assert.equal(w.eval('pendingUserInput.requestId'), 'current');
      assert.equal(w.eval('pendingQueue.length'), 0);
    } finally { w.close(); }
  });
}
test('hello waits for current desktop capabilities before resetting pending requests', () => {
  const dom = phone(), w = dom.window;
  try {
    w.handleMsg({type: 'approval.requested', threadId: 'a', requestId: 'old', toolName: 'Bash'});
    w.setConn('offline');
    // A phone socket reconnect retains the previous Mac capability list.
    // The replacement desktop may be an older build that cannot replay.
    w.handleMsg({type: 'hello.ok'});
    assert.equal(w.eval('pendingApproval?.requestId'), 'old');
    w.handleMsg({type: 'desktop.online', capabilities: ['images']});
    assert.equal(w.eval('pendingApproval?.requestId'), 'old');
  } finally { w.close(); }
});
test('switching sessions isolates and restores unsent text and attachments', () => {
  const dom = phone(), w = dom.window;
  try {
    w.openThread('a');
    w.eval(`document.getElementById('compText').value = 'only for A'; attachedImages = [{id: 'image', data: 'photo', dataUrl: 'data:image/png;base64,cA==', mediaType: 'image/png'}];`);
    w.openThread('b');
    assert.equal(w.document.getElementById('compText').value, '');
    assert.equal(w.eval('attachedImages.length'), 0);
    w.openThread('a');
    assert.equal(w.document.getElementById('compText').value, 'only for A');
    assert.equal(w.eval('attachedImages[0].data'), 'photo');
  } finally { w.close(); }
});
test('a pending new chat keeps its first prompt when another session is opened', () => {
  const dom = phone(), w = dom.window;
  try {
    w.openNewChat({projectId: 'p'});
    w.document.getElementById('compText').value = 'first prompt';
    w.send();
    const requestId = w.eval('draft.requestId');
    w.openThread('a');
    w.handleMsg({type: 'thread.created', requestId, thread: {id: 'new', provider: 'ClaudeCode', surface: 'chat', projectId: 'p'}});
    assert.equal(w.eval('activeThreadId'), 'a');
    assert.equal(w.eval("msgQueue.find(m => m.threadId === 'new')?.text"), 'first prompt');
    assert.equal(w.document.getElementById('compText').value, '');
  } finally { w.close(); }
});
test('expanded tools stay attached to their entry when earlier tools gain output', () => {
  const dom = phone(), w = dom.window;
  try {
    const tools = [
      {id: 'first', kind: 'tool', toolName: 'Edit', lead: 'Edited', subject: 'first.txt'},
      {id: 'second', kind: 'tool', toolName: 'Edit', lead: 'Edited', subject: 'second.txt', body: '-old\n+new'},
    ];
    w.renderEntries(tools, true);
    w.document.querySelector('.trow.act').click();
    w.renderEntries([{...tools[0], body: '-before\n+after'}, tools[1]], true);
    const expanded = Array.from(w.document.querySelectorAll('.trow.open'), row => row.textContent);
    assert.equal(expanded.length, 1);
    assert.match(expanded[0], /second.txt/);
  } finally { w.close(); }
});
test('returning to a pending draft preserves its original provider and first prompt', () => {
  const dom = phone(), w = dom.window;
  try {
    w.openNewChat({projectId: 'p'});
    w.document.getElementById('compText').value = 'first prompt';
    w.send();
    const requestId = w.eval('draft.requestId');
    w.openThread('a');
    w.document.getElementById('compText').value = 'unsent in A';
    w.openNewChat({projectId: 'other'});
    assert.equal(w.eval('draft.projectId'), 'p');
    assert.equal(w.document.getElementById('compText').value, 'first prompt');
    assert.equal(w.eval('draft.requestId'), requestId);
    w.handleMsg({type: 'thread.created', requestId, thread: {id: 'new', provider: 'ClaudeCode', surface: 'chat', projectId: 'p'}});
    assert.equal(w.eval('activeThreadId'), 'new');
    assert.equal(w.document.getElementById('compText').value, '');
    w.openThread('a');
    assert.equal(w.document.getElementById('compText').value, 'unsent in A');
  } finally { w.close(); }
});
for (const provider of ['Cline', 'Hermes', 'Droid', 'Pi', 'Kimi', 'OpenCode']) {
  test(`${provider} terminal hides unsupported model settings and supports send, queue and stop`, () => {
    const dom = phone(), w = dom.window;
    try {
      w.__provider = provider;
      w.eval(`threads[0].provider = window.__provider; threads[0].surface = 'terminal'; window.sent = []; ws.send = raw => window.sent.push(JSON.parse(raw));`);
      w.openThread('a');
      assert.equal(w.document.getElementById('modelChip').hidden, true);
      assert.equal(w.document.getElementById('effortChip').hidden, true);
      w.document.getElementById('compText').value = 'resume this terminal';
      w.send();
      assert.equal(w.sent.find(m => m.type === 'message.send')?.threadId, 'a');
      w.eval('threads[0].processing = true; refreshRunningState();');
      w.document.getElementById('compText').value = 'follow up';
      w.send();
      assert.equal(w.eval("msgQueue.find(m => m.threadId === 'a')?.text"), 'follow up');
      w.document.getElementById('stopBtn').click();
      assert.equal(w.sent.at(-1).type, 'turn.interrupt');
      assert.equal(w.sent.at(-1).threadId, 'a');
    } finally { w.close(); }
  });
}
for (const provider of ['ClaudeCode', 'Codex', 'Grok', 'Gemini', 'OpenCode', 'Cursor']) {
  test(`${provider} chat creates with its first prompt and queues follow-ups on the right session`, () => {
    const dom = phone(), w = dom.window;
    try {
      w.__provider = provider;
      w.eval(`window.sent = []; ws.send = raw => window.sent.push(JSON.parse(raw));`);
      w.openNewChat({projectId: 'p'});
      w.eval(`applyComposerChoice('model', DEFAULT_MODELS[window.__provider], window.__provider);`);
      w.document.getElementById('compText').value = 'first prompt';
      w.send();
      const create = w.sent.find(m => m.type === 'thread.create');
      assert.equal(create.provider, provider);
      assert.equal(create.projectId, 'p');
      w.handleMsg({type: 'thread.created', requestId: create.requestId, thread: {id: 'new', provider, surface: 'chat', projectId: 'p', processing: false}});
      assert.equal(w.eval('activeThreadId'), 'new');
      assert.equal(w.eval("msgQueue.find(m => m.threadId === 'new')?.text"), 'first prompt');
      w.eval("threads.find(t => t.id === 'new').processing = true; refreshRunningState();");
      w.document.getElementById('compText').value = 'follow up';
      w.send();
      assert.deepEqual(Array.from(w.eval("msgQueue.filter(m => m.threadId === 'new')"), m => m.text), ['first prompt', 'follow up']);
      w.document.getElementById('stopBtn').click();
      assert.equal(w.sent.at(-1).type, 'turn.interrupt');
      assert.equal(w.sent.at(-1).threadId, 'new');
    } finally { w.close(); }
  });
}
test('chunked catalogs become visible atomically without dropping session preferences', () => {
  const dom = phone(), w = dom.window;
  try {
    w.eval("sessionUi.b = {permissionMode: 'full', planMode: true};");
    const a = {id: 'a', provider: 'Codex', surface: 'chat', processing: false};
    const b = {id: 'b', provider: 'Codex', surface: 'chat', processing: true};
    w.handleMsg({type: 'threads.snapshot', snapshotId: 'catalog', chunkIndex: 0, chunkCount: 2, threads: [a]});
    assert.deepEqual(Array.from(w.eval('threads'), t => t.id), ['a', 'b']);
    assert.equal(w.eval('sessionUi.b.permissionMode'), 'full');
    w.handleMsg({type: 'threads.snapshot', snapshotId: 'catalog', chunkIndex: 1, chunkCount: 2, threads: [b]});
    assert.deepEqual(Array.from(w.eval('threads'), t => t.id), ['a', 'b']);
    assert.equal(w.eval('threads[1].processing'), true);
    assert.equal(w.eval('sessionUi.b.permissionMode'), 'full');
  } finally { w.close(); }
});
test('out-of-order or disconnected catalog chunks cannot replace the current catalog', () => {
  const dom = phone(), w = dom.window;
  try {
    const chunk = {type: 'threads.snapshot', snapshotId: 'catalog', chunkCount: 3, threads: [{id: 'partial', provider: 'Codex'}]};
    w.handleMsg({...chunk, chunkIndex: 0});
    w.handleMsg({...chunk, chunkIndex: 2});
    w.handleMsg({...chunk, chunkIndex: 1});
    assert.deepEqual(Array.from(w.eval('threads'), t => t.id), ['a', 'b']);
    w.handleMsg({...chunk, chunkCount: 2, chunkIndex: 0});
    w.setConn('offline');
    w.handleMsg({...chunk, chunkCount: 2, chunkIndex: 1});
    assert.deepEqual(Array.from(w.eval('threads'), t => t.id), ['a', 'b']);
  } finally { w.close(); }
});

test('opening a thread measures its restored composer after the chat becomes visible', () => {
  const dom = phone(), w = dom.window;
  try {
    const ta = w.document.getElementById('compText');
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => w.eval("get('route')") === 'chat' ? 90 : 0 });
    w.eval("set('route', 'list'); composerDrafts.set('a', {text: 'first\\nsecond\\nthird', images: []});");
    w.openThread('a');
    assert.equal(ta.style.height, '90px');
    assert.equal(ta.value, 'first\nsecond\nthird');
    Object.defineProperty(ta, 'scrollHeight', { get: () => 300 });
    ta.dispatchEvent(new w.Event('input'));
    assert.equal(ta.style.height, '140px');
  } finally { w.close(); }
});

test('internal task notifications do not appear as queued messages or timeline turns', () => {
  const dom = phone(), w = dom.window;
  try {
    w.openThread('a');
    const notification = '<task-notification>\n<task-id>b19tm5l03</task-id>\n<status>stopped</status>\n<summary>No completion record was found.</summary>\n</task-notification>';
    const entries = [
      {id: 'internal', kind: 'user', state: 'queued', text: notification},
      {id: 'real', kind: 'user', state: 'queued', text: 'Please continue'},
      {id: 'quoted', kind: 'user', text: 'Explain this: ' + notification},
      {id: 'reply', kind: 'assistant', text: 'Ready.'},
    ];
    w.renderEntries(entries, true);
    assert.equal(w.document.querySelectorAll('.turn-user.queued').length, 1);
    assert.match(w.document.querySelector('.turn-user.queued').textContent, /Please continue/);
    assert.match(w.document.getElementById('thread').textContent, /Explain this/);
    assert.equal(w.eval("sessionTimelineEntries.get('a').some(e => e.id === 'internal')"), false);
    w.renderEntries([{...entries[0], id: 'delivered', state: undefined}], false);
    assert.equal(w.eval("sessionTimelineEntries.get('a').some(e => e.id === 'delivered')"), false);
    assert.equal(w.document.querySelectorAll('.turn-user').length, 2);
  } finally { w.close(); }
});
