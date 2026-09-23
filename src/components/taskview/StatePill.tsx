import type { EffectiveState } from "./taskStateMeta";
import { STATE_META } from "./taskStateMeta";

interface StatePillProps {
  state: EffectiveState;
  small?: boolean;
}

export function StatePill({ state, small = false }: StatePillProps) {
  const m = STATE_META[state];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: small ? "1.5px 6px" : "2px 8px",
        borderRadius: 9999,
        background: m.bg,
        border: `1px solid ${m.bd}`,
        color: m.fg,
        fontSize: small ? 9.5 : 10.5,
        fontWeight: 500,
        letterSpacing: 0,
      }}
    >
      <span
        className={state === "running" || state === "attention" ? "pulse-dot" : ""}
        style={{
          width: 5,
          height: 5,
          borderRadius: 9999,
          background: m.fg,
        }}
      />
      {m.label}
    </span>
  );
}

export function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: "#34d399" }}>+{additions}</span>
      <span style={{ color: "var(--text-muted)" }}> · </span>
      <span style={{ color: "#f87171" }}>−{deletions}</span>
    </span>
  );
}
