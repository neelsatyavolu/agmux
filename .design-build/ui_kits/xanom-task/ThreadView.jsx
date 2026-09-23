// ThreadView.jsx — Task mode main pane
// Layout (top → bottom):
//   1. TaskHeader           — title, branch, Agent/Task segmented, actions (Run, Merge)
//   2. AgentTabs            — horizontal tabs, one per parallel agent attempt (Claude / Codex / Droid …)
//   3. Split body:
//        left:  AgentThread — the chat + tool-use blocks for the selected attempt
//        right: ReviewPanel — diff summary, file tree, CI checks, Merge CTA
//   4. Composer             — send-follow-up input at bottom of left pane
//
// Visual DNA reused from Agent mode:
//   • Glass surfaces (header 35 %, sidebar 30 %, card 25 %, panel 50 %)
//   • 7 px GlassButton radius (load-bearing)
//   • Emerald accent for primary, zinc/translucent for secondary
//   • Tool-block left-bar pattern w/ category colors
//   • Status pills borrow semantic tokens (emerald / amber / red / blue)

/* ── Reusable primitives ─────────────────────────────────────────── */
const glassBtn = {
  padding: "6px 12px", borderRadius: 7,
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.65)", fontSize: 12, fontWeight: 500, cursor: "pointer",
  letterSpacing: "-0.015em",
  display: "inline-flex", alignItems: "center", gap: 6,
  transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
};
const glassBtnPrimary = {
  ...glassBtn,
  background: "rgba(52,211,153,0.15)",
  border: "1px solid rgba(52,211,153,0.40)",
  color: "#34d399",
};
const iconBtn = {
  width: 28, height: 28, borderRadius: 7,
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
  color: "#a1a1aa", display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer",
};

const Kbd = ({ children }) => (
  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, opacity: 0.7, marginLeft: 4 }}>{children}</span>
);

/* ── 1. Task header ──────────────────────────────────────────────── */
const TaskHeader = ({ task }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 14,
    padding: "10px 18px",
    background: "rgba(0,0,0,0.35)", backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    height: 56, boxSizing: "border-box", flexShrink: 0,
  }}>
    {/* task identity */}
    <div style={{
      width: 28, height: 28, borderRadius: 7,
      background: "rgba(52,211,153,0.10)", border: "1px solid rgba(52,211,153,0.24)",
      color: "#34d399",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      <i data-lucide="list-checks" style={{ width: 14, height: 14 }}></i>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13.5, color: "#fff", fontWeight: 500, letterSpacing: "-0.015em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
        <StatePill state={task.state}/>
      </div>
      <div style={{ fontSize: 10.5, color: "#71717a", fontFamily: "var(--font-mono)", marginTop: 2, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <i data-lucide="git-branch" style={{ width: 10, height: 10 }}></i>
          {task.branch}
        </span>
        <span>·</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <i data-lucide="folder-git-2" style={{ width: 10, height: 10 }}></i>
          worktree
        </span>
        <span>·</span>
        <span>started {task.when} ago</span>
      </div>
    </div>

    {/* Segmented control — Agent / Task, with Task active */}
    <div style={{
      display: "inline-flex", background: "rgba(0,0,0,0.20)",
      border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 3,
    }}>
      {["Agent", "Task"].map((m, i) => {
        const isActive = i === 1;
        return (
          <div key={m} style={{
            padding: "4px 12px", fontSize: 11.5, fontWeight: 500, borderRadius: 7,
            color: isActive ? "#fff" : "rgba(255,255,255,0.55)",
            background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
            boxShadow: isActive ? "inset 0 0.5px 0 rgba(255,255,255,0.12), 0 1px 3px rgba(0,0,0,0.2)" : "none",
            letterSpacing: "-0.01em", cursor: "pointer",
          }}>{m}</div>
        );
      })}
    </div>

    {/* Actions */}
    <button style={glassBtn}>
      <i data-lucide="play" style={{ width: 12, height: 12 }}></i>
      Run again
    </button>
    <button style={glassBtnPrimary}>
      <i data-lucide="git-merge" style={{ width: 12, height: 12 }}></i>
      Merge <Kbd>⌘↵</Kbd>
    </button>
    <button style={iconBtn}>
      <i data-lucide="more-horizontal" style={{ width: 14, height: 14 }}></i>
    </button>
  </div>
);

/* ── 2. Agent tabs — parallel attempts ──────────────────────────── */
const AGENT_ATTEMPTS = [
  { provider: "claude", model: "sonnet-4.6", state: "running", additions: 148, deletions: 22, turns: 18, preferred: true },
  { provider: "codex",  model: "gpt-5.4",    state: "review",  additions: 96,  deletions: 18, turns: 11 },
  { provider: "droid",  model: "droid",      state: "failed",  additions: 0,   deletions: 0,  turns: 4  },
];

const AgentTab = ({ a, active, onSelect }) => {
  const m = STATE_META[a.state];
  return (
    <div onClick={onSelect} style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "8px 12px",
      borderRadius: 8,
      background: active ? "rgba(255,255,255,0.06)" : "transparent",
      border: active ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent",
      boxShadow: active ? "inset 0 0.5px 0 rgba(255,255,255,0.12)" : "none",
      cursor: "pointer",
      transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
      position: "relative",
    }}>
      <AgentAvatar provider={a.provider} size={18}/>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 500,
          color: active ? "#fff" : "#e4e4e7", letterSpacing: "-0.015em",
          textTransform: "capitalize",
        }}>
          {a.provider === "codex" ? "Codex" : a.provider === "droid" ? "Droid" : "Claude"}
          <span style={{ color: "#71717a", fontFamily: "var(--font-mono)", fontWeight: 400, marginLeft: 6 }}>{a.model}</span>
        </div>
        <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "#71717a", display: "flex", alignItems: "center", gap: 6 }}>
          {a.state === "failed"
            ? <span style={{ color: m.fg }}>failed after {a.turns} turns</span>
            : <>
                <span style={{ color: "#34d399" }}>+{a.additions}</span>
                <span style={{ color: "#52525b" }}>/</span>
                <span style={{ color: "#f87171" }}>−{a.deletions}</span>
                <span style={{ color: "#52525b" }}>·</span>
                <span>{a.turns} turns</span>
              </>
          }
        </div>
      </div>
      <span
        className={a.state === "running" ? "pulse-dot" : ""}
        style={{
          width: 6, height: 6, borderRadius: 9999, background: m.fg,
          marginLeft: 2,
        }}
      />
      {a.preferred && (
        <div title="Preferred attempt" style={{
          position: "absolute", top: -5, right: -5,
          width: 14, height: 14, borderRadius: 9999,
          background: "#0a0a0b", border: "1px solid rgba(52,211,153,0.55)",
          color: "#34d399",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <i data-lucide="star" style={{ width: 7, height: 7, fill: "#34d399" }}></i>
        </div>
      )}
    </div>
  );
};

