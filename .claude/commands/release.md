# release

Create a GitHub release for agmux with user-facing release notes. Version number is provided as an argument.

Usage: `/release 0.4.8`

The argument `$ARGUMENTS` is the version number (e.g. `0.4.8`).

## Steps

1. Parse the version number from `$ARGUMENTS`. If empty or missing, ask the user for a version number and stop.
1a. **Claude Agent SDK preflight** — verify we are shipping against the latest SDK release. Do this BEFORE the version bump:
    - Read current version from `sidecar/package.json` (`@anthropic-ai/claude-agent-sdk` in `dependencies`).
    - Fetch latest version: `npm view @anthropic-ai/claude-agent-sdk version`.
    - If they match, print `✓ Claude Agent SDK up to date (vX.Y.Z)` and continue to step 2.
    - If they differ, run the conflict/compatibility check:
      - Fetch release notes for every version between current (exclusive) and latest (inclusive):
        `gh api repos/anthropics/claude-agent-sdk-typescript/releases --jq '.[] | select(.tag_name >= "v<current>" and .tag_name <= "v<latest>") | {tag: .tag_name, body: .body}'`
      - Scan each `body` for breaking-change signals: the words `Breaking`, `BREAKING`, `removed`, `renamed`, `replaced`, `no longer`, or a native-binary split (phrases like `native binary`, `per-platform`, `optional dependency`).
      - For each flagged item, check our code for impact:
        - `options.env` / env-handling changes → grep `sidecar/claude-sdk-bridge.mjs` for `env:`
        - Native-binary / `pathToClaudeCodeExecutable` → confirm `src-tauri/src/commands/claude_sdk.rs` still passes `claudeBinaryPath` and `sidecar/build.mjs` externalizes `@anthropic-ai/claude-agent-sdk-*` subpackages
        - Removed/renamed JSON-RPC-visible options (`query()` params) → grep `sidecar/claude-sdk-bridge.mjs` for each removed name
        - Event name changes → grep `system-events.mjs`, `subagent-tool-events.mjs`, and `src/lib/sdkSessionAdapter.ts`
      - Summarize findings as a table: version · change · impact on agmux · suggested action (safe to bump / requires code change / block release).
    - Present the summary to the user and STOP. Do not bump or release until the user responds with one of:
      - `proceed` — ship on current SDK version, no upgrade this release
      - `upgrade` — bump `sidecar/package.json` to latest, run `cd sidecar && npm install && node build.mjs && npm test`, verify `cargo check` and `tsc --noEmit`, then continue
      - `abort` — stop entirely
    - If all intermediate releases are parity-only patches with no breaking signals, still surface the version delta and suggest `upgrade`, but allow `proceed` without manual review.
2. Read the `## Unreleased` section of `RELEASE_NOTES.md`. This is the primary source for release notes — agents append to it as they make user-facing changes (see `CLAUDE.md` → Workflow → Mandatory). Treat its `### New` / `### Improved` / `### Fixed` bullets as already-drafted content, not raw material to rewrite from scratch.
   - **Net delta only**: `## Unreleased` must describe what changed vs the last public GitHub release — not intermediate local fix-churn of unreleased WIP. Before shipping, drop or fold any Fixed bullets that only polish work never shipped (fold into the New/Improved feature bullet).
3. **Cross-check for gaps** — don't trust the log blindly:
   - Run `git log --oneline` from the last version bump commit (find it with `git log --oneline --grep="bump version"`) to HEAD.
   - Run `git diff <last-version-bump-commit>..HEAD --stat` to see all changed files.
   - For any non-trivial user-facing file (`src/`, `src-tauri/src/commands/`, `src-tauri/src/mlx/`, etc.) that doesn't obviously correspond to an existing bullet in `RELEASE_NOTES.md`, read its diff (`git diff <last-version-bump-commit>..HEAD -- <file>`) and draft a bullet for it in the correct category. Skip purely internal files (tests, sidecar internals with no user-visible effect, tooling, docs). Skip local polish of unreleased features already covered by a New/Improved bullet.
   - If you find gaps, mention them to the user before finalizing — someone forgot to log a change, which is worth surfacing so the habit improves.
4. Bump the version in ALL of these files (replace the old version with the new one):
   - `package.json` (`"version": "X.Y.Z"`)
   - `src-tauri/tauri.conf.json` (`"version": "X.Y.Z"`)
   - `src-tauri/Cargo.toml` (`version = "X.Y.Z"`)
   - `CLAUDE.md` (header line `# CLAUDE.md — agmux (vX.Y.Z)`)
