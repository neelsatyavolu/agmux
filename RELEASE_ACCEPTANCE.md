# Installed-app release acceptance

Run on a disposable macOS user account/test Mac, with test projects and provider accounts. Never reset the developer's live database, credentials or sessions. Record candidate version/commit, macOS version, architecture, previous public version and the result of each check. A build or unit test is not evidence for these flows. Run on Apple Silicon and Intel before claiming both are verified.

- Fresh install: open the signed/notarized DMG, install and launch without terminal workarounds.
- First run with no agents: setup explains installation and login; skipping or cancelling folder selection is safe; optional appearance/local-model setup does not block the short path.
- First conversation: install/sign in to a primary provider, open a test project, send a read-only prompt, receive a reply. Repeat for every advertised chat and terminal provider, noting unsupported combinations.
- Approvals and stop: request a harmless operation requiring approval, deny once, approve once, stop a running turn, then send a follow-up. Background sessions retain approvals.
- Persistence: close/reopen window, quit/relaunch, reopen the same conversation and continue. Check provider history on disk as well as the UI. Do not confuse app UUIDs with provider IDs.
- Load: run several sessions, switch tabs/splits, hide/unhide and sleep/wake; check output, scroll position, responsiveness and orphan processes.
- Upgrade: upgrade the previous public version with existing conversations and app records. Confirm migration backup creation, records and settings preserved, updater download/signature/relaunch successful.
- Recovery: using a disposable data directory/account, exercise an unreadable database and failed migration. Recovery screen must offer Support, folder access and restart. Restore a known snapshot only after confirmation, verify the original files survive in backups, then relaunch successfully. No automatic reset.
- Support: send a clearly labeled test report to the deployed owner service, attach a screenshot and crash/log file, optionally include a saved performance capture. Confirm receipt ID, matching owner inbox entry, byte-identical owner download, anonymous access denied, status change and no duplicate on double-click. Check offline failure retains the draft. Remove test artifacts using an authorized maintenance flow.
- Teams: verify new-session activity and coverage labels; missing provider history must remain partial and must not be advertised as complete cost/invoice reconciliation.

Record failures and platform/provider coverage explicitly. Do not check off unperformed steps. Service changes (support schema and private attachment bucket) must be deployed before distributing a desktop that depends on them.

## v4.3.0 — 2026-09-26

Candidate recorded before a signed DMG existed. Machine: macOS 27.2, Apple Silicon. Previous public version: v4.2.0. Parent commit at the start of the bump: `02677c33`.

Automated checks (pass):

- `npx tsc --noEmit`
- `npm test` — 7098 passed, 14 skipped
- `cd sidecar && npm test`
- `cd analytics-service && npm run typecheck && npm test` — 29 passed
- `cd src-tauri && cargo test -p xanom -- --test-threads=1` — 2454 passed, 26 ignored
- `cd src-tauri && python3 -m unittest discover -s tests -p 'test_codex_diff_hook.py'` — 126 tests, 1 skipped

Not run on an installed app, so these are not accepted: fresh install of the signed DMG, first-run setup, a live conversation for each provider, approvals and stop, quit/relaunch persistence, load, upgrade from the installed v4.2.0, recovery, a real support submission, or Teams on the live site. Intel was not tested on this Mac. The release workflow repeats the automated checks and builds both Mac architectures.
