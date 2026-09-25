/**
 * Design screen 11 — Settings → Organization → Sync.
 *
 * Status, backoff position, queued batches, recent uploads, and a payload
 * preview showing exactly what would leave the machine: counters and short
 * labels, nothing else.
 */

import { useCallback, useEffect, useState } from "react";
import { RotateCw, WifiOff } from "lucide-react";
import {
  agoLabel,
  fmtWhen,
  parseTeamsTs,
  teamsGetStatus,
  teamsListQueue,
  teamsPreviewPayload,
  teamsSyncNow,
  type HourlyBucket,
  type QueuedBatch,
  type TeamsSyncStatus,
} from "../../lib/teams";
import { GlassButton } from "../ui/GlassButton";
import { Banner, EmptyState, Panel, Pill } from "../teams/primitives";

const fmtBytes = (n: number): string =>
  n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export function TeamsSyncSection() {
  const [status, setStatus] = useState<TeamsSyncStatus | null>(null);
  const [queue, setQueue] = useState<QueuedBatch[]>([]);
  const [preview, setPreview] = useState<HourlyBucket[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, q] = await Promise.all([teamsGetStatus(), teamsListQueue()]);
      setStatus(s);
      setQueue(q);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const syncNow = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await teamsSyncNow();
      if (outcome.lastError) {
        setError(outcome.lastError);
      } else if (outcome.sent > 0) {
        const n = outcome.buckets;
        setNote(
          `Uploaded ${outcome.sent} ${outcome.sent === 1 ? "batch" : "batches"}` +
            (n > 0 ? ` · ${n} hourly ${n === 1 ? "bucket" : "buckets"}` : "") +
            (outcome.duplicates > 0 ? ` · ${outcome.duplicates} already applied` : ""),
        );
      } else {
        setNote("Up to date — nothing new to upload.");
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async () => {
    try {
      setPreview(await teamsPreviewPayload());
    } catch (e) {
      setError(String(e));
    }
  };

  if (!status?.linked) {
    return (
      <div className="flex flex-col gap-2.5">
        <SyncHeader />
        <Panel padded={false}>
          <EmptyState
            icon={WifiOff}
            title="Not signed in"
            body="Link this Mac under Settings → Teams to start uploading aggregates."
          />
        </Panel>
      </div>
    );
  }

  const coverage = status.accountingCoverage;
  const failing = Boolean(status.lastError) || status.backoffStep > 0;
  const lastMs = status.lastUploadAt ? parseTeamsTs(status.lastUploadAt) : NaN;
  const stale =
    !status.lastUploadAt ||
    !Number.isFinite(lastMs) ||
    Date.now() - lastMs > 86_400_000;

  return (
    <div className="flex flex-col gap-2.5">
      <SyncHeader />
      <p className="m-0 text-[11.5px] text-[var(--text-muted)]">
        Teams includes verified agmux-created sessions and reported usage only. Create new Grok and Cline sessions from agmux’s New menu;
        internal session changes and Gemini terminal may lack creation evidence. Missing provider reports are not counted as zero usage.
      </p>

      {coverage && (coverage.unverifiedLegacyRecords > 0 || coverage.awaitingNativeBinding > 0 || coverage.unrevalidatedCodexSnapshots > 0) ? (
        <Banner tone="plain" icon={RotateCw}>
          <b className="font-medium">Usage coverage is incomplete.</b>{" "}
          {coverage.unverifiedLegacyRecords > 0 ? `${coverage.unverifiedLegacyRecords} older records have unverified creation origins. ` : ""}
          {coverage.awaitingNativeBinding > 0 ? `${coverage.awaitingNativeBinding} created threads are awaiting a provider session identity. ` : ""}
          {coverage.unrevalidatedCodexSnapshots > 0 ? `${coverage.unrevalidatedCodexSnapshots} saved Codex sessions need their original logs to verify usage. ` : ""}
          Unverified history is kept locally and excluded from confirmed Teams totals. Missing provider reports cannot be reconstructed.
        </Banner>
      ) : null}

      {error || status.lastError ? (
        <Banner
          tone="err"
          icon={WifiOff}
          action={
            <GlassButton
              icon={RotateCw}
              size="sm"
              onClick={() => void syncNow()}
              disabled={busy}
            >
              Retry now
            </GlassButton>
          }
        >
          <b className="font-medium">Upload failed.</b>{" "}
          {error ?? status.lastError}
          {status.queuedBatches > 0
            ? ` ${status.queuedBatches} ${status.queuedBatches === 1 ? "batch is" : "batches are"} queued locally and will send automatically.`
            : ""}
        </Banner>
      ) : note ? (
        <Banner tone="plain" icon={RotateCw}>
          {note}
        </Banner>
      ) : null}

      <Panel
        title="Status"
        right={
          failing ? (
            <Pill tone="err">failing</Pill>
          ) : stale ? (
            <Pill tone="warn">stale</Pill>
          ) : (
            <Pill tone="ok">healthy</Pill>
          )
        }
      >
        <dl
          className="grid gap-y-2 text-[12.5px]"
          style={{ gridTemplateColumns: "170px 1fr", columnGap: 14 }}
        >
          <dt className="text-[var(--text-muted)]">Last successful upload</dt>
          <dd className="m-0 tabular-nums text-[var(--text-secondary)]">
            {status.lastUploadAt ? (
              <>
                {fmtWhen(status.lastUploadAt)}{" "}
                <span className={stale ? "text-[var(--status-amber)]" : "text-[var(--text-muted)]"}>
                  · {agoLabel(status.lastUploadAt)}
                </span>
              </>
            ) : (
              <span className="text-[var(--text-muted)]">never</span>
            )}
          </dd>

          <dt className="text-[var(--text-muted)]">Next attempt</dt>
          <dd className="m-0 tabular-nums text-[var(--text-secondary)]">
            {status.nextAttemptAt ? (
              <>
                {(() => {
                  const t = parseTeamsTs(status.nextAttemptAt);
                  return Number.isFinite(t)
                    ? new Date(t).toLocaleTimeString()
                    : status.nextAttemptAt;
                })()}
                {status.backoffStep > 0 ? (
                  <span className="text-[var(--text-muted)]"> · backoff {status.backoffStep}/6</span>
                ) : null}
              </>
            ) : (
              "on the next flush"
            )}
          </dd>

          <dt className="text-[var(--text-muted)]">Queued batches</dt>
          <dd className="m-0 tabular-nums text-[var(--text-secondary)]">
            {status.queuedBatches}
            {status.queuedBytes > 0 ? (
              <span className="text-[var(--text-muted)]"> · {fmtBytes(status.queuedBytes)}</span>
            ) : null}
          </dd>

          <dt className="text-[var(--text-muted)]">Teams receiving</dt>
          <dd className="m-0 text-[var(--text-secondary)]">
            {status.teams.length ? status.teams.map((t) => t.name).join(", ") : "none"}
          </dd>

          <dt className="text-[var(--text-muted)]">Linked account</dt>
          <dd className="m-0 text-[var(--text-secondary)]">
            {status.account?.handle ? `@${status.account.handle}` : (status.account?.email ?? "—")}
          </dd>

          <dt className="text-[var(--text-muted)]">Payload</dt>
          <dd className="m-0 text-[var(--text-secondary)]">
            counters and labels only —{" "}
            <button
              onClick={loadPreview}
              className="text-[var(--status-blue)] underline-offset-2 hover:underline"
            >
              see exactly what would be sent
            </button>
          </dd>
        </dl>

        <div className="mt-3.5">
          <GlassButton
            icon={RotateCw}
            size="sm"
            onClick={() => void syncNow()}
            disabled={busy}
          >
            {busy ? "Syncing…" : "Sync now"}
          </GlassButton>
        </div>
      </Panel>

      {preview ? (
        <Panel
          title="Payload preview"
          sub={`${preview.length} hourly ${preview.length === 1 ? "bucket" : "buckets"}`}
          right={
            <GlassButton size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Hide
            </GlassButton>
          }
          padded={false}
        >
          {preview.length === 0 ? (
            <p className="m-0 px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">
              Nothing to upload right now — no agent activity in the last 48 hours.
            </p>
          ) : (
            <div className="max-h-[280px] overflow-auto">
              <table className="w-full border-collapse tabular-nums">
                <thead className="sticky top-0 bg-[var(--surface-code-panel)]">
                  <tr>
                    {["Hour (UTC)", "Provider", "Project", "Tokens", "Active", "Sessions"].map((h, i) => (
                      <th
                        key={h}
                        className={`border-b border-white/[0.06] px-3 py-[7px] ui-eyebrow font-normal text-[var(--text-muted)] ${
                          i < 3 ? "text-left" : "text-right"
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((b) => (
                    <tr key={`${b.hourUtc}-${b.provider}-${b.model}-${b.projectKey}`} className="h-[30px]">
                      <td className="border-b border-white/[0.035] px-3 text-left font-mono text-[11px] text-[var(--text-tertiary)]">
                        {b.hourUtc}
                      </td>
                      <td className="border-b border-white/[0.035] px-3 text-left text-[11.5px] text-[var(--text-secondary)]">
                        {b.provider}
                      </td>
                      <td className="border-b border-white/[0.035] px-3 text-left font-mono text-[11px] text-[var(--text-muted)]">
                        {b.projectKey || "—"}
                      </td>
                      <td className="border-b border-white/[0.035] px-3 text-right text-[11.5px] text-[var(--text-secondary)]">
                        {(
                          b.tokensIn + b.tokensOut + b.tokensCacheRead + b.tokensCacheWrite
                        ).toLocaleString()}
                      </td>
                      <td className="border-b border-white/[0.035] px-3 text-right text-[11.5px] text-[var(--text-muted)]">
                        {(b.activeMs / 3_600_000).toFixed(1)}h
                      </td>
                      <td className="border-b border-white/[0.035] px-3 text-right text-[11.5px] text-[var(--text-muted)]">
                        {b.sessions}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {queue.length > 0 ? (
        <Panel title="Queued batches" sub="retried automatically with backoff" padded={false}>
          {queue.map((b) => (
            <div
              key={b.batchId}
              className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-[var(--text-tertiary)]">{b.batchId.slice(0, 8)}</div>
                <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                  {b.bucketCount} buckets · {fmtBytes(b.byteSize)}
                  {b.attempts > 0 ? ` · ${b.attempts} attempts` : ""}
                </div>
              </div>
              {b.lastError ? <Pill tone="err">failing</Pill> : <Pill tone="warn">queued</Pill>}
            </div>
          ))}
        </Panel>
      ) : null}
    </div>
  );
}

function SyncHeader() {
  return (
    <div>
      <h2 className="m-0 text-[16px] font-semibold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>
        Sync
      </h2>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        Aggregated counters upload about every two minutes while agmux is running. Nothing is sent when
        you&apos;re not on a team.
      </p>
    </div>
  );
}
