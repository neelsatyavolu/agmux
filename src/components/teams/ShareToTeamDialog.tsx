/**
 * Share local memory (or a short digest) to Team Knowledge.
 * Explicit human action only — no auto-upload.
 */
import { useEffect, useState } from "react";
import {
  teamsGetStatus,
  teamsGetProjectBind,
  teamsSetProjectBind,
  teamsKnowledgeSettings,
  teamsKnowledgeAcceptDisclosure,
  teamsKnowledgePromote,
  teamsKnowledgeShareDigest,
  type TeamMembership,
  type ProjectTeamBind,
} from "../../lib/teams";

export type ShareToTeamMode = "promote" | "digest";

export interface ShareToTeamPayload {
  title: string;
  content: string;
  kind?: string;
  /** For digest mode */
  summary?: string;
  decisions?: string[];
  projectKey?: string;
  threadId?: string;
}

interface Props {
  open: boolean;
  mode: ShareToTeamMode;
  projectId: string;
  payload: ShareToTeamPayload;
  onClose: () => void;
  onShared?: (result: { teamName: string }) => void;
}

const DISCLOSURE =
  "Team Knowledge stores only what you share here — short decisions or session digests, not full chats. Agents only read official records when an owner enables agent access. Best-effort filters block common secrets and absolute paths (not a complete scanner). One team is one disclosure boundary for this pilot.";

export function ShareToTeamDialog({
  open,
  mode,
  projectId,
  payload,
  onClose,
  onShared,
}: Props) {
  const [teams, setTeams] = useState<TeamMembership[]>([]);
  const [bind, setBind] = useState<ProjectTeamBind | null>(null);
  const [teamKey, setTeamKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosureOk, setDisclosureOk] = useState(false);
  const [needsDisclosure, setNeedsDisclosure] = useState(false);
  const [title, setTitle] = useState(payload.title);
  const [body, setBody] = useState(payload.content || payload.summary || "");

  useEffect(() => {
    if (!open) return;
    setTitle(payload.title);
    setBody(payload.content || payload.summary || "");
    setError(null);
    setBusy(false);
    void (async () => {
      try {
        const status = await teamsGetStatus();
        setTeams(status.teams ?? []);
        const b = await teamsGetProjectBind(projectId).catch(() => null);
        setBind(b);
        const preferred =
          b?.teamSlug ||
          b?.teamId ||
          status.teams?.[0]?.slug ||
          status.teams?.[0]?.teamId ||
          "";
        setTeamKey(preferred);
        if (preferred) {
          const settings = await teamsKnowledgeSettings(preferred).catch(() => null);
          const ok = Boolean(
            settings && (settings as { disclosureAccepted?: boolean }).disclosureAccepted,
          );
          setDisclosureOk(ok);
          setNeedsDisclosure(!ok);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [open, projectId, payload.title, payload.content, payload.summary]);

  useEffect(() => {
    if (!open || !teamKey) return;
    void teamsKnowledgeSettings(teamKey)
      .then((s) => {
        const ok = Boolean((s as { disclosureAccepted?: boolean }).disclosureAccepted);
        setDisclosureOk(ok);
        setNeedsDisclosure(!ok);
      })
      .catch(() => {
        setDisclosureOk(false);
        setNeedsDisclosure(true);
      });
  }, [teamKey, open]);

  if (!open) return null;

  const selected = teams.find((t) => t.slug === teamKey || t.teamId === teamKey);

  const acceptDisclosure = async () => {
    if (!teamKey) return;
    setBusy(true);
    setError(null);
    try {
      await teamsKnowledgeAcceptDisclosure(teamKey);
      setDisclosureOk(true);
      setNeedsDisclosure(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!teamKey || !selected) {
      setError("Pick a team.");
      return;
    }
    if (!title.trim() || !body.trim()) {
      setError("Title and content are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (needsDisclosure || !disclosureOk) {
        await teamsKnowledgeAcceptDisclosure(teamKey);
      }
      await teamsSetProjectBind({
        projectId,
        teamId: selected.teamId,
        teamSlug: selected.slug || selected.teamId,
        teamName: selected.name,
      });
      if (mode === "digest") {
        await teamsKnowledgeShareDigest({
          team: teamKey,
          title: title.trim(),
          summary: body.trim(),
          decisions: payload.decisions ?? [body.trim().slice(0, 500)],
          projectKey: payload.projectKey,
          threadId: payload.threadId,
        });
      } else {
        await teamsKnowledgePromote({
          team: teamKey,
          title: title.trim(),
          content: body.trim(),
          kind: payload.kind || "decision",
        });
      }
      onShared?.({ teamName: selected.name });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "digest" ? "Share session to team" : "Share memory to team"}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-[var(--surface-modal)] p-4 shadow-2xl">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          {mode === "digest" ? "Share session digest" : "Share to Team Knowledge"}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          {mode === "digest"
            ? "Posts a short summary to your team’s Knowledge tab. Not a full transcript."
            : "Promotes this local memory item into a team record (member authority until a manager marks it official)."}
        </p>

        {teams.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-amber-300/90">
            Link agmux Teams in Settings and join a team first.
          </p>
        ) : (
          <>
            <label className="mt-3 block text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Team
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[13px] text-[var(--text-primary)]"
              value={teamKey}
              disabled={busy}
              onChange={(e) => setTeamKey(e.target.value)}
            >
              {teams.map((t) => (
                <option key={t.teamId} value={t.slug || t.teamId}>
                  {t.name}
                  {bind && (bind.teamId === t.teamId || bind.teamSlug === t.slug)
                    ? " (bound)"
                    : ""}
                </option>
              ))}
            </select>

            {(needsDisclosure || !disclosureOk) && (
              <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">{DISCLOSURE}</p>
                <button
                  type="button"
                  className="mt-2 text-[12px] font-medium text-[var(--status-blue)]"
                  disabled={busy}
                  onClick={() => void acceptDisclosure()}
                >
                  I understand — accept
                </button>
              </div>
            )}

            <label className="mt-3 block text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Title
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[13px] text-[var(--text-primary)]"
              value={title}
              disabled={busy}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label className="mt-3 block text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {mode === "digest" ? "Summary" : "Content"}
            </label>
            <textarea
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[13px] text-[var(--text-primary)]"
              rows={4}
              value={body}
              disabled={busy}
              maxLength={12000}
              onChange={(e) => setBody(e.target.value)}
            />
          </>
        )}

        {error && <p className="mt-2 text-[12px] text-amber-300/90">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-[var(--text-tertiary)] hover:bg-white/5"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-[#60a5fa] px-3 py-1.5 text-[12.5px] font-medium text-[#0a0a0b] disabled:opacity-50"
            disabled={busy || teams.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Sharing…" : mode === "digest" ? "Share digest" : "Share to team"}
          </button>
        </div>
      </div>
    </div>
  );
}