const AgentTabs = ({ active, onSelect }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 4,
    padding: "8px 16px",
    background: "rgba(0,0,0,0.25)", backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0, overflowX: "auto",
  }}>
    {AGENT_ATTEMPTS.map((a, i) => (
      <AgentTab key={i} a={a} active={i === active} onSelect={() => onSelect(i)}/>
    ))}
    <button title="Add another agent attempt" style={{
      ...iconBtn, marginLeft: 4,
      background: "transparent", border: "1px dashed rgba(255,255,255,0.10)",
    }}>
      <i data-lucide="plus" style={{ width: 13, height: 13 }}></i>
    </button>
    <div style={{ flex: 1 }}/>
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 9999,
      background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)",
      fontSize: 10.5, color: "#a1a1aa", fontFamily: "var(--font-mono)",
    }}>
      <i data-lucide="git-compare" style={{ width: 11, height: 11 }}></i>
      Compare attempts
    </div>
  </div>
);

/* ── 3a. Agent thread (left) ─────────────────────────────────────── */
const InlineCode = ({ children }) => (
  <code style={{
    background: "rgba(255,255,255,0.06)", color: "#e4e4e7",
    padding: "1px 5px", borderRadius: 4,
    fontFamily: "var(--font-mono)", fontSize: 13,
  }}>{children}</code>
);

const TOOL_COLORS = {
  edit:   { bar: "rgba(96,165,250,0.55)",  fg: "#60a5fa" },
  write:  { bar: "rgba(52,211,153,0.55)",  fg: "#34d399" },
  read:   { bar: "rgba(161,161,170,0.40)", fg: "#a1a1aa" },
  bash:   { bar: "rgba(74,222,128,0.55)",  fg: "#4ade80" },
  search: { bar: "rgba(167,139,250,0.55)", fg: "#a78bfa" },
  agent:  { bar: "rgba(96,165,250,0.55)",  fg: "#60a5fa" },
};
const PILLS = {
  done:    { bg: "rgba(52,211,153,0.10)", bd: "rgba(52,211,153,0.22)", fg: "#34d399" },
  running: { bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.28)", fg: "rgb(251,191,36)" },
  error:   { bg: "rgba(239,68,68,0.10)",  bd: "rgba(239,68,68,0.22)",  fg: "#f87171" },
};

