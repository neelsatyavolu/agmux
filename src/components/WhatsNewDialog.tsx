import { useState, useEffect, useCallback } from "react";
import {
  X,
  Sparkles,
  ArrowUpRight,
  Wrench,
  ExternalLink,
  Check,
  type LucideIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getVersion } from "@tauri-apps/api/app";
import agmuxIcon from "../assets/xanom-icon.png";
import { useSettingsStore } from "../stores/settingsStore";

const STORAGE_KEY = "xanom_last_seen_version";
const GITHUB_REPO = "neelsatyavolu/agmux";
const CHANGELOG_URL = `https://github.com/${GITHUB_REPO}/releases`;

type Category = "new" | "improved" | "fixed";

interface ReleaseItem {
  cat: Category;
  title: string;
  body: string;
}

interface ReleaseData {
  version: string;
  prev: string | null;
  date: string;
  tagline: string;
  summary: string;
  items: ReleaseItem[];
}

const CAT_STYLES: Record<
  Category,
  { color: string; bg: string; border: string; label: string; Icon: LucideIcon }
> = {
  new: {
    color: "var(--accent)",
    bg: "color-mix(in srgb, var(--accent) 10%, transparent)",
    border: "color-mix(in srgb, var(--accent) 25%, transparent)",
    label: "New",
    Icon: Sparkles,
  },
  improved: {
    color: "var(--status-blue)",
    bg: "rgba(96,165,250,0.10)",
    border: "rgba(96,165,250,0.22)",
    label: "Improved",
    Icon: ArrowUpRight,
  },
  fixed: {
    color: "var(--status-purple)",
    bg: "rgba(167,139,250,0.10)",
    border: "rgba(167,139,250,0.22)",
    label: "Fixed",
    Icon: Wrench,
  },
};

/** Map a markdown heading like "### New Features" to a category. */
function categoryFromHeading(heading: string): Category {
  const h = heading.toLowerCase();
  if (/(improv|enhanc|perf|speed|fast)/.test(h)) return "improved";
  if (/(fix|bug|patch)/.test(h)) return "fixed";
  return "new";
}

/**
 * Parse a GitHub release body into (tagline, summary, items).
 *
 * Recognised structure:
 *   <optional prelude — first line is tagline, rest is summary>
 *
 *   ### New           ← maps to cat = "new"
 *   - **Title** — body
 *   - [fix] **Title** — body   (per-item override)
 *
 *   ### Improved      ← cat = "improved"
 *   - ...
 *
 *   ### Fixed         ← cat = "fixed"
 *   - ...
 *
 * Headings whose text doesn't match any keyword default to "new", so older
 * releases with feature-named headings still render (all items tagged New).
 */
function parseReleaseBody(body: string): {
  tagline: string;
  summary: string;
  items: ReleaseItem[];
} {
  const items: ReleaseItem[] = [];
  const preLines: string[] = [];
  let currentCat: Category | null = null;
  let sawHeading = false;

  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("<!--")) continue;

    const headingMatch = trimmed.match(/^###\s+(.+)/);
    if (headingMatch) {
      sawHeading = true;
      currentCat = categoryFromHeading(headingMatch[1]);
      continue;
    }

    if (!sawHeading) {
      if (trimmed.length > 0) {
        preLines.push(trimmed.replace(/\*\*(.+?)\*\*/g, "$1"));
      }
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (!bulletMatch || !currentCat) continue;

    let raw = bulletMatch[1];
    let cat: Category = currentCat;

    const overrideMatch = raw.match(/^\[(new|improved|improvement|fix|fixed)\]\s+(.+)/i);
    if (overrideMatch) {
      const o = overrideMatch[1].toLowerCase();
      cat = o.startsWith("fix") ? "fixed" : o.startsWith("improv") ? "improved" : "new";
      raw = overrideMatch[2];
    }

    raw = raw.replace(/\*\*(.+?)\*\*/g, "$1").trim();

    const splitMatch = raw.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    const title = splitMatch ? splitMatch[1].trim() : raw;
    const itemBody = splitMatch ? splitMatch[2].trim() : "";

    items.push({ cat, title, body: itemBody });
  }

  const tagline = preLines[0] ?? "";
  const summary = preLines.slice(1).join(" ");

  return { tagline, summary, items };
}

