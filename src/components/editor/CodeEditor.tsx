import { useEffect, useRef, useState } from "react";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { readFile, writeFile } from "../../lib/commands";
import { useEditorStore } from "../../stores/editorStore";
import { useResolvedColorMode } from "../ThemeProvider";
import { MarkdownContent } from "../thread/MarkdownContent";
import { WorkDirProvider } from "../thread/WorkDirContext";
import {
  xanomDarkEditorTheme,
  xanomDarkHighlightStyle,
  xanomLightEditorTheme,
  xanomLightHighlightStyle,
} from "../../lib/codemirrorTheme";
import { getLanguageExtension } from "../../lib/languageMap";

interface Props {
  filePath: string | null;
}

export function CodeEditor({ filePath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Stable refs to avoid stale closures in editor callbacks
  const filePathRef = useRef<string | null>(filePath);
  const markCleanRef = useRef(useEditorStore.getState().markClean);
  const markDirtyRef = useRef(useEditorStore.getState().markDirty);
  // Flag to suppress markDirty when we push external content changes into the editor
  const externalUpdateRef = useRef(false);

  const [loadError, setLoadError] = useState<string | null>(null);

  filePathRef.current = filePath;

  const markDirty = useEditorStore((s) => s.markDirty);
  const markClean = useEditorStore((s) => s.markClean);
  const activeFileContent = useEditorStore((s) => filePath ? s.fileContents[filePath] : undefined);
  const rawMode = useEditorStore((s) => s.rawMode);
  const isLightMode = useResolvedColorMode();

  markCleanRef.current = markClean;
  markDirtyRef.current = markDirty;

  const isMarkdown = filePath ? /\.mdx?$/i.test(filePath) : false;
  const isRaw = filePath ? rawMode[filePath] === true : false;
  const showPreview = isMarkdown && !isRaw;

  // Track content per file to detect external updates
  const lastExternalContentRef = useRef<string | null>(null);

  // Build and mount a fresh EditorView whenever the active file changes
  useEffect(() => {
    if (!containerRef.current || !filePath || showPreview) {
      // Destroy any existing view if we're showing a preview or no file
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      return;
    }

    let cancelled = false;
    setLoadError(null);

    const initEditor = (initialContent: string) => {
      if (cancelled || !containerRef.current) return;

      // Destroy previous view before creating a new one
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }

      lastExternalContentRef.current = initialContent;

      const saveFn = () => {
        const path = filePathRef.current;
        if (!path || !viewRef.current) return true;
        const content = viewRef.current.state.doc.toString();
        writeFile(path, content)
          .then(() => {
            markCleanRef.current(path);
          })
          .catch((err) => {
            console.error("Failed to save file:", err);
          });
        return true;
      };

      const langExt = getLanguageExtension(filePath);
      const editorTheme = isLightMode ? xanomLightEditorTheme : xanomDarkEditorTheme;
      const highlightStyle = isLightMode ? xanomLightHighlightStyle : xanomDarkHighlightStyle;

      const extensions = [
        editorTheme,
        syntaxHighlighting(highlightStyle),
        lineNumbers(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: "Mod-s", run: saveFn },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !externalUpdateRef.current) {
            const path = filePathRef.current;
            if (path) {
              markDirtyRef.current(path, update.state.doc.toString());
            }
          }
        }),
        EditorView.lineWrapping,
        ...(langExt ? [langExt] : []),
      ];

      const state = EditorState.create({
        doc: initialContent,
        extensions,
      });

      const view = new EditorView({
        state,
        parent: containerRef.current,
      });

      viewRef.current = view;
    };

    // Use buffered content if available, otherwise fetch from disk
    const buffered = useEditorStore.getState().fileContents[filePath];
    if (buffered !== undefined) {
      initEditor(buffered);
    } else {
      readFile(filePath)
        .then((text) => {
          if (!cancelled) {
            initEditor(text);
          }
        })
        .catch((err) => {
          console.error("Failed to read file:", err);
          if (!cancelled) {
            setLoadError(String(err));
          }
        });
    }

    return () => {
      cancelled = true;
      // Destroy the view immediately during cleanup so there's no stale EditorView
      // attached to the DOM between cleanup and the next effect run
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
    // Re-run whenever the active file or preview mode changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, showPreview, isLightMode]);

  // Sync external content changes (e.g. file saved externally, or store update)
  // without triggering markDirty
  useEffect(() => {
    const view = viewRef.current;
    if (!filePath || !view || showPreview) return;

    if (activeFileContent === undefined) return;

    const currentDoc = view.state.doc.toString();
    // Only push update if store content differs from what editor currently shows
    // and it's a new external value (not reflecting our own typing)
    if (activeFileContent !== currentDoc && activeFileContent !== lastExternalContentRef.current) {
      lastExternalContentRef.current = activeFileContent;
      externalUpdateRef.current = true;
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: activeFileContent },
      });
      externalUpdateRef.current = false;
    }
  }, [filePath, activeFileContent, showPreview]);

  // Load file content for markdown preview (the editor init effect skips this case)
  useEffect(() => {
    if (!filePath || !showPreview) return;
    // Already have content buffered
    if (activeFileContent !== undefined) return;

    readFile(filePath)
      .then((text) => {
        useEditorStore.setState((s) => ({
          fileContents: { ...s.fileContents, [filePath]: text },
        }));
      })
      .catch((err) => {
        console.error("Failed to read file for preview:", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, showPreview, activeFileContent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

  if (!filePath) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm"
        style={{ color: "var(--text-tertiary)" }}
      >
        No file open
      </div>
    );
  }

  if (showPreview) {
    const content = activeFileContent ?? "";
    const slash = filePath.lastIndexOf("/");
    const previewDir = slash > 0 ? filePath.slice(0, slash) : filePath;
    return (
      <div className="flex h-full flex-col overflow-y-auto p-6">
        <WorkDirProvider workDir={previewDir}>
          <MarkdownContent content={content} />
        </WorkDirProvider>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm">
        <span style={{ color: "var(--text-error, #f87171)" }}>Failed to load file</span>
        <code className="max-w-full break-all rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
          {loadError}
        </code>
        <span className="text-xs text-zinc-600">{filePath}</span>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