5. Run `npx tsc --noEmit`, `npm test`, `cd sidecar && npm test`, `cd src-tauri && cargo test -p xanom`, and owner-service typecheck/tests. Fix failures before proceeding. Complete `RELEASE_ACCEPTANCE.md` against the candidate installed app and the previous public version; record actual evidence and untested platforms. Do not call fixture tests live acceptance or broadly announce a release with unresolved acceptance failures. The tag workflow repeats automated checks before publishing.
6. Assemble the final release notes (see Format section below): a tagline + summary (write these fresh — `RELEASE_NOTES.md` doesn't carry them), followed by the `### New` / `### Improved` / `### Fixed` bullets from `RELEASE_NOTES.md`'s `## Unreleased` section plus any gap-fill bullets drafted in step 3. Lightly edit for clarity/tone but don't re-derive content that's already there.
7. **Reset `RELEASE_NOTES.md`**: move the (now finalized) `## Unreleased` content into a new dated section below it — `## v<version> — <YYYY-MM-DD>` — and clear the `## Unreleased` section back to empty `### New` / `### Improved` / `### Fixed` stubs.
8. Stage all changed files (including `RELEASE_NOTES.md`) and commit with message: `chore: bump version to v<version>`
9. Push to the public repo: `git push origin master`
10. Create the GitHub release as a **prerelease** (its tag triggers `.github/workflows/release.yml`, which builds, signs, notarizes, uploads the DMGs + `latest.json`, then promotes it to the latest release and updates Homebrew). Prerelease keeps `releases/latest` on the previous version until the assets exist:
    ```
    gh release create v<version> -R neelsatyavolu/agmux --target master --prerelease --title "v<version>" --notes "<release notes>"
    ```
    Watch it with `gh run watch -R neelsatyavolu/agmux`.
11. Return the release URL to the user.

## Release Notes Format (CRITICAL)

The WhatsNewDialog parser (`src/components/WhatsNewDialog.tsx`) renders each bullet as a card with a colored category pill (emerald = New, blue = Improved, purple = Fixed). The category is inferred from the section heading, so use the canonical `### New` / `### Improved` / `### Fixed` headings.

**Required format:**
```markdown
Tagline goes here — one short sentence, shown big in the dialog header.

One-paragraph summary sentence that expands the tagline. Shown in zinc under the tagline.

### New
- **Task mode** — Worktree-isolated agent runs with a dedicated review sidebar.
- **Live preview window** — See the agent's current diff render in real-time.

### Improved
- **PTY runner is ~40% faster** — New sidecar writes to xterm.js directly.
- **Sidebar thread search** — Fuzzy-match on title and the last user message.

### Fixed
- **Chat scroll no longer jumps** — Fixed a race when a tool-use block expanded mid-stream.
- **Worktree cleanup on quit** — Stale `.xanom/worktrees` entries are now pruned on clean exit.
```

**Rules:**
- Pre-heading prose is optional. If present, the **first non-blank line** becomes the dialog's big tagline, and the **remaining lines** become the summary paragraph. Skip it on patch releases.
- Section headings MUST be `###` (three hashes) and SHOULD be one of: `New`, `Improved`, `Fixed` (aliases like `New Features`, `Improvements`, `Bug Fixes` also map correctly via keyword detection). Any unrecognized heading falls back to the **New** category.
- Every item MUST start with `- ` (bullet). Use the form `- **Title** — body` (em-dash separator preferred; ` - ` and `: ` also work). The title becomes the card heading, the body is the muted subtitle.
- Per-item category override: prefix the bullet with `[new]`, `[improved]`, or `[fixed]` to tag one item differently from its section (e.g., putting a stray fix inside a `### New` section). Example: `- [fixed] **Regression in X** — …`.
- Bold (`**text**`) in bullets is OK — the parser strips it for display.
- Keep each bullet to 1-2 lines.
- Do not include `## `-level headings — they're ignored.

## Rules

- The release is ONLY created in the public `neelsatyavolu/agmux` repo. `neel-xanom/agmux-releases` holds full releases up to v4.1.3; the workflow copies only each new `latest.json` there so older app versions' fallback update check keeps working. Never delete that repo.
- Release notes are written for END USERS, not developers.
- `RELEASE_NOTES.md`'s `## Unreleased` section is the source of truth for what shipped — agents log entries there as they work (see `CLAUDE.md` → Workflow → Mandatory). Don't discard it and reconstruct from the diff; use the diff only to catch gaps.
- If there are uncommitted changes beyond the version bump, include them in the release commit.
- If `npx tsc --noEmit` fails, fix errors before committing.
- Always verify the old version number by reading the files before replacing — don't assume.
