# agmux Remote — App Store submission

Everything needed to put the iPhone app on TestFlight and the App Store, checked
against the [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Guideline checklist

| Guideline | How the app meets it | Status |
|---|---|---|
| 1.5 Developer information | Support URL is the public issue tracker; the privacy policy has a contact section. | Done |
| 2.1 App completeness | Reviewers can't pair a Mac, so the first screen has **Try a demo**: sample sessions answered on the phone (approve a tool, watch a reply stream, send messages, open Settings). Review notes point to it. | Done |
| 2.3 Accurate metadata | Screenshots must show the real app. Capture them in demo mode (no personal project names). | **Before App Store review** |
| 2.5.1 Public APIs only | Capacitor and WebKit only. | Done |
| 2.5.2 Self-contained | The UI ships inside the app (`www/`); the app never loads remote code. Updating the UI means a new build. | Done |
| 2.5.6 Web content uses WebKit | WKWebView. Links open in Safari, never in an in-app browser. | Done |
| 4.0 Design | iPhone only, portrait, dark appearance, safe areas, keyboard pushes the composer up. | Done |
| 4.2 Minimum functionality | Native features beyond the website: Keychain-kept pairing, QR codes open the app (Universal Links), iOS notifications for approvals and finished runs with a Settings screen, camera and photo attachments, haptics, push notifications while the app is closed (relay → APNs), in-app QR scanning. | Done |
| 4.2.3 Works on its own | It is a companion to the free agmux Mac app; say so in the description and Review notes. | Done (copy below) |
| 5.1.1(i) Privacy policy | Linked in App Store Connect and inside the app (pairing screen and the More menu). The policy names the iPhone app. | Done once agmux.dev is deployed |
| 5.1.1(ii) Permissions | Camera and photos are asked for only when the user attaches an image; purpose strings explain why. Nothing is requested at launch. | Done |
| 5.1.1(v) Account deletion | No accounts. "Forget this Mac" signs the phone out; revoking on the Mac removes access. | Done |
| 5.1.2 Data use | No analytics, ads or tracking. | Done |
| 5.2 Intellectual property | Agent names and icons appear only to label the user's own sessions. Keep third-party names and logos out of the app name, keywords and screenshots. | Follow when writing metadata |
| Export compliance | Only HTTPS/WSS through iOS; `ITSAppUsesNonExemptEncryption = false`, so no question per build. | Done |
| Privacy manifest | `PrivacyInfo.xcprivacy` (no tracking, no collected data, no required-reason APIs); Capacitor ships its own. | Done |
| SDK / Xcode | Built by `scripts/release-ios.sh` with the release Xcode (beta-Xcode builds are rejected). | Done |
| IPv6 | Review runs on IPv6-only networks; the relay (Cloudflare) supports IPv6. | Done |

## Create the app record (once)

App Store Connect → Apps → **+** → New App (an Admin can do this; the API can't):

| Field | Value |
|---|---|
| Platform | iOS |
| Name | agmux Remote |
| Primary language | English (U.S.) |
| Bundle ID | dev.agmux.remote |
| SKU | agmux-remote-ios |
| User access | Full access |

Then `scripts/release-ios.sh` uploads builds; they appear under TestFlight after processing.
Internal testers (team members) need no review. External testers need Beta App Review.

## Listing

- **Subtitle:** Your Mac's coding agents, anywhere
- **Category:** Developer Tools · secondary Productivity
- **Support URL:** https://github.com/neelsatyavolu/agmux/issues
- **Marketing URL:** https://agmux.dev
- **Privacy Policy URL:** https://agmux.dev/privacy
- **Keywords:** `ai,coding,agent,remote,mac,developer,terminal,llm,assistant,approve,code,programming`

**Promotional text**

> Follow the coding agents running in agmux on your Mac. Reply, approve tool requests and start new chats from your iPhone.

**Description**

> agmux Remote puts the coding agents running on your Mac in your pocket.
>
> Pair your iPhone with agmux on your Mac once, then:
> • See every agent session and follow its progress live
> • Reply to an agent or start a new chat
> • Approve or deny tool requests while you're away from your desk
> • Attach photos from your camera or library
> • Stop a run that's heading the wrong way
>
> agmux Remote connects to agmux on your Mac through an encrypted relay. Your agents, files and API keys stay on your Mac. Pairing takes a one-time code or a QR scan, and you can revoke this phone from your Mac at any time.
>
> Requires agmux for macOS (free at agmux.dev) running on your Mac with Remote control turned on.

**Screenshots:** 6.9" iPhone (1320 × 2868), at least 3: session list, a live session, an approval. Capture in demo mode on the iPhone 17 Pro Max simulator.

## App Privacy answers

- **Tracking:** No.
- **Data collected:** Identifiers → **Device ID** (the random pairing ID the relay keeps for this phone). Purpose: App Functionality. Linked to the user: No. Used for tracking: No.
- **Everything else:** Not collected. Messages and attached photos pass through the relay in real time to the user's own Mac and aren't stored, which Apple doesn't count as collection.

## Age rating

Answer "None" to every content question. Unrestricted web access: No (links open in Safari).
If asked about AI-generated content, answer Yes: the app shows output from AI models the user runs on their own Mac.

## Review notes

> agmux Remote is the companion app for agmux, a free macOS app (https://agmux.dev) that runs AI coding agents on the user's own Mac. The iPhone app shows those sessions and lets the user reply and approve tool requests remotely.
>
> It needs a Mac running agmux with Settings → Remote control turned on; the user pairs with the code or QR code shown there. No account or sign-in exists.
>
> To try the app without a Mac, tap **Try a demo** on the first screen. It loads sample sessions on the phone: open "Fix the flaky checkout test" to approve a tool request, send a message in any session, and open Settings from the ••• menu. "Exit demo" in the same menu returns to pairing.

## TestFlight "What to test"

> Pair with agmux on your Mac (Settings → Remote control), then open a session, send a message, approve a tool request, attach a photo, lock the phone for a minute and come back. Scanning the Mac's QR code with the iPhone camera should open the app.
