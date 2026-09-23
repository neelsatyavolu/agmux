import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../editorStore";

const INITIAL = {
  openTabs: [],
  activeTabPath: null,
  dirtyFiles: {},
  fileContents: {},
  rawMode: {},
  aiEditedFiles: {},
};

describe("editorStore", () => {
  beforeEach(() => {
    useEditorStore.setState(INITIAL, false);
  });

  describe("openTab", () => {
    it("adds a new tab and makes it active", () => {
      useEditorStore.getState().openTab("/a/b/foo.ts");
      const s = useEditorStore.getState();
      expect(s.openTabs).toHaveLength(1);
      expect(s.openTabs[0]).toEqual({ path: "/a/b/foo.ts", name: "foo.ts", language: "typescript" });
      expect(s.activeTabPath).toBe("/a/b/foo.ts");
    });

    it("infers language from file extension", () => {
      useEditorStore.getState().openTab("/x.py");
      useEditorStore.getState().openTab("/x.rs");
      useEditorStore.getState().openTab("/x.unknown");
      const tabs = useEditorStore.getState().openTabs;
      expect(tabs.find((t) => t.path === "/x.py")?.language).toBe("python");
      expect(tabs.find((t) => t.path === "/x.rs")?.language).toBe("rust");
      expect(tabs.find((t) => t.path === "/x.unknown")?.language).toBe("plaintext");
    });

    it("does not add duplicate tabs but switches active to it", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().openTab("/b.ts");
      useEditorStore.getState().openTab("/a.ts");
      const s = useEditorStore.getState();
      expect(s.openTabs).toHaveLength(2);
      expect(s.activeTabPath).toBe("/a.ts");
    });
  });

  describe("closeTab", () => {
    it("removes the tab and picks the next tab as active", () => {
      const { openTab, closeTab } = useEditorStore.getState();
      openTab("/a.ts");
      openTab("/b.ts");
      openTab("/c.ts");
      closeTab("/b.ts");
      const s = useEditorStore.getState();
      expect(s.openTabs.map((t) => t.path)).toEqual(["/a.ts", "/c.ts"]);
      // closing the active middle tab → next-at-same-index → /c.ts
      expect(s.activeTabPath).toBe("/c.ts");
    });

    it("clears activeTabPath when last tab closes", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().closeTab("/a.ts");
      const s = useEditorStore.getState();
      expect(s.openTabs).toEqual([]);
      expect(s.activeTabPath).toBeNull();
    });

    it("is a no-op for unknown paths", () => {
      useEditorStore.getState().openTab("/a.ts");
      const before = useEditorStore.getState();
      useEditorStore.getState().closeTab("/nope.ts");
      expect(useEditorStore.getState().openTabs).toBe(before.openTabs);
    });

    it("clears dirtyFiles, fileContents, rawMode for the closed tab", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().markDirty("/a.ts", "content");
      useEditorStore.getState().toggleRawMode("/a.ts");
      useEditorStore.getState().closeTab("/a.ts");
      const s = useEditorStore.getState();
      expect(s.dirtyFiles["/a.ts"]).toBeUndefined();
      expect(s.fileContents["/a.ts"]).toBeUndefined();
      expect(s.rawMode["/a.ts"]).toBeUndefined();
    });
  });

  describe("dirty/clean", () => {
    it("markDirty stores content and marks dirty", () => {
      useEditorStore.getState().markDirty("/a.ts", "hello");
      const s = useEditorStore.getState();
      expect(s.dirtyFiles["/a.ts"]).toBe(true);
      expect(s.fileContents["/a.ts"]).toBe("hello");
    });

    it("markClean removes dirty flag but keeps content", () => {
      useEditorStore.getState().markDirty("/a.ts", "hello");
      useEditorStore.getState().markClean("/a.ts");
      const s = useEditorStore.getState();
      expect(s.dirtyFiles["/a.ts"]).toBeUndefined();
      expect(s.fileContents["/a.ts"]).toBe("hello");
    });
  });

  describe("closeAllTabs", () => {
    it("clears every tab and related state", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().openTab("/b.ts");
      useEditorStore.getState().markDirty("/a.ts", "x");
      useEditorStore.getState().closeAllTabs();
      const s = useEditorStore.getState();
      expect(s.openTabs).toEqual([]);
      expect(s.activeTabPath).toBeNull();
      expect(s.dirtyFiles).toEqual({});
      expect(s.fileContents).toEqual({});
    });
  });

  describe("closeOtherTabs", () => {
    it("keeps only the chosen tab", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().openTab("/b.ts");
      useEditorStore.getState().openTab("/c.ts");
      useEditorStore.getState().closeOtherTabs("/b.ts");
      const s = useEditorStore.getState();
      expect(s.openTabs).toHaveLength(1);
      expect(s.openTabs[0].path).toBe("/b.ts");
      expect(s.activeTabPath).toBe("/b.ts");
    });

    it("preserves dirty/contents only for the kept tab", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().openTab("/b.ts");
      useEditorStore.getState().markDirty("/a.ts", "A");
      useEditorStore.getState().markDirty("/b.ts", "B");
      useEditorStore.getState().closeOtherTabs("/b.ts");
      const s = useEditorStore.getState();
      expect(s.dirtyFiles).toEqual({ "/b.ts": true });
      expect(s.fileContents).toEqual({ "/b.ts": "B" });
    });
  });

  describe("toggleRawMode", () => {
    it("toggles between true and false", () => {
      useEditorStore.getState().toggleRawMode("/a.md");
      expect(useEditorStore.getState().rawMode["/a.md"]).toBe(true);
      useEditorStore.getState().toggleRawMode("/a.md");
      expect(useEditorStore.getState().rawMode["/a.md"]).toBe(false);
    });
  });

  describe("aiEdited", () => {
    it("markAiEdited records a timestamp", () => {
      useEditorStore.getState().markAiEdited("/a.ts");
      expect(typeof useEditorStore.getState().aiEditedFiles["/a.ts"]).toBe("number");
    });

    it("clearAiEdited removes the entry", () => {
      useEditorStore.getState().markAiEdited("/a.ts");
      useEditorStore.getState().clearAiEdited("/a.ts");
      expect(useEditorStore.getState().aiEditedFiles["/a.ts"]).toBeUndefined();
    });
  });

  describe("setActiveTab", () => {
    it("just updates the activeTabPath", () => {
      useEditorStore.getState().openTab("/a.ts");
      useEditorStore.getState().openTab("/b.ts");
      useEditorStore.getState().setActiveTab("/a.ts");
      expect(useEditorStore.getState().activeTabPath).toBe("/a.ts");
    });
  });

  describe("refreshFileFromDisk", () => {
    it("removes the cached content for that file only", () => {
      useEditorStore.getState().markDirty("/a.ts", "A");
      useEditorStore.getState().markDirty("/b.ts", "B");
      useEditorStore.getState().refreshFileFromDisk("/a.ts");
      const s = useEditorStore.getState();
      expect(s.fileContents["/a.ts"]).toBeUndefined();
      expect(s.fileContents["/b.ts"]).toBe("B");
    });
  });
});
