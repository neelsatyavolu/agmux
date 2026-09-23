/** Optional local D1/Workers runtime smoke: node test/provider-accounts.workerd.mjs.
 * Uses Miniflare/esbuild shipped with Wrangler; no remote resources or real credentials.
 */
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const bundle = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022" });
const compatibilityDate = /compatibility_date\s*=\s*"([^"]+)"/.exec(readFileSync("wrangler.toml", "utf8"))[1];
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate,
  d1Databases: ["DB"], bindings: { PROVIDER_ACCOUNTS_KEY: Buffer.alloc(32, 5).toString("base64") } });
try {
  const db = await mf.getD1Database("DB");
  for (const sql of readFileSync("schema.sql", "utf8").replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for (const id of ["owner", "employee"]) {
    await db.prepare("INSERT INTO users(id,display_name,created_at) VALUES(?,?,'now')").bind(id, id).run();
    await db.prepare("INSERT INTO device_tokens(token_hash,device_id,user_id,created_at) VALUES(?,?,?,'now')")
      .bind(createHash("sha256").update(id).digest("hex"), `${id}-device`, id).run();
  }
  await db.prepare("INSERT INTO teams(id,slug,name,created_by,created_at) VALUES('team','team','Team','owner','now')").run();
  for (const id of ["owner", "employee"]) await db.prepare("INSERT INTO team_members(id,team_id,user_id,role,joined_at) VALUES(?,'team',?,?,'now')").bind(id, id, id).run();
  const call = (user, path, body) => mf.dispatchFetch(`https://teams.test/api/teams/team/provider-accounts${path}`, {
    method: "POST", headers: { authorization: `Bearer ${user}` }, body: JSON.stringify(body),
  });
  const payload = { provider: "codex", label: "Test", credentials: {
    tokens: { access_token: "synthetic", refresh_token: "synthetic", id_token: `header.${Buffer.from(JSON.stringify({ sub: "synthetic" })).toString("base64url")}.signature`, account_id: "synthetic" },
  } };
  const creates = await Promise.all(Array.from({ length: 8 }, () => call("owner", "", payload)));
  assert.equal(creates.filter(r => r.status === 201).length, 1);
  assert.ok(creates.every(r => [200, 201, 409].includes(r.status)));
  const count = await db.prepare("SELECT count(*) AS n FROM provider_accounts").first();
  assert.equal(count.n, 1);
  const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => call("employee", "/allocate", { provider: "codex", sessionId: `s${i}` })));
  assert.equal(claims.filter(r => r.status === 200).length, 1);
  assert.equal(claims.filter(r => r.status === 409).length, 11);
  const success = await claims.find(r => r.status === 200).json();
  const renewed = await call("employee", `/leases/${success.data.leaseId}/renew`, { remainingPercent: 0, blockedUntil: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(renewed.status, 200, await renewed.text());
  console.log("Local workerd/D1 PASS: 8 duplicate uploads (1 account), 12 concurrent claims (1 success/11 conflicts), health renewal.");
} finally { await mf.dispose(); }
