// Sidebar.jsx — Task list grouped by state (Active / In review / Done).
// Visual DNA preserved from Agent-mode sidebar: 280px, glass bg at 30%,
// sentence-case section eyebrows in mono uppercase, rows with 7px radius.
// Differences from Agent sidebar:
//   • rows carry a branch label + diff stats instead of model/time
//   • state is a colored PILL (not a dot) because state is a first-class field
//   • "New Task" primary button uses filled emerald language from approval's Accept btn

/* ── Agent avatar (reused) ─────────────────────────────────────────── */
const AgentAvatar = ({ provider, size = 22 }) => {
  const map = {
    claude:   { bg: "#C15F3C", label: "C", src: "../../assets/agents/claude-white-icon.svg" },
    codex:    { bg: "#10a37f", label: "X", src: "../../assets/agents/chatgpt-icon.svg" },
    droid:    { bg: "#7c3aed", label: "D", src: "../../assets/agents/droid-icon.svg" },
    opencode: { bg: "#0891b2", label: "O" },
  };
  const p = map[provider] || map.opencode;
  const icon = Math.round(size * 0.63);
  return (
    <div style={{
      width: size, height: size, borderRadius: 5, background: p.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, overflow: "hidden"
    }}>
      {p.src
        ? <img src={p.src} alt="" style={{ width: icon, height: icon, filter: "brightness(0) invert(1)" }}/>
        : <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", fontFamily: "var(--font-mono)" }}>{p.label}</span>}
    </div>
  );
};

/* ── State pill: maps task state to semantic color tokens ─────────── */
const STATE_META = {
  queued:  { fg: "#a1a1aa", bg: "rgba(161,161,170,0.10)", bd: "rgba(161,161,170,0.22)", label: "Queued",   icon: "clock" },
  running: { fg: "rgb(251,191,36)", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.28)", label: "Running",  icon: "loader" },
  review:  { fg: "#60a5fa", bg: "rgba(96,165,250,0.10)", bd: "rgba(96,165,250,0.24)", label: "In review", icon: "eye" },
  merged:  { fg: "#34d399", bg: "rgba(52,211,153,0.10)", bd: "rgba(52,211,153,0.24)", label: "Merged",   icon: "check" },
  failed:  { fg: "#f87171", bg: "rgba(239,68,68,0.10)",  bd: "rgba(239,68,68,0.22)",  label: "Failed",   icon: "x" },
};

const StatePill = ({ state, small = false }) => {
  const m = STATE_META[state] || STATE_META.queued;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: small ? "1.5px 6px" : "2px 8px",
      borderRadius: 9999,
      background: m.bg, border: `1px solid ${m.bd}`, color: m.fg,
      fontSize: small ? 9.5 : 10.5, fontWeight: 500,
      letterSpacing: 0,
      fontFamily: "var(--font-sans)",
    }}>
      <span
        className={state === "running" ? "pulse-dot" : ""}
        style={{
          width: 5, height: 5, borderRadius: 9999, background: m.fg,
        }}
      />
      {m.label}
    </span>
  );
};

/* ── Diff stat — "+148 −22" in mono, green/red tints ─────────────── */
const DiffStat = ({ additions, deletions }) => (
  <span style={{
    fontFamily: "var(--font-mono)", fontSize: 10.5, whiteSpace: "nowrap",
  }}>
    <span style={{ color: "#34d399" }}>+{additions}</span>
    <span style={{ color: "#52525b" }}> · </span>
    <span style={{ color: "#f87171" }}>−{deletions}</span>
  </span>
);

/* ── Task row in sidebar ─────────────────────────────────────────── */
const TaskRow = ({ t, active, onSelect }) => (
  <div onClick={onSelect}
    style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: "9px 10px 10px",
      borderRadius: 7, cursor: "pointer",
      background: active ? "rgba(255,255,255,0.06)" : "transparent",
      border: active ? "1px solid rgba(255,255,255,0.08)" : "1px solid transparent",
      transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
    }}
    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
  >
    {/* top row: title + agent count */}
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: active ? "#fff" : "#e4e4e7",
          letterSpacing: "-0.015em", lineHeight: 1.35,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>{t.title}</div>
      </div>
      {t.agents > 0 && (
        <div title={`${t.agents} agent attempt${t.agents > 1 ? "s" : ""}`} style={{
          display: "flex", alignItems: "center", gap: 3,
          padding: "1px 6px", borderRadius: 9999,
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)",
          fontSize: 10, fontFamily: "var(--font-mono)", color: "#a1a1aa",
          flexShrink: 0,
        }}>
          <i data-lucide="users" style={{ width: 9, height: 9 }}></i>
          {t.agents}
        </div>
      )}
    </div>

    {/* middle row: branch (mono, dim) */}
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      fontSize: 10.5, fontFamily: "var(--font-mono)", color: "#71717a",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>
      <i data-lucide="git-branch" style={{ width: 10, height: 10, flexShrink: 0 }}></i>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.branch}</span>
    </div>

    {/* bottom row: state pill + diff stat / timestamp */}
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <StatePill state={t.state}/>
      <div style={{ flex: 1 }}/>
      {typeof t.additions === "number"
        ? <DiffStat additions={t.additions} deletions={t.deletions}/>
        : <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "#52525b" }}>{t.when}</span>}
    </div>
  </div>
);

