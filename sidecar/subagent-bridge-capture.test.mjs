import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

for (const provider of ['claude', 'cursor']) {
  test(`${provider} bridge captures child conversation without child content or completion entering parent`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'agmux-child-bridge-'));
    const mock = provider === 'claude' ? `
      export function query({options}) {
        if (!options.forwardSubagentText) throw new Error('Child forwarding is disabled');
        return (async function* () {
          yield {type:'system',subtype:'init',session_id:'parent-session'};
          yield {type:'assistant',message:{id:'p',content:[{type:'tool_use',id:'launch',name:'Agent',input:{prompt:'Inspect'}}]}};
          yield {type:'assistant',parent_tool_use_id:'launch',session_id:'child-session',message:{id:'child-message',content:[{type:'text',text:'PRIVATE CHILD TEXT'}]}};
          yield {type:'result',parent_tool_use_id:'launch',session_id:'child-session',subtype:'success'};
          yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'launch',content:'Done'}]}};
          yield {type:'assistant',session_id:'parent-session',message:{id:'p2',content:[{type:'text',text:'Parent response'}]}};
          yield {type:'result',session_id:'parent-session',subtype:'success'};
        })();
      }` : `
      export class Agent {
        static async create() { return new Agent(); }
        agentId = 'parent-agent';
        async send(message, options) {
          if (!options.onDelta) throw new Error('Child delta capture is disabled');
          await options.onDelta({update:{type:'tool-call-started',callId:'launch',toolCall:{type:'task',args:{prompt:'Inspect'}}}});
          await options.onDelta({update:{type:'tool-call-delta',callId:'launch',taskUpdate:{type:'text-delta',text:'PRIVATE CHILD TEXT'}}});
          await options.onDelta({update:{type:'tool-call-completed',callId:'launch',toolCall:{type:'task',args:{},result:{status:'success',value:{agentId:'child-agent',isBackground:false}}}}});
          return {id:'run',async *stream() { yield {type:'assistant',content:[{type:'text',text:'Parent response'}]}; },async wait() {return {status:'finished',result:'Done'};}};
        }
        async close() {}
      }`;
    writeFileSync(join(root, 'mock.mjs'), mock);
    writeFileSync(join(root, 'os.mjs'), `export const homedir = () => ${JSON.stringify(root)};`);
    writeFileSync(join(root, 'loader.mjs'), `export async function resolve(specifier, context, next) { if (specifier === '@cursor/sdk' || specifier === '@anthropic-ai/claude-agent-sdk') return {url:${JSON.stringify(pathToFileURL(join(root, 'mock.mjs')).href)},shortCircuit:true}; if (specifier === 'node:os') return {url:${JSON.stringify(pathToFileURL(join(root, 'os.mjs')).href)},shortCircuit:true}; return next(specifier,context); }`);
    const proc = spawn(process.execPath, ['--loader', join(root, 'loader.mjs'), new URL(`./${provider}-sdk-bridge.mjs`, import.meta.url).pathname], { env: { ...process.env, CURSOR_API_KEY: 'test-fixture' }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { proc.kill(); rmSync(root, {recursive:true,force:true}); });
    let output = '', errors = '';
    const events = [];
    proc.stderr.on('data', chunk => errors += chunk);
    proc.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) >= 0) { const line = output.slice(0,end); output = output.slice(end+1); if(line) events.push(JSON.parse(line)); }
    });
    function send(id, method, params) {proc.stdin.write(JSON.stringify({id,method,params})+'\n');}
    async function until(predicate) {
      for (let count=0;count<150;count++) {if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,20));}
      assert.fail(`Bridge did not respond: ${JSON.stringify(events)} ${errors}`);
    }
    send(1,'startSession',{threadId:'thread-1',directory:root});
    await until(()=>events.some(event=>event.id===1));
    if (provider==='cursor') {send(2,'sendMessage',{threadId:'thread-1',text:'Inspect'}); await until(()=>events.some(event=>event.id===2));}
    await until(()=>events.some(event=>(event.event??event.type)==='turn.completed'));
    proc.stdin.end();
    await new Promise(resolve=>proc.on('exit',resolve));
    const child = JSON.parse(readFileSync(join(root,'.agmux/threads/thread-1/subagent-conversations/launch.json')));
    assert.equal(child.status,'completed');
    assert.ok(child.items.some(item=>item.text==='PRIVATE CHILD TEXT'));
    assert.equal(events.filter(event=>(event.event??event.type)==='turn.completed').length,1);
    assert.ok(!events.some(event=>event.text==='PRIVATE CHILD TEXT'));
    assert.ok(events.some(event=>event.text==='Parent response'));
  });
}
