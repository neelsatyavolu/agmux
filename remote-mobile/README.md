# agmux Remote — iOS (Capacitor)

Native **iOS shell** around the existing remote PWA. Same design and same backend:

| Layer | Source |
|-------|--------|
| UI | Bundled from canonical `remote-relay/public` |
| Relay | `wss://agmux-remote-relay.xanom.workers.dev/ws` (unchanged) |
| Desktop | agmux Mac app Remote control (unchanged) |

This is **not** a SwiftUI rewrite. Capacitor loads the same HTML/CSS/JS in a WKWebView with a real app icon, splash, status bar, and keyboard handling.

## Prerequisites

- macOS + **Xcode** (with iOS Simulator or a device)
- Node 20+
- Apple Developer account only when shipping to TestFlight/App Store

## Setup

```bash
cd remote-mobile
npm install
npm run sync-web          # copy latest PWA into www/
npx cap add ios           # first time only
npm run cap:sync          # re-copy web + sync native project
npm run cap:open          # open Xcode
```

In Xcode: select a simulator or your iPhone → **Run**.

## Updating the UI

Edit `remote-relay/public/app.html`, copy it to `remote-relay/public/index.html`, then:

```bash
npm run cap:sync
```

## Pairing

Same as the web app:

1. Mac: **Settings → Remote control** → enable → show code/QR  
2. Phone app: enter desktop ID + code (or open a pair link if deep-linked)

Deep link form (web / future universal links):

`https://remote.agmux.dev#pair=…&desktopId=…`

Custom scheme registered: `agmux-remote://` (for future pair-link handling).

## Dev: live site instead of bundle

In `capacitor.config.ts`, uncomment:

```ts
server: { url: 'https://remote.agmux.dev/', cleartext: false },
```

Then `npm run cap:sync`. Useful while iterating on the PWA without rebundling.

## App Store notes

- Bundle ID: `dev.agmux.remote`
- Privacy: remote control of the user’s own Mac over TLS; no chat content stored on agmux servers
- Push notifications / Face ID: not in this shell yet (add Capacitor plugins when needed)

## Out of scope (for now)

- Android (same Capacitor project can add `npx cap add android` later)
- Push when a turn finishes
- Universal Links / QR auto-pair into the app
- Offline UI beyond the last bundled assets
