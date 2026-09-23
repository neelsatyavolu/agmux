import { useState, type ReactNode } from "react";

/** Enter lazily, then keep session owners alive while another mode is shown. */
export function RetainedModePanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;
  return (
    <div className="min-h-0 min-w-0 flex-1" style={{ display: active ? "flex" : "none" }} aria-hidden={!active}>
      {children}
    </div>
  );
}
