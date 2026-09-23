import { Home, Brain, Activity } from "lucide-react";
import { useUiStore } from "../../stores/uiStore";

function goHome() {
  const store = useUiStore.getState();
  store.setUsagePanelOpen(false);
  store.setSidebarTab("agents");
  store.selectThread(null);
}

function goMemory() {
  const store = useUiStore.getState();
  // Clear session selection so MainPanel shows Memory (not a cached session).
  store.selectThread(null);
  store.setUsagePanelOpen(false);
  store.setSidebarTab("memory");
}

export function SidebarTabs({
  collapsed = false,
  orientation = "vertical",
}: {
  collapsed?: boolean;
  /** `"horizontal"` for agent top-chrome (segmented control along the toolbar). */
  orientation?: "vertical" | "horizontal";
}) {
  const activeTab = useUiStore((s) => s.sidebarTab);
  const usagePanelOpen = useUiStore((s) => s.usagePanelOpen);
  const hasSelection = useUiStore(
    (s) =>
      s.selectedThreadId !== null ||
      s.selectedCodexSessionId !== null ||
      s.selectedClaudeSessionId !== null,
  );
  // Exactly one nav item should look selected. Usage is a panel overlay
  // (usagePanelOpen), not a sidebarTab — when it's open it owns the highlight
  // so Home/Memory don't stay "active" underneath.
  const items = [
    {
      id: "home",
      label: "Home",
      icon: Home,
      active: !usagePanelOpen && activeTab === "agents" && !hasSelection,
      onClick: goHome,
      badge: 0,
    },
    {
      id: "memory",
      label: "Memory",
      icon: Brain,
      active: !usagePanelOpen && activeTab === "memory",
      onClick: goMemory,
      badge: 0,
    },
    {
      id: "usage",
      label: "Usage",
      icon: Activity,
      active: usagePanelOpen,
      onClick: () => useUiStore.getState().toggleUsagePanel(),
      badge: 0,
    },
  ];

  if (orientation === "horizontal") {
    return (
      <nav className="agent-top-chrome-seg">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={item.onClick}
              data-active={item.active ? "true" : "false"}
            >
              <Icon size={13} strokeWidth={1.8} />
              {item.label}
              {item.badge > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-amber-300">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    );
  }

  if (collapsed) {
    return (
      <div className="sb-nav items-center !px-1.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={item.onClick}
              data-active={item.active ? "true" : "false"}
              className="sb-nav-item !justify-center !px-2 relative"
              title={item.label}
            >
              <Icon size={15} strokeWidth={1.8} />
              {item.badge > 0 && (
                <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <nav className="sb-nav">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onClick={item.onClick}
            data-active={item.active ? "true" : "false"}
            className="sb-nav-item"
          >
            <Icon size={15} strokeWidth={1.8} />
            {item.label}
            {item.badge > 0 && (
              <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-amber-300">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
