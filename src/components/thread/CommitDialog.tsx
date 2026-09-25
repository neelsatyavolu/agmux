import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  GitCommitHorizontal,
  GitBranch,
  ArrowUp,
  GitPullRequest,
  Check,
  Loader2,
  Sparkles,
  Pencil,
  Plus,
  Minus,
  ArrowRightLeft,
  ExternalLink,
} from "lucide-react";
import {
  gitStatusSummary,
  getGitCommittedChanges,
  type GitStatusSummary,
} from "../../lib/commands";
import { getWorktreeChanges } from "../../lib/taskCommands";
import type { ChangedFile } from "../../lib/types";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  getCommitOpState,
  hasActiveCommitOp,
  subscribeCommitOp,
  resetCommitOp,
  setCommitSubject,
  setCommitBody,
  setPhase,
  runCommitGenerate,
  runCommit,
  type Action,
} from "./commitOpStore";

interface CommitDialogProps {
  open: boolean;
  onClose: () => void;
  workDir: string;
  /**
   * Hide the "Create PR" footer button. Used in task mode where PR creation
   * lives in its own header button — the commit dialog there should only do
   * commit / commit+push.
   */
  hideCreatePrButton?: boolean;
}

// Visual tokens — foreground/border values use CSS variables so the
// html[data-mode="light"] override system can reach them at runtime.
// Semantic ink keeps its hue while adapting contrast to the current mode.
const TOK = {
  accent: "var(--accent)",
  accentDim: "var(--accent-dim)",
  accentBd: "var(--accent-border)",
  add: "var(--accent)",
  del: "var(--status-red)",
  mod: "var(--status-blue)",
  ren: "var(--status-purple)",
  fg: {
    pri: "var(--commit-fg-pri)",
    sec: "var(--commit-fg-sec)",
    ter: "var(--commit-fg-ter)",
    mut: "var(--commit-fg-mut)",
    sub: "var(--commit-fg-sub)",
  },
  bd: {
    sub: "var(--commit-bd-sub)",
    def: "var(--commit-bd-def)",
    str: "var(--commit-bd-str)",
  },
};

const SUBJECT_LIMIT = 72;

const glassBtn: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 7,
  background: "var(--surface-1)",
  border: "1px solid var(--glass-border)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  letterSpacing: "-0.015em",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
  fontFamily: "var(--font-sans, inherit)",
};

const glassBtnPrimary: React.CSSProperties = {
  ...glassBtn,
  background: TOK.accentDim,
  border: `1px solid ${TOK.accentBd}`,
  color: TOK.accent,
};

// Unified (Flat) look, from the mockup's dialog card: neutral chrome, quiet
// ringed buttons (fx-quiet adds hover/disabled) and the app's status colors
// (A green, M gold, D red). Glass keeps glassBtn / TOK above.
const FLAT_INK = {
  add: "var(--status-green)",
  del: "var(--status-red)",
  mod: "var(--status-amber)",
  ren: "var(--status-purple)",
};

const quietBtn: React.CSSProperties = {
  ...glassBtn,
  height: 28,
  padding: "0 11px",
  borderRadius: 8,
  background: "transparent",
  border: "1px solid transparent",
  boxShadow: "inset 0 0 0 1px var(--ui-rule-2)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "normal",
};

/** Footer-size quiet button (mockup .btn.lg). */
const quietBtnLg: React.CSSProperties = {
  ...quietBtn,
  height: 38,
  padding: "0 16px",
  borderRadius: 11,
  fontSize: 13,
};

/** Size of the gold primary under Flat; its colors come from fx-accent. */
const primaryLg: React.CSSProperties = {
  height: 38,
  padding: "0 16px",
  borderRadius: 11,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "normal",
};

const flatCloseBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  color: "var(--text-tertiary)",
};

