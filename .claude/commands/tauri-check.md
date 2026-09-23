# tauri-check

Full build validation for both TypeScript and Rust sides of the app.

## Steps

1. Run TypeScript type checking: `npx tsc --noEmit`
2. Run Rust cargo check: `cd src-tauri && cargo check`
3. Report any errors found in either step
4. If both pass, confirm the build is clean

Run both checks and report results. If either fails, show the errors clearly with file paths and line numbers. Do NOT attempt to fix anything — just report.
