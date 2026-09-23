const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function relay(initialId) {
  const source = fs.readFileSync('src-tauri/src/hooks/pi_extension.rs', 'utf8').match(/const PI_EXTENSION_TS: &str = r#"([\s\S]*?)"#;/)[1];
  const callbacks = {}, messages = [], exported = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {
    exports: exported,
    process: {env: {AGMUX_SESSION_ID: 'owner', AGMUX_HOOK_SOCKET: '/fixture/socket', AGMUX_INITIAL_CREATED_SESSION_ID: initialId}},
    require(name) {
      assert.equal(name, 'node:net');
      return {connect: () => ({on() {}, end(json) { messages.push(JSON.parse(json)); }})};
    },
  });
  exported.default({on(name, callback) { callbacks[name] = callback; }});
  return { messages, start(reason, sid) {
    callbacks.session_start({reason}, {hasUI: true, sessionManager: {getSessionId: () => sid}});
  }};
}

test('Pi emits creation only for explicit new or exact backend-created initial ID', () => {
  const r = relay('initial');
  for (const [reason, sid, proof] of [
    ['startup', 'initial', 'pi-initial-id'], ['new', 'new-native', 'pi-new'],
    ['resume', 'outside', undefined], ['startup', 'outside', undefined],
    ['reload', 'outside', undefined], ['fork', 'outside', undefined],
    [undefined, 'outside', undefined], ['resume', 'initial', 'pi-initial-id'],
  ]) {
    r.start(reason, sid);
    const m = r.messages.at(-1);
    assert.equal(m.session_id, 'owner');
    assert.equal(m.payload.session_id, sid);
    assert.equal(m.payload.source, reason);
    assert.equal(m.payload.agmux_creation, proof, `${reason}:${sid}`);
  }
  const withoutIntent = relay();
  withoutIntent.start('startup', 'outside');
  assert.equal(withoutIntent.messages[0].payload.agmux_creation, undefined);
});