/** Header icon tile (mockup .icon-tile): neutral, or a soft status tint. */
function iconTile(tone: "neutral" | "green" | "red"): React.CSSProperties {
  const [background, color] =
    tone === "green"
      ? ["var(--ui-green-soft)", "var(--status-green)"]
      : tone === "red"
        ? ["var(--ui-red-soft)", "var(--status-red)"]
        : ["var(--ui-panel-2)", "var(--text-secondary)"];
  return {
    width: 36,
    height: 36,
    borderRadius: 11,
    background,
    color,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

/** Boxed file list / summary under Flat: canvas well with a hairline ring. */
const flatWell: React.CSSProperties = {
  background: "var(--ui-canvas)",
  border: "1px solid transparent",
  boxShadow: "inset 0 0 0 1px var(--ui-rule)",
  borderRadius: 12,
};

function statusMeta(status: string, flat = false): { icon: typeof Pencil; color: string; letter: string } {
  const ink = flat ? FLAT_INK : TOK;
  const s = status.toLowerCase();
  if (s === "added" || s.startsWith("a") || s === "untracked" || s === "??") {
    return { icon: Plus, color: ink.add, letter: "A" };
  }
  if (s === "deleted" || s.startsWith("d")) {
    return { icon: Minus, color: ink.del, letter: "D" };
  }
  if (s === "renamed" || s.startsWith("r")) {
    return { icon: ArrowRightLeft, color: ink.ren, letter: "R" };
  }
  return { icon: Pencil, color: ink.mod, letter: "M" };
}

/** Eyebrow header — matches ReviewPanel pattern from the design. */
function Eyebrow({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 4px 8px",
      }}
    >
      <div className="ui-eyebrow">
        {children}
      </div>
      {right}
    </div>
  );
}