const ToolBlock = ({ kind, title, detail, status, pillText }) => {
  const c = TOOL_COLORS[kind]; const p = PILLS[status] || PILLS.done;
  return (
    <div style={{
      marginTop: 10, marginBottom: 4,
      borderLeft: `2px solid ${c.bar}`,
      background: "rgba(0,0,0,0.25)", borderRadius: "0 7px 7px 0",
      padding: "8px 12px",
      fontFamily: "var(--font-mono)", fontSize: 12, color: "#a1a1aa",
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ color: c.fg, textTransform: "capitalize" }}>{kind}</span>
        <span style={{ color: "#52525b", margin: "0 6px" }}>·</span>
        <span style={{ color: "#e4e4e7" }}>{title}</span>
        {detail && <span style={{ color: "#71717a" }}> {detail}</span>}
      </div>
      <span style={{
        padding: "2px 8px", borderRadius: 9999, fontSize: 10,
        background: p.bg, border: `1px solid ${p.bd}`, color: p.fg,
        fontFamily: "var(--font-sans)", letterSpacing: 0, fontWeight: 500,
      }}>{pillText}</span>
    </div>
  );
};

const UserPrompt = ({ children }) => (
  <div style={{ display: "flex", justifyContent: "flex-end", margin: "14px 0" }}>
    <div style={{
      maxWidth: "85%", padding: "10px 14px", borderRadius: 16,
      background: "rgba(99,102,241,0.12)", border: "1px solid rgba(129,140,248,0.18)",
      fontSize: 14.5, lineHeight: 1.5, color: "#e4e4e7", letterSpacing: "-0.015em",
    }}>
      {children}
    </div>
  </div>
);

const AiMessage = ({ children }) => (
  <div style={{ maxWidth: "92%", margin: "14px 0", fontSize: 14.5, lineHeight: 1.6, color: "#e4e4e7", letterSpacing: "-0.015em" }}>
    {children}
  </div>
);

