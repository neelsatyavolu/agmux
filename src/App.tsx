import { useProviderAccountNotifications } from "./hooks/useProviderAccountNotifications";
import { useDebugHeartbeat } from "./hooks/useDebugHeartbeat";
import { useEffect, useCallback, useState, useRef, lazy, Suspense } from "react";
// PanelLeftOpen moved into Sidebar collapsed rail
import { Sidebar } from "./components/layout/Sidebar";
import { AgentTopChrome } from "./components/layout/AgentTopChrome";
import { MainPanel } from "./components/layout/MainPanel";
import { UsagePanel } from "./components/sidebar/UsagePanel";
import { TaskViewLayout } from "./components/taskview/TaskViewLayout";
import { RetainedModePanel } from "./components/layout/RetainedModePanel";
import { ResizeHandle } from "./components/layout/ResizeHandle";
import { SetupWizardDialog } from "./components/sidebar/SetupWizardDialog";
import { LocalModelSetupDialog } from "./components/sidebar/LocalModelSetupDialog";
import { LocalModelUpgradeDialog } from "./components/sidebar/LocalModelUpgradeDialog";
import { UpdateChecker } from "./components/UpdateChecker";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { ApprovalToast } from "./components/ApprovalToast";
import { AgentCompleteToastLayer } from "./components/AgentCompleteToast";
import { NotificationPromptDialog } from "./components/NotificationPromptDialog";
import { CommandPalette } from "./components/CommandPalette";
import { NotificationHistoryPanel } from "./components/NotificationHistoryPanel";
import { HookEventListener } from "./components/HookEventListener";
import { useUiStore } from "./stores/uiStore";
import { useLocalModelStore } from "./stores/localModelStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSplitViewStore } from "./stores/splitViewStore";
import { useTaskViewStore } from "./stores/taskViewStore";
import { useThreadDiffUpdates } from "./hooks/useThreadDiffUpdates";
import { useKeepAwake } from "./hooks/useKeepAwake";
import { runQuickOpenAction, isQuickOpenAction } from "./lib/quickOpen";
import { coworkDraftProvider } from "./lib/coworkMode";
import { prepareCoworkLists } from "./lib/desktopCowork";
import { CoworkLoadingOverlay } from "./components/layout/CoworkLoadingOverlay";
import { countRunningSessions } from "./lib/runningSessions";
import { isEditableKeyboardTarget } from "./lib/textFieldNav";
import { installVisibleSessionSync } from "./lib/visibleSessionIds";
import { syncCreatedClaudeSessionsToTeams } from "./lib/teamsClaudeOwnership";

// Settings dialog is heavy (themes, MCP, local models, git accounts, etc.) and
// only renders once the user opens it — split it out of the startup bundle.
const SettingsDialog = lazy(() =>
  import("./components/sidebar/SettingsDialog").then((m) => ({ default: m.SettingsDialog }))
);

/** Fade out and remove the HTML splash screen from index.html */
function dismissSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "scale(1.04)";
  setTimeout(() => el.remove(), 550);
}

