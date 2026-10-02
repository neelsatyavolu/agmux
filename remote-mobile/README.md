# agmux Remote — iPhone app (Capacitor)

Native iPhone app around the existing remote PWA. Same design and same backend:

| Layer | Source |
|-------|--------|
| UI | Bundled from canonical `remote-relay/public` into `www/` |
| Relay | `wss://remote.agmux.dev/ws` (the PWA picks it when not served over http(s)) |
| Desktop | agmux Mac app → Settings → Remote control (unchanged) |

This is **not** a SwiftUI rewrite. Capacitor 8 (Swift Package Manager) loads the same HTML/CSS/JS in a WKWebView.
iPhone only, portrait, iOS 17+, dark appearance. Bundle ID `dev.agmux.remote`, team `VTQW687WBQ`.

## What the native shell adds

- **Pairing kept in the Keychain** (`PairingPersistence.swift`). The PWA stores its pairing in
  `localStorage["agmux-remote-auth"]`; a document-start script restores it from the Keychain before
  any page script runs and reports every change back, so iOS clearing web storage can't unpair the phone.
  "Forget this Mac" deletes it.
- **QR codes open the app.** `applinks:remote.agmux.dev` + `remote-relay/public/.well-known/apple-app-site-association`
  (only URLs whose fragment contains `pair=`). `native-bridge.js` turns the link into the PWA's `#pair=` boot path.
  The `agmux-remote://pair?pair=…&desktopId=…` scheme works too.
- **Notifications**: `native-bridge.js` backs `window.Notification` with `@capacitor/local-notifications`, so the PWA's
  approval / finished-run alerts and its Settings sheet (`agmux-remote-prefs`) work unchanged. Tapping one opens the session.
- **Push while closed**: `@capacitor/push-notifications` registers once notifications are allowed; the PWA sends
  `push.register` (token + Settings switches) and `app.state`. The relay (`src/push.ts`, `src/push-events.ts`) sends APNs
  alerts for approvals/questions and finished runs to phones that aren't in the foreground. Secret: `APNS_KEY`.
- **Demo mode** lives in the PWA (`startDemo()`): a fake socket answers like a Mac, for App Review and screenshots.
- Reconnect on resume (`resume` → `pageshow` → `resumeIfDead()`), haptics on Allow/Deny (Settings switch),
  links open in Safari, the web view shrinks above the keyboard, "Pair this iPhone" wording.

## Prerequisites

- The **release** Xcode at `/Applications/Xcode.app` (scripts set `DEVELOPER_DIR`; beta Xcode builds are rejected by App Store Connect)
- Node 20+, CocoaPods' Ruby (only for `scripts/configure-xcode-project.rb`)
- For releases: 1Password CLI signed in (see `scripts/release-ios.sh` header)

## Develop

```bash
cd remote-mobile
npm install
npm run ios               # sync the PWA into www/, sync native, open Xcode
```

Run on a simulator from Xcode. After editing `remote-relay/public/app.html`, copy it to `index.html`
and run `npm run cap:sync`. `www/` is committed; re-sync before committing.

## Regenerating `ios/`

`npx cap add ios --packagemanager SPM` wipes the project. Re-apply agmux's settings afterwards:

```bash
GEM_HOME="$(brew --prefix cocoapods)/libexec" ruby scripts/configure-xcode-project.rb
git checkout -- ios/App/App/Info.plist ios/App/App/Assets.xcassets ios/App/App/SceneDelegate.swift
```

## Release to TestFlight

```bash
scripts/release-ios.sh              # archive, sign, upload
scripts/release-ios.sh --no-upload  # archive, sign, export build/agmux.ipa
```

Signing needs no account holder: the Apple Distribution certificate lives in 1Password, and
`scripts/asc-profile.mjs` turns on the App ID's capabilities and creates/refreshes the App Store profile
through the team's App Store Connect API key. App record, listing, privacy answers and review notes:
[`APP_STORE.md`](APP_STORE.md).

## Tests

```bash
node --test scripts/*.test.mjs                 # sync script + profile helpers
(cd ../remote-relay && npm test)               # PWA, incl. tests/native-shell.test.mjs
```

## Not yet

- Android (`npx cap add android` later)
