/**
 * Design screen 14 — first-link disclosure.
 *
 * A blocking modal shown once per team. The accept button stays disabled until
 * the checkbox is ticked: there is no path into a team that skips this.
 */

import { useState } from "react";
import { Shield } from "lucide-react";
import { GlassButton } from "../ui/GlassButton";
import { DisclosureBlock, Pill } from "./primitives";
import { NEVER_SHORT, SHARED_SHORT } from "./disclosureCopy";

export function JoinDisclosureDialog({
  teamName,
  busy,
  error,
  onAccept,
  onCancel,
  onOpenPrivacy,
}: {
  teamName: string;
  busy?: boolean;
  error?: string | null;
  onAccept: () => void;
  onCancel: () => void;
  onOpenPrivacy?: () => void;
}) {
  const [accepted, setAccepted] = useState(false);

  return (
    // Fixed, not absolute: this opens from inside the Settings pane, which is
    // not a positioned ancestor that would contain the overlay correctly.
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(4,4,6,0.62)] p-6 backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Join ${teamName}`}
    >
      <div className="max-h-full w-[min(620px,100%)] overflow-y-auto rounded-[14px] border border-white/[0.10] bg-[rgba(16,16,19,0.92)] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-[24px]">
        <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-[18px] py-[15px]">
          <Shield size={16} className="text-[var(--status-blue)]" />
          <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">Join {teamName}</h3>
          <div className="flex-1" />
          <Pill tone="acc">required</Pill>
        </div>

        <div className="flex flex-col gap-3.5 px-[18px] py-4">
          <p className="m-0 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            Joining turns on metrics upload from this Mac. It stays on while you&apos;re a member.
            Complete list:
          </p>

          <DisclosureBlock
            shared={SHARED_SHORT}
            never={NEVER_SHORT}
            sharedTitle="Shared"
            neverTitle="Never"
          />

          <label className="flex cursor-default items-start gap-2.5 rounded-[10px] border border-white/[0.10] bg-white/[0.02] p-3">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 h-[15px] w-[15px] shrink-0 accent-[#60a5fa]"
            />
            <span className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              I understand what is collected and that the owner and managers of {teamName} can see it
              next to my name.
            </span>
          </label>

          {error ? (
            <p className="m-0 text-[12px] text-[var(--status-red)]">{error}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5 border-t border-white/[0.06] px-[18px] py-[13px]">
          <GlassButton
            variant="accent"
            onClick={onAccept}
            disabled={!accepted || busy}
          >
            {busy ? "Joining…" : "Accept & join"}
          </GlassButton>
          <GlassButton variant="ghost" onClick={onCancel} disabled={busy}>
            Not now
          </GlassButton>
          <div className="flex-1" />
          {onOpenPrivacy ? (
            <button
              onClick={onOpenPrivacy}
              className="text-[12px] text-[var(--status-blue)] underline-offset-2 hover:underline"
            >
              Read full disclosure →
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
