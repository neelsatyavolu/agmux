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
      className={`ui-chip ${small ? "sm" : ""} task-state-pill`}
      style={{
        background: m.bg,
        border: `1px solid ${m.bd}`,
        color: m.fg,
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
    <span className="ui-diff">
      <span className="fx-green" style={{ color: "#34d399" }}>+{additions}</span>
      <span style={{ color: "var(--text-muted)" }}> </span>
      <span className="fx-red" style={{ color: "#f87171" }}>−{deletions}</span>
    </span>
  );
}
