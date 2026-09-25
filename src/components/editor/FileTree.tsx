import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { FolderTree, Search, Trash2, Pencil } from "lucide-react";
import { listDirectory, deletePath, renamePath } from "../../lib/commands";
import { useUiStore } from "../../stores/uiStore";
import { useEditorStore } from "../../stores/editorStore";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { syncPollingToAppForeground } from "../../lib/appVisibility";
import { FileTreeContextMenu } from "./FileTreeContextMenu";
import type { FileEntry } from "../../lib/types";

/* ── Colored extension tile (e.g. "TSX", "RS", "MD") ──────────── */
const EXT_COLORS: Record<string, string> = {
  tsx: "var(--status-blue)",
  ts: "#3b82f6",
  jsx: "var(--status-blue)",
  js: "var(--status-amber)",
  css: "#f472b6",
  scss: "#f472b6",
  md: "#94a3b8",
  json: "var(--status-amber)",
  yaml: "var(--status-purple)",
  yml: "var(--status-purple)",
  rs: "#fb923c",
  toml: "#fb923c",
  png: "var(--accent)",
  jpg: "var(--accent)",
  svg: "var(--accent)",
  ico: "var(--accent)",
  sh: "#4ade80",
  py: "var(--status-blue)",
  go: "#22d3ee",
  html: "#f97316",
};

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function ExtTile({ name, size = 12 }: { name: string; size?: number }) {
  const ext = getExt(name);
  const c = EXT_COLORS[ext] || "#71717a";
  const label = (ext || "·").slice(0, 3).toUpperCase();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size + 6,
        height: size + 2,
        borderRadius: 3,
        background: `color-mix(in oklab, ${c} 14%, transparent)`,
        color: c,
        fontFamily: "var(--font-mono)",
        fontSize: Math.round(size * 0.6),
        fontWeight: 600,
        letterSpacing: 0,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

/* ── Git status dot ───────────────────────────────────────────── */
function StatusDot({ code }: { code: string | undefined }) {
  if (!code) return null;
  const up = code.trim().toUpperCase();
  let color = "var(--status-blue)"; // modified
  if (up.includes("A") || up === "??") color = "var(--status-green)"; // added/untracked
  else if (up.includes("D")) color = "var(--status-red)"; // deleted
  else if (up.includes("R")) color = "var(--status-purple)"; // renamed
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 9999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

/** Compute a relative path by stripping the rootPath prefix. */
function toRelativePath(absolutePath: string, rootPath: string): string {
  const normalized = rootPath.endsWith("/") ? rootPath : rootPath + "/";
  if (absolutePath.startsWith(normalized)) {
    return absolutePath.slice(normalized.length);
  }
  return absolutePath;
}

/** Check if any git status key starts with a directory prefix. */
function directoryHasStatus(
  dirRelativePath: string,
  gitStatus: Record<string, string>,
): string | undefined {
  const prefix = dirRelativePath.endsWith("/")
    ? dirRelativePath
    : dirRelativePath + "/";
  for (const key of Object.keys(gitStatus)) {
    if (key.startsWith(prefix)) {
      return gitStatus[key];
    }
  }
  return undefined;
}

interface ContextMenuState {
  x: number;
  y: number;
  filePath: string;
  relativePath: string;
  isDirectory: boolean;
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  rootPath: string;
  gitStatus?: Record<string, string>;
  onContextMenu: (state: ContextMenuState) => void;
  filter: string;
  changedOnly: boolean;
}

function FileTreeNode({
  entry,
  depth,
  rootPath,
  gitStatus,
  onContextMenu,
  filter,
  changedOnly,
}: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const openFile = useUiStore((s) => s.openFile);
  const openTab = useEditorStore((s) => s.openTab);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);

  const relativePath = toRelativePath(entry.path, rootPath);

  const statusCode = gitStatus
    ? entry.is_dir
      ? directoryHasStatus(relativePath, gitStatus)
      : gitStatus[relativePath]
    : undefined;

  const loadChildren = useCallback(async () => {
    try {
      const items = await listDirectory(entry.path);
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setChildren(items);
    } catch (err) {
      console.error("Failed to list directory:", err);
    }
  }, [entry.path]);

  useEffect(() => {
    if (expanded) loadChildren();
  }, [expanded, loadChildren]);

  // Auto-expand when a filter or changed-only mode is active so matches surface.
  // Skip heavy dirs (node_modules, .git, build artifacts) to avoid cascading
  // listDirectory IPC storms on large repos.
  useEffect(() => {
    if (!(filter.length > 0 || changedOnly) || !entry.is_dir || expanded) return;
    const HEAVY = new Set([
      "node_modules", ".git", "target", "dist", "build",
      ".next", ".turbo", ".cache", "out", "vendor", ".venv", "venv",
      "__pycache__", ".pytest_cache", ".mypy_cache", ".idea", ".vscode",
    ]);
    if (HEAVY.has(entry.name)) return;
    setExpanded(true);
  }, [filter, changedOnly, entry.is_dir, entry.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = () => {
    if (entry.is_dir) {
      setExpanded(!expanded);
    } else {
      openFile(entry.path, { showFileTree: true });
      openTab(entry.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu({
      x: e.clientX,
      y: e.clientY,
      filePath: entry.path,
      relativePath,
      isDirectory: entry.is_dir,
    });
  };

  const lowerFilter = filter.toLowerCase();
  const nameMatches = !filter || entry.name.toLowerCase().includes(lowerFilter);
  const pathMatches =
    !filter || relativePath.toLowerCase().includes(lowerFilter);
  const changedMatches = !changedOnly || !!statusCode;

  if (!entry.is_dir && !(pathMatches && changedMatches)) return null;

  const isActive = !entry.is_dir && activeTabPath === entry.path;
  const pad = depth * 12 + 8;

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className="file-tree-row group flex w-full items-center gap-2 py-[3px] pr-2 text-left transition-colors"
        style={{
          paddingLeft: pad,
          background: isActive ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
          borderLeft: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
          color: isActive ? "var(--text-primary, #fff)" : "var(--text-secondary, #e4e4e7)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          letterSpacing: 0,
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.background = "var(--glass-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.background = "transparent";
        }}
      >
        {entry.is_dir ? (
          <span
            style={{
              display: "inline-block",
              width: 10,
              color: "var(--text-muted)",
              fontSize: 9,
              flexShrink: 0,
              textAlign: "center",
            }}
          >
            {expanded ? "▾" : "▸"}
          </span>
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        {entry.is_dir ? (
          <span
            style={{
              color: expanded ? "var(--text-secondary, #e4e4e7)" : "var(--text-tertiary, #a1a1aa)",
              flexShrink: 0,
            }}
          >
            {entry.name}
          </span>
        ) : (
          <>
            <ExtTile name={entry.name} size={11} />
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: isActive
                  ? "var(--text-primary, #fff)"
                  : nameMatches
                    ? "var(--text-secondary, #e4e4e7)"
                    : "var(--text-tertiary, #a1a1aa)",
              }}
            >
              {entry.name}
            </span>
          </>
        )}
        {entry.is_dir && <span style={{ flex: 1 }} />}
        {gitStatus && statusCode && <StatusDot code={statusCode} />}
      </button>

      {expanded &&
        children.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            rootPath={rootPath}
            gitStatus={gitStatus}
            onContextMenu={onContextMenu}
            filter={filter}
            changedOnly={changedOnly}
          />
        ))}
    </div>
  );
}

interface Props {
  rootPath: string;
  threadId: string | null;
  gitStatus?: Record<string, string>;
  onAskClaude?: (filePath: string) => void;
  hideHeader?: boolean;
}

interface RenameState {
  filePath: string;
  isDirectory: boolean;
  currentName: string;
}

interface DeleteState {
  filePath: string;
  isDirectory: boolean;
  relativePath: string;
}

export function FileTree({
  rootPath,
  threadId,
  gitStatus,
  onAskClaude,
  hideHeader,
}: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filter, setFilter] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const closeTab = useEditorStore((s) => s.closeTab);
  const renameTab = useEditorStore((s) => s.renameTab);

  const folderName = rootPath
    ? rootPath.replace(/\/+$/, "").split("/").pop() ?? rootPath
    : "";

  const changedCount = useMemo(() => {
    if (!gitStatus) return 0;
    return Object.keys(gitStatus).length;
  }, [gitStatus]);

  const loadRoot = useCallback(async () => {
    if (!rootPath) {
      setLoadError("No root path provided");
      setLoaded(true);
      return;
    }
    try {
      const items = await listDirectory(rootPath);
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(items);
      setLoadError(null);
      setLoaded(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("FileTree: failed to list directory:", rootPath, err);
      setLoadError(msg);
      setLoaded(true);
    }
  }, [rootPath]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  useFileWatcher(
    threadId,
    useCallback(() => {
      loadRoot();
    }, [loadRoot]),
  );

  useEffect(() => {
    if (threadId) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(loadRoot, 3000);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const unsub = syncPollingToAppForeground(start, stop);
    return () => {
      stop();
      unsub();
    };
  }, [threadId, loadRoot]);

  const handleContextMenu = useCallback((state: ContextMenuState) => {
    setContextMenu(state);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleStartRename = useCallback(
    (filePath: string, isDirectory: boolean) => {
      const name = filePath.split("/").pop() ?? "";
      setActionError(null);
      setRenameState({ filePath, isDirectory, currentName: name });
    },
    [],
  );

  const handleStartDelete = useCallback(
    (filePath: string, isDirectory: boolean) => {
      const relative = toRelativePath(filePath, rootPath);
      setActionError(null);
      setDeleteState({ filePath, isDirectory, relativePath: relative });
    },
    [rootPath],
  );

  const handleCloseRename = useCallback(() => {
    setRenameState(null);
    setActionError(null);
    setActionBusy(false);
  }, []);

  const handleCloseDelete = useCallback(() => {
    setDeleteState(null);
    setActionError(null);
    setActionBusy(false);
  }, []);

  const handleConfirmRename = useCallback(
    async (newName: string) => {
      if (!renameState) return;
      const trimmed = newName.trim();
      if (!trimmed) {
        setActionError("Name cannot be empty");
        return;
      }
      if (trimmed === renameState.currentName) {
        handleCloseRename();
        return;
      }
      if (trimmed.includes("/") || trimmed.includes("\\")) {
        setActionError("Name cannot contain path separators");
        return;
      }
      setActionBusy(true);
      setActionError(null);
      try {
        const newPath = await renamePath(renameState.filePath, trimmed);
        if (newPath) renameTab(renameState.filePath, newPath);
        handleCloseRename();
        await loadRoot();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionError(msg);
        setActionBusy(false);
      }
    },
    [renameState, handleCloseRename, renameTab, loadRoot],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteState) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await deletePath(deleteState.filePath);
      closeTab(deleteState.filePath);
      handleCloseDelete();
      await loadRoot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
      setActionBusy(false);
    }
  }, [deleteState, handleCloseDelete, closeTab, loadRoot]);

  return (
    <div
      className="file-tree-panel flex h-full flex-col overflow-hidden"
      style={{
        background: "var(--glass-card)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Dock-style header */}
      {!hideHeader && (
        <div
          className="file-tree-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--glass-border)",
            background: "var(--glass-card)",
            flexShrink: 0,
          }}
        >
          <FolderTree size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <div
            className="ui-eyebrow"
            style={{
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            Files
          </div>
          <span style={{ color: "var(--text-muted, #52525b)", flexShrink: 0 }}>·</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-tertiary, #a1a1aa)",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={rootPath}
          >
            {folderName}
          </span>
          {changedCount > 0 && (
            <span
              style={{
                padding: "1px 7px",
                borderRadius: 9999,
                fontSize: 10,
                background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
                flexShrink: 0,
              }}
            >
              {changedCount} changed
            </span>
          )}
        </div>
      )}

      {/* Filter + changed-only */}
      <div
        className="file-tree-filter-section"
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--glass-border)",
          flexShrink: 0,
        }}
      >
        <div
          className="file-tree-filter-input"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 8px",
            borderRadius: 6,
            background: "var(--glass-card)",
            border: "1px solid var(--glass-border)",
          }}
        >
          <Search size={10} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              minWidth: 0,
            }}
          />
        </div>
        {gitStatus && changedCount > 0 && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setChangedOnly((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setChangedOnly((v) => !v);
              }
            }}
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                border: `1px solid ${changedOnly ? "var(--accent)" : "var(--glass-border-highlight)"}`,
                background: changedOnly ? "color-mix(in srgb, var(--accent) 25%, transparent)" : "transparent",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {changedOnly && (
                <span style={{ color: "var(--accent)", fontSize: 9 }}>✓</span>
              )}
            </span>
            Changed only
          </div>
        )}
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto" style={{ padding: "4px 0" }}>
        {loadError && (
          <div className="px-3 py-4 text-[11px] text-red-400/80">
            <div className="font-medium mb-1">Failed to load files</div>
            <div className="text-red-300/60 break-all">{loadError}</div>
            <div className="mt-2 text-zinc-500 break-all">
              Path: {rootPath}
            </div>
          </div>
        )}
        {!loadError && !loaded && (
          <div className="px-3 py-4 text-[11px] text-zinc-500">Loading…</div>
        )}
        {!loadError && loaded && entries.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-zinc-500">
            <div>Directory is empty</div>
            <div className="mt-2 text-zinc-600 break-all">{rootPath}</div>
          </div>
        )}
        {entries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            rootPath={rootPath}
            gitStatus={gitStatus}
            onContextMenu={handleContextMenu}
            filter={filter}
            changedOnly={changedOnly}
          />
        ))}
      </div>

      {contextMenu &&
        createPortal(
          <FileTreeContextMenu
            {...contextMenu}
            onClose={handleCloseContextMenu}
            onAskClaude={onAskClaude}
            onRename={handleStartRename}
            onDelete={handleStartDelete}
          />,
          document.body
        )}

      {renameState &&
        createPortal(
          <RenameDialog
            initialName={renameState.currentName}
            isDirectory={renameState.isDirectory}
            busy={actionBusy}
            error={actionError}
            onCancel={handleCloseRename}
            onConfirm={handleConfirmRename}
          />,
          document.body
        )}

      {deleteState &&
        createPortal(
          <DeleteDialog
            relativePath={deleteState.relativePath}
            isDirectory={deleteState.isDirectory}
            busy={actionBusy}
            error={actionError}
            onCancel={handleCloseDelete}
            onConfirm={handleConfirmDelete}
          />,
          document.body
        )}
    </div>
  );
}