async function fetchReleaseData(version: string): Promise<ReleaseData | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`,
      { method: "GET", headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      body?: string;
      published_at?: string;
      name?: string;
    };

    const parsed = parseReleaseBody(data.body ?? "");
    let tagline = parsed.tagline;
    if (!tagline && data.name && data.name.toLowerCase() !== `v${version}`.toLowerCase()) {
      tagline = data.name;
    }

    let prev: string | null = null;
    try {
      const listResp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5`,
        { method: "GET", headers: { Accept: "application/vnd.github.v3+json" } },
      );
      if (listResp.ok) {
        const releases = (await listResp.json()) as { tag_name: string }[];
        const idx = releases.findIndex((r) => r.tag_name === `v${version}`);
        if (idx >= 0 && idx + 1 < releases.length) {
          prev = releases[idx + 1].tag_name.replace(/^v/, "");
        }
      }
    } catch {
      /* ignore — prev is optional */
    }

    const date = data.published_at
      ? new Date(data.published_at).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "";

    return {
      version,
      prev,
      date,
      tagline,
      summary: parsed.summary,
      items: parsed.items,
    };
  } catch {
    return null;
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (err) {
    console.error("Failed to open external URL", err);
  }
}

function AgmuxMark({ size = 42 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.27,
        overflow: "hidden",
        border: "1px solid var(--glass-border-highlight)",
        boxShadow:
          "inset 0 0.5px 0 rgba(255,255,255,0.10), 0 4px 14px rgba(0,0,0,0.4), 0 0 40px color-mix(in srgb, var(--accent) 15%, transparent)",
        flexShrink: 0,
      }}
    >
      <img
        src={agmuxIcon}
        alt="agmux"
        width={size}
        height={size}
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
    </div>
  );
}

function DontShowAgain({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        cursor: "pointer",
        userSelect: "none",
        fontSize: 11.5,
        color: "var(--text-muted)",
        letterSpacing: "-0.01em",
      }}
    >
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: 3,
          background: checked ? "color-mix(in srgb, var(--accent) 90%, transparent)" : "var(--glass-card)",
          border:
            "1px solid " + (checked ? "color-mix(in srgb, var(--accent) 100%, transparent)" : "var(--glass-border-highlight)"),
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 150ms",
          flexShrink: 0,
        }}
      >
        {checked && <Check size={9} strokeWidth={3} color="#052e1f" />}
      </span>
      <span>Don't show again for this version</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ display: "none" }}
      />
    </label>
  );
}

