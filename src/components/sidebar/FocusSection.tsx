import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Focus, FolderGit2, Plus } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { DropdownHeader, DropdownPopover, DropdownRow } from "../ui/ComposerDropdown";
import { useUiStore } from "../../stores/uiStore";
import type { Project } from "../../lib/types";
import { FOCUS_GROUP_EXPAND_KEY, formatFocusWindow, requestFocusNewSession } from "../../lib/focusView";

const PICKER_WIDTH = 260;
const PICKER_MARGIN = 8;

interface Props {
  projects: Project[];
  windowHours: number;
  /** Receives the list element that project groups portal their Focus rows into. */
  onListElement: (el: HTMLDivElement | null) => void;
}

/**
 * Sidebar group of recently active threads across all projects. The rows
 * themselves are rendered by each ProjectGroup (see `focusPortal`); this
 * component owns the header, the list container and the project picker for
 * new sessions, since a new session always belongs to a real project.
 */
export function FocusSection({ projects, windowHours, onListElement }: Props) {
  const expanded = useUiStore((s) => s.projectExpandedById[FOCUS_GROUP_EXPAND_KEY] ?? true);
  const setProjectExpanded = useUiStore((s) => s.setProjectExpanded);
  const [rowCount, setRowCount] = useState(0);
  const [picker, setPicker] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Rows arrive through portals, so count them from the DOM.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setRowCount(el.childElementCount);
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!picker) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (pickerRef.current?.contains(target) || plusRef.current?.contains(target)) return;
      setPicker(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picker]);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.repo_path.toLowerCase().includes(q));
  }, [projects, query]);

  // Stable so React doesn't detach/reattach the list (and re-render Sidebar) every render.
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    onListElement(el);
  }, [onListElement]);

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
      <div className={`pg-h group relative ${expanded ? "open" : ""}`}>
        <button
          type="button"
          onClick={() => setProjectExpanded(FOCUS_GROUP_EXPAND_KEY, !expanded)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left bg-transparent border-0 p-0 cursor-default"
          title={`Threads active in the last ${formatFocusWindow(windowHours)}, from every project`}
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
        ref={setListRef}
        className="pg-body"
        data-focus-list=""
        style={expanded ? undefined : { display: "none" }}
      />
      {expanded && rowCount === 0 && (
        <p className="px-4 pb-2 text-xs text-zinc-500">
          Nothing active in the last {formatFocusWindow(windowHours)}.
        </p>
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