const Composer = ({ value, onChange, onSend }) => (
  <div style={{
    padding: "10px 18px 14px",
    background: "rgba(0,0,0,0.35)", backdropFilter: "blur(12px)",
    borderTop: "1px solid rgba(255,255,255,0.06)",
  }}>
    <div style={{
      background: "rgba(0,0,0,0.30)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 12, padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); } }}
        placeholder="Follow up with this agent…  (⌘↵ to send)"
        rows={2}
        style={{
          resize: "none", width: "100%", border: "none", outline: "none",
          background: "transparent", color: "#e4e4e7",
          fontFamily: "var(--font-sans)", fontSize: 14, letterSpacing: "-0.015em",
          lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button style={{ ...iconBtn, width: 26, height: 26, borderRadius: 6 }} title="Attach file">
          <i data-lucide="paperclip" style={{ width: 12, height: 12 }}></i>
        </button>
        <button style={{ ...glassBtn, padding: "4px 10px", borderRadius: 6, fontSize: 11 }}>
          <i data-lucide="terminal" style={{ width: 11, height: 11 }}></i>
          plan
        </button>
        <div style={{ flex: 1 }}/>
        <span style={{ fontSize: 10.5, color: "#52525b", fontFamily: "var(--font-mono)" }}>sonnet-4.6 · worktree</span>
        <button onClick={onSend} style={{
          width: 28, height: 28, borderRadius: 7,
          background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.40)",
          color: "#34d399", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
        }}>
          <i data-lucide="arrow-up" style={{ width: 14, height: 14 }}></i>
        </button>
      </div>
    </div>
  </div>
);

const AgentThread = ({ value, onChange, onSend }) => (
  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
    <div style={{ flex: 1, overflowY: "auto", padding: "4px 24px 8px" }}>
      <UserPrompt>
        Add a theme preset picker in Settings → Appearance. Should show all 11 presets plus a Custom tile. Persist with <code style={{ fontFamily: "var(--font-mono)" }}>localStorage</code>.
      </UserPrompt>

      <AiMessage>
        <p style={{ margin: "0 0 8px" }}>Plan: add a <InlineCode>ThemePresetGrid</InlineCode> component, wire it into <InlineCode>SettingsAppearance</InlineCode>, and persist via the existing <InlineCode>useThemeStore</InlineCode>.</p>
        <ToolBlock kind="read" title="src/settings/Appearance.tsx" detail="locate insertion" status="done" pillText="Done · 86 lines"/>
        <ToolBlock kind="read" title="src/theme/presets.ts" status="done" pillText="Done · 12 presets"/>
        <ToolBlock kind="search" title="useThemeStore usages" status="done" pillText="4 matches"/>
      </AiMessage>

      <AiMessage>
        <p style={{ margin: "0 0 8px" }}>Writing the grid. Each tile is a 72×56 swatch of the preset's tint with the accent ring around the active one.</p>
        <ToolBlock kind="write" title="src/settings/ThemePresetGrid.tsx" status="done" pillText="+112 / new file"/>
        <ToolBlock kind="edit"  title="src/settings/Appearance.tsx"  detail="insert <ThemePresetGrid/>" status="done" pillText="+6 −1"/>
        <ToolBlock kind="edit"  title="src/theme/useThemeStore.ts"   detail="add persist middleware" status="done" pillText="+21 −8"/>
      </AiMessage>

      <AiMessage>
        <p style={{ margin: "0 0 8px" }}>Running lint and the settings tests. Smoke test launches the app with <InlineCode>pnpm tauri dev</InlineCode>.</p>
        <ToolBlock kind="bash" title="pnpm lint --filter settings" status="done" pillText="Done · 0 warnings"/>
        <ToolBlock kind="bash" title="pnpm test settings/appearance" status="running" pillText="Running"/>
      </AiMessage>
    </div>
    <Composer value={value} onChange={onChange} onSend={onSend}/>
  </div>
);

/* ── 3b. Review panel (right) ────────────────────────────────────── */
const FileRow = ({ name, add, del, status }) => {
  const total = add + del || 1;
  const addPct = (add / total) * 100;
  const statusIcon = {
    modified: { i: "pencil", c: "#60a5fa" },
    added:    { i: "plus",   c: "#34d399" },
    renamed:  { i: "arrow-right-left", c: "#a78bfa" },
  }[status] || { i: "pencil", c: "#60a5fa" };
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 10px", borderRadius: 6,
      cursor: "pointer",
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
    >
      <i data-lucide={statusIcon.i} style={{ width: 11, height: 11, color: statusIcon.c, flexShrink: 0 }}></i>
      <span style={{
        flex: 1, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "#e4e4e7",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{name}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#34d399" }}>+{add}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#f87171" }}>−{del}</span>
      <div style={{ width: 36, height: 3, background: "rgba(239,68,68,0.30)", borderRadius: 9999, overflow: "hidden" }}>
        <div style={{ width: `${addPct}%`, height: "100%", background: "#34d399" }}/>
      </div>
    </div>
  );
};

const CheckRow = ({ name, state, duration }) => {
  const m = {
    passed:  { i: "check-circle-2", c: "#34d399", label: "passed" },
    failed:  { i: "x-circle",       c: "#f87171", label: "failed" },
    running: { i: "loader-2",       c: "rgb(251,191,36)", label: "running" },
  }[state];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "7px 10px", borderRadius: 7,
      background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)",
    }}>
      <i data-lucide={m.i} style={{ width: 13, height: 13, color: m.c, flexShrink: 0 }}></i>
      <span style={{ flex: 1, fontSize: 12, color: "#e4e4e7", letterSpacing: "-0.015em" }}>{name}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#71717a" }}>{duration}</span>
    </div>
  );
};

const SectionEyebrow = ({ children, right }) => (
  <div style={{
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 16px 8px",
  }}>
    <div style={{
      fontSize: 10, fontFamily: "var(--font-mono)", color: "#71717a",
      textTransform: "uppercase", letterSpacing: "0.2em",
    }}>{children}</div>
    {right}
  </div>
);