/* ── Rename dialog ─────────────────────────────────────────────── */
interface RenameDialogProps {
  initialName: string;
  isDirectory: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (newName: string) => void;
}

function RenameDialog({
  initialName,
  isDirectory,
  busy,
  error,
  onCancel,
  onConfirm,
}: RenameDialogProps) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the base name (without extension) so users can retype the stem quickly.
    const dot = initialName.lastIndexOf(".");
    if (!isDirectory && dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
  }, [initialName, isDirectory]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    onConfirm(value);
  };

  return (
    <DialogShell onCancel={onCancel}>
      <form onSubmit={submit}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px 8px",
          }}
        >
          <Pencil size={13} style={{ color: "var(--status-blue)", flexShrink: 0 }} />
          <div
            className="ui-eyebrow"
            style={{ color: "var(--status-blue)" }}
          >
            Rename {isDirectory ? "Folder" : "File"}
          </div>
        </div>
        <div style={{ padding: "4px 14px 10px" }}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            style={{
              width: "100%",
              padding: "7px 10px",
              borderRadius: 6,
              border: "1px solid var(--glass-border-highlight)",
              background: "var(--glass-card)",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              outline: "none",
            }}
          />
          {error && (
            <div
              style={{
                marginTop: 8,
                fontFamily: "var(--font-sans)",
                fontSize: 10.5,
                color: "var(--status-red)",
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <DialogActions>
          <DialogButton onClick={onCancel} disabled={busy}>
            Cancel
          </DialogButton>
          <DialogButton
            type="submit"
            primary
            disabled={busy || !value.trim() || value.trim() === initialName}
          >
            {busy ? "Renaming…" : "Rename"}
          </DialogButton>
        </DialogActions>
      </form>
    </DialogShell>
  );
}

/* ── Delete confirmation dialog ────────────────────────────────── */
interface DeleteDialogProps {
  relativePath: string;
  isDirectory: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteDialog({
  relativePath,
  isDirectory,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeleteDialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <DialogShell onCancel={onCancel}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 14px 8px",
        }}
      >
        <Trash2 size={13} style={{ color: "var(--status-red)", flexShrink: 0 }} />
        <div
          className="ui-eyebrow"
          style={{ color: "var(--status-red)" }}
        >
          Delete {isDirectory ? "Folder" : "File"}
        </div>
      </div>
      <div style={{ padding: "4px 14px 10px" }}>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Permanently delete{" "}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              background: "var(--surface-2)",
              padding: "1px 5px",
              borderRadius: 4,
              wordBreak: "break-all",
            }}
          >
            {relativePath}
          </span>
          {isDirectory && " and everything inside it"}?
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            color: "var(--text-tertiary)",
          }}
        >
          This cannot be undone.
        </div>
        {error && (
          <div
            style={{
              marginTop: 8,
              fontFamily: "var(--font-sans)",
              fontSize: 10.5,
              color: "var(--status-red)",
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        )}
      </div>
      <DialogActions>
        <DialogButton onClick={onCancel} disabled={busy}>
          Cancel
        </DialogButton>
        <DialogButton onClick={onConfirm} danger disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </DialogButton>
      </DialogActions>
    </DialogShell>
  );
}

