import { useRef } from "react";
import { X, Eye, Code2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useEditorStore } from "../../stores/editorStore";

/* ── Dock-style colored extension tile ────────────────────────── */
const EXT_COLORS: Record<string, string> = {
  tsx: "#60a5fa",
  ts: "#3b82f6",
  jsx: "#60a5fa",
  js: "#fbbf24",
  css: "#f472b6",
  scss: "#f472b6",
  md: "#94a3b8",
  json: "#fbbf24",
  yaml: "#a78bfa",
  yml: "#a78bfa",
  rs: "#fb923c",
  toml: "#fb923c",
  png: "var(--accent)",
  jpg: "var(--accent)",
  svg: "var(--accent)",
  ico: "var(--accent)",
  sh: "#4ade80",
  py: "#60a5fa",
  go: "#22d3ee",
  html: "#f97316",
};

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function ExtTile({ name }: { name: string }) {
  const ext = getExt(name);
  const c = EXT_COLORS[ext] || "#71717a";
  const label = (ext || "·").slice(0, 3).toUpperCase();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 17,
        height: 13,
        borderRadius: 3,
        background: `color-mix(in oklab, ${c} 14%, transparent)`,
        color: c,
        fontFamily: "var(--font-mono)",
        fontSize: 7.5,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function isMarkdownFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "mdx";
}

export function EditorTabs({ inTitlebar = false }: { inTitlebar?: boolean } = {}) {
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const dirtyFiles = useEditorStore((s) => s.dirtyFiles);
  const rawMode = useEditorStore((s) => s.rawMode);
  const aiEditedFiles = useEditorStore((s) => s.aiEditedFiles);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const toggleRawMode = useEditorStore((s) => s.toggleRawMode);
  const scrollRef = useRef<HTMLDivElement>(null);

  const showMarkdownToggle = activeTabPath && isMarkdownFile(activeTabPath);
  const isRaw = activeTabPath ? rawMode[activeTabPath] === true : false;

  if (openTabs.length === 0) {
    if (inTitlebar) return <div data-tauri-drag-region className="flex-1" />;
    return null;
  }

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region={inTitlebar || undefined}
      className={`flex shrink-0 items-center gap-1 overflow-x-auto scrollbar-none${
        inTitlebar ? "" : " editor-tabs-bar"
      }`}
      style={{
        height: inTitlebar ? undefined : 32,
        flex: inTitlebar ? 1 : undefined,
        padding: "0 8px",
        borderBottom: inTitlebar
          ? undefined
          : "1px solid var(--glass-border)",
        background: inTitlebar ? undefined : "var(--glass-header)",
        backdropFilter: inTitlebar ? undefined : "blur(12px)",
        scrollbarWidth: "none",
      }}
    >
      <div className="flex flex-1 items-center gap-1">
        {openTabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          const isDirty = dirtyFiles[tab.path] === true;
          const isAiEdited = aiEditedFiles[tab.path] != null;

          return (
            <button
              key={tab.path}
              title={tab.path}
              onClick={() => setActiveTab(tab.path)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(tab.path);
                }
              }}
              className="group relative flex shrink-0 items-center gap-1.5 transition-colors"
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                background: isActive
                  ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                  : "transparent",
                border: `1px solid ${
                  isActive ? "color-mix(in srgb, var(--accent) 25%, transparent)" : "transparent"
                }`,
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              }}
              onMouseEnter={(e) => {
                if (!isActive)
                  e.currentTarget.style.background = "var(--glass-hover, rgba(255,255,255,0.04))";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              <AnimatePresence>
                {isAiEdited && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                    style={{
                      position: "absolute",
                      right: -4,
                      top: -4,
                      zIndex: 10,
                      background: "#3b82f6",
                      color: "#fff",
                      fontSize: 7,
                      fontWeight: 700,
                      lineHeight: 1,
                      padding: "1px 3px",
                      borderRadius: 9999,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    AI
                  </motion.span>
                )}
              </AnimatePresence>
              <ExtTile name={tab.name} />
              <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tab.name}
              </span>
              {isDirty && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 9999,
                    background: "var(--accent)",
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                role="button"
                aria-label={`Close ${tab.name}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.path);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    closeTab(tab.path);
                  }
                }}
                style={{
                  marginLeft: 2,
                  padding: 1,
                  borderRadius: 3,
                  display: "inline-flex",
                  color: isActive ? "var(--text-secondary)" : "transparent",
                }}
                className="hover:!text-[var(--text-primary)] hover:bg-white/[0.08] group-hover:!text-[var(--text-secondary)]"
              >
                <X size={9} />
              </span>
            </button>
          );
        })}
      </div>
      {showMarkdownToggle && (
        <button
          onClick={() => toggleRawMode(activeTabPath)}
          title={isRaw ? "Switch to preview" : "Switch to raw editor"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            borderRadius: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
            flexShrink: 0,
          }}
        >
          {isRaw ? <Eye size={10} /> : <Code2 size={10} />}
          <span>{isRaw ? "Preview" : "Raw"}</span>
        </button>
      )}
    </div>
  );
}
