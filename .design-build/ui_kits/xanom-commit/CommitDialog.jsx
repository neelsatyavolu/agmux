/* global React, lucide */
// CommitDialog — UI-kit "standard" variant (A).
// Mirrors the real shipping dialog at src/components/thread/CommitDialog.tsx.
// Tokens, subcomponents, and visual grammar preserved; fields/labels/options
// aligned to the real component (no amend/sign/push-after toggles, no
// author/co-author row — those do not exist in the shipping dialog).

const {
  X,
  GitCommitHorizontal,
  GitBranch,
  ArrowUp,
  GitPullRequest,
  Check,
  Sparkles,
  Pencil,
  Plus,
  Minus,
  ArrowRightLeft,
} = lucide;

// Visual tokens — emerald accent + add/del/mod/ren semantic colors.
const cdTok = {
  accent: "#34d399",
  accentDim: "rgba(52,211,153,0.15)",
  accentBd: "rgba(52,211,153,0.40)",
  add: "#34d399",
  del: "#f87171",
  mod: "#60a5fa",
  ren: "#a78bfa",
  fg: {
    pri: "rgba(255,255,255,0.95)",
    sec: "rgba(255,255,255,0.72)",
    ter: "rgba(255,255,255,0.55)",
    mut: "rgba(255,255,255,0.40)",
    sub: "rgba(255,255,255,0.28)",
  },
  bd: {
    sub: "rgba(255,255,255,0.06)",
    def: "rgba(255,255,255,0.10)",
    str: "rgba(255,255,255,0.16)",
  },
};

const SUBJECT_LIMIT = 72;

const cdGlassBtn = {
  padding: "7px 12px",
  borderRadius: 7,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  color: "rgba(255,255,255,0.75)",
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

const cdGlassBtnPrimary = {
  ...cdGlassBtn,
  background: cdTok.accentDim,
  border: `1px solid ${cdTok.accentBd}`,
  color: cdTok.accent,
};

function CdKbd({ children }) {
  return (
    <kbd
      style={{
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 4,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "rgba(255,255,255,0.65)",
        lineHeight: 1.4,
      }}
    >
      {children}
    </kbd>
  );
}

function statusMeta(status) {
  const s = String(status).toLowerCase();
  if (s === "added" || s.startsWith("a") || s === "untracked" || s === "??") {
    return { icon: Plus, color: cdTok.add, letter: "A" };
  }
  if (s === "deleted" || s.startsWith("d")) {
    return { icon: Minus, color: cdTok.del, letter: "D" };
  }
  if (s === "renamed" || s.startsWith("r")) {
    return { icon: ArrowRightLeft, color: cdTok.ren, letter: "R" };
  }
  return { icon: Pencil, color: cdTok.mod, letter: "M" };
}

function CdEyebrow({ children, right }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 4px 8px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)",
          color: cdTok.fg.mut,
          textTransform: "uppercase",
          letterSpacing: "0.2em",
        }}
      >
        {children}
      </div>
      {right}
    </div>
  );
}

