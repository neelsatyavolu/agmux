/** Shared Codex-style composer control classes for all chat surfaces. */

export const CBTN =
  "inline-flex h-[29px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-[9px] " +
  "font-sans text-[12px] font-medium tracking-[-0.01em] text-[var(--text-secondary)] whitespace-nowrap " +
  "transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-40";

export const CBTN_SQ =
  "inline-flex h-[29px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-transparent " +
  "text-[var(--text-secondary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--text-primary)] " +
  "disabled:pointer-events-none disabled:opacity-40";

export const CBTN_EFFORT =
  "composer-selector-amber";

export const CBTN_PLAN =
  "composer-selector-violet";

export const CBTN_PERM_FULL =
  "!text-[color:var(--accent)] bg-[var(--accent-dim)] !border-[color:var(--accent-border)] hover:!bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]";

export const CBTN_PERM_AUTO =
  "composer-selector-amber";

export const CBTN_FAST =
  "!text-[color:var(--accent)] bg-[var(--accent-dim)] !border-[color:var(--accent-border)] hover:!bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]";

export const SEND_BTN_ACTIVE =
  "ml-0.5 inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] " +
  "bg-[var(--accent)] text-[#14110a] shadow-[0_4px_16px_-4px_color-mix(in_srgb,var(--accent)_60%,transparent)] " +
  "transition-all duration-150 hover:brightness-110 active:scale-95 disabled:cursor-not-allowed";

export const SEND_BTN_IDLE =
  "ml-0.5 inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] " +
  "bg-white/[0.07] text-white/40 transition-all duration-150 disabled:cursor-not-allowed";

export const STOP_BTN =
  "ml-0.5 inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] " +
  "bg-red-500/20 text-red-400 shadow-[0_4px_16px_-4px_rgba(248,113,113,0.4)] " +
  "transition-all hover:bg-red-500/30 active:scale-95";