function FileRow({
  file,
  staged,
  onToggle,
  committed = false,
  flat = false,
}: {
  file: ChangedFile;
  staged: boolean;
  onToggle: () => void;
  /** Unified (Flat) surface look. */
  flat?: boolean;
  /**
   * When true, the file has already been committed (i.e. shown as
   * informational — it will be pushed, not committed again). The row
   * displays a "Committed" badge in place of the staging checkbox.
   */
  committed?: boolean;
}) {
  const meta = statusMeta(file.status, flat);
  const ink = flat ? FLAT_INK : TOK;
  const total = file.added + file.removed || 1;
  const addPct = (file.added / total) * 100;
  const [hover, setHover] = useState(false);
  const bg = flat
    ? hover
      ? "var(--ui-hover)"
      : "transparent"
    : committed
    ? hover
      ? "rgba(255,255,255,0.02)"
      : "transparent"
    : staged
      ? "color-mix(in srgb, var(--accent) 4%, transparent)"
      : hover
        ? "rgba(255,255,255,0.03)"
        : "transparent";

  const dirPart = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const namePart = file.path.includes("/")
    ? file.path.slice(file.path.lastIndexOf("/") + 1)
    : file.path;

  const rowContent = (
    <>
      {committed ? (
        <span
          style={
            flat
              ? {
                  flexShrink: 0,
                  fontSize: 10.5,
                  fontWeight: 650,
                  color: "var(--text-tertiary)",
                  boxShadow: "inset 0 0 0 1px var(--ui-rule-2)",
                  borderRadius: 9999,
                  padding: "0 7px",
                  lineHeight: "18px",
                }
              : {
                  flexShrink: 0,
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 8.5,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "var(--status-purple)",
                  background: "rgba(167,139,250,0.10)",
                  border: "1px solid rgba(167,139,250,0.28)",
                  borderRadius: 4,
                  padding: "1px 5px",
                  textTransform: "uppercase",
                  lineHeight: 1.2,
                }
          }
          title="Already committed — will be pushed, not re-committed"
        >
          Committed
        </span>
      ) : (
        <>
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: flat ? 5 : 4,
              flexShrink: 0,
              background: staged ? TOK.accent : flat ? "transparent" : "var(--glass-card)",
              border: `1px solid ${staged ? TOK.accentBd : flat ? "var(--ui-rule-2)" : TOK.bd.def}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 120ms cubic-bezier(0.16,1,0.3,1)",
            }}
          >
            {staged && <Check size={10} color="var(--accent-foreground)" strokeWidth={3} />}
          </span>
          <input
            type="checkbox"
            checked={staged}
            onChange={onToggle}
            style={{ display: "none" }}
          />
        </>
      )}

      <span
        style={{
          width: 14,
          textAlign: "center",
          flexShrink: 0,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 10,
          fontWeight: 600,
          color: meta.color,
        }}
      >
        {meta.letter}
      </span>

      <span
        style={{
          flex: 1,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 11.5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: TOK.fg.mut }}>{dirPart}</span>
        <span style={{ color: committed ? TOK.fg.ter : staged ? "var(--text-primary)" : TOK.fg.sec }}>
          {namePart}
        </span>
      </span>

      <span
        style={{ fontSize: flat ? 11 : 10, color: ink.add, fontVariantNumeric: "tabular-nums" }}
      >
        +{file.added}
      </span>
      <span
        style={{ fontSize: flat ? 11 : 10, color: ink.del, fontVariantNumeric: "tabular-nums" }}
      >
        −{file.removed}
      </span>
      <div
        style={{
          width: 36,
          height: 3,
          background: flat ? "var(--ui-red-soft)" : "rgba(239,68,68,0.30)",
          borderRadius: 9999,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div style={{ width: `${addPct}%`, height: "100%", background: ink.add }} />
      </div>
    </>
  );

  const sharedStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 10px",
    borderRadius: flat ? 8 : 6,
    userSelect: "none",
    background: bg,
    transition: "background 120ms cubic-bezier(0.16,1,0.3,1)",
  };

  if (committed) {
    return (
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ ...sharedStyle, cursor: "default" }}
      >
        {rowContent}
      </div>
    );
  }

  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...sharedStyle, cursor: "pointer" }}
    >
      {rowContent}
    </label>
  );
}

export function CommitDialog({ open, onClose, workDir, hideCreatePrButton = false }: CommitDialogProps) {
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const overlayLeft = sidebarCollapsed ? 52 : sidebarWidth;
  const flat = (useSettingsStore((s) => s.settings.surfaceStyle) ?? "flat") === "flat";
  const ink = flat ? FLAT_INK : TOK;

  // Op state (subject/body/phase/steps/isGenerating/etc.) is hoisted to a
  // module-level store keyed by workDir so it survives the dialog unmounting
  // mid-operation. Subscribe via useSyncExternalStore so React re-renders
  // whenever the underlying async progresses.
  const subscribe = useCallback(
    (cb: () => void) => subscribeCommitOp(workDir, cb),
    [workDir],
  );
  const getSnapshot = useCallback(() => getCommitOpState(workDir), [workDir]);
  const op = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const {
    subject,
    body,
    isGenerating,
    generateError,
    phase,
    action,
    steps,
    errorMessage,
    commitUrl,
  } = op;

  // Display-only state — fetched fresh on open, never persisted across
  // operations (the user could have made new edits in another tool).
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [committedFiles, setCommittedFiles] = useState<ChangedFile[]>([]);
  const [stagedIds, setStagedIds] = useState<Set<string>>(new Set());

  // Re-fetch git state every time the dialog opens so the file list is fresh.
  // If an operation for this workDir is still in flight (or showing
  // success/error), keep the op state intact — only the display data resets.
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    reqIdRef.current += 1;
    const myReq = reqIdRef.current;

    setStatus(null);
    setStatusError(null);
    setFiles([]);
    setCommittedFiles([]);
    setStagedIds(new Set());

    if (!hasActiveCommitOp(workDir)) {
      resetCommitOp(workDir);
    }

    gitStatusSummary(workDir)
      .then((s) => {
        if (reqIdRef.current === myReq) setStatus(s);
      })
      .catch((e: unknown) => {
        if (reqIdRef.current === myReq) setStatusError(String(e));
      });

    getWorktreeChanges(workDir)
      .then((list) => {
        if (reqIdRef.current !== myReq) return;
        setFiles(list);
        setStagedIds(new Set(list.map((f) => f.path)));
      })
      .catch((e: unknown) => {
        if (reqIdRef.current === myReq) {
          console.warn("[CommitDialog] getWorktreeChanges failed:", e);
        }
      });

    getGitCommittedChanges(workDir)
      .then((list) => {
        if (reqIdRef.current !== myReq) return;
        setCommittedFiles(list);
      })
      .catch((e: unknown) => {
        if (reqIdRef.current === myReq) {
          console.warn("[CommitDialog] getGitCommittedChanges failed:", e);
        }
      });
  }, [open, workDir]);

  const branch = status?.branch ?? "—";
  const isOnMainOrMaster = branch === "main" || branch === "master";

  const stagedCount = stagedIds.size;
  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      if (!stagedIds.has(f.path)) continue;
      add += f.added;
      del += f.removed;
    }
    return { add, del };
  }, [files, stagedIds]);

  // Prefer the snapshot the op captured when it started — those numbers stay
  // stable across success/error views even if `files` were refetched.
  const summaryStagedCount =
    phase === "success" || phase === "error" ? op.stagedCount : stagedCount;
  const summaryTotals =
    phase === "success" || phase === "error" ? op.totals : totals;

  const allStaged = files.length > 0 && stagedCount === files.length;

  const toggleFile = useCallback((p: string) => {
    setStagedIds((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setStagedIds((prev) => {
      if (prev.size === files.length) return new Set();
      return new Set(files.map((f) => f.path));
    });
  }, [files]);

  const runGenerate = useCallback(
    () => runCommitGenerate(workDir),
    [workDir],
  );

  const run = useCallback(
    (a: Action) => {
      if (stagedCount === 0 && a !== "push") return;
      void runCommit({
        workDir,
        action: a,
        branch,
        files,
        stagedIds,
      });
    },
    [workDir, branch, files, stagedIds, stagedCount],
  );

  const handleClose = useCallback(() => {
    // After success/error the user has acknowledged the result — clear the
    // op state so reopening starts fresh.
    if (phase === "success" || phase === "error") {
      resetCommitOp(workDir);
    }
    onClose();
  }, [onClose, phase, workDir]);

  const backToForm = useCallback(() => {
    setPhase(workDir, "form");
  }, [workDir]);

  const openCommitOnGithub = useCallback(async () => {
    if (!commitUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(commitUrl);
    } catch (err) {
      console.warn("[CommitDialog] openUrl failed:", err);
    }
  }, [commitUrl]);

  const progressTitle = (a: Action) =>
    a === "commit"
      ? "Committing changes"
      : a === "push"
        ? "Pushing changes"
      : a === "commit-push"
        ? "Pushing changes"
        : "Creating pull request";

  const successTitle = (a: Action) =>
    a === "commit"
      ? "Changes committed"
      : a === "push"
        ? "Pushed committed changes"
      : a === "commit-push"
        ? "Committed and pushed changes"
        : "Committed and created PR";

  /* ──────────────────────────────── Form view ───────────────────────────── */
  const renderForm = () => {
    const canCommit = stagedCount > 0 && status !== null && !isGenerating;
    const canPushCommitted = committedFiles.length > 0 && status !== null && !isGenerating;
    const pushAction: Action = stagedCount > 0 ? "commit-push" : "push";
    const canPush = stagedCount > 0 ? canCommit : canPushCommitted;

    return (
      <>
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${TOK.bd.sub}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            data-commit-icon=""
            style={
              flat
                ? iconTile("neutral")
                : {
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
                    color: TOK.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }
            }
          >
            <GitCommitHorizontal size={flat ? 17 : 15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className={flat ? "ui-title-d" : undefined}
              style={
                flat
                  ? { color: "var(--text-primary)" }
                  : {
                      fontSize: 15,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      letterSpacing: "-0.015em",
                    }
              }
            >
              Commit changes
            </div>
            <div
              style={{
                fontSize: flat ? 12 : 10.5,
                color: flat ? "var(--text-tertiary)" : TOK.fg.mut,
                marginTop: flat ? 4 : 2,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: flat ? 11.5 : undefined,
                }}
              >
                <GitBranch size={flat ? 11 : 10} />
                {branch}
              </span>
              {statusError && (
                <>
                  <span>·</span>
                  <span style={{ color: TOK.del }}>{statusError}</span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close commit dialog"
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
              color: TOK.fg.ter,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              ...(flat ? flatCloseBtn : {}),
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-2)";
              e.currentTarget.style.borderColor = TOK.bd.sub;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 16px" }}>
          {/* Message */}
          <Eyebrow
            right={
              <button
                onClick={() => void runGenerate()}
                disabled={isGenerating}
                className={flat ? "fx-quiet" : undefined}
                style={
                  flat
                    ? {
                        ...quietBtn,
                        height: 26,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        minWidth: 128,
                        justifyContent: "center",
                        opacity: isGenerating ? 0.5 : 1,
                        cursor: isGenerating ? "wait" : "pointer",
                        position: "relative",
                        zIndex: 1,
                        isolation: "isolate",
                      }
                    : {
                        ...glassBtn,
                        padding: "3px 9px",
                        fontSize: 10.5,
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        minWidth: 128,
                        justifyContent: "center",
                        background: "color-mix(in srgb, var(--accent) 6%, transparent)",
                        borderColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
                        color: TOK.accent,
                        opacity: isGenerating ? 0.5 : 1,
                        cursor: isGenerating ? "wait" : "pointer",
                        position: "relative",
                        zIndex: 1,
                        isolation: "isolate",
                      }
                }
              >
                {isGenerating ? (
                  <Loader2 size={flat ? 12 : 10} className="animate-spin" />
                ) : (
                  <Sparkles size={flat ? 12 : 10} style={flat ? { color: "var(--accent)" } : undefined} />
                )}
                <span>{isGenerating ? "Generating…" : "Generate from diff"}</span>
              </button>
            }
          >
            Message
          </Eyebrow>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ position: "relative" }}>
              <input
                value={subject}
                onChange={(e) => setCommitSubject(workDir, e.target.value)}
                placeholder="Commit summary — leave blank to autogenerate"
                className="fx-input"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "11px 62px 11px 14px",
                  background: "var(--glass-card)",
                  border: `1px solid ${TOK.bd.def}`,
                  borderRadius: flat ? 10 : 8,
                  color: "var(--text-primary)",
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: "var(--font-sans, inherit)",
                  letterSpacing: "-0.015em",
                  outline: "none",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: flat ? 11 : 10.5,
                  fontVariantNumeric: "tabular-nums",
                  color: subject.length > SUBJECT_LIMIT ? TOK.del : TOK.fg.mut,
                }}
              >
                {subject.length}/{SUBJECT_LIMIT}
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setCommitBody(workDir, e.target.value)}
              placeholder={
                "Optional extended description\n\nUse conventional commit format: type(scope): summary"
              }
              rows={5}
              className="fx-input"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                background: "var(--glass-card)",
                border: `1px solid ${TOK.bd.sub}`,
                borderRadius: flat ? 10 : 8,
                color: TOK.fg.sec,
                fontSize: flat ? 13 : 12.5,
                // Flat: the description is prose, so it reads in the UI face.
                fontFamily: flat ? "var(--font-sans, inherit)" : "var(--font-mono, monospace)",
                letterSpacing: 0,
                lineHeight: 1.55,
                outline: "none",
                resize: "vertical",
              }}
            />
            {generateError && (
              <div
                role="alert"
                style={{
                  padding: "7px 10px",
                  background: flat ? "var(--ui-red-soft)" : "rgba(248,113,113,0.07)",
                  border: flat ? "1px solid transparent" : `1px solid rgba(248,113,113,0.28)`,
                  borderRadius: flat ? 8 : 6,
                  fontSize: flat ? 12 : 11.5,
                  color: TOK.del,
                  lineHeight: 1.45,
                  wordBreak: "break-word",
                }}
              >
                {generateError}
              </div>
            )}
          </div>

          {/* Uncommitted changes */}
          <Eyebrow
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    fontSize: flat ? 12 : 10,
                    color: TOK.fg.mut,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {stagedCount}/{files.length} files ·{" "}
                  <span style={{ color: ink.add }}>+{totals.add}</span>{" "}
                  {!flat && (
                    <>
                      <span style={{ color: TOK.fg.sub }}>/</span>{" "}
                    </>
                  )}
                  <span style={{ color: ink.del }}>−{totals.del}</span>
                </span>
                <button
                  onClick={toggleAll}
                  disabled={files.length === 0}
                  className={flat ? "fx-quiet" : undefined}
                  style={flat ? { ...quietBtn, height: 26 } : { ...glassBtn, padding: "3px 9px", fontSize: 10.5 }}
                >
                  {allStaged ? "Unstage all" : "Stage all"}
                </button>
              </div>
            }
          >
            Uncommitted changes
          </Eyebrow>

          <div
            style={{
              background: "var(--glass-card)",
              border: `1px solid ${TOK.bd.sub}`,
              borderRadius: 10,
              ...(flat ? flatWell : {}),
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 1,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {files.length === 0 ? (
              <div
                style={{
                  padding: "18px 10px",
                  textAlign: "center",
                  fontSize: 11.5,
                  color: TOK.fg.mut,
                }}
              >
                {status === null ? "Loading changes…" : "No uncommitted changes"}
              </div>
            ) : (
              files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  staged={stagedIds.has(f.path)}
                  onToggle={() => toggleFile(f.path)}
                  flat={flat}
                />
              ))
            )}
          </div>

          {/* Committed (unpushed) changes — informational only */}
          {committedFiles.length > 0 && (
            <>
              <Eyebrow
                right={
                  <span
                    style={{
                      fontSize: flat ? 12 : 10,
                      color: TOK.fg.mut,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {committedFiles.length} file{committedFiles.length !== 1 ? "s" : ""} ·{" "}
                    <span style={{ color: ink.add }}>
                      +{committedFiles.reduce((n, f) => n + f.added, 0)}
                    </span>{" "}
                    {!flat && (
                      <>
                        <span style={{ color: TOK.fg.sub }}>/</span>{" "}
                      </>
                    )}
                    <span style={{ color: ink.del }}>
                      −{committedFiles.reduce((n, f) => n + f.removed, 0)}
                    </span>
                  </span>
                }
              >
                Committed · unpushed
              </Eyebrow>
              <div
                style={{
                  background: "var(--glass-card)",
                  border: `1px solid ${TOK.bd.sub}`,
                  borderRadius: 10,
                  ...(flat ? flatWell : {}),
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {committedFiles.map((f) => (
                  <FileRow
                    key={`committed:${f.path}`}
                    file={f}
                    staged={false}
                    onToggle={() => {}}
                    committed
                    flat={flat}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${TOK.bd.sub}`,
            background: flat ? "transparent" : "var(--glass-card)",
            display: "flex",
            alignItems: "center",
            gap: flat ? 8 : 10,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: flat ? 12 : 10.5,
              color: TOK.fg.mut,
              marginRight: "auto",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {/* Flat: a quiet static dot — gold means "needs you", and nothing does here. */}
            <span
              className={flat ? undefined : "bg-pausable"}
              style={{
                display: "block",
                width: 5,
                height: 5,
                flexShrink: 0,
                borderRadius: 9999,
                background: flat ? "var(--text-muted)" : TOK.accent,
                animation: flat ? "none" : "cd-pulse 1.6s cubic-bezier(0.16,1,0.3,1) infinite",
              }}
            />
            {stagedCount > 0 ? "Pre-commit hooks will run" : "Existing commits will be pushed"}
          </div>
          <button
            onClick={handleClose}
            className={flat ? "fx-quiet" : undefined}
            style={flat ? quietBtnLg : glassBtn}
          >
            Cancel
          </button>
          <button
            disabled={!canCommit}
            onClick={() => void run("commit")}
            className="fx-accent"
            style={{
              ...glassBtnPrimary,
              padding: "8px 14px",
              ...(flat ? primaryLg : {}),
              opacity: canCommit ? 1 : 0.35,
              pointerEvents: canCommit ? "auto" : "none",
            }}
          >
            <GitCommitHorizontal size={flat ? 14 : 13} />
            {stagedCount > 0 ? `Commit (${stagedCount})` : "Commit"}
          </button>
          <button
            disabled={!canPush}
            onClick={() => void run(pushAction)}
            className={flat ? "fx-quiet" : undefined}
            style={{
              ...(flat ? quietBtnLg : { ...glassBtnPrimary, padding: "8px 14px" }),
              opacity: canPush ? 1 : 0.35,
              pointerEvents: canPush ? "auto" : "none",
            }}
          >
            <ArrowUp size={flat ? 14 : 13} />
            {stagedCount > 0 ? "Commit + Push" : "Push"}
          </button>
          {!isOnMainOrMaster && !hideCreatePrButton && (
            <button
              disabled={!canCommit}
              onClick={() => void run("commit-pr")}
              className={flat ? "fx-quiet" : undefined}
              style={{
                ...(flat ? quietBtnLg : { ...glassBtnPrimary, padding: "8px 14px" }),
                opacity: canCommit ? 1 : 0.35,
                pointerEvents: canCommit ? "auto" : "none",
              }}
              title="Commits, pushes, and opens a pull request"
            >
              <GitPullRequest size={13} />
              Create PR
            </button>
          )}
        </div>
      </>
    );
  };

  /* ──────────────────────── Progress / Success / Error ──────────────────── */
  const renderProgress = () => (
    <div style={{ padding: "24px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div
          style={
            flat
              ? iconTile("neutral")
              : {
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
                  color: TOK.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }
          }
        >
          <GitCommitHorizontal size={18} />
        </div>
        <button
          onClick={handleClose}
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "transparent",
            border: "1px solid transparent",
            color: TOK.fg.ter,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...(flat ? flatCloseBtn : {}),
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div
        className={flat ? "ui-title-d" : undefined}
        style={
          flat
            ? { color: "var(--text-primary)", marginBottom: 6 }
            : { fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }
        }
      >
        {progressTitle(action)}
      </div>
      <div style={{ fontSize: flat ? 12.5 : 11, color: TOK.fg.mut, marginBottom: 18 }}>
        Hold tight, this may take a few moments…
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {s.state === "done" ? (
              <Check size={16} color={flat ? "var(--status-green)" : TOK.accent} />
            ) : s.state === "running" ? (
              <Loader2 size={16} className="animate-spin" color={flat ? "var(--status-blue)" : TOK.fg.ter} />
            ) : (
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 9999,
                  border: `1px solid ${TOK.bd.def}`,
                }}
              />
            )}
            <span
              style={{
                fontSize: 13,
                color: s.state === "pending" ? TOK.fg.mut : TOK.fg.sec,
              }}
            >
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSuccess = () => (
    <>
      {/* Header — mirrors the form header chrome */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${TOK.bd.sub}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={
            flat
              ? iconTile("green")
              : {
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 24%, transparent)",
                  color: TOK.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }
          }
        >
          <Check size={flat ? 17 : 15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className={flat ? "ui-title-d" : undefined}
            style={
              flat
                ? { color: "var(--text-primary)" }
                : {
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    letterSpacing: "-0.015em",
                  }
            }
          >
            {successTitle(action)}
          </div>
          <div
            style={{
              fontSize: flat ? 12 : 10.5,
              color: flat ? "var(--text-tertiary)" : TOK.fg.mut,
              marginTop: flat ? 4 : 2,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: flat ? 11.5 : undefined,
              }}
            >
              <GitBranch size={flat ? 11 : 10} />
              {branch}
            </span>
          </div>
        </div>
        <button
          onClick={handleClose}
          aria-label="Close commit dialog"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "transparent",
            border: "1px solid transparent",
            color: TOK.fg.ter,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...(flat ? flatCloseBtn : {}),
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--surface-2)";
            e.currentTarget.style.borderColor = TOK.bd.sub;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "transparent";
          }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Body — uses the same Eyebrow + boxed-list chrome as the form */}
      <div style={{ padding: "4px 20px 16px" }}>
        <Eyebrow>Summary</Eyebrow>
        <div
          style={{
            background: "var(--glass-card)",
            border: `1px solid ${TOK.bd.sub}`,
            borderRadius: 10,
            ...(flat ? flatWell : {}),
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <span style={{ color: TOK.fg.mut }}>Branch</span>
            <span
              style={{
                color: TOK.fg.sec,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              <GitBranch size={11} color={TOK.fg.mut} />
              {branch}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <span style={{ color: TOK.fg.mut }}>Changes</span>
            <span
              style={{
                color: TOK.fg.sec,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>
                {summaryStagedCount} file{summaryStagedCount !== 1 ? "s" : ""}
              </span>
              {summaryTotals.add > 0 && (
                <span style={{ color: ink.add, fontVariantNumeric: "tabular-nums" }}>+{summaryTotals.add}</span>
              )}
              {summaryTotals.del > 0 && (
                <span style={{ color: ink.del, fontVariantNumeric: "tabular-nums" }}>−{summaryTotals.del}</span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Footer — View commit (left) + Close (right) */}
      <div
        style={{
          padding: "12px 20px",
          borderTop: `1px solid ${TOK.bd.sub}`,
          background: flat ? "transparent" : "var(--glass-card)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: "space-between",
        }}
      >
        {commitUrl ? (
          <button
            type="button"
            onClick={() => void openCommitOnGithub()}
            aria-label="View commit on GitHub"
            className={flat ? "fx-quiet" : undefined}
            style={flat ? quietBtnLg : { ...glassBtn, padding: "8px 14px" }}
          >
            <ExternalLink size={12} />
            View commit
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={handleClose}
          className={flat ? "fx-quiet" : undefined}
          style={flat ? quietBtnLg : { ...glassBtn, padding: "8px 14px" }}
        >
          Close
        </button>
      </div>
    </>
  );

  const renderError = () => (
    <div style={{ padding: "24px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div
          style={
            flat
              ? iconTile("red")
              : {
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "rgba(239,68,68,0.14)",
                  border: "1px solid rgba(239,68,68,0.30)",
                  color: TOK.del,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }
          }
        >
          <X size={18} />
        </div>
        <button
          onClick={handleClose}
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "transparent",
            border: "1px solid transparent",
            color: TOK.fg.ter,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...(flat ? flatCloseBtn : {}),
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div
        className={flat ? "ui-title-d" : undefined}
        style={
          flat
            ? { color: "var(--text-primary)", marginBottom: 10 }
            : { fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }
        }
      >
        Something went wrong
      </div>
      <div
        style={{
          padding: "10px 12px",
          borderRadius: flat ? 10 : 8,
          border: flat ? "1px solid transparent" : "1px solid rgba(239,68,68,0.30)",
          background: flat ? "var(--ui-red-soft)" : "rgba(239,68,68,0.08)",
          color: TOK.del,
          fontSize: 12,
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 16,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {errorMessage}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={backToForm}
          className={flat ? "fx-quiet" : undefined}
          style={
            flat
              ? { ...quietBtnLg, flex: 1, justifyContent: "center" }
              : { ...glassBtn, flex: 1, justifyContent: "center", padding: "10px 14px" }
          }
        >
          Back
        </button>
        <button
          onClick={handleClose}
          className={flat ? "fx-quiet" : undefined}
          style={
            flat
              ? { ...quietBtnLg, flex: 1, justifyContent: "center" }
              : { ...glassBtn, flex: 1, justifyContent: "center", padding: "10px 14px" }
          }
        >
          Close
        </button>
      </div>
    </div>
  );

  return createPortal(
    <AnimatePresence>
      {!open ? null : (
        <motion.div
          key="commit-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          onMouseDown={(e) => {
            // Don't close on backdrop click while an operation is running —
            // generating a message, committing, pushing, or creating a PR.
            // The op state survives close+reopen via commitOpStore, but
            // accidentally dismissing during an in-flight op still hides UI
            // the user wants to see.
            if (
              e.target === e.currentTarget &&
              phase !== "progress" &&
              !isGenerating
            ) {
              handleClose();
            }
          }}
          className="fx-scrim"
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            left: overlayLeft,
            zIndex: 100,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: flat ? "none" : "blur(6px)",
            WebkitBackdropFilter: flat ? "none" : "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <style>{`
            @keyframes cd-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
          `}</style>
          <motion.div
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fx-dialog"
            style={{
              width: "min(720px, 92vw)",
              maxHeight: "86vh",
              background: "var(--surface-commit-dialog)",
              backdropFilter: flat ? "none" : "blur(24px) saturate(140%)",
              WebkitBackdropFilter: flat ? "none" : "blur(24px) saturate(140%)",
              border: `1px solid ${TOK.bd.def}`,
              borderRadius: 20,
              boxShadow:
                "0 20px 50px -10px rgba(0,0,0,0.50), 0 0 0 1px rgba(255,255,255,0.02) inset",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <AnimatePresence mode="wait">
              {phase === "form" && (
                <motion.div
                  key="form"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
                >
                  {renderForm()}
                </motion.div>
              )}
              {phase === "progress" && (
                <motion.div
                  key="progress"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {renderProgress()}
                </motion.div>
              )}
              {phase === "success" && (
                <motion.div
                  key="success"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {renderSuccess()}
                </motion.div>
              )}
              {phase === "error" && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  {renderError()}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
