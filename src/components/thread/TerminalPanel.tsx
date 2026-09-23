import { useSharedSessionPanels } from "./SessionPanelsContext";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Plus,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { stopShell } from "../../lib/commands";
import TerminalCmdK from "./TerminalCmdK";
import TerminalInstance, {
  type TerminalInstanceHandle,
} from "./TerminalInstance";

interface Props {
  shellId: string;
  workDir: string;
  onClose: () => void;
}

interface TabState {
  id: string;
  shellId: string;
  workDir: string;
  label: string;
  status: "running" | "exited";
  busy: boolean; // OSC 133;C → true, OSC 133;D → false
}

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;
const DEFAULT_HEIGHT = 240;

function labelFromCwd(cwd: string): string {
  if (cwd === "/") return "/";
  const trimmed = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return trimmed.split("/").pop() || cwd;
}

export default function TerminalPanel(props: Props) {
  const sharedPanels = useSharedSessionPanels();
  return sharedPanels ? null : <TerminalPanelContent {...props} />;
}

function TerminalPanelContent({ shellId, workDir, onClose }: Props) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [aiPopupOpen, setAiPopupOpen] = useState(false);
  const [tabs, setTabs] = useState<TabState[]>(() => [
    {
      id: shellId,
      shellId,
      workDir,
      label: `zsh — ${labelFromCwd(workDir)}`,
      status: "running",
      busy: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(shellId);
  const [animDone, setAnimDone] = useState(false);

  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const instanceRefs = useRef<Map<string, TerminalInstanceHandle | null>>(
    new Map(),
  );
  const dragHandlersRef = useRef<{
    move: (ev: MouseEvent) => void;
    up: () => void;
  } | null>(null);
  const newShellSeqRef = useRef(2);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const setInstanceRef = useCallback(
    (id: string) => (handle: TerminalInstanceHandle | null) => {
      if (handle) {
        instanceRefs.current.set(id, handle);
      } else {
        instanceRefs.current.delete(id);
      }
    },
    [],
  );

  const focusActive = useCallback(() => {
    const handle = instanceRefs.current.get(activeTabId);
    handle?.focus();
  }, [activeTabId]);

  const handleClose = useCallback(() => {
    onClose();
    for (const tab of tabs) {
      stopShell(tab.shellId).catch((err) => {
        console.error("Failed to stop shell:", err);
      });
    }
  }, [onClose, tabs]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;

      let fitRafId: number | null = null;
      const scheduleFitActive = () => {
        if (fitRafId != null) return;
        fitRafId = requestAnimationFrame(() => {
          fitRafId = null;
          // Only the visible tab needs geometry during drag; inactive tabs
          // refit when they become active (TerminalInstance hidden effect).
          instanceRefs.current.get(activeTabId)?.fit();
        });
      };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startYRef.current - ev.clientY;
        const newHeight = Math.max(
          MIN_HEIGHT,
          Math.min(MAX_HEIGHT, startHeightRef.current + delta),
        );
        setHeight(newHeight);
        scheduleFitActive();
      };

      const handleMouseUp = () => {
        draggingRef.current = false;
        dragHandlersRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (fitRafId != null) {
          cancelAnimationFrame(fitRafId);
          fitRafId = null;
        }
        requestAnimationFrame(() => {
          instanceRefs.current.get(activeTabId)?.fit();
          focusActive();
        });
      };

      dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [activeTabId, focusActive, height],
  );

  useEffect(() => {
    return () => {
      const handlers = dragHandlersRef.current;
      if (handlers) {
        document.removeEventListener("mousemove", handlers.move);
        document.removeEventListener("mouseup", handlers.up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        draggingRef.current = false;
        dragHandlersRef.current = null;
      }
    };
  }, []);

  const handleAnimationComplete = useCallback(() => {
    setAnimDone(true);
    focusActive();
  }, [focusActive]);

  const handleNewShell = useCallback(() => {
    const seq = newShellSeqRef.current++;
    const newId = `${shellId}-${seq}`;
    const newTab: TabState = {
      id: newId,
      shellId: newId,
      workDir,
      label: `zsh ${seq}`,
      status: "running",
      busy: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [shellId, workDir]);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabId(id);
    requestAnimationFrame(() => {
      const handle = instanceRefs.current.get(id);
      handle?.fit();
      handle?.focus();
    });
  }, []);

  const handleCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;

      // If this is the only tab, closing it closes the whole panel.
      if (tabs.length === 1) {
        handleClose();
        return;
      }

      stopShell(tab.shellId).catch((err) => {
        console.error("Failed to stop shell:", err);
      });
      instanceRefs.current.delete(id);

      setTabs((prev) => {
        const filtered = prev.filter((t) => t.id !== id);
        if (id === activeTabId && filtered.length > 0) {
          const idx = prev.findIndex((t) => t.id === id);
          const fallback = filtered[Math.min(idx, filtered.length - 1)];
          setActiveTabId(fallback.id);
        }
        return filtered;
      });
    },
    [activeTabId, handleClose, tabs],
  );

  const handleTabExited = useCallback(
    (id: string) => () => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: "exited", busy: false } : t,
        ),
      );
    },
    [],
  );

  const handleTabActivity = useCallback(
    (id: string) => (busy: boolean) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, busy } : t)),
      );
    },
    [],
  );

  const getActiveContext = useCallback(() => {
    const handle = instanceRefs.current.get(activeTabId);
    return handle?.getContext() ?? "";
  }, [activeTabId]);

  const insertActiveCommand = useCallback(
    (cmd: string) => {
      const handle = instanceRefs.current.get(activeTabId);
      handle?.insertCommand(cmd);
    },
    [activeTabId],
  );

  const openCmdK = useCallback(() => setAiPopupOpen(true), []);

  return (
    <motion.div
      initial={{ height: 0 }}
      animate={{ height }}
      exit={{ height: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
      onAnimationComplete={handleAnimationComplete}
      className="terminal-panel-bg relative flex flex-col overflow-hidden"
    >
      {/* Drag rail with grip dots */}
      <div
        onMouseDown={handleDragStart}
        className="terminal-panel-drag flex shrink-0 cursor-row-resize items-center justify-center"
        aria-label="Resize terminal panel"
      >
        <div className="terminal-panel-drag-grip" />
      </div>

      {/* Tab strip + actions */}
      <div
        className="terminal-panel-header flex shrink-0 items-center"
        style={{
          gap: 8,
          padding: "0 8px",
          height: 34,
          boxSizing: "border-box",
        }}
      >
        <div
          className="flex flex-1 items-center overflow-hidden"
          style={{ gap: 2, minWidth: 0 }}
        >
          {tabs.map((tab) => (
            <TerminalTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onSelect={() => handleSelectTab(tab.id)}
              onClose={() => handleCloseTab(tab.id)}
            />
          ))}
          <button
            type="button"
            onClick={handleNewShell}
            title="New shell"
            aria-label="New shell"
            className="terminal-panel-gb terminal-panel-gb-icon-sm"
            style={{ marginLeft: 2 }}
          >
            <Plus size={12} />
          </button>
        </div>

        <div className="flex items-center" style={{ gap: 2 }}>
          <span
            className="terminal-panel-cwd"
            title={activeTab?.workDir}
          >
            {activeTab?.workDir ?? ""}
          </span>
          <button
            type="button"
            onClick={openCmdK}
            className="terminal-panel-gb"
            title="Ask AI (⌘K)"
            aria-label="Ask AI"
          >
            <Sparkles size={11} />
            <span
              style={{
                fontSize: 10,
                opacity: 0.7,
                fontFamily: "var(--font-mono)",
              }}
            >
              ⌘K
            </span>
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="terminal-panel-gb terminal-panel-gb-icon-sm"
            title="Close panel"
            aria-label="Close panel"
          >
            <ChevronDown size={12} />
          </button>
        </div>
      </div>

      {/* Terminal instances + Cmd+K — flush to panel edges (no inset tile) */}
      <div className="terminal-panel-body">
        {tabs.map((tab) => (
          <TerminalInstance
            key={tab.id}
            ref={setInstanceRef(tab.id)}
            shellId={tab.shellId}
            workDir={tab.workDir}
            hidden={tab.id !== activeTabId}
            ready={animDone}
            onCmdK={openCmdK}
            onExited={handleTabExited(tab.id)}
            onActivityChange={handleTabActivity(tab.id)}
          />
        ))}

        <TerminalCmdK
          open={aiPopupOpen}
          onClose={() => {
            setAiPopupOpen(false);
            focusActive();
          }}
          terminalContext={getActiveContext()}
          workDir={activeTab?.workDir ?? workDir}
          onInsertCommand={(cmd: string) => {
            insertActiveCommand(cmd);
            setAiPopupOpen(false);
            focusActive();
          }}
        />
      </div>
    </motion.div>
  );
}

interface TabProps {
  tab: TabState;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TerminalTab({ tab, active, onSelect, onClose }: TabProps) {
  const isRunning = tab.status === "running";

  return (
    <div
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className="terminal-panel-tab inline-flex cursor-pointer items-center"
    >
      <SquareTerminal size={11} style={{ opacity: 0.7 }} />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          letterSpacing: "-0.01em",
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={tab.label}
      >
        {tab.label}
      </span>
      {isRunning && (
        tab.busy ? (
          <Loader2
            size={10}
            className="terminal-tab-spinner"
            color="rgb(245,158,11)"
            aria-label="Command running"
          />
        ) : (
          <span
            className="terminal-tab-dot"
            aria-label="Shell idle"
          />
        )
      )}
      <span
        role="button"
        tabIndex={-1}
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onClose();
          }
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginLeft: 2,
          color: "var(--text-tertiary, #52525b)",
          cursor: "pointer",
        }}
      >
        <X size={10} />
      </span>
    </div>
  );
}
