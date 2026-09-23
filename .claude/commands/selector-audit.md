# selector-audit

Audit Zustand store selectors for unstable reference patterns that cause infinite re-render loops.

## Checks

1. **`|| []` or `|| {}` in selectors:** These create a new reference on every call, causing `useSyncExternalStore` to loop infinitely. Must use module-level constants with `??` instead.

   ```tsx
   // BAD
   useStore((s) => s.items || [])

   // GOOD
   const EMPTY: Item[] = [];
   useStore((s) => s.items ?? EMPTY)
   ```

2. **Inline object/array creation in selectors:** Any selector that returns `{ ...spread }`, `[...spread]`, `.map()`, `.filter()`, or `Object.keys()` without memoization creates new references every call.

3. **Selector functions that derive new objects:** Look for selectors computing derived state inline instead of using `useMemo` or storing derived state in the store.

## How

- Search all `.ts` and `.tsx` files in `src/` for `useStore(`, `use.*Store(`
- Check each selector callback for the patterns above
- Also check store definitions in `src/stores/` for selector helpers
- Report findings with file, line number, the problematic pattern, and the fix
- Rate severity: CRITICAL (will cause infinite loop), HIGH (performance issue), MEDIUM (code smell)

Do NOT fix anything — report only.
