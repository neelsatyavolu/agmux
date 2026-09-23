# agmux patch of wry 0.54.4

Vendored from crates.io `wry` 0.54.4 and wired via `[patch.crates-io]` in
`src-tauri/Cargo.toml`.

## Why

macOS file drag into the WKWebView calls `collect_paths` on **every**
`draggingEntered` / drop. Upstream does:

```rust
pb.propertyListForType(NSFilenamesPboardType).unwrap()
  .downcast::<NSArray>().unwrap()
```

On newer macOS (observed on 26/27 betas with agmux 3.1.4) the pasteboard can
advertise `NSFilenamesPboardType` while the property list is nil or not an
array. That panics on the main AppKit thread. Release builds use
`panic = "abort"`, so the whole app dies mid-drag (Claude terminal file drop
was the reported repro).

## Diff

`src/wkwebview/drag_drop.rs` — `collect_paths` uses `if let` / `continue`
instead of `unwrap`, and skips null `UTF8String` pointers. Still reads
`NSFilenamesPboardType` (deprecated) because Finder drag exposes it; silenced
with `#[allow(deprecated)]`. Dropped unnecessary `unsafe` around
`draggingLocation()` under objc2-app-kit 0.3.

## Drop when upgrading wry

When Tauri bumps to a wry that already has this (or equivalent) fix, delete
this vendor tree and the `[patch.crates-io] wry = …` entry.
