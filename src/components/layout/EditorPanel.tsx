import { useSharedSessionPanels } from "../thread/SessionPanelsContext";
import { useMemo, useState, useCallback, useRef, useEffect, lazy, Suspense } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import { useEditorStore } from "../../stores/editorStore";
import { useTaskViewStore } from "../../stores/taskViewStore";
import { FileTree } from "../editor/FileTree";
import { EditorTabs } from "../editor/EditorTabs";
import { ResizeHandle } from "./ResizeHandle";

// CodeEditor pulls in CodeMirror core + all 13 language modes; defer it out of
// the startup bundle until a file tab is actually opened.
const CodeEditor = lazy(() =>
  import("../editor/CodeEditor").then((m) => ({ default: m.CodeEditor }))
);

const FILE_TREE_MIN = 160;
const FILE_TREE_MAX = 400;
const FILE_TREE_DEFAULT = 220;

const EDITOR_MIN = 280;
const EDITOR_MAX = 1100;
const EDITOR_DEFAULT_WITH_FILE = 605;
const EDITOR_DEFAULT_TREE_ONLY = 240;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function EditorPanel() {
  const sharedPanels = useSharedSessionPanels();
  return sharedPanels ? null : <EditorPanelContent />;
}

function EditorPanelContent() {
  const editorPanelOpen = useUiStore((s) => s.editorPanelOpen);
  const fileTreeVisible = useUiStore((s) => s.fileTreeVisible);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectedCodexSessionCwd = useUiStore((s) => s.selectedCodexSessionCwd);
  const selectedClaudeSessionCwd = useUiStore((s) => s.selectedClaudeSessionCwd);
  const draftChatRepoPath = useUiStore((s) => s.draftChat?.repoPath ?? null);
  const appMode = useUiStore((s) => s.appMode);
  const threads = useThreadStore((s) => s.threads);
  const selectedTaskId = useTaskViewStore((s) => s.selectedTaskId);
  const allTasks = useTaskViewStore((s) => s.tasks);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);

  // Resizable widths
  const [fileTreeWidth, setFileTreeWidth] = useState(FILE_TREE_DEFAULT);
  const [totalWidth, setTotalWidth] = useState(
    activeTabPath ? EDITOR_DEFAULT_WITH_FILE : EDITOR_DEFAULT_TREE_ONLY
  );

  // Track previous activeTabPath to detect file open/close transitions
  const prevActiveTabRef = useRef(activeTabPath);
  useEffect(() => {
    const wasEmpty = !prevActiveTabRef.current;
    const nowHasFile = !!activeTabPath;
    prevActiveTabRef.current = activeTabPath;

    // Expand to default width when a file is first opened
    if (wasEmpty && nowHasFile) {
      setTotalWidth((w) => Math.max(w, EDITOR_DEFAULT_WITH_FILE));
    }
    // Shrink back when all tabs are closed
    if (!wasEmpty && !nowHasFile) {
      setTotalWidth(EDITOR_DEFAULT_TREE_ONLY);
    }
  }, [activeTabPath]);

  // File-only view with no remaining tabs: close the panel instead of a blank strip.
  useEffect(() => {
    if (appMode === "cowork" && editorPanelOpen && !fileTreeVisible && !activeTabPath) {
      useUiStore.setState({ editorPanelOpen: false, fileTreeVisible: true });
    }
  }, [appMode, editorPanelOpen, fileTreeVisible, activeTabPath]);

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) return null;
    for (const projectThreads of Object.values(threads)) {
      const found = projectThreads.find((t) => t.id === selectedThreadId);
      if (found) return found;
    }
    return null;
  }, [selectedThreadId, threads]);

  const selectedTaskWorktree = useMemo(() => {
    if (!selectedTaskId) return null;
    for (const list of Object.values(allTasks)) {
      const found = list.find((t) => t.id === selectedTaskId);
      if (found) return found.worktree_path ?? null;
    }
    return null;
  }, [selectedTaskId, allTasks]);

  const rootPath =
    (appMode === "task" && selectedTaskWorktree) ||
    selectedThread?.work_dir ||
    selectedCodexSessionCwd ||
    selectedClaudeSessionCwd ||
    draftChatRepoPath ||
    selectedTaskWorktree ||
    "";

  // Left edge resize: dragging left increases total width, right decreases
  const handlePanelResize = useCallback(
    (delta: number) => {
      setTotalWidth((w) => {
        const min = activeTabPath
          ? fileTreeVisible
            ? EDITOR_MIN + FILE_TREE_MIN
            : EDITOR_MIN
          : FILE_TREE_MIN;
        return clamp(w - delta, min, EDITOR_MAX);
      });
    },
    [activeTabPath, fileTreeVisible]
  );

  // Internal split resize: dragging left shrinks editor / grows file tree
  const handleSplitResize = useCallback((delta: number) => {
    setFileTreeWidth((w) => clamp(w - delta, FILE_TREE_MIN, FILE_TREE_MAX));
  }, []);

  const panelWidth = activeTabPath
    ? fileTreeVisible
      ? Math.max(totalWidth, EDITOR_MIN + fileTreeWidth)
      : clamp(totalWidth, EDITOR_MIN, EDITOR_MAX)
    : clamp(totalWidth, FILE_TREE_MIN, FILE_TREE_MAX);

  // Animate width with CSS transitions for smooth flex reflow
  const [mounted, setMounted] = useState(editorPanelOpen);
  const [transitioning, setTransitioning] = useState(false);
  const [visible, setVisible] = useState(editorPanelOpen);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorPanelOpen) {
      // Mount first, then animate open on next frame
      setMounted(true);
      setTransitioning(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true);
          // Keep transition flag on until animation completes
          setTimeout(() => setTransitioning(false), 300);
        });
      });
    } else if (mounted) {
      // Start close animation: keep mounted, enable transition, then hide
      setTransitioning(true);
      setVisible(false);
      // Unmount after transition completes
      const timer = setTimeout(() => {
        setMounted(false);
        setTransitioning(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [editorPanelOpen]);

  if (!mounted) return null;

  return (
    <div
      ref={containerRef}
      className="flex h-full z-20 overflow-hidden"
      style={{
        width: visible ? panelWidth : 0,
        opacity: visible ? 1 : 0,
        transition: transitioning ? "width 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease" : undefined,
        willChange: transitioning ? "width" : undefined,
      }}
    >
      {/* Left-edge resize handle */}
      <ResizeHandle direction="horizontal" onResize={handlePanelResize} />
      <div className="editor-panel-shell flex h-full flex-1 flex-col overflow-hidden border-l border-[color:var(--glass-border)]">
        {rootPath ? (
          <div className="flex flex-1 overflow-hidden">
            {/* Code editor (left side) */}
            {activeTabPath && (
              <div className="panel-bg flex min-w-0 flex-1 flex-col overflow-hidden">
                <EditorTabs />
                <Suspense fallback={null}>
                  <CodeEditor filePath={activeTabPath} />
                </Suspense>
              </div>
            )}
            {/* Split resize handle (between editor and file tree) */}
            {activeTabPath && fileTreeVisible && (
              <ResizeHandle direction="horizontal" onResize={handleSplitResize} />
            )}
            {/* File tree (right side) */}
            {fileTreeVisible && (
              <div
                className={`editor-panel-shell flex shrink-0 flex-col overflow-hidden sidebar-bg ${activeTabPath ? "border-l border-[color:var(--glass-border)]" : ""}`}
                style={{
                  width: activeTabPath ? fileTreeWidth : "100%",
                }}
              >
                <FileTree rootPath={rootPath} threadId={selectedThreadId} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 sidebar-bg">
            Open a project or session to browse files
          </div>
        )}
      </div>
    </div>
  );
}