const ReviewPanel = ({ task }) => (
  <div style={{
    width: 380, flexShrink: 0, height: "100%",
    background: "rgba(0,0,0,0.20)", backdropFilter: "blur(12px)",
    display: "flex", flexDirection: "column", overflow: "hidden",
  }}>
    {/* Header — diff summary card */}
    <div style={{ padding: 14, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{
        background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12, padding: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{
            fontSize: 10, fontFamily: "var(--font-mono)", color: "#71717a",
            textTransform: "uppercase", letterSpacing: "0.2em",
          }}>Diff summary</div>
          <button style={{ ...glassBtn, padding: "3px 8px", fontSize: 10.5 }}>
            <i data-lucide="external-link" style={{ width: 10, height: 10 }}></i>
            Open diff
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 28, fontWeight: 600, color: "#fff", letterSpacing: "-0.025em" }}>{task.files}</span>
          <span style={{ fontSize: 12, color: "#71717a" }}>files changed</span>
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "var(--font-mono)", fontSize: 11,
        }}>
          <span style={{ color: "#34d399" }}>+{task.additions}</span>
          <div style={{ flex: 1, height: 4, borderRadius: 9999, overflow: "hidden", display: "flex" }}>
            <div style={{ flex: task.additions, background: "#34d399" }}/>
            <div style={{ flex: task.deletions, background: "#f87171" }}/>
          </div>
          <span style={{ color: "#f87171" }}>−{task.deletions}</span>
        </div>
      </div>
    </div>

    <div style={{ flex: 1, overflowY: "auto" }}>
      {/* Files changed */}
      <SectionEyebrow right={
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#71717a" }}>{task.files} files</span>
      }>Changed files</SectionEyebrow>
      <div style={{ padding: "0 8px 8px" }}>
        <FileRow name="src/settings/ThemePresetGrid.tsx" add={112} del={0}  status="added"/>
        <FileRow name="src/settings/Appearance.tsx"      add={6}   del={1}  status="modified"/>
        <FileRow name="src/theme/useThemeStore.ts"       add={21}  del={8}  status="modified"/>
        <FileRow name="src/theme/presets.ts"             add={4}   del={2}  status="modified"/>
        <FileRow name="src/theme/types.ts"               add={3}   del={1}  status="modified"/>
        <FileRow name="src/settings/index.ts"            add={1}   del={0}  status="modified"/>
        <FileRow name="src/__tests__/theme.test.ts"      add={1}   del={10} status="modified"/>
      </div>

      {/* Checks */}
      <SectionEyebrow right={
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#71717a" }}>4 passed · 1 running</span>
      }>Checks</SectionEyebrow>
      <div style={{ padding: "0 14px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
        <CheckRow name="tsc --noEmit"        state="passed"  duration="12.4s"/>
        <CheckRow name="eslint"              state="passed"  duration="3.8s"/>
        <CheckRow name="vitest / theme"      state="passed"  duration="1.2s"/>
        <CheckRow name="vitest / settings"   state="running" duration="0.4s"/>
        <CheckRow name="tauri build (macos)" state="passed"  duration="1m 08s"/>
      </div>

      {/* Notes */}
      <SectionEyebrow>Agent notes</SectionEyebrow>
      <div style={{ padding: "0 16px 16px" }}>
        <div style={{
          background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 10, padding: 12,
          fontSize: 12.5, color: "#e4e4e7", letterSpacing: "-0.015em", lineHeight: 1.55,
        }}>
          Added <InlineCode>ThemePresetGrid</InlineCode> as a 4-column grid of 72×56 swatches. Active preset is
          ringed with <InlineCode>--accent-border</InlineCode>. Persistence uses the existing
          zustand <InlineCode>persist</InlineCode> middleware — no new deps.
        </div>
      </div>
    </div>

    {/* Footer — primary merge CTA */}
    <div style={{
      padding: 12,
      borderTop: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(0,0,0,0.30)",
      display: "flex", gap: 8,
    }}>
      <button style={{ ...glassBtn, flex: 1, justifyContent: "center", padding: "8px 12px" }}>
        <i data-lucide="trash-2" style={{ width: 12, height: 12 }}></i>
        Discard
      </button>
      <button style={{
        flex: 2, justifyContent: "center", padding: "8px 14px", borderRadius: 7,
        background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.40)",
        color: "#34d399", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
        letterSpacing: "-0.015em",
        display: "inline-flex", alignItems: "center", gap: 6,
      }}>
        <i data-lucide="git-merge" style={{ width: 13, height: 13 }}></i>
        Merge into master
        <Kbd>⌘↵</Kbd>
      </button>
    </div>
  </div>
);

/* ── Compose the whole view ──────────────────────────────────────── */
const ThreadView = ({ task, activeAgent, onSelectAgent, composerValue, setComposerValue, onSend }) => (
  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
    <TaskHeader task={task}/>
    <AgentTabs active={activeAgent} onSelect={onSelectAgent}/>
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <AgentThread value={composerValue} onChange={setComposerValue} onSend={onSend}/>
      <ReviewPanel task={task}/>
    </div>
  </div>
);

Object.assign(window, {
  ThreadView, TaskHeader, AgentTabs, AgentTab, AgentThread, ReviewPanel,
  Composer, ToolBlock, InlineCode,
});
