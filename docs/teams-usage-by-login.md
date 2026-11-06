# Teams: usage split by login

Requested by a Teams user (2026-11-06): "Would be good to split by Claude
username" — a member who uses several Claude (or Codex) logins, some of them
shared, wants to see how many tokens went through each.

Owner decisions (2026-11-06):

- Claude and Codex.
- A Claude login is named by its email only when the team owner has turned on
  the existing **Shared Claude accounts** switch (`provider_account_settings.claude_activity`).
  Otherwise logins show as "Claude login 1", "Claude login 2"… (stable order per member).
- Codex logins are named by the team pool account label when the identity hash
  matches a `provider_accounts` row of that team, else "Codex login N".
- Same visibility as the rest of the dashboard: employees see their own,
  managers/owners see the members in their scope.

## Why the desktop must record it

Provider transcripts do not say which login ran them, and account homes share
`~/.claude/projects`. Each app records the login **when it starts or resumes a
session**, and keeps the record locally. Automatic account switching resumes the
*same* session under another login, so a record is a time span:
`(provider, native session id, identity hash, label?, from_ms)`. An event belongs
to the latest span of its session whose `from_ms <= event time`. Events with no
span (sessions from before this feature, or launched where the login was unknown)
are not attributed; the server shows them as "Not attributed".

## Identity hash (must match across agmux, agterm and the pool)

- Claude: lowercase hex `sha256` of the compact JSON array `["claude", identity]`,
  exactly as agmux `provider_accounts::activity::claude_hash` writes it with
  `serde_json` (no spaces, `/` NOT escaped). `identity` is
  `claude:account-org:["<accountUuid>","<orgId>"]` when both are known, else
  `claude:email-org:["<lowercased email>","<orgId>"]`
  (`provider_accounts/claude.rs` `parse_metadata`).
- Codex: `provider_accounts::profile::team_identity_hash("codex", auth.json)` —
  the same hash the team pool stores in `provider_accounts.identity_hash`.
- Swift trap: `JSONSerialization` escapes `/` as `\/`; build the string by hand or
  strip that, and pin it with a test vector shared with Rust.

## Upload contract (additive)

`POST /api/metrics/upload` body gains two optional arrays. Old desktops omit them.

```jsonc
{
  "batchId": "…",
  "buckets": [ … ],                 // unchanged
  "accountBuckets": [               // ≤ 2000 per batch
    {
      "hourUtc": "2026-11-06T14",
      "provider": "claude",          // "claude" | "codex" (lowercase, as the pool;
                                     // regular buckets keep "ClaudeCode" / "Codex")
      "identityHash": "<64 hex>",
      "tokensIn": 0, "tokensOut": 0, "tokensCacheRead": 0,
      "tokensCacheWrite": 0, "tokensReasoning": 0,
      "costUsd": 0, "costIncomplete": true,
      "activeMs": 0, "turns": 0
    }
  ],
  "accountLabels": [                // Claude only; ≤ 50
    { "provider": "claude", "identityHash": "<64 hex>", "label": "name@example.com" }
  ]
}
```

- Same rules as `buckets`: absolute counters for the whole hour, replaced on the
  server (never added). Counters are the same numbers the regular buckets use
  (same cost calculator), restricted to attributed events. One row per
  (hour, provider, identityHash), summed across models and projects.
- Every full snapshot sends every account bucket again, like `buckets`; prune
  removes account rows not refreshed by the snapshot.
- `accountLabels` are sent only when the desktop knows at least one of its teams
  has Shared Claude accounts on (agmux: the activity report already learns this;
  agterm: `GET /api/teams/:key/provider-accounts/activity` → `claudeActivity`).
  The server stores a label only for teams with the switch on and deletes Claude
  labels when it is turned off.
- `accountsReported: true` is sent on every upload from a desktop that has this
  feature, even with no account buckets, so the dashboard can tell "this app does
  not report logins" from "nothing attributed".

## Server

- D1 `metric_account_hourly` (PK team, user, device, hour, provider, identity_hash)
  and `account_labels` (PK team, user, provider, identity_hash); migration 019.
- `sync_state.accounts_reported_at` marks devices that send the new fields.
- Retention, prune and member removal treat the new table like `metric_hourly`.
- `GET …/members/:id` and `…/me` responses gain `logins`:
  `{ reported: boolean, rows: [{ provider, identityHash|null, name, tokens, costUsd, costIncomplete, activeHours, share }] }`
  with one `identityHash: null` "Not attributed" row per provider holding
  `metric_hourly` total minus attributed tokens (never negative).
- Disclosure copy (`teams-service/web/disclosure.js` and
  `src/components/teams/disclosureCopy.ts`, word-identical) names the new field.
