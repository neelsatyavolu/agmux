import { ReactNode } from "react";
import { motion } from "framer-motion";

/**
 * Shared composer / "more" dropdown primitives styled after the agmux design system.
 * All popovers share: translucent glass, subtle white border, inset highlight, strong shadow,
 * mono-uppercase header with optional ⌘-kbd hint, faint dividers, rounded rows.
 */

export const dropdownVariants = {
  hidden: { opacity: 0, y: 4, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.12 } },
  exit: { opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.08 } },
};

interface DropdownPopoverProps {
  children: ReactNode;
  className?: string;
  /** When true, renders the little arrow tail at the bottom-left pointing to the trigger. */
  withArrow?: boolean;
  style?: React.CSSProperties;
}

export function DropdownPopover({ children, className = "", withArrow = false, style }: DropdownPopoverProps) {
  return (
    <motion.div
      variants={dropdownVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={style}
      className={
        "composer-popover relative overflow-hidden rounded-xl p-1 " +
        "border border-white/[0.09] " +
        "backdrop-blur-2xl backdrop-saturate-150 " +
        "shadow-[0_28px_60px_-12px_rgba(0,0,0,0.70),0_0_0_1px_rgba(0,0,0,0.40),inset_0_0.5px_0_rgba(255,255,255,0.08)] " +
        className
      }
    >
      {/* Accent wash across the top edge — ties the popover to the app's
          emerald glass instead of reading as a flat gray sheet. */}
      <span aria-hidden className="composer-popover-wash" />
      {withArrow && (
        <span
          aria-hidden
          className="absolute -bottom-[5px] left-6 h-2.5 w-2.5 rotate-45 border-b border-r border-white/[0.09] bg-[var(--surface-popover-arrow)]"
        />
      )}
      <div className="relative">{children}</div>
    </motion.div>
  );
}

interface DropdownHeaderProps {
  title: string;
  kbd?: string;
}

export function DropdownHeader({ title, kbd }: DropdownHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
      <span className="ui-eyebrow text-zinc-500">{title}</span>
      {kbd && (
        <span className="ui-kbd text-zinc-500 border border-white/[0.06] bg-white/[0.04]">
          {kbd}
        </span>
      )}
    </div>
  );
}

export function DropdownSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="ui-eyebrow text-zinc-600 px-3 pt-2 pb-1">
      {children}
    </div>
  );
}

export function DropdownDivider() {
  return <div className="h-px bg-white/[0.05] my-0.5" />;
}

export interface DropdownRowProps {
  onClick?: () => void;
  selected?: boolean;
  danger?: boolean;
  disabledReason?: string;
  /** Left-side icon or avatar node. */
  icon?: ReactNode;
  /** Primary label. */
  title: ReactNode;
  /** Secondary caption (muted). */
  meta?: ReactNode;
  /** Set when `meta` is a path, branch or command — machine text stays mono. Display labels (default) stay sans. */
  metaMono?: boolean;
  /** Right-side adornment (tag, kbd, check). */
  right?: ReactNode;
  className?: string;
}

export function DropdownRow({
  onClick,
  selected,
  danger,
  disabledReason,
  icon,
  title,
  meta,
  metaMono = false,
  right,
  className = "",
}: DropdownRowProps) {
  const base = "dd-row flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors";
  const color = danger
    ? "text-red-400 hover:bg-red-500/[0.06]"
    : selected
    ? "bg-[var(--accent-dim)] text-white"
    : "text-zinc-200 hover:bg-white/[0.04]";
  return (
    <button type="button" onClick={onClick} disabled={!!disabledReason} title={disabledReason} data-selected={selected ? "true" : undefined} className={`${base} ${color} ${className} disabled:opacity-50`}>
      {icon && <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center">{icon}</span>}
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] font-medium tracking-[-0.015em] leading-tight truncate">{title}</span>
        {disabledReason && <span className="mt-0.5 block text-[10.5px] text-[var(--text-secondary)]">{disabledReason}</span>}
        {meta && (
          <span className={`mt-0.5 block truncate text-zinc-500 ${metaMono ? "font-mono text-[10.5px]" : "text-[12px]"}`}>{meta}</span>
        )}
      </span>
      {right && <span className="flex shrink-0 items-center gap-1.5">{right}</span>}
    </button>
  );
}

const FLAT_TONE = { accent: "fx-chip-q", emerald: "fx-chip-q", violet: "fx-soft-violet", amber: "fx-soft-gold" } as const;

/** Small pill tag ("Rec", "New"). */
export function DropdownTag({ children, variant = "accent" }: { children: ReactNode; variant?: "accent" | "emerald" | "violet" | "amber" }) {
  const map: Record<string, string> = {
    accent: "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]",
    // legacy alias — brand chrome follows theme accent
    emerald: "bg-[var(--accent-dim)] border-[color:var(--accent-border)] text-[color:var(--accent)]",
    violet: "bg-violet-400/10 border-violet-400/20 text-violet-400",
    amber: "bg-amber-400/10 border-amber-400/20 text-amber-400",
  };
  return (
    <span className={`ui-chip sm border ${map[variant]} ${FLAT_TONE[variant]}`}>
      {children}
    </span>
  );
}

/** Inline keybinding pill. */
export function DropdownKbd({ children }: { children: ReactNode }) {
  return (
    <span className="ui-kbd text-zinc-500 border border-white/[0.06] bg-white/[0.04]">
      {children}
    </span>
  );
}

/** Footer action row (settings-like, single line, muted, top-divider). */
export function DropdownFooterAction({ icon, children, onClick }: { icon?: ReactNode; children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 -mb-1 mt-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 border-t border-white/[0.05] px-3 py-2.5 text-[12px] tracking-[-0.015em] text-zinc-400 hover:bg-white/[0.03] hover:text-white transition-colors"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

/** Five-step reasoning bars (Low..Max). `level` 1-5 determines how many are lit.
 *  Lit bars carry `data-lit` so tests can assert on state, not a color class. */
export function EffortBars({ level }: { level: 1 | 2 | 3 | 4 | 5 | 6 }) {
  // Six bars so GPT-5.6 Max / Ultra can show a step above Extra High.
  const heights = ["h-[3px]", "h-[5px]", "h-[7px]", "h-[9px]", "h-[11px]", "h-[13px]"];
  return (
    <span className="inline-flex h-[13px] items-end gap-[2px]">
      {heights.map((h, i) => {
        const lit = i < level;
        return (
          <span
            key={i}
            data-lit={lit ? "" : undefined}
            className={`${h} w-[3px] rounded-[1px] transition-colors duration-200 ${
              lit
                ? "bg-[var(--accent)] shadow-[0_0_6px_-1px_var(--accent)]"
                : "bg-white/[0.14]"
            }`}
          />
        );
      })}
    </span>
  );
}

/** Selected rail for the left edge of a selected stepped row. */
export function SelectedRail() {
  return (
    <span
      aria-hidden
      className="absolute -left-0.5 bottom-2 top-2 w-[2px] rounded-full bg-[var(--accent)] shadow-[0_0_8px_-1px_var(--accent)]"
    />
  );
}