/* ── Shared dialog chrome ──────────────────────────────────────── */
function DialogShell({
  children,
  onCancel,
}: {
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "18vh",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          minWidth: 320,
          maxWidth: "min(460px, 92vw)",
          borderRadius: 10,
          border: "1px solid var(--glass-border)",
          background: "var(--surface-modal)",
          backdropFilter: "blur(14px)",
          boxShadow:
            "0 24px 60px -12px rgba(0,0,0,0.28), 0 0 0 1px var(--glass-border)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function DialogActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 6,
        padding: "8px 10px 10px",
        borderTop: "1px solid var(--glass-border)",
        background: "var(--glass-card)",
      }}
    >
      {children}
    </div>
  );
}

interface DialogButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

function DialogButton({
  children,
  onClick,
  type = "button",
  primary,
  danger,
  disabled,
}: DialogButtonProps) {
  const baseColor = danger ? "var(--status-red)" : primary ? "var(--status-blue)" : "var(--text-tertiary)";
  const baseBg = danger
    ? "rgba(248,113,113,0.10)"
    : primary
      ? "rgba(96,165,250,0.10)"
      : "transparent";
  const borderColor = danger
    ? "rgba(248,113,113,0.30)"
    : primary
      ? "rgba(96,165,250,0.30)"
      : "var(--glass-border-highlight)";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 12px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        letterSpacing: 0,
        borderRadius: 6,
        border: `1px solid ${borderColor}`,
        background: baseBg,
        color: baseColor,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "background 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = danger
          ? "rgba(248,113,113,0.20)"
          : primary
            ? "rgba(96,165,250,0.20)"
            : "var(--surface-hover)";
        e.currentTarget.style.color = danger ? "var(--status-red)" : primary ? "var(--status-blue)" : "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = baseBg;
        e.currentTarget.style.color = baseColor;
      }}
    >
      {children}
    </button>
  );
}
