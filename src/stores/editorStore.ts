import { create } from "zustand";

export interface EditorTab {
  path: string;
  name: string;
  language: string;
}

interface EditorState {
  openTabs: EditorTab[];
  activeTabPath: string | null;
  dirtyFiles: Record<string, boolean>;
  fileContents: Record<string, string>;
  /** Tracks which files are in "raw" edit mode (vs rendered preview). Markdown files default to preview. */
  rawMode: Record<string, boolean>;
  /** Tracks files recently edited by AI — filePath -> timestamp (ms). Used for tab badges. */
  aiEditedFiles: Record<string, number>;

  openTab: (path: string) => void;
  /** Keep an open tab (and dirty/preview state) when a file is renamed on disk. */
  renameTab: (oldPath: string, newPath: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  markDirty: (path: string, content: string) => void;
  markClean: (path: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (keepPath: string) => void;
  toggleRawMode: (path: string) => void;
  markAiEdited: (filePath: string) => void;
  clearAiEdited: (filePath: string) => void;
  /** Remove cached file content so CodeEditor re-reads from disk on next render. */
  refreshFileFromDisk: (filePath: string) => void;
}

const EMPTY_TABS: EditorTab[] = [];

function getFilename(path: string): string {
  return path.split("/").pop() || path;
}

function getLanguageFromExtension(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    rs: "rust",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    xml: "xml",
    svg: "xml",
    graphql: "graphql",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
  };
  return map[ext] || "plaintext";
}

export const useEditorStore = create<EditorState>((set) => ({
  openTabs: EMPTY_TABS,
  activeTabPath: null,
  dirtyFiles: {},
  fileContents: {},
  rawMode: {},
  aiEditedFiles: {},

  openTab: (path) => {
    set((state) => {
      const existing = state.openTabs.find((t) => t.path === path);
      if (existing) {
        return { activeTabPath: path };
      }
      const name = getFilename(path);
      const language = getLanguageFromExtension(name);
      const newTab: EditorTab = { path, name, language };
      return {
        openTabs: [...state.openTabs, newTab],
        activeTabPath: path,
      };
    });
  },

  renameTab: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.path === oldPath);
      if (idx === -1) return state;
      const name = getFilename(newPath);
      const language = getLanguageFromExtension(name);
      const remap = <T,>(rec: Record<string, T>): Record<string, T> => {
        if (!(oldPath in rec)) return rec;
        const next = { ...rec };
        next[newPath] = rec[oldPath];
        delete next[oldPath];
        return next;
      };
      return {
        openTabs: state.openTabs.map((t) =>
          t.path === oldPath ? { path: newPath, name, language } : t,
        ),
        activeTabPath: state.activeTabPath === oldPath ? newPath : state.activeTabPath,
        dirtyFiles: remap(state.dirtyFiles),
        fileContents: remap(state.fileContents),
        rawMode: remap(state.rawMode),
        aiEditedFiles: remap(state.aiEditedFiles),
      };
    });
  },

  closeTab: (path) => {
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.path === path);
      if (idx === -1) return state;

      const newTabs = state.openTabs.filter((t) => t.path !== path);
      const newDirty = { ...state.dirtyFiles };
      delete newDirty[path];
      const newContents = { ...state.fileContents };
      delete newContents[path];
      const newRawMode = { ...state.rawMode };
      delete newRawMode[path];

      let newActiveTabPath = state.activeTabPath;
      if (state.activeTabPath === path) {
        if (newTabs.length === 0) {
          newActiveTabPath = null;
        } else if (idx < newTabs.length) {
          newActiveTabPath = newTabs[idx].path;
        } else {
          newActiveTabPath = newTabs[newTabs.length - 1].path;
        }
      }

      return {
        openTabs: newTabs,
        activeTabPath: newActiveTabPath,
        dirtyFiles: newDirty,
        fileContents: newContents,
        rawMode: newRawMode,
      };
    });
  },

  setActiveTab: (path) => {
    set({ activeTabPath: path });
  },

  markDirty: (path, content) => {
    set((state) => ({
      dirtyFiles: { ...state.dirtyFiles, [path]: true },
      fileContents: { ...state.fileContents, [path]: content },
    }));
  },

  markClean: (path) => {
    set((state) => {
      const newDirty = { ...state.dirtyFiles };
      delete newDirty[path];
      return { dirtyFiles: newDirty };
    });
  },

  closeAllTabs: () => {
    set({ openTabs: EMPTY_TABS, activeTabPath: null, dirtyFiles: {}, fileContents: {}, rawMode: {} });
  },

  closeOtherTabs: (keepPath) => {
    set((state) => {
      const kept = state.openTabs.filter((t) => t.path === keepPath);
      const newDirty = kept.length > 0 && state.dirtyFiles[keepPath]
        ? { [keepPath]: true }
        : {};
      const newContents: Record<string, string> = {};
      if (state.fileContents[keepPath] !== undefined) {
        newContents[keepPath] = state.fileContents[keepPath];
      }
      const newRawMode: Record<string, boolean> = {};
      if (state.rawMode[keepPath] !== undefined) {
        newRawMode[keepPath] = state.rawMode[keepPath];
      }
      return {
        openTabs: kept,
        activeTabPath: kept.length > 0 ? keepPath : null,
        dirtyFiles: newDirty,
        fileContents: newContents,
        rawMode: newRawMode,
      };
    });
  },

  toggleRawMode: (path) => {
    set((state) => ({
      rawMode: { ...state.rawMode, [path]: !state.rawMode[path] },
    }));
  },

  markAiEdited: (filePath) =>
    set((s) => ({
      aiEditedFiles: { ...s.aiEditedFiles, [filePath]: Date.now() },
    })),

  clearAiEdited: (filePath) =>
    set((s) => {
      const { [filePath]: _, ...rest } = s.aiEditedFiles;
      return { aiEditedFiles: rest };
    }),

  refreshFileFromDisk: (filePath) =>
    set((s) => {
      const { [filePath]: _, ...rest } = s.fileContents;
      return { fileContents: rest };
    }),

}));