export function WhatsNewDialog() {
  const [open, setOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [data, setData] = useState<ReleaseData | null>(null);
  const [dontShow, setDontShow] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getVersion().then(async (version) => {
      if (cancelled) return;
      setAppVersion(version);
      const lastSeen = localStorage.getItem(STORAGE_KEY);
      if (lastSeen === version) return;
      // Wizard (first-run or the rev-3 upgrade pass) owns the screen.
      const settingsState = useSettingsStore.getState();
      if (
        !settingsState.settings.setupWizardCompleted ||
        settingsState.isSetupWizardOpen
      ) {
        return;
      }
      const release = await fetchReleaseData(version);
      if (cancelled) return;
      if (!release) return;
      setData(release);
      // Small delay so the app finishes loading first
      setTimeout(() => {
        if (!cancelled) setOpen(true);
      }, 800);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setOpen(false);
    if (appVersion && dontShow) {
      localStorage.setItem(STORAGE_KEY, appVersion);
    }
  }, [appVersion, dontShow]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  const items = data?.items ?? [];
  const hasItems = items.length > 0;
  const useGrid = items.length > 5;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[9998]"
            style={{
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
            onClick={handleDismiss}
          />
          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-0 z-[9999] flex items-start justify-center overflow-auto"
            style={{ paddingTop: 64, paddingBottom: 40, paddingLeft: 16, paddingRight: 16 }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 620,
                maxWidth: "100%",
                maxHeight: "82vh",
                borderRadius: 14,
                background: "var(--surface-modal)",
                backdropFilter: "blur(24px) saturate(140%)",
                WebkitBackdropFilter: "blur(24px) saturate(140%)",
                border: "1px solid var(--glass-border-highlight)",
                boxShadow:
                  "0 24px 48px -16px rgba(0,0,0,0.28), inset 0 0.5px 0 rgba(255,255,255,0.08)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                color: "var(--text-primary)",
                letterSpacing: "-0.015em",
              }}
            >
              {/* Header — centered, celebratory */}
              <div
                style={{
                  padding: "24px 22px 18px",
                  textAlign: "center",
                  borderBottom: "1px solid var(--hairline)",
                  position: "relative",
                  background:
                    "radial-gradient(ellipse 60% 80% at 50% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%)",
                }}
              >
                <button
                  onClick={handleDismiss}
                  aria-label="Close"
                  style={{
                    position: "absolute",
                    top: 14,
                    right: 14,
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    background: "transparent",
                    border: "1px solid transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "all 150ms",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--surface-2)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <X size={14} />
                </button>

                <div style={{ display: "inline-flex" }}>
                  <AgmuxMark size={48} />
                </div>
                <div
                  className="fx-graphite"
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: "var(--accent)",
                  }}
                >
                  {appVersion ? `agmux v${appVersion}` : "agmux"}
                  {data?.prev && ` · updated from v${data.prev}`}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 22,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    letterSpacing: "-0.02em",
                    lineHeight: 1.25,
                  }}
                >
                  {data?.tagline || "What's New"}
                </div>
                {data?.summary && (
                  <div
                    style={{
                      marginTop: 6,
                      maxWidth: 480,
                      marginLeft: "auto",
                      marginRight: "auto",
                      fontSize: 13,
                      lineHeight: 1.55,
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {data.summary}
                  </div>
                )}
              </div>

              {/* Cards */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 18,
                  display: "grid",
                  gridTemplateColumns: useGrid ? "1fr 1fr" : "1fr",
                  gap: 10,
                }}
              >
                {hasItems ? (
                  items.map((it, i) => {
                    const c = CAT_STYLES[it.cat];
                    const Icon = c.Icon;
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          gap: 12,
                          padding: 14,
                          borderRadius: 12,
                          background: "var(--glass-card)",
                          border: "1px solid var(--glass-border)",
                          transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "var(--surface-1)";
                          e.currentTarget.style.borderColor = "var(--glass-border-highlight)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "var(--glass-card)";
                          e.currentTarget.style.borderColor = "var(--glass-border)";
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 7,
                            background: c.bg,
                            border: `1px solid ${c.border}`,
                            color: c.color,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon size={13} strokeWidth={2} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            className="ui-eyebrow fx-graphite"
                            style={{
                              color: c.color,
                            }}
                          >
                            {c.label}
                          </div>
                          <div
                            style={{
                              marginTop: 3,
                              fontSize: 13,
                              fontWeight: 500,
                              color: "var(--text-secondary)",
                              lineHeight: 1.35,
                            }}
                          >
                            {it.title}
                          </div>
                          {it.body && (
                            <div
                              style={{
                                marginTop: 3,
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: "var(--text-muted)",
                                letterSpacing: "-0.01em",
                              }}
                            >
                              {it.body}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div
                    style={{
                      padding: "14px 0",
                      fontSize: 13,
                      color: "var(--text-tertiary)",
                      textAlign: "center",
                    }}
                  >
                    Bug fixes and improvements.
                  </div>
                )}
              </div>

              {/* Footer */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 18px 12px 22px",
                  borderTop: "1px solid var(--hairline)",
                  background: "var(--glass-card)",
                  flexWrap: "wrap",
                }}
              >
                <DontShowAgain checked={dontShow} onChange={setDontShow} />
                <span style={{ flex: 1 }} />
                {appVersion && data?.date && (
                  <div
                    className="tabular-nums"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 10.5,
                      color: "var(--text-muted)",
                    }}
                  >
                    <span>v{appVersion}</span>
                    <span>·</span>
                    <span>{data.date}</span>
                  </div>
                )}
                <button
                  onClick={() => openExternal(CHANGELOG_URL)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 7,
                    background: "var(--surface-1)",
                    border: "1px solid var(--glass-border)",
                    color: "var(--text-tertiary)",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    letterSpacing: "-0.01em",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--surface-2)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--surface-1)";
                    e.currentTarget.style.color = "var(--text-tertiary)";
                  }}
                >
                  View full changelog
                  <ExternalLink size={11} />
                </button>
                <button
                  onClick={handleDismiss}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 7,
                    background: "color-mix(in srgb, var(--accent) 90%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--accent) 100%, transparent)",
                    color: "#052e1f",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    letterSpacing: "-0.01em",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    boxShadow:
                      "inset 0 0.5px 0 rgba(255,255,255,0.30), 0 1px 3px rgba(0,0,0,0.3)",
                    transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 100%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 90%, transparent)";
                  }}
                >
                  Got it
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
