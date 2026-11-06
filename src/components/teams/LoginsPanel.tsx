/** Usage split by the Claude/Codex login each session ran on. */

import { fmtPct, fmtTokens, type LoginsBlock } from "../../lib/teams";
import { providerColor } from "./charts";
import { Panel } from "./primitives";

export function LoginsPanel({ logins }: { logins: LoginsBlock | undefined }) {
  // An older server sends nothing; say nothing rather than a misleading zero.
  if (!logins) return null;
  return (
    <Panel title="Usage by login" sub="which Claude or Codex login did the work">
      {!logins.reported ? (
        <p className="m-0 text-[11.5px] text-[var(--text-muted)]">
          Not reported yet. Logins appear after your app's next sync, for sessions started from then on.
        </p>
      ) : !logins.rows.length ? (
        <p className="m-0 text-[11.5px] text-[var(--text-muted)]">No Claude or Codex usage in this range.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {logins.rows.map((row) => {
            const tokens = fmtTokens(row.tokens);
            const unattributed = row.identityHash === null;
            return (
              <div
                key={`${row.provider}:${row.identityHash ?? "none"}`}
                className="grid items-center gap-2.5 text-[12px]"
                style={{ gridTemplateColumns: "minmax(140px,1.4fr) 1fr 40px 52px" }}
                title={`${row.name}: ${fmtPct(row.share)} of tokens`}
              >
                <div className="flex min-w-0 items-center gap-[7px] text-[var(--text-secondary)]">
                  <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: providerColor(row.provider) }} />
                  <span className={`truncate ${unattributed ? "text-[var(--text-muted)]" : ""}`}>{row.name}</span>
                </div>
                <div className="h-[7px] overflow-hidden rounded-[3px] bg-white/[0.05]">
                  <div
                    className="h-full rounded-[3px]"
                    style={{ width: `${(row.share * 100).toFixed(1)}%`, background: providerColor(row.provider), opacity: unattributed ? 0.35 : 1 }}
                  />
                </div>
                <div className="text-right text-[11.5px] tabular-nums text-[var(--text-tertiary)]">{fmtPct(row.share)}</div>
                <div className="text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                  {tokens.value}
                  {tokens.unit}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
