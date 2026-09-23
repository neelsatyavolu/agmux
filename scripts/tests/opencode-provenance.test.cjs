const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('OpenCode creation proves exact ID without changing active pointer or promoting updates', async () => {
  const source = fs.readFileSync('src-tauri/src/hooks/opencode_plugin.rs', 'utf8').match(/const RELAY_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
  const exported = {}, packets = [];
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {
    exports: exported, process: {env: {AGMUX_SESSION_ID: 'owner', AGMUX_HOOK_SOCKET: '/fixture/socket'}},
    require(name) {
      assert.equal(name, 'node:net');
      return {default: {createConnection() { return {
        on(name, callback) { if (name === 'connect') callback(); },
        write(data) { packets.push(JSON.parse(data)); }, end() {},
      }; }}};
    },
  });
  const relay = await exported.default();
  const emit = (type, properties) => relay.event({event: {type, properties}});
  await emit('message.updated', {info: {id:'m0',role:'user',sessionID:'parent'}});
  packets.length = 0;
  await emit('session.created', {sessionID:'child',info:{id:'child',parentID:'parent'}});
  assert.equal(packets.length, 1);
  assert.equal(packets[0].session_id, 'owner');
  assert.equal(packets[0].payload.session_id, 'child');
  assert.equal(packets[0].payload.agmux_creation, 'opencode-session-created');
  assert.equal(packets[0].payload.agmux_provenance_only, true);
  await emit('session.idle', {});
  assert.equal(packets.at(-1).payload.session_id, 'parent', 'creation notification cannot steal active pointer');
  await emit('session.updated', {info:{id:'outside'}});
  await emit('message.updated', {info:{id:'m1',role:'user',sessionID:'outside'}});
  assert.equal(packets.at(-1).payload.agmux_creation, undefined);
  await emit('message.updated', {info:{id:'m2',role:'user',sessionID:'child'}});
  assert.equal(packets.at(-1).payload.agmux_creation, 'opencode-session-created');
  assert.equal(packets.at(-1).payload.agmux_provenance_only, undefined);
});
