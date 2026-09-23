# sync-claude-md

Audit CLAUDE.md against the actual codebase and update any outdated sections.

## Steps

1. **Scan the codebase** for current state:
   - List all Tauri commands registered in `lib.rs` `invoke_handler![]`
   - List all Zustand stores in `src/stores/`
   - List all components in `src/components/`
   - List all Rust modules in `src-tauri/src/`
   - List all SQLite migrations in `src-tauri/migrations/`
   - List all database tables referenced in migrations
   - List all event names (emit/listen patterns)

2. **Compare against CLAUDE.md** sections:
   - Architecture descriptions
   - Project Structure tree
   - Database tables list
   - Store list
   - Component descriptions
   - Command descriptions

3. **Report differences:**
   - New items not documented in CLAUDE.md
   - Items documented but no longer existing
   - Descriptions that appear outdated

4. **Update CLAUDE.md** with the findings, preserving the existing format and style.

5. **Also check `.claude/rules/`** files for consistency with CLAUDE.md.

Be thorough but preserve the existing writing style. Only update sections that are actually wrong or missing — don't rewrite things that are accurate.
