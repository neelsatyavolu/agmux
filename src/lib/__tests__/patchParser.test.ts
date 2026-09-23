import { describe, expect, it } from "vitest";
import {
  isApplyPatch,
  isPatchText,
  isUnifiedPatch,
  parseApplyPatch,
  parsePatchText,
  parseUnifiedPatch,
  summarizePatchText,
} from "../patchParser";

const UNIFIED_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 keep me
-old line
+new line
 trailing`;

const APPLY_PATCH = `*** Begin Patch
*** Update File: src/bar.ts
@@
 context
-removed
+added
*** End Patch`;

describe("patch format detection", () => {
  it("isUnifiedPatch recognises a standard unified diff", () => {
    expect(isUnifiedPatch(UNIFIED_DIFF)).toBe(true);
  });

  it("isUnifiedPatch rejects arbitrary text", () => {
    expect(isUnifiedPatch("just prose")).toBe(false);
    expect(isUnifiedPatch("--- not a patch")).toBe(false);
  });

  it("isApplyPatch recognises the Begin/End Patch envelope", () => {
    expect(isApplyPatch(APPLY_PATCH)).toBe(true);
  });

  it("isApplyPatch rejects unified diffs", () => {
    expect(isApplyPatch(UNIFIED_DIFF)).toBe(false);
  });

  it("isPatchText accepts both formats", () => {
    expect(isPatchText(UNIFIED_DIFF)).toBe(true);
    expect(isPatchText(APPLY_PATCH)).toBe(true);
    expect(isPatchText("nope")).toBe(false);
  });
});

describe("parseUnifiedPatch", () => {
  it("extracts file path, old content, and new content", () => {
    const hunks = parseUnifiedPatch(UNIFIED_DIFF);
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk.filePath).toBe("src/foo.ts");
    expect(hunk.oldContent.split("\n")).toEqual([
      "keep me",
      "old line",
      "trailing",
    ]);
    expect(hunk.newContent.split("\n")).toEqual([
      "keep me",
      "new line",
      "trailing",
    ]);
  });

  it("handles multi-file unified diffs", () => {
    const multi = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a old
+a new
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-b old
+b new`;
    const hunks = parseUnifiedPatch(multi);
    expect(hunks.map((h) => h.filePath)).toEqual(["a.ts", "b.ts"]);
    expect(hunks[0].newContent).toBe("a new");
    expect(hunks[1].newContent).toBe("b new");
  });

  it("returns a stub hunk when no --- / +++ markers are present", () => {
    const hunks = parseUnifiedPatch("not actually a patch");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].filePath).toBe("");
    expect(hunks[0].oldContent).toBe("not actually a patch");
  });
});

describe("parseApplyPatch", () => {
  it("parses an Update File block", () => {
    const hunks = parseApplyPatch(APPLY_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].filePath).toBe("src/bar.ts");
    expect(hunks[0].oldContent.split("\n")).toEqual(["context", "removed"]);
    expect(hunks[0].newContent.split("\n")).toEqual(["context", "added"]);
  });

  it("parses an Add File block (only the new content is populated)", () => {
    const input = `*** Begin Patch
*** Add File: src/new.ts
+line one
+line two
*** End Patch`;
    const hunks = parseApplyPatch(input);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].filePath).toBe("src/new.ts");
    expect(hunks[0].oldContent).toBe("");
    expect(hunks[0].newContent.split("\n")).toEqual(["line one", "line two"]);
  });

  it("parses a Delete File block (only the old content is populated)", () => {
    const input = `*** Begin Patch
*** Delete File: src/gone.ts
-line one
-line two
*** End Patch`;
    const hunks = parseApplyPatch(input);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].filePath).toBe("src/gone.ts");
    expect(hunks[0].newContent).toBe("");
    expect(hunks[0].oldContent.split("\n")).toEqual(["line one", "line two"]);
  });

  it("handles multiple files in a single apply-patch envelope", () => {
    const input = `*** Begin Patch
*** Update File: a.ts
-oldA
+newA
*** Update File: b.ts
-oldB
+newB
*** End Patch`;
    const hunks = parseApplyPatch(input);
    expect(hunks.map((h) => h.filePath)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("parsePatchText", () => {
  it("dispatches unified diffs to parseUnifiedPatch", () => {
    const hunks = parsePatchText(UNIFIED_DIFF);
    expect(hunks[0].filePath).toBe("src/foo.ts");
  });

  it("dispatches apply-patch format to parseApplyPatch", () => {
    const hunks = parsePatchText(APPLY_PATCH);
    expect(hunks[0].filePath).toBe("src/bar.ts");
  });
});

describe("summarizePatchText", () => {
  it("returns null for non-patch text", () => {
    expect(summarizePatchText("not a patch")).toBeNull();
  });

  it("summarises file paths plus addition/deletion counts for a unified diff", () => {
    const summary = summarizePatchText(UNIFIED_DIFF);
    expect(summary).not.toBeNull();
    expect(summary!.filePaths).toEqual(["src/foo.ts"]);
    expect(summary!.additions).toBe(1);
    expect(summary!.deletions).toBe(1);
  });

  it("summarises file paths and counts for an apply-patch block", () => {
    const summary = summarizePatchText(APPLY_PATCH);
    expect(summary).not.toBeNull();
    expect(summary!.filePaths).toEqual(["src/bar.ts"]);
    expect(summary!.additions).toBe(1);
    expect(summary!.deletions).toBe(1);
  });

  it("dedupes file paths across hunks", () => {
    const multi = `--- a/dup.ts
+++ b/dup.ts
@@ -1 +1 @@
-x
+y
--- a/dup.ts
+++ b/dup.ts
@@ -1 +1 @@
-p
+q`;
    const summary = summarizePatchText(multi);
    expect(summary!.filePaths).toEqual(["dup.ts"]);
    expect(summary!.additions).toBe(2);
    expect(summary!.deletions).toBe(2);
  });
});
