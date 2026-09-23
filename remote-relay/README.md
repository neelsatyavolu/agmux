# agmux remote relay

Cloudflare Worker + Durable Object fan-out for **Mobile Remote Control**.

| Piece | URL |
|-------|-----|
| Phone UI (canonical) | https://remote.agmux.dev (Worker assets) |
| Phone UI (legacy mirror) | https://agmux.dev/remote (Vercel — keep for old QR / installed PWAs) |
| WebSocket hub | `wss://remote.agmux.dev/ws` (same Worker; `*.workers.dev` still live) |

Desktop (agmux) dials out to the hub. Phone pairs via auto-link:

`https://remote.agmux.dev#pair=…&desktopId=…`

(Fragment form keeps the one-time pair code out of host access logs.)

**Compatibility:** older app builds still emit `https://agmux.dev/remote#…` pair links and may dial `wss://agmux-remote-relay.xanom.workers.dev/ws`. Both stay deployed; do not remove either without a long deprecation window.

### Same-device desktop web pair

On a Mac browser, the PWA shows **Connect this Mac**, which opens:

`agmux://remote/pair?return=https://remote.agmux.dev/`

The desktop app (scheme registered via `tauri-plugin-deep-link`) enables remote if needed, mints a pair code, and reopens the return URL with `#pair=…&desktopId=…` so the PWA auto-pairs. Return hosts are allowlisted (`remote.agmux.dev`, `agmux.dev/remote`, localhost).

### Security notes

- Desktop id is only published after the Mac has enrolled (`hello.ok`).
- Phone tokens are stored as SHA-256 hashes; desktop revokes by `deviceId`.
- Tokens expire after 90 days; disabling remote revokes all phones.
- Node hub (`server.mjs`) defaults to `127.0.0.1`; set `HOST=0.0.0.0` for Railway.

## Local dev

```bash
cd remote-relay
npm install
npx wrangler dev --port 8787
# or Node hub:
# node server.mjs   # binds 127.0.0.1:8787, auth under ./.relay-data
# HOST=0.0.0.0 PORT=8787 node server.mjs   # public bind
```

Point desktop at local relay once:

```js
await invoke("remote_set_relay_ws_base", { base: "ws://127.0.0.1:8787/ws" })
// clear override:
await invoke("remote_set_relay_ws_base", { base: null })
```

## Deploy

```bash
npx wrangler deploy
# → https://remote.agmux.dev  (+ workers.dev still up)
```

Also sync `public/` into `xanom-website/public/remote/` and deploy the marketing site so the legacy mirror stays in lockstep.

### Native iOS shell

Optional Capacitor wrapper of the same PWA lives at **`remote-mobile/`** in this monorepo
(bundle id `dev.agmux.remote`). Same relay WebSocket; no separate backend.

```bash
cd remote-mobile && npm install && npm run ios   # sync web + open Xcode
```

## Protocol

See `src/protocol.ts` and `src-tauri/src/remote/protocol.rs` in the agmux monorepo.

## Remote regression checks

```bash
node --test remote-relay/tests/*.test.mjs remote-relay/desktop-hub.test.mjs remote-mobile/scripts/sync-web.test.mjs
npm run test -- src/lib/__tests__/remoteQuestions.dom.test.ts
(cd src-tauri && cargo test -p xanom remote:: --lib)
(cd src-tauri && cargo test -p xanom remote_logs_stream_parts --lib)
npx tsc --noEmit
npm run typecheck --prefix remote-relay
```

Run these from the repository root. `public/app.html` is canonical; copy it to `public/index.html` and run `npm run sync-web --prefix remote-mobile` after UI changes. See [the provider audit](../docs/remote-control-audit-2026-09-07.md) for tested behavior and open coverage gaps. Changes to `message-ack`/request correlation require the desktop and relay updates as well as the PWA.

Large timelines use ordered snapshot/append frames below the 1 MiB UTF-8 limit. Large catalogs use `snapshotId`, `chunkIndex`, and `chunkCount` on `threads.snapshot`; the phone stages these and replaces its catalog only after all chunks arrive. Ship the updated desktop and phone frontend together. Terminal sends hold the remote busy state through the initial provider handoff; an unconfirmed handoff is shown for review rather than automatically retried.