const SidebarSection = ({ label, count, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      fontSize: 10, fontFamily: "var(--font-mono)", color: "#71717a",
      textTransform: "uppercase", letterSpacing: "0.2em",
      padding: "6px 12px 6px", marginTop: 4,
    }}>
      {label}
      <span style={{ letterSpacing: 0, color: "#52525b" }}>({count})</span>
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 6px" }}>{children}</div>
  </div>
);

/* ── Sidebar shell ───────────────────────────────────────────────── */
const Sidebar = ({ tasks, activeId, onSelect, onNew }) => {
  const active = tasks.filter(t => t.group === "active");
  const review = tasks.filter(t => t.group === "review");
  const done   = tasks.filter(t => t.group === "done");

  return (
    <div style={{
      width: 300, flexShrink: 0, height: "100%",
      background: "rgba(0,0,0,0.30)", backdropFilter: "blur(12px)",
      borderRight: "1px solid rgba(255,255,255,0.06)",
      display: "flex", flexDirection: "column",
    }}>
      {/* Top: New Task + Filter */}
      <div style={{
        padding: "12px 12px 10px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        display: "flex", gap: 6, alignItems: "center",
      }}>
        <button onClick={onNew} style={{
          flex: 1, display: "flex", alignItems: "center", gap: 6,
          padding: "7px 12px", borderRadius: 7,
          background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.35)",
          color: "#34d399", fontSize: 12.5, fontWeight: 500,
          cursor: "pointer", letterSpacing: "-0.015em",
        }}>
          <i data-lucide="plus" style={{ width: 13, height: 13 }}></i>
          New Task
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, opacity: 0.7 }}>⌘T</span>
        </button>
        <button style={{
          width: 28, height: 28, borderRadius: 7,
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
          color: "#a1a1aa", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
        }} title="Filter tasks">
          <i data-lucide="sliders-horizontal" style={{ width: 13, height: 13 }}></i>
        </button>
      </div>

      {/* Summary strip — counts by state */}
      <div style={{
        display: "flex", gap: 6, padding: "10px 12px 8px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        fontFamily: "var(--font-mono)", fontSize: 10.5,
      }}>
        {[
          { k: "running", n: tasks.filter(t => t.state === "running").length },
          { k: "review",  n: tasks.filter(t => t.state === "review").length  },
          { k: "merged",  n: tasks.filter(t => t.state === "merged").length  },
        ].map(({ k, n }) => {
          const m = STATE_META[k];
          return (
            <div key={k} style={{
              flex: 1, padding: "5px 8px", borderRadius: 7,
              background: "rgba(0,0,0,0.25)", border: `1px solid ${m.bd}`,
              display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
            }}>
              <span style={{ color: m.fg, fontSize: 13, fontWeight: 600, letterSpacing: "-0.015em", fontFamily: "var(--font-sans)" }}>{n}</span>
              <span style={{ color: "#71717a", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.15em" }}>{m.label}</span>
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: "auto", paddingTop: 4 }}>
        {active.length > 0 && (
          <SidebarSection label="Active" count={active.length}>
            {active.map(t => <TaskRow key={t.id} t={t} active={t.id === activeId} onSelect={() => onSelect(t.id)}/>)}
          </SidebarSection>
        )}
        {review.length > 0 && (
          <SidebarSection label="In review" count={review.length}>
            {review.map(t => <TaskRow key={t.id} t={t} active={t.id === activeId} onSelect={() => onSelect(t.id)}/>)}
          </SidebarSection>
        )}
        {done.length > 0 && (
          <SidebarSection label="Done" count={done.length}>
            {done.map(t => <TaskRow key={t.id} t={t} active={t.id === activeId} onSelect={() => onSelect(t.id)}/>)}
          </SidebarSection>
        )}
      </div>

      {/* Bottom: account (mirrors Agent-mode sidebar) */}
      <div style={{
        padding: 10, borderTop: "1px solid rgba(255,255,255,0.06)",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: "linear-gradient(135deg, #34d399, #059669)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, color: "#0a0a0b",
        }}>N</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: "#e4e4e7", letterSpacing: "-0.015em" }}>neel</div>
          <div style={{ fontSize: 10.5, color: "#71717a", fontFamily: "var(--font-mono)" }}>6 tasks · 3 worktrees</div>
        </div>
        <button style={{
          width: 26, height: 26, borderRadius: 6, background: "transparent",
          border: "1px solid transparent", color: "#71717a", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <i data-lucide="settings" style={{ width: 13, height: 13 }}></i>
        </button>
      </div>
    </div>
  );
};

Object.assign(window, { Sidebar, AgentAvatar, StatePill, DiffStat, STATE_META });
