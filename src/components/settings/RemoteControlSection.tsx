import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import QRCode from "qrcode";
import {
  remoteCreatePairCode,
  remoteGetStatus,
  remoteResetIdentity,
  remoteRevokeAllDevices,
  remoteRevokeDevice,
  remoteSetEnabled,
  remoteSyncSessionNames,
  type RemoteStatus,
} from "../../lib/commands";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionNameStore } from "../../stores/sessionNameStore";
import { GlassButton } from "../ui/GlassButton";

/** Push sidebar titles so the phone list matches desktop names. */
async function pushSessionTitlesForRemote(): Promise<void> {
  const names = useSessionNameStore.getState().names;
  if (Object.keys(names).length === 0) return;
  try {
    await remoteSyncSessionNames(names);
  } catch {
    /* remote optional */
  }
}

function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 flex items-baseline gap-3 border-b border-white/[0.05] pb-4">
      <h1
        className="m-0 text-[26px] font-semibold leading-[1.1] text-[var(--text-primary)]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {title}
      </h1>
      {description ? (
        <span
          className="text-[12.5px] text-[var(--text-muted)]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}

function SettingsCard({
  children,
  className,
  eyebrow,
  title,
  description,
}: {
  children: React.ReactNode;
  className?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
}) {
  const hasHeader = !!(eyebrow || title || description);
  return (
    <div className={`settings-card mb-5 overflow-hidden rounded-xl ${className ?? ""}`}>
      {hasHeader ? (
        <div className="settings-card-header px-6 pb-3.5 pt-[22px]">
          {eyebrow ? (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--accent, #f7ad3c)",
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                marginBottom: 8,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          {title ? (
            <h3
              className="m-0"
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: "var(--text-primary, #fff)",
                letterSpacing: "-0.015em",
              }}
            >
              {title}
            </h3>
          ) : null}
          {description ? (
            <p
              className="m-0 mt-1.5"
              style={{
                fontSize: 12.5,
                color: "var(--text-tertiary, #a1a1aa)",
                lineHeight: 1.55,
                letterSpacing: "-0.01em",
                maxWidth: 560,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="settings-card-rows">{children}</div>
    </div>
  );
}

function SettingsRow({
  label,
  description,
  children,
  stacked,
}: {
  label: React.ReactNode;
  description?: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="settings-row px-6 py-3.5 transition-colors">
        <div className="mb-3">
          <p
            style={{
              fontSize: 13.5,
              color: "var(--text-primary, #fff)",
              letterSpacing: "-0.015em",
              margin: 0,
            }}
          >
            {label}
          </p>
          {description ? (
            <p
              className="mt-[3px]"
              style={{
                fontSize: 12,
                color: "var(--text-muted, #71717a)",
                lineHeight: 1.45,
                letterSpacing: "-0.01em",
                margin: 0,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div className="settings-row flex items-start justify-between gap-6 px-6 py-3.5 transition-colors">
      <div className="min-w-0 flex-1">
        <p
          style={{
            fontSize: 13.5,
            color: "var(--text-primary, #fff)",
            letterSpacing: "-0.015em",
            margin: 0,
          }}
        >
          {label}
        </p>
        {description ? (
          <p
            className="mt-[3px]"
            style={{
              fontSize: 12,
              color: "var(--text-muted, #71717a)",
              lineHeight: 1.45,
              letterSpacing: "-0.01em",
              margin: 0,
            }}
          >
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      role="switch"
      aria-checked={enabled}
      className={`settings-toggle ${enabled ? "settings-toggle-on" : "settings-toggle-off"} relative inline-flex h-[18px] w-8 items-center rounded-full border transition-all`}
      style={{
        background: enabled ? "var(--accent, #f7ad3c)" : undefined,
        borderColor: enabled ? "var(--accent, #f7ad3c)" : undefined,
        boxShadow: enabled ? "0 0 0 4px var(--accent-dim, rgba(247,173,60,0.15))" : "none",
        transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)",
        transitionDuration: "200ms",
      }}
    >
      <span
        className={`settings-toggle-knob ${enabled ? "settings-toggle-knob-on" : "settings-toggle-knob-off"} inline-block h-[14px] w-[14px] rounded-full`}
        style={{
          transform: enabled ? "translateX(15px)" : "translateX(1px)",
          transition: "transform 200ms cubic-bezier(0.16,1,0.3,1)",
        }}
      />
    </button>
  );
}

function formatCountdown(expiresAtMs: number | null | undefined): string | null {
  if (!expiresAtMs) return null;
  const left = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  if (left <= 0) return "expired";
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function formatDeviceWhen(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** High-contrast QR of the auto-pair URL for phone camera scanners. */
function PairQrCode({ url, expired }: { url: string; expired: boolean }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
      color: { dark: "#0a0a0b", light: "#ffffff" },
    })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div
      className="relative mx-auto flex size-[200px] items-center justify-center overflow-hidden rounded-2xl bg-white p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
      style={{ opacity: expired ? 0.4 : 1 }}
      aria-label="QR code — scan with your phone to pair"
    >
      {dataUrl ? (
        <img src={dataUrl} alt="Scan to pair phone" className="size-full object-contain" />
      ) : (
        <Loader2 className="size-6 animate-spin text-zinc-400" />
      )}
      {expired ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
          <span className="rounded-md bg-red-500/90 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
            Expired
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function RemoteControlSection() {
  const remoteEnabled = useSettingsStore((s) => s.settings.remoteControlEnabled ?? false);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [copied, setCopied] = useState<"url" | "id" | "code" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  /** Avoid hammering the relay if auto-pair fails once this mount. */
  const autoPairAttempted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const st = await remoteGetStatus();
      setStatus(st);
      setError(st.lastError);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    listen<RemoteStatus>("remote-status", (ev) => {
      setStatus(ev.payload);
      setError(ev.payload.lastError);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  // Countdown ticker while a pair code is active
  useEffect(() => {
    if (!status?.pairExpiresAt) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [status?.pairExpiresAt, status?.pairCode]);

  const onPair = useCallback(async () => {
    setPairBusy(true);
    setError(null);
    try {
      // Ensure bridge is up (handles race where UI says Online before socket is ready)
      if (remoteEnabled && !status?.connected) {
        await remoteSetEnabled(true);
      }
      const st = await remoteCreatePairCode();
      setStatus(st);
      if (st.lastError) setError(st.lastError);
    } catch (e) {
      setError(String(e));
    } finally {
      setPairBusy(false);
    }
  }, [remoteEnabled, status?.connected]);

  // Auto-mint a pair code once online so the QR is ready without an extra click.
  useEffect(() => {
    if (!remoteEnabled || !status?.connected) {
      if (!status?.connected) autoPairAttempted.current = false;
      return;
    }
    const hasLiveCode =
      !!status.pairCode &&
      !!status.pairExpiresAt &&
      status.pairExpiresAt > Date.now() &&
      !!status.pairUrl;
    if (hasLiveCode || pairBusy || autoPairAttempted.current) return;
    autoPairAttempted.current = true;
    void onPair();
  }, [
    remoteEnabled,
    status?.connected,
    status?.pairCode,
    status?.pairExpiresAt,
    status?.pairUrl,
    pairBusy,
    onPair,
  ]);

  const onToggle = async (v: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateSettings({
        remoteControlEnabled: v,
        ...(v ? { keepAwakeClosedLid: true, keepAwakeWhileRunning: true } : {}),
      });
      const st = await remoteSetEnabled(v);
      setStatus(st);
      if (st.lastError) setError(st.lastError);
      // After enabling, wait briefly then refresh so Online flips when hello.ok lands
      if (v) {
        autoPairAttempted.current = false;
        await pushSessionTitlesForRemote();
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const next = await remoteGetStatus();
          setStatus(next);
          if (next.connected) break;
        }
      }
    } catch (e) {
      setError(String(e));
      updateSettings({ remoteControlEnabled: false });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (kind: "url" | "id" | "code", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  };

  const openPairUrl = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const onRevokeDevice = async (deviceId: string) => {
    setDeviceBusy(deviceId);
    setError(null);
    try {
      const st = await remoteRevokeDevice(deviceId);
      setStatus(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeviceBusy(null);
    }
  };

  const onRevokeAll = async () => {
    if (!window.confirm("Revoke all paired phones? They will need a new pair code.")) return;
    setDeviceBusy("all");
    setError(null);
    try {
      const st = await remoteRevokeAllDevices();
      setStatus(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeviceBusy(null);
    }
  };

  const onResetIdentity = async () => {
    if (
      !window.confirm(
        "Reset remote identity? This creates a new Desktop ID, disconnects all phones, and re-enables remote. Use this if remote is stuck with “invalid desktop token”.",
      )
    ) {
      return;
    }
    setResetBusy(true);
    setError(null);
    try {
      updateSettings({ remoteControlEnabled: true });
      autoPairAttempted.current = false;
      const st = await remoteResetIdentity(true);
      setStatus(st);
      if (st.lastError) setError(st.lastError);
      // Wait for re-enrollment
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const next = await remoteGetStatus();
        setStatus(next);
        if (next.connected) break;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setResetBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  // Desktop id only after hub enrollment (hello.ok) — never shown offline.
  const desktopId = connected ? (status?.desktopId ?? null) : null;
  const pairCode = status?.pairCode ?? null;
  const pairUrl = status?.pairUrl ?? null;
  const devices = status?.devices ?? [];
  const countdown = formatCountdown(status?.pairExpiresAt ?? null);
  const expired = countdown === "expired";
  const hasLivePair = !!pairCode && !!pairUrl && !expired;

  const statusDescription = !remoteEnabled
    ? "Turn on Remote control to connect this Mac to the relay."
    : connected
      ? `Connected · ${status?.threadCount ?? 0} session${(status?.threadCount ?? 0) === 1 ? "" : "s"} available on your phone`
      : status?.lastError
        ? `Connecting… (${status.lastError})`
        : "Connecting to relay…";

  return (
    <div>
      <PageHeader
        title="Remote Control"
        description="Control your coding agents from your phone — chats and terminals from every provider."
      />

      {/* ── 1. Connection (toggle + status) — needed before pair ── */}
      <SettingsCard
        className="mb-5"
        eyebrow="Remote Control"
        title="Connection"
        description="Enable remote control so your phone can reach this Mac over the secure relay."
      >
        <SettingsRow
          label="Remote control"
          description="Keeps the Mac awake (including with the lid closed) while enabled. Install the closed-display helper under General → Behavior if needed."
        >
          <div className="flex items-center gap-2">
            {busy ? <Loader2 className="size-4 animate-spin text-[var(--text-muted)]" /> : null}
            <Toggle enabled={remoteEnabled} onChange={(v) => void onToggle(v)} />
          </div>
        </SettingsRow>

        <SettingsRow label="Status" description={statusDescription}>
          <button
            type="button"
            className="rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-white/5"
            onClick={() => void refresh()}
            title="Refresh status"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              connected
                ? "bg-[var(--accent-dim)] text-[color:var(--accent)]"
                : remoteEnabled
                  ? "bg-white/5 text-[var(--text-muted)]"
                  : "text-[var(--text-muted)]"
            }`}
          >
            {connected ? (
              <>
                <CheckCircle2 className="size-3.5" />
                Online
              </>
            ) : remoteEnabled ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Offline
              </>
            ) : (
              "Off"
            )}
          </span>
        </SettingsRow>
      </SettingsCard>

      {/* ── 2. Pair phone — QR first, main action ── */}
      <SettingsCard
        className="mb-5"
        eyebrow="Remote Control"
        title="Pair phone"
        description={
          connected
            ? "Scan the QR with your phone camera — it opens remote.agmux.dev and pairs automatically."
            : remoteEnabled
              ? "Waiting for the relay connection. Leave Remote control on, then the QR will appear."
              : "Turn on Remote control above, then scan the QR with your phone."
        }
      >
        {!remoteEnabled ? (
          <div className="settings-row flex flex-col items-center gap-3 px-6 py-8 text-center">
            <div
              className="flex size-14 items-center justify-center rounded-2xl"
              style={{ background: "var(--accent-dim, rgba(247,173,60,0.12))" }}
            >
              <Smartphone className="size-6 text-[var(--accent,#f7ad3c)]" />
            </div>
            <p className="m-0 max-w-sm text-[13px] leading-snug text-[var(--text-muted)]">
              Flip the Remote control switch on, wait for Online, then point your phone camera at
              the QR code.
            </p>
          </div>
        ) : !connected ? (
          <div className="settings-row flex flex-col items-center gap-3 px-6 py-8 text-center">
            <Loader2 className="size-7 animate-spin text-[var(--accent,#f7ad3c)]" />
            <p className="m-0 max-w-sm text-[13px] leading-snug text-[var(--text-muted)]">
              Connecting to relay… QR appears when this Mac is Online.
            </p>
          </div>
        ) : (
          <div className="settings-row px-6 py-5">
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:justify-center sm:gap-8">
              {/* QR — primary path */}
              <div className="flex flex-col items-center gap-2.5">
                {hasLivePair || (pairUrl && pairCode) ? (
                  <PairQrCode url={pairUrl!} expired={expired} />
                ) : pairBusy ? (
                  <div className="flex size-[200px] items-center justify-center rounded-2xl bg-white/5">
                    <Loader2 className="size-7 animate-spin text-[var(--text-muted)]" />
                  </div>
                ) : (
                  <div className="flex size-[200px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 bg-white/[0.02]">
                    <QrCode className="size-8 text-[var(--text-muted)]" />
                    <GlassButton
                      size="sm"
                      variant="primary"
                      disabled={pairBusy}
                      onClick={() => void onPair()}
                    >
                      {pairBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <QrCode className="size-3.5" />
                      )}
                      <span className="ml-1.5">Show QR</span>
                    </GlassButton>
                  </div>
                )}
                <p className="m-0 text-center text-[12px] text-[var(--text-muted)]">
                  {expired
                    ? "Code expired — generate a new one"
                    : countdown
                      ? `Expires in ${countdown}`
                      : pairBusy
                        ? "Generating pair code…"
                        : "Point your phone camera here"}
                </p>
              </div>

              {/* Code + actions — secondary path */}
              <div className="flex w-full max-w-[280px] flex-col items-center gap-3 sm:items-start sm:pt-2">
                {pairCode ? (
                  <>
                    <div className="w-full text-center sm:text-left">
                      <div
                        className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
                        style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.14em" }}
                      >
                        Pairing code
                      </div>
                      <div
                        className={`font-mono text-[26px] font-semibold tracking-[0.2em] ${
                          expired ? "text-red-400/90 line-through" : "text-[var(--text-primary)]"
                        }`}
                      >
                        {pairCode}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                      {pairUrl ? (
                        <GlassButton
                          size="sm"
                          variant="primary"
                          disabled={expired}
                          onClick={() => void copy("url", pairUrl)}
                        >
                          {copied === "url" ? (
                            <CheckCircle2 className="size-3.5 text-[color:var(--accent)]" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                          <span className="ml-1.5">
                            {copied === "url" ? "Copied" : "Copy link"}
                          </span>
                        </GlassButton>
                      ) : null}
                      <GlassButton
                        size="sm"
                        variant="ghost"
                        disabled={expired}
                        onClick={() => void copy("code", pairCode)}
                      >
                        {copied === "code" ? (
                          <CheckCircle2 className="size-3.5 text-[color:var(--accent)]" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        <span className="ml-1.5">
                          {copied === "code" ? "Copied" : "Copy code"}
                        </span>
                      </GlassButton>
                      {pairUrl ? (
                        <GlassButton
                          size="sm"
                          variant="ghost"
                          disabled={expired}
                          onClick={() => void openPairUrl(pairUrl)}
                        >
                          <ExternalLink className="size-3.5" />
                          <span className="ml-1.5">Open</span>
                        </GlassButton>
                      ) : null}
                      <GlassButton
                        size="sm"
                        variant="ghost"
                        disabled={pairBusy}
                        onClick={() => {
                          autoPairAttempted.current = false;
                          void onPair();
                        }}
                      >
                        {pairBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        <span className="ml-1.5">New code</span>
                      </GlassButton>
                    </div>
                    <p className="m-0 text-center text-[11.5px] leading-snug text-[var(--text-muted)] sm:text-left">
                      Camera app → scan QR, or paste the link in Safari/Chrome on your phone.
                      Pairs in one tap — no typing.
                    </p>
                  </>
                ) : (
                  <p className="m-0 text-center text-[12.5px] leading-snug text-[var(--text-muted)] sm:text-left">
                    {pairBusy
                      ? "Creating a one-time pair link…"
                      : "Generate a code to show the QR."}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {error ? (
          <div className="settings-row border-t border-[var(--glass-border)] px-6 py-3 text-[12px] text-red-400/90">
            {error}
          </div>
        ) : null}
      </SettingsCard>

      {/* ── 3. Paired phones ── */}
      <SettingsCard
        className="mb-5"
        eyebrow="Remote Control"
        title="Paired phones"
        description="Tokens last 90 days. Revoke a device immediately if a phone is lost or shared."
      >
        {devices.length === 0 ? (
          <div className="settings-row px-6 py-4 text-[12.5px] text-[var(--text-muted)]">
            {connected
              ? "No phones paired yet. Scan the QR above with your phone."
              : "Paired phones appear when this Mac is Online."}
          </div>
        ) : (
          <>
            {devices.map((d) => (
              <div
                key={d.id}
                className="settings-row flex items-center justify-between gap-4 px-6 py-3.5"
              >
                <div className="min-w-0">
                  <p className="m-0 text-[13.5px] text-[var(--text-primary)]">
                    {d.label || "Phone"}{" "}
                    <code className="font-mono text-[11px] text-[var(--text-muted)]">
                      {d.tokenPrefix}…
                    </code>
                  </p>
                  <p className="m-0 mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                    Paired {formatDeviceWhen(d.createdAt)} · last seen{" "}
                    {formatDeviceWhen(d.lastSeenAt)} · expires {formatDeviceWhen(d.expiresAt)}
                  </p>
                </div>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  disabled={deviceBusy === d.id || !connected}
                  onClick={() => void onRevokeDevice(d.id)}
                >
                  {deviceBusy === d.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  <span className="ml-1.5">Revoke</span>
                </GlassButton>
              </div>
            ))}
            <div className="settings-row flex justify-end px-6 py-3">
              <GlassButton
                size="sm"
                variant="ghost"
                disabled={deviceBusy === "all" || !connected || devices.length === 0}
                onClick={() => void onRevokeAll()}
              >
                {deviceBusy === "all" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                <span className="ml-1.5">Revoke all</span>
              </GlassButton>
            </div>
          </>
        )}
      </SettingsCard>

      {/* ── 4. Advanced (desktop id / reset) — secondary ── */}
      <SettingsCard
        className="mb-5"
        eyebrow="Remote Control"
        title="Advanced"
        description="Desktop identity details. Prefer the QR or auto-pair link so the code stays out of browser history."
      >
        <SettingsRow
          label="Desktop ID"
          description={
            connected
              ? "Shown only while online. Used if you pair manually on remote.agmux.dev."
              : "Available after this Mac connects to the relay."
          }
        >
          <div className="flex max-w-[240px] items-center gap-1">
            <code className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
              {desktopId ?? (remoteEnabled ? "Connecting…" : "—")}
            </code>
            {desktopId ? (
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-white/5"
                onClick={() => void copy("id", desktopId)}
                title="Copy desktop ID"
              >
                {copied === "id" ? (
                  <CheckCircle2 className="size-3.5 text-[color:var(--accent)]" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          label="Reset identity"
          description="New Desktop ID + secret. Use if remote is stuck with an invalid desktop token. All phones must re-pair."
        >
          <GlassButton
            size="sm"
            variant="ghost"
            disabled={resetBusy}
            onClick={() => void onResetIdentity()}
          >
            {resetBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            <span className="ml-1.5">Reset</span>
          </GlassButton>
        </SettingsRow>
      </SettingsCard>

      {/* ── 5. How it works ── */}
      <SettingsCard
        eyebrow="Remote Control"
        title="How it works"
        description="Three steps from this Mac to your phone."
      >
        <div className="settings-row space-y-0 px-6 py-4">
          {[
            {
              step: "1",
              title: "Turn on Remote control",
              body: "This Mac connects to the relay and stays reachable while enabled.",
            },
            {
              step: "2",
              title: "Scan the QR with your phone",
              body: "Camera opens remote.agmux.dev and pairs automatically — or copy the link.",
            },
            {
              step: "3",
              title: "Chat from anywhere",
              body: "Open any chat or terminal session on your phone — it keeps running on this Mac.",
            },
          ].map((item, i, arr) => (
            <div
              key={item.step}
              className={`flex gap-3 ${i < arr.length - 1 ? "mb-4 pb-4 border-b border-[var(--glass-border)]" : ""}`}
            >
              <div
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                style={{
                  background: "var(--accent-dim, rgba(247,173,60,0.15))",
                  color: "var(--accent, #f7ad3c)",
                }}
              >
                {item.step}
              </div>
              <div className="min-w-0 pt-0.5">
                <p
                  className="m-0 text-[13.5px] text-[var(--text-primary)]"
                  style={{ letterSpacing: "-0.015em" }}
                >
                  {item.title}
                </p>
                <p
                  className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]"
                  style={{ letterSpacing: "-0.01em" }}
                >
                  {item.body}
                </p>
              </div>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
            <Smartphone className="size-3.5 shrink-0" />
            <span>
              PWA: <span className="text-[var(--text-secondary)]">remote.agmux.dev</span>
            </span>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
