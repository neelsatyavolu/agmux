# invoke-audit

Audit all Tauri `invoke()` calls in the frontend for common mistakes.

## Checks

1. **Missing error handling:** Find all `invoke(` calls that lack `.catch()` or are not inside a `try/catch` block. Every invoke in event handlers or effects MUST have error handling — unhandled rejections are invisible to users.

2. **Snake_case keys:** Find any `invoke(` calls where the parameter object uses `snake_case` keys instead of `camelCase`. Tauri v2 auto-converts from Rust snake_case, so JS must use camelCase.

3. **Missing await:** Find any `invoke(` calls in async functions that are missing `await`.

## How

- Search all `.ts` and `.tsx` files in `src/` for `invoke(` patterns
- For each call, check surrounding context for error handling
- For each call, inspect the parameter object keys
- Report findings grouped by file, with line numbers
- Rate severity: CRITICAL (missing error handling), HIGH (wrong key casing), MEDIUM (missing await)

Do NOT fix anything — report only.