function CdFileRow({ file, staged, onToggle }) {
  const meta = statusMeta(file.status);
  const total = file.added + file.removed || 1;
  const addPct = (file.added / total) * 100;
  const [hover, setHover] = React.useState(false);
  const bg = staged
    ? "rgba(52,211,153,0.04)"
    : hover
      ? "rgba(255,255,255,0.03)"
      : "transparent";

  const dirPart = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/") + 1)
    : "";
  const namePart = file.path.includes("/")
    ? file.path.slice(file.path.lastIndexOf("/") + 1)
    : file.path;

  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        borderRadius: 6,
        userSelect: "none",
        cursor: "pointer",
        background: bg,
        transition: "background 120ms cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 4,
          flexShrink: 0,
          background: staged ? cdTok.accent : "rgba(0,0,0,0.35)",
          border: `1px solid ${staged ? cdTok.accentBd : cdTok.bd.def}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 120ms cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {staged && <Check size={10} color="#0a0a0b" strokeWidth={3} />}
      </span>
      <input type="checkbox" checked={staged} onChange={onToggle} style={{ display: "none" }} />

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
        <span style={{ color: cdTok.fg.mut }}>{dirPart}</span>
        <span style={{ color: staged ? "#fff" : cdTok.fg.sec }}>{namePart}</span>
      </span>

      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: cdTok.add }}>
        +{file.added}
      </span>
      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10, color: cdTok.del }}>
        −{file.removed}
      </span>
      <div
        style={{
          width: 36,
          height: 3,
          background: "rgba(239,68,68,0.30)",
          borderRadius: 9999,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div style={{ width: `${addPct}%`, height: "100%", background: cdTok.add }} />
      </div>
    </label>
  );
}

function CdSubjectInput({ value, onChange }) {
  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Commit summary — leave blank to autogenerate"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "11px 62px 11px 14px",
          background: "rgba(0,0,0,0.30)",
          border: `1px solid ${cdTok.bd.def}`,
          borderRadius: 8,
          color: "#fff",
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
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 10.5,
          color: value.length > SUBJECT_LIMIT ? cdTok.del : cdTok.fg.mut,
        }}
      >
        {value.length}/{SUBJECT_LIMIT}
      </span>
    </div>
  );
}

function CdBodyInput({ value, onChange }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={"Optional extended description\n\nUse conventional commit format: type(scope): summary"}
      rows={5}
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: "10px 12px",
        background: "rgba(0,0,0,0.25)",
        border: `1px solid ${cdTok.bd.sub}`,
        borderRadius: 8,
        color: cdTok.fg.sec,
        fontSize: 12.5,
        fontFamily: "var(--font-mono, monospace)",
        letterSpacing: 0,
        lineHeight: 1.55,
        outline: "none",
        resize: "vertical",
      }}
    />
  );
}

function CommitDialog({
  files = [],
  subject: subjectProp = "",
  body: bodyProp = "",
  branch = "main",
  onClose = () => {},
}) {
  const [subject, setSubject] = React.useState(subjectProp);
  const [body, setBody] = React.useState(bodyProp);
  const [stagedIds, setStagedIds] = React.useState(() => new Set(files.map((f) => f.path)));
  const [isGenerating, setIsGenerating] = React.useState(false);

  const stagedCount = stagedIds.size;
  const allStaged = files.length > 0 && stagedCount === files.length;
  const isOnMainOrMaster = branch === "main" || branch === "master";

  const totals = React.useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      if (!stagedIds.has(f.path)) continue;
      add += f.added;
      del += f.removed;
    }
    return { add, del };
  }, [files, stagedIds]);

  const toggleFile = (p) =>
    setStagedIds((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const toggleAll = () =>
    setStagedIds((prev) =>
      prev.size === files.length ? new Set() : new Set(files.map((f) => f.path)),
    );

  const canCommit = stagedCount > 0 && !isGenerating;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <style>{`@keyframes cd-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
      <div
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "86vh",
          background: "rgba(12,12,14,0.82)",
          backdropFilter: "blur(24px) saturate(140%)",
          WebkitBackdropFilter: "blur(24px) saturate(140%)",
          border: `1px solid ${cdTok.bd.def}`,
          borderRadius: 14,
          boxShadow:
            "0 20px 50px -10px rgba(0,0,0,0.50), 0 0 0 1px rgba(255,255,255,0.02) inset",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${cdTok.bd.sub}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 7,
              background: "rgba(52,211,153,0.10)",
              border: "1px solid rgba(52,211,153,0.24)",
              color: cdTok.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <GitCommitHorizontal size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "#fff",
                letterSpacing: "-0.015em",
              }}
            >
              Commit changes
            </div>
            <div
              style={{
                fontSize: 10.5,
                color: cdTok.fg.mut,
                fontFamily: "var(--font-mono, monospace)",
                marginTop: 2,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <GitBranch size={10} />
                {branch}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close commit dialog"
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
              color: cdTok.fg.ter,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 16px" }}>
          {/* Message */}
          <CdEyebrow
            right={
              <button
                onClick={() => {
                  setIsGenerating(true);
                  setTimeout(() => setIsGenerating(false), 900);
                }}
                disabled={isGenerating}
                style={{
                  ...cdGlassBtn,
                  padding: "3px 9px",
                  fontSize: 10.5,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  minWidth: 128,
                  justifyContent: "center",
                  background: "rgba(52,211,153,0.06)",
                  borderColor: "rgba(52,211,153,0.22)",
                  color: cdTok.accent,
                  opacity: isGenerating ? 0.5 : 1,
                  cursor: isGenerating ? "wait" : "pointer",
                }}
              >
                <Sparkles size={10} />
                <span>{isGenerating ? "Generating…" : "Generate from diff"}</span>
              </button>
            }
          >
            Message
          </CdEyebrow>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <CdSubjectInput value={subject} onChange={setSubject} />
            <CdBodyInput value={body} onChange={setBody} />
          </div>

          {/* Uncommitted changes */}
          <CdEyebrow
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 10,
                    color: cdTok.fg.mut,
                  }}
                >
                  {stagedCount}/{files.length} files ·{" "}
                  <span style={{ color: cdTok.add }}>+{totals.add}</span>{" "}
                  <span style={{ color: cdTok.fg.sub }}>/</span>{" "}
                  <span style={{ color: cdTok.del }}>−{totals.del}</span>
                </span>
                <button
                  onClick={toggleAll}
                  disabled={files.length === 0}
                  style={{ ...cdGlassBtn, padding: "3px 9px", fontSize: 10.5 }}
                >
                  {allStaged ? "Unstage all" : "Stage all"}
                </button>
              </div>
            }
          >
            Uncommitted changes
          </CdEyebrow>

          <div
            style={{
              background: "rgba(0,0,0,0.25)",
              border: `1px solid ${cdTok.bd.sub}`,
              borderRadius: 10,
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
                  color: cdTok.fg.mut,
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                No uncommitted changes
              </div>
            ) : (
              files.map((f) => (
                <CdFileRow
                  key={f.path}
                  file={f}
                  staged={stagedIds.has(f.path)}
                  onToggle={() => toggleFile(f.path)}
                />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: `1px solid ${cdTok.bd.sub}`,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10.5,
              color: cdTok.fg.mut,
              fontFamily: "var(--font-mono, monospace)",
              marginRight: "auto",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                display: "block",
                width: 5,
                height: 5,
                flexShrink: 0,
                borderRadius: 9999,
                background: cdTok.accent,
                animation: "cd-pulse 1.6s cubic-bezier(0.16,1,0.3,1) infinite",
              }}
            />
            {stagedCount > 0 ? "Pre-commit hooks will run" : "Existing commits will be pushed"}
          </div>
          <button onClick={onClose} style={cdGlassBtn}>
            Cancel
          </button>
          <button
            disabled={!canCommit}
            style={{
              ...cdGlassBtnPrimary,
              padding: "8px 14px",
              opacity: canCommit ? 1 : 0.35,
              pointerEvents: canCommit ? "auto" : "none",
            }}
          >
            <GitCommitHorizontal size={13} />
            {stagedCount > 0 ? `Commit (${stagedCount})` : "Commit"}
            <CdKbd>⌘↵</CdKbd>
          </button>
          <button
            disabled={!canCommit}
            style={{
              ...cdGlassBtnPrimary,
              padding: "8px 14px",
              opacity: canCommit ? 1 : 0.35,
              pointerEvents: canCommit ? "auto" : "none",
            }}
          >
            <ArrowUp size={13} />
            {stagedCount > 0 ? "Commit + Push" : "Push"}
          </button>
          {!isOnMainOrMaster && (
            <button
              disabled={!canCommit}
              title="Commits, pushes, and opens a pull request"
              style={{
                ...cdGlassBtnPrimary,
                padding: "8px 14px",
                opacity: canCommit ? 1 : 0.35,
                pointerEvents: canCommit ? "auto" : "none",
              }}
            >
              <GitPullRequest size={13} />
              Create PR
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Retained for proposal variants B/C (not used by the standard dialog,
   which mirrors the real app's CommitDialog — no amend/sign/author UI). ── */
const CdAuthorRow = ({ author, coAuthors }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
    <div style={{
      width: 22, height: 22, borderRadius: 5,
      background: "linear-gradient(135deg, #34d399, #059669)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 10, fontWeight: 700, color: "#0a0a0b", flexShrink: 0,
    }}>{author.initial}</div>
    <span style={{ fontSize: 12, color: cdTok.fg.sec, letterSpacing: "-0.015em" }}>{author.name}</span>
    <span style={{ fontSize: 11, color: cdTok.fg.mut, fontFamily: "var(--font-mono)" }}>{author.email}</span>
    {coAuthors.length > 0 && (
      <>
        <span style={{ color: cdTok.fg.sub, margin: "0 4px" }}>·</span>
        <span style={{
          fontSize: 10.5, fontFamily: "var(--font-mono)",
          color: cdTok.fg.mut, textTransform: "uppercase", letterSpacing: "0.15em",
        }}>Co-authored by</span>
        <div style={{ display: "flex" }}>
          {coAuthors.map((c, i) => (
            <div key={i} title={`${c.name} <${c.email}>`} style={{
              width: 18, height: 18, borderRadius: 4,
              background: c.color, border: "1.5px solid #0a0a0b",
              marginLeft: i === 0 ? 0 : -5,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontWeight: 700, color: "#fff", fontFamily: "var(--font-mono)",
            }}>{c.initial}</div>
          ))}
        </div>
      </>
    )}
  </div>
);

const CdToggleTile = ({ active, onToggle, icon, label, detail }) => (
  <button onClick={onToggle} style={{
    padding: "9px 11px", borderRadius: 8,
    background: active ? "rgba(52,211,153,0.08)" : "rgba(0,0,0,0.20)",
    border: `1px solid ${active ? "rgba(52,211,153,0.30)" : cdTok.bd.sub}`,
    color: active ? cdTok.accent : cdTok.fg.ter,
    cursor: "pointer", textAlign: "left",
    display: "flex", flexDirection: "column", gap: 3,
    transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
    fontFamily: "var(--font-sans)",
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <i data-lucide={icon} style={{ width: 11, height: 11 }}></i>
      <span style={{ fontSize: 11.5, fontWeight: 500, letterSpacing: "-0.015em",
        color: active ? "#fff" : cdTok.fg.sec }}>{label}</span>
      <div style={{ flex: 1 }}/>
      <span style={{
        width: 22, height: 12, borderRadius: 9999, flexShrink: 0,
        background: active ? cdTok.accent : "rgba(255,255,255,0.10)",
        position: "relative", transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
      }}>
        <span style={{
          position: "absolute", top: 1.5, left: active ? 11.5 : 1.5,
          width: 9, height: 9, borderRadius: 9999,
          background: active ? "#0a0a0b" : "#a1a1aa",
          transition: "all 150ms cubic-bezier(0.16,1,0.3,1)",
        }}/>
      </span>
    </div>
    <span style={{
      fontSize: 10, fontFamily: "var(--font-mono)", color: cdTok.fg.mut, letterSpacing: 0,
    }}>{detail}</span>
  </button>
);

Object.assign(window, {
  CommitDialog,
  CdFileRow,
  CdSubjectInput,
  CdBodyInput,
  CdEyebrow,
  CdKbd,
  CdToggleTile,
  CdAuthorRow,
  cdTok,
});