function App() {
  useDebugHeartbeat();
  useThreadDiffUpdates();
  useKeepAwake();
  const accountNotices = useProviderAccountNotifications();
  useEffect(() => installVisibleSessionSync(), []);
  useEffect(() => { void syncCreatedClaudeSessionsToTeams(); }, []);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const usagePanelOpen = useUiStore((s) => s.usagePanelOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const runningSessionCount = useUiStore(countRunningSessions);
  const appMode = useUiStore((s) => s.appMode);
  const coworkLoading = useUiStore((s) => s.coworkLoading);
  const taskViewAllowed = useUiStore((s) => s.taskViewAllowed);
  const agentTabsLayout = useSettingsStore((s) => s.settings.agentTabsLayout ?? "vertical");
  const horizontalAgentChrome = agentTabsLayout === "horizontal";
  const taskModeActive = appMode === "task" && taskViewAllowed;

  useEffect(() => {
    if (!coworkLoading) return;
    let cancelled = false;
    const started = Date.now();
    void prepareCoworkLists()
      .catch((err) => console.error("Failed to load Cowork sessions:", err))
      .finally(() => {
        if (cancelled) return;
        const wait = Math.max(0, 220 - (Date.now() - started));
        window.setTimeout(() => {
          if (!cancelled) useUiStore.getState().setCoworkLoading(false);
        }, wait);
      });
    return () => {
      cancelled = true;
    };
  }, [coworkLoading]);

  // Resolve the hardware-gated Task View flag once at startup.
  useEffect(() => {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<boolean>("is_task_view_allowed")
        .then((allowed) => useUiStore.getState().setTaskViewAllowed(Boolean(allowed)))
        .catch(() => { /* unauthorized — keep default false */ });
    });
  }, []);

  // Reconnect the mobile-remote relay at startup when the user left it on.
  // Without this the desktop only connects when the Remote settings panel
  // mounts, so phones showed "desktop offline" after every app restart.
  useEffect(() => {
    const t = setTimeout(() => {
      if (useSettingsStore.getState().settings.remoteControlEnabled) {
        import("./lib/commands").then(({ remoteSetEnabled }) => {
          remoteSetEnabled(true).catch(() => { /* relay optional */ });
        });
      }
      // Mirror sidebar prefs (project order + pins) so the phone matches the
      // app even when neither changed this session.
      import("./lib/remoteSidebarPrefs").then(({ syncRemoteSidebarPrefs }) =>
        syncRemoteSidebarPrefs()
      ).catch(() => { /* remote optional */ });
      // Green-pulse unread dots → phone catalog; phone open clears desktop.
      import("./lib/remoteUnread").then(({ startRemoteUnreadBridge }) =>
        startRemoteUnreadBridge()
      ).catch(() => { /* remote optional */ });
      // Seed remote new-chat model picker with desktop last-used defaults.
      import("./lib/remoteDraftPrefs").then(({ syncRemoteDraftPrefs }) =>
        syncRemoteDraftPrefs()
      ).catch(() => { /* remote optional */ });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // Same-device web pair (remote.agmux.dev → agmux://remote/pair): Rust mints
  // the code when Remote is already on. Never flip the setting from a web
  // page — that would let any site enable phone control. Just open Settings.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ ok: boolean; message: string }>("remote-easy-pair", (ev) => {
          const { openSettings } = useSettingsStore.getState();
          openSettings("remote");
          if (!ev.payload?.ok && ev.payload?.message) {
            console.warn("[remote-easy-pair]", ev.payload.message);
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => { /* optional */ });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const [appReady, setAppReady] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const settingsOpen = useSettingsStore((s) => s.isOpen);
  const [showQuitDialog, setShowQuitDialog] = useState(false);
  const [isQuitting, setIsQuitting] = useState(false);
  const quitDialogRef = useRef<HTMLDivElement>(null);

  // Native menu Quit / Cmd+Q (custom menu item) emit this from Rust so the
  // confirm dialog shows even when webview keydown never fires.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("quit-requested", () => {
          setShowQuitDialog(true);
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to subscribe to quit-requested:", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Global keyboard shortcuts — capture phase to intercept before terminal swallows events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();

      // Cmd+Q — quit (webview path; native menu path uses quit-requested above)
      if (key === "q" && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        setShowQuitDialog(true);
        return;
      }

      // Cmd+Opt+Shift+I — toggle devtools inspector in production.
      // Gated by hardware UUID on the Rust side; unauthorized machines silently fail.
      // Uses `e.code` because Option+I produces a dead key glyph for `e.key` on macOS.
      if (e.metaKey && e.altKey && e.shiftKey && e.code === "KeyI") {
        e.preventDefault();
        e.stopPropagation();
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("toggle_devtools").catch(() => {
            // Silent — no UI tell on unauthorized machines.
          });
        });
        return;
      }

      // Cmd+Shift+T — toggle between agent and task modes (hardware-gated).
      if (e.shiftKey && e.key === "T") {
        const ui = useUiStore.getState();
        if (!ui.taskViewAllowed) return; // silently ignore on unauthorized machines
        e.preventDefault();
        e.stopPropagation();
        ui.setAppMode(ui.appMode === "task" ? "agent" : "task");
        return;
      }

      // Task mode shortcuts
      const currentAppMode = useUiStore.getState().appMode;
      if (currentAppMode === "task") {
        // Cmd+N → new task
        if (e.metaKey && !e.shiftKey && e.key === "n") {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("agmux-new-task"));
          return;
        }
        // Cmd+Shift+R → toggle review sidebar
        if (e.metaKey && e.shiftKey && e.key === "R") {
          e.preventDefault();
          e.stopPropagation();
          useTaskViewStore.getState().toggleReviewSidebar();
          return;
        }
      }

      // Cmd+B — toggle sidebar
      if (key === "b") {
        e.preventDefault();
        e.stopPropagation();
        useUiStore.getState().toggleSidebar();
        return;
      }

      // Cmd+E — toggle editor panel
      if (key === "e") {
        e.preventDefault();
        e.stopPropagation();
        useUiStore.getState().toggleEditorPanel();
        return;
      }

      // Cmd+, — open settings
      if (key === ",") {
        e.preventDefault();
        e.stopPropagation();
        useSettingsStore.getState().openSettings();
        return;
      }

      // Cmd+K — command palette
      if (key === "k") {
        e.preventDefault();
        e.stopPropagation();
        setShowCommandPalette(true);
        return;
      }

      // Cmd+Shift+F — global search
      if (e.shiftKey && key === "f") {
        e.preventDefault();
        e.stopPropagation();
        useUiStore.getState().setSearchDialogOpen(true);
        return;
      }


      // Cmd+N — new thread using default pairing
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const ui = useUiStore.getState();
        const projects = useProjectStore.getState().projects;
        const settings = useSettingsStore.getState().settings;
        const cwd = ui.selectedClaudeSessionCwd ?? ui.selectedCodexSessionCwd ?? ui.selectedTerminalSessionCwd;
        const project = cwd
          ? projects.find((p) => p.repo_path === cwd) ?? projects[0]
          : projects[0];
        if (!project) return;

        if (ui.appMode === "cowork") {
          void import("./lib/coworkMode").then(({ resolveCoworkDraftProject }) => {
            const folder = resolveCoworkDraftProject();
            if (!folder) return;
            ui.selectProject(folder.id);
            ui.setDraftChat({
              projectId: folder.id,
              repoPath: folder.repo_path,
              provider: coworkDraftProvider(settings.defaultProvider),
              model: null,
              agentProfile: "cowork",
            });
          });
          return;
        }
        const action = isQuickOpenAction(settings.quickOpenAction)
          ? settings.quickOpenAction
          : "chat";
        runQuickOpenAction(
          { id: project.id, repo_path: project.repo_path },
          action,
          settings.defaultProvider,
        ).catch((err) => console.error("Cmd+N quick open failed:", err));
        return;
      }

      // Cmd+Up/Down — navigate between sessions.
      // Yield when focus is in a composer / terminal so those surfaces can use
      // Cmd+Up/Down for start/end of prompt (see textFieldNav / terminalCmdArrow).
      if (key === "arrowup" || key === "arrowdown") {
        if (isEditableKeyboardTarget(e.target)) return;
        // Focus repeats rows from project groups and orders its portaled rows
        // with CSS, so walk visible rows top-to-bottom and skip repeats.
        const seen = new Set<string>();
        const els = Array.from(document.querySelectorAll<HTMLElement>("[data-session-nav]"))
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => ({ el, top: el.getBoundingClientRect().top }))
          .sort((a, b) => a.top - b.top)
          .map(({ el }) => el)
          .filter((el) => {
            const id = el.dataset.sessionNav ?? "";
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
        if (els.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const ui = useUiStore.getState();
        const currentId = ui.selectedClaudeSessionId ?? ui.selectedCodexSessionId ?? ui.selectedThreadId;
        const currentIdx = currentId ? els.findIndex((el) => el.dataset.sessionNav === currentId) : -1;
        const nextIdx = key === "arrowup"
          ? (currentIdx <= 0 ? els.length - 1 : currentIdx - 1)
          : (currentIdx >= els.length - 1 ? 0 : currentIdx + 1);
        els[nextIdx].click();
        els[nextIdx].scrollIntoView({ block: "nearest" });
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const handleQuit = useCallback(() => {
    setIsQuitting(true);
    // Two RAFs let the "Shutting down…" frame commit and paint before we
    // trigger exit(). exit() tears down the WebView and synchronously cleans
    // up PTYs/sidecars on the Rust side, which blocks the JS event loop —
    // without this, the dialog never visibly updates and the app just freezes.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        import("@tauri-apps/plugin-process").then(({ exit }) => exit(0));
      });
    });
  }, []);

  // Focus trap for quit dialog + Escape to dismiss
  useEffect(() => {
    if (!showQuitDialog) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isQuitting) {
        e.preventDefault();
        setShowQuitDialog(false);
      } else if (e.key === "Enter" && !isQuitting) {
        e.preventDefault();
        handleQuit();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [showQuitDialog, isQuitting, handleQuit]);

  const handleSidebarResize = useCallback(
    (delta: number) => setSidebarWidth(useUiStore.getState().sidebarWidth + delta),
    [setSidebarWidth]
  );

  // Anonymous product analytics — one heartbeat per UTC day when enabled.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void import("./lib/productAnalytics").then(({ sendProductHeartbeat }) => {
        sendProductHeartbeat();
      });
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  // Auto-start local LLM server if model is already downloaded
  useEffect(() => {
    const { fetchStatus, ensureServer } = useLocalModelStore.getState();
    fetchStatus().then(() => {
      const { status } = useLocalModelStore.getState();
      if (status?.model_downloaded && status?.server_downloaded && !status?.server_running) {
        ensureServer().catch(() => {
          // Silent failure — server will start on first inference request
        });
      }
    });
  }, []);

  // Restore multiview tab selection from persisted splitViewStore state.
  // The persist middleware rehydrates synchronously from localStorage, so
  // by the time this effect runs the panes/tabs are already available.
  useEffect(() => {
    const { multiViewEnabled } = useSettingsStore.getState().settings;
    if (!multiViewEnabled) return;

    const svState = useSplitViewStore.getState();
    const focusedPane = svState.panes[svState.focusedPaneId];
    if (!focusedPane?.activeTabId) return;

    const activeTab = focusedPane.tabs.find((t) => t.id === focusedPane.activeTabId);
    if (!activeTab) return;

    const ui = useUiStore.getState();
    switch (activeTab.type) {
      case "claude":
        if (activeTab.claudeSessionId) {
          ui.selectClaudeSession(activeTab.claudeSessionId, activeTab.claudeSessionCwd, activeTab.claudeSessionIsNew, activeTab.label);
        }
        break;
      case "codex":
        if (activeTab.codexSessionId) {
          ui.selectCodexSession(activeTab.codexSessionId, activeTab.codexSessionCwd, activeTab.label);
        }
        break;
      case "thread":
        if (activeTab.threadId) {
          ui.selectThread(activeTab.threadId, activeTab.label);
        }
        break;
      case "terminal":
        if (activeTab.terminalSessionId) {
          ui.selectTerminalSession(activeTab.terminalSessionId, activeTab.terminalSessionCwd, activeTab.label);
        }
        break;
    }
  }, []);

  // Sidebar signals when all data (projects + claude sessions + codex threads) is loaded
  const handleSidebarReady = useCallback(() => {
    setAppReady(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => dismissSplash());
    });
  }, []);

  // In task mode the Sidebar is not rendered, so dismiss splash immediately
  useEffect(() => {
    if (appMode === "task" && !appReady) {
      setAppReady(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => dismissSplash());
      });
    }
  }, [appMode, appReady]);

  return (
    <div
      className="flex h-screen w-screen overflow-hidden bg-transparent"
      style={{
        opacity: appReady ? 1 : 0,
        transition: "opacity 0.3s ease",
      }}
    >
      {/* Mode-dependent layout */}
      <RetainedModePanel active={taskModeActive}>
        <TaskViewLayout active={taskModeActive} />
      </RetainedModePanel>
      <RetainedModePanel active={!taskModeActive}>
      {horizontalAgentChrome ? (
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Emerald wall under the frosted top chrome + main canvas */}
          <div className="codex-wall" aria-hidden />
          <div className="relative z-[1] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!taskModeActive && <AgentTopChrome onReady={handleSidebarReady} />}
            {usagePanelOpen ? (
              <div className="codex-glass relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <UsagePanel />
              </div>
            ) : (
              <MainPanel />
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Sidebar with smooth collapse animation */}
          <div
            className="shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: sidebarCollapsed ? 52 : sidebarWidth }}
          >
            {!taskModeActive && <Sidebar onReady={handleSidebarReady} />}
          </div>
          {!sidebarCollapsed && (
            <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
          )}
          {usagePanelOpen ? (
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="codex-wall" aria-hidden />
              <div className="codex-glass relative z-[1] flex min-h-0 flex-1 flex-col overflow-hidden">
                <UsagePanel />
              </div>
            </div>
          ) : (
            <MainPanel />
          )}
        </>
      )}
      </RetainedModePanel>

      <CoworkLoadingOverlay />

      {/* Dialogs — only mount while open so closed overlays don't run hooks
          or subscribe to stores on every App re-render. */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
      {/* Hook listeners must mount before Sidebar so no race can register a
          second unguarded claude-hook path (Grok amber flash during Auto). */}
      <HookEventListener />
      <SetupWizardDialog />
      <LocalModelSetupDialog />
      <LocalModelUpgradeDialog />
      <UpdateChecker />
      <WhatsNewDialog />
      <ApprovalToast />
      <AgentCompleteToastLayer />
      {accountNotices.notifications.length > 0 && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2" aria-label="Account notifications">
          {accountNotices.notifications.map(notice => (
            <div key={notice.key} role={notice.status === "ready" ? "status" : "alert"} className="pointer-events-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--surface-popover)] p-4 text-[var(--text-primary)] shadow-xl">
              <p className="text-xs font-semibold">{notice.provider === "claude" ? "Claude" : notice.provider === "codex" ? "Codex" : "Grok"} account</p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{notice.message}</p>
              <div className="mt-3 flex gap-2">
                <button className="min-h-10 rounded-lg bg-[var(--accent-dim)] px-3 text-xs font-medium text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => { useSettingsStore.getState().openSettings("agentAccounts"); accountNotices.dismiss(notice.key); }}>Open Agent accounts</button>
                <button className="min-h-10 rounded-lg px-3 text-xs text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => accountNotices.dismiss(notice.key)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <NotificationPromptDialog />
      {showCommandPalette && (
        <CommandPalette open onClose={() => setShowCommandPalette(false)} />
      )}
      <NotificationHistoryPanel />

      {/* Quit confirmation dialog */}
      {showQuitDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            ref={quitDialogRef}
            className="w-[300px] rounded-xl border border-zinc-700/50 bg-zinc-950/95 p-5 shadow-2xl"
          >
            {isQuitting ? (
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                <p className="text-[13px] text-zinc-400">Shutting down…</p>
              </div>
            ) : (
              <>
                <h2 className="text-[14px] font-semibold text-zinc-100">
                  Quit agmux?
                </h2>
                {runningSessionCount > 0 && (
                  <p className="mt-1 text-[12px] leading-relaxed text-zinc-300">
                    You have {runningSessionCount}{" "}
                    {runningSessionCount === 1 ? "session" : "sessions"} running.
                  </p>
                )}
                <p className={`text-[12px] leading-relaxed text-zinc-500 ${runningSessionCount > 0 ? "mt-0.5" : "mt-1"}`}>
                  Running sessions will be stopped.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setShowQuitDialog(false)}
                    className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleQuit}
                    className="rounded-lg bg-red-600/90 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-500 transition-colors"
                  >
                    Quit
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
