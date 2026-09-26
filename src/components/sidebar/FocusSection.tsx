import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ChevronUp, Focus, FolderGit2, Plus } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { DropdownHeader, DropdownPopover, DropdownRow } from "../ui/ComposerDropdown";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useFocusRowsStore } from "../../stores/focusRowsStore";
import type { Project } from "../../lib/types";
import {
  FOCUS_GROUP_EXPAND_KEY,
  MAX_FOCUS_THREADS_VISIBLE,
  formatFocusWindow,
  requestFocusNewSession,
  resolveFocusThreadsVisible,
} from "../../lib/focusView";

const PICKER_WIDTH = 260;
const PICKER_MARGIN = 8;
const MENU_WIDTH = 240;

/** Close a popover on Escape or a mousedown outside `refs`. */
function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // `refs` is a fresh array each render, but the ref objects in it are stable.
  }, [open, close]);
}

interface Props {
  projects: Project[];
  windowMinutes: number;
  /** Receives the list element that project groups portal their Focus rows into. */
  onListElement: (el: HTMLDivElement | null) => void;
}

/**
 * Sidebar group of recently active threads across all projects. The rows
 * themselves are rendered by each ProjectGroup (see `focusPortal`); this
 * component owns the header, the list container and the project picker for
 * new sessions, since a new session always belongs to a real project.
 */
export function FocusSection({ projects, windowMinutes, onListElement }: Props) {
  const expanded = useUiStore((s) => s.projectExpandedById[FOCUS_GROUP_EXPAND_KEY] ?? true);
  const setProjectExpanded = useUiStore((s) => s.setProjectExpanded);
  const limit = useSettingsStore((s) => resolveFocusThreadsVisible(s.settings.focusThreadsVisible));
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // Rows arrive through portals from every project; the store counts them all.
  const rowCount = useFocusRowsStore((s) => {
    let total = 0;
    for (const times of Object.values(s.timestampsByProject)) total += times.length;
    return total;
  });
  const extraShown = useFocusRowsStore((s) => s.extraShown);
  const showMore = useFocusRowsStore((s) => s.showMore);
  const showLess = useFocusRowsStore((s) => s.showLess);
  const [picker, setPicker] = useState<{ top: number; left: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const plusRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closePicker = useCallback(() => setPicker(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(!!picker, [pickerRef, plusRef], closePicker);
  useDismiss(!!menu, [menuRef], closeMenu);

  const shown = limit + extraShown;
  const remaining = rowCount - shown;
  const setLimit = (next: number) => updateSettings({ focusThreadsVisible: resolveFocusThreadsVisible(next) });

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.repo_path.toLowerCase().includes(q));
  }, [projects, query]);


  const togglePicker = () => {
    if (picker) {
      setPicker(null);
      return;
    }
    const rect = plusRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(PICKER_MARGIN, Math.min(rect.right - PICKER_WIDTH, window.innerWidth - PICKER_WIDTH - PICKER_MARGIN));
    setQuery("");
    setPicker({ top: rect.bottom + 6, left });
  };

  const chooseProject = (project: Project) => {
    setPicker(null);
    const anchor = plusRef.current;
    if (anchor) requestFocusNewSession({ projectId: project.id, anchor });
  };

  return (
    <div className="pg" data-testid="focus-section">
      <div
        className={`pg-h group relative ${expanded ? "open" : ""}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setPicker(null);
          setMenu({
            x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH - PICKER_MARGIN),
            y: e.clientY,
          });
        }}
      >
        <button
          type="button"
          onClick={() => setProjectExpanded(FOCUS_GROUP_EXPAND_KEY, !expanded)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left bg-transparent border-0 p-0 cursor-default"
          title={`Threads running or active in the last ${formatFocusWindow(windowMinutes)}, from every project`}
        >
          <ChevronRight size={13} className="chev" />
          <Focus size={14} className="picn" />
          <span className="pnm">Focus</span>
          <span className="pcount">{rowCount}</span>
        </button>
        <button
          ref={plusRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePicker();
          }}
          className="padd"
          title="New session in…"
          aria-label="New session in a project"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Stays mounted while collapsed so project groups keep a portal target. */}
      <div
        ref={onListElement}
        className="pg-body"
        data-focus-list=""
        style={expanded ? undefined : { display: "none" }}
      />
      {expanded && remaining > 0 && (
        <button
          type="button"
          onClick={() => showMore(limit)}
          className="flex w-full items-center gap-1.5 rounded px-3 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ChevronDown size={12} />
          <span>Show more ({Math.min(remaining, limit)} of {remaining})</span>
        </button>
      )}
      {expanded && remaining <= 0 && extraShown > 0 && rowCount > limit && (
        <button
          type="button"
          onClick={showLess}
          className="flex w-full items-center gap-1.5 rounded px-3 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <ChevronUp size={12} />
          <span>Show less</span>
        </button>
      )}
      {expanded && rowCount === 0 && (
        <p className="px-4 pb-2 text-xs text-zinc-500">
          Nothing active in the last {formatFocusWindow(windowMinutes)}.
        </p>
      )}

      {menu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999]"
          style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
        >
          <DropdownPopover>
            <DropdownHeader title="Focus" />
            <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[13px] text-zinc-200">
              <span className="flex items-center gap-2.5">
                <ChevronDown size={13} className="shrink-0 text-zinc-400" />
                Threads visible
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setLimit(limit - 1)}
                  disabled={limit <= 1}
                  className="flex h-5 w-5 items-center justify-center rounded border border-white/10 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-40"
                  aria-label="Decrease visible threads"
                >
                  −
                </button>
                <span className="min-w-[1.5rem] text-center text-xs tabular-nums text-zinc-200">
                  {limit}
                </span>
                <button
                  type="button"
                  onClick={() => setLimit(limit + 1)}
                  disabled={limit >= MAX_FOCUS_THREADS_VISIBLE}
                  className="flex h-5 w-5 items-center justify-center rounded border border-white/10 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-40"
                  aria-label="Increase visible threads"
                >
                  +
                </button>
              </div>
            </div>
          </DropdownPopover>
        </div>,
        document.body,
      )}

      {createPortal(
        <AnimatePresence>
          {picker && (
            <div
              ref={pickerRef}
              className="fixed z-[9999]"
              style={{ top: picker.top, left: picker.left, width: PICKER_WIDTH }}
            >
              <DropdownPopover>
                <DropdownHeader title="New session in" />
                {projects.length > 6 && (
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && filteredProjects.length > 0) chooseProject(filteredProjects[0]);
                    }}
                    placeholder="Search projects"
                    aria-label="Search projects"
                    className="mx-1 mb-1 w-[calc(100%-8px)] rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-500"
                  />
                )}
                <div className="max-h-[320px] overflow-y-auto">
                  {filteredProjects.length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-zinc-500">
                      {projects.length === 0 ? "No projects yet. Add one first." : "No matching projects."}
                    </div>
                  ) : (
                    filteredProjects.map((p) => (
                      <DropdownRow
                        key={p.id}
                        onClick={() => chooseProject(p)}
                        icon={<FolderGit2 size={14} className="text-zinc-400" />}
                        title={p.name}
                        meta={p.repo_path.replace(/^\/Users\/[^/]+/, "~")}
                        metaMono
                      />
                    ))
                  )}
                </div>
              </DropdownPopover>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
