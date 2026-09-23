/**
 * Settings → Teams.
 *
 * Linked account, team list, join-by-link. Opening a team launches the web app
 * (teams.agmux.dev) — desktop only handles account link + sync, not the dashboard.
 * Org analytics only; personal usage stays in Settings → Usage and is untouched.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Github,
  LogIn,
  RefreshCw,
  Users,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  teamsAcceptInvite,
  teamsGetStatus,
  teamsLinkClaim,
  teamsLinkStart,
  teamsPreviewInvite,
  teamsKnowledgeAvailable,
  teamsRefresh,
  teamsSignOut,
  type InvitePreview,
  type TeamMembership,
  type TeamsSyncStatus,
} from "../../lib/teams";
import { GlassButton } from "../ui/GlassButton";
import { JoinDisclosureDialog } from "../teams/JoinDisclosureDialog";
import { Avatar, EmptyState, Panel, Pill, RoleBadge } from "../teams/primitives";

/** Poll cadence while the browser half of the device link is outstanding. */
const CLAIM_POLL_MS = 2000;
const CLAIM_TIMEOUT_MS = 5 * 60_000;

export function TeamsSection() {
  const [status, setStatus] = useState<TeamsSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Join-by-link: paste → preview → required disclosure → join.
  const [inviteLink, setInviteLink] = useState("");
  const [pendingInvite, setPendingInvite] = useState<InvitePreview | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** Server advertises Knowledge only after D1 migration; hide UI on older backends. */
  const [knowledgeAvailable, setKnowledgeAvailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await teamsGetStatus());
      // Best-effort: older servers / pre-migration return false; never blocks status.
      const kw = await teamsKnowledgeAvailable().catch(() => false);
      setKnowledgeAvailable(kw);
    } catch (e) {
      setError(String(e));
      setKnowledgeAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await teamsLinkStart("agmux desktop");
      await openUrl(start.url);

      // The browser half completes out of band; poll until the token lands.
      const startedAt = Date.now();
      pollRef.current = window.setInterval(async () => {
        if (Date.now() - startedAt > CLAIM_TIMEOUT_MS) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setBusy(false);
          setError("Sign-in timed out. Try again.");
          return;
        }
        try {
          const account = await teamsLinkClaim(start.code, start.deviceId);
          if (account) {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(false);
            await refresh();
          }
        } catch (e) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setBusy(false);
          setError(String(e));
        }
      }, CLAIM_POLL_MS);
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  };

  const signOut = async () => {
    if (!window.confirm("Sign out of agmux Teams? Uploads stop and queued batches are discarded.")) {
      return;
    }
    setBusy(true);
    try {
      await teamsSignOut();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const syncRoster = async () => {
    setBusy(true);
    try {
      await teamsRefresh();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Step 1 — resolve the link so the disclosure can name the real team. */
  const previewInvite = async () => {
    setBusy(true);
    setError(null);
    setJoinError(null);
    try {
      const preview = await teamsPreviewInvite(inviteLink);
      if (preview.state !== "active") {
        setError(
          preview.state === "expired"
            ? "That invite has expired — ask the team owner for a new link."
            : preview.state === "revoked"
              ? "That invite was revoked — ask the team owner for a new link."
              : "That invite has been used up — ask the team owner for a new link.",
        );
        return;
      }
      setPendingInvite(preview);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Step 2 — only reached once the disclosure checkbox was ticked. */
  const acceptInvite = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      await teamsAcceptInvite(inviteLink);
      setPendingInvite(null);
      setInviteLink("");
      await refresh();
    } catch (e) {
      setJoinError(String(e));
    } finally {
      setJoining(false);
    }
  };

  const openWeb = (team: TeamMembership, path = "") => {
    const base = status?.baseUrl ?? "https://teams.agmux.dev";
    const suffix = path ? `/${path.replace(/^\//, "")}` : "";
    void openUrl(
      `${base.replace(/\/$/, "")}/#/t/${encodeURIComponent(team.slug)}${suffix}`,
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <h2 className="m-0 text-[16px] font-semibold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>
          Teams
        </h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          Org-level analytics. Your personal usage stays in Settings → Usage and is never affected by
          this.
        </p>
      </div>

      {error ? (
        <div className="rounded-[10px] border border-[#f87171]/[0.24] bg-[#f87171]/[0.08] px-3.5 py-2.5 text-[12.5px] text-[var(--status-red)]">
          {error}
        </div>
      ) : null}

      <Panel
        title="Linked account"
        padded={false}
        right={
          status?.linked ? <Pill tone="ok">signed in</Pill> : <Pill tone="none">not signed in</Pill>
        }
      >
        {status?.linked && status.account ? (
          <div className="flex items-center gap-3 px-3.5 py-[11px]">
            <Avatar name={status.account.displayName} color={status.account.avatarColor} />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{status.account.displayName}</div>
              <div className="mt-0.5 font-mono text-[11.5px] text-[var(--text-muted)]">
                {status.account.email ?? status.account.handle ?? status.account.userId}
              </div>
            </div>
            <GlassButton size="sm" variant="ghost" onClick={signOut} disabled={busy}>
              Sign out
            </GlassButton>
          </div>
        ) : (
          <EmptyState
            icon={Users}
            title="Sign in to agmux Teams"
            body="Link this Mac to see team analytics and start uploading aggregates. You choose GitHub or Google in the browser."
            actions={
              <GlassButton icon={busy ? RefreshCw : Github} variant="accent" onClick={signIn} disabled={busy}>
                {busy ? "Waiting for browser…" : "Sign in"}
              </GlassButton>
            }
          />
        )}
      </Panel>

      {status?.linked ? (
        <Panel
          title="Your teams"
          padded={false}
          right={
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-[var(--text-muted)]">{status.teams.length}</span>
              <GlassButton icon={RefreshCw} size="sm" variant="ghost" onClick={syncRoster} disabled={busy}>
                Refresh
              </GlassButton>
            </div>
          }
        >
          {status.teams.length === 0 ? (
            <EmptyState
              icon={LogIn}
              title="No teams yet"
              body="Paste an invite link below to join, or create a team on the web."
              actions={
                <GlassButton
                  size="sm"
                  onClick={() => void openUrl(`${status.baseUrl.replace(/\/$/, "")}/#/teams`)}
                >
                  Open agmux Teams
                </GlassButton>
              }
            />
          ) : (
            <>
              {status.teams.map((t) => (
                <div
                  key={t.teamId}
                  className="flex items-center gap-3 border-b border-white/[0.06] px-3.5 py-[11px] last:border-b-0"
                >
                  <div className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-[#60a5fa] font-mono text-[9px] font-bold text-[#0a0a0b]">
                    {t.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t.name}</div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                      {t.role === "owner" || t.role === "manager"
                        ? "full team analytics"
                        : "your stats only"}
                    </div>
                  </div>
                  <RoleBadge role={t.role} />
                  {knowledgeAvailable ? (
                    <GlassButton size="sm" variant="ghost" onClick={() => openWeb(t, "knowledge")}>
                      Knowledge
                    </GlassButton>
                  ) : null}
                  <GlassButton iconRight={ArrowRight} size="sm" variant="ghost" onClick={() => openWeb(t)}>
                    Open
                  </GlassButton>
                </div>
              ))}
              <div className="px-3.5 py-[11px] text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                Metrics upload covers every team you belong to. Team data is never mixed — each team
                only sees your totals for the period you were a member.
                {knowledgeAvailable ? (
                  <>
                    {" "}
                    On a Teams plan (or trial), share decisions from the Memory tab (Share icon) or
                    open Knowledge on the web. Free teams get analytics only. Binding a project to a
                    team lets agents read official records when the owner enables MCP.
                  </>
                ) : null}
              </div>
            </>
          )}
        </Panel>
      ) : null}

      {status?.linked ? (
        <Panel title="Join a team">
          <div className="flex gap-2">
            <input
              className="w-full rounded-lg border border-white/[0.10] bg-black/35 px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[#60a5fa]/[0.28]"
              placeholder="Paste invite link — teams.agmux.dev/join/…"
              value={inviteLink}
              onChange={(e) => setInviteLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && inviteLink.trim()) void previewInvite();
              }}
              spellCheck={false}
            />
            <GlassButton size="sm" onClick={previewInvite} disabled={busy || !inviteLink.trim()}>
              Continue
            </GlassButton>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            You&apos;ll see exactly what joining shares before anything is uploaded.
          </p>
        </Panel>
      ) : null}

      {pendingInvite ? (
        <JoinDisclosureDialog
          teamName={pendingInvite.team.name}
          busy={joining}
          error={joinError}
          onAccept={acceptInvite}
          onCancel={() => {
            setPendingInvite(null);
            setJoinError(null);
          }}
        />
      ) : null}
    </div>
  );
}
