// Local-only compatibility check of the actual pre-Accounts production bundle and release candidate.
// Uses synthetic identities/credentials and pre-012 schema; no production requests.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../package.json', import.meta.url));
if (process.argv.length !== 4) throw new Error('Usage: node test/provider-accounts-release.workerd.mjs baseline.js candidate.js');
const {Miniflare}=require('miniflare');
const legacy=execFileSync('git',['show','acd290ea:teams-service/schema.sql'],{cwd:new URL('../../', import.meta.url),encoding:'utf8'});
const migration=readFileSync(new URL('../migrations/013_provider_accounts.sql', import.meta.url),'utf8');
const baseline=readFileSync(process.argv[2],'utf8');
const candidate=readFileSync(process.argv[3],'utf8');
const runners=[];
async function fixture(script,key,migrated){
 const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{APP_ORIGIN:'https://teams.test',BILLING_ENFORCE:'false',...(key?{PROVIDER_ACCOUNTS_KEY:Buffer.alloc(32,3).toString('base64')}: {})}});runners.push(mf);
 const db=await mf.getD1Database('DB');
 for(const sql of (legacy+(migrated?migration:'')).replace(/--[^\n]*/g,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 for(const id of ['owner','employee']){
  await db.prepare("INSERT INTO users(id,display_name,created_at) VALUES(?,?,'2026-01-01')").bind(id,id).run();
  await db.prepare("INSERT INTO device_tokens(token_hash,device_id,user_id,created_at) VALUES(?,?,?,'2026-01-01')").bind(createHash('sha256').update(id).digest('hex'),id+'-device',id).run();
 }
 await db.prepare("INSERT INTO teams(id,slug,name,created_by,created_at,billing_status) VALUES('team','team','Team','owner','2026-01-01','comp')").run();
 for(const id of ['owner','employee'])await db.prepare("INSERT INTO team_members(id,team_id,user_id,role,joined_at) VALUES(?,'team',?,?,'2026-01-01')").bind(id,id,id).run();
 return {mf,db};
}
function normalized(v){
 if(Array.isArray(v))return v.map(normalized);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['acceptedAt','last_seen_at','lastUploadAt','last_upload_at','createdAt','updatedAt'].includes(k)).map(([k,v])=>[k,normalized(v)]));
 return v;
}
async function call(mf,path,body,method,user='employee'){
 const r=await mf.dispatchFetch('https://teams.test'+path,{method:method||(body?'POST':'GET'),headers:{authorization:'Bearer '+user,'content-type':'application/json',accept:'text/html'},...(body?{body:JSON.stringify(body)}:{})});
 return {status:r.status,data:normalized(await r.json())};
}
try{
 const old=await fixture(baseline,false,false), upgraded=await fixture(candidate,true,true), noKey=await fixture(candidate,false,true);
 const cases=[['/api/auth/me'],['/api/teams'],['/api/teams/team/policy'],['/api/metrics/sync-state'],['/api/teams/team/overview'],['/api/teams/team/me'],['/api/teams/team/billing']];
 for(const [path] of cases){
  const expected=await call(old.mf,path);assert.equal(expected.status,200,path);
  assert.deepEqual(await call(upgraded.mf,path),expected,path+' upgraded');
  assert.deepEqual(await call(noKey.mf,path),expected,path+' missing key');
 }
 const payload={batchId:'old-client',buckets:[{hourUtc:new Date(Date.now()-3600000).toISOString().slice(0,13),provider:'Codex',model:'gpt-5',projectKey:'legacy',tokensIn:100,tokensOut:50,costUsd:0.1,activeMs:5000,sessions:1,turns:1,toolCalls:2}]};
 for(const target of [old,upgraded,noKey]){
  const result=await call(target.mf,'/api/metrics/upload',payload);assert.equal(result.status,200);assert.equal(result.data.data.accepted,true);
  const retry=await call(target.mf,'/api/metrics/upload',payload);assert.equal(retry.data.data.duplicate,true);
 }
 const legacyPolicy={allowedProviders:[],allowedModels:[],defaultPermissionMode:null,mcpAllowlist:[],spendHardStopUsd:null};
 const expected=await call(old.mf,'/api/teams/team/policy',legacyPolicy,'PUT','owner');assert.equal(expected.status,200);
 assert.deepEqual(await call(upgraded.mf,'/api/teams/team/policy',legacyPolicy,'PUT','owner'),expected);
 assert.equal((await call(upgraded.mf,'/api/teams/team/provider-accounts')).status,200);
 assert.equal((await call(noKey.mf,'/api/teams/team/provider-accounts')).status,503);
 // Downgrade direction: original code still functions with additive table in place.
 for(const sql of migration.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await old.db.prepare(sql).run();
 assert.equal((await call(old.mf,'/api/teams/team/policy')).status,200);
 assert.equal((await call(old.mf,'/api/metrics/upload',{...payload,batchId:'after-migration'})).status,200);
 console.log('PASS actual deployed baseline vs isolated candidate: 7 existing read contracts, missing-key behavior, old upload/retry, legacy policy PUT, additive migration downgrade.');
}finally{await Promise.all(runners.map(mf=>mf.dispose()));}
