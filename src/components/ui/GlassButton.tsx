import type { LucideIcon } from "lucide-react";

type ButtonSize = "sm" | "md";
type ButtonVariant = "primary" | "ghost" | "accent" | "destructive";

interface GlassButtonProps {
  children: React.ReactNode;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  size?: ButtonSize;
  variant?: ButtonVariant;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-[5px] text-[11px] gap-1",
  md: "px-3 py-[5px] text-xs gap-1.5",
};

export function GlassButton({
  children,
  icon: Icon,
  iconRight: IconRight,
  size = "md",
  variant = "primary",
  active,
  disabled,
  onClick,
  title,
  className = "",
}: GlassButtonProps) {
  const base =
    "relative inline-flex items-center justify-center font-medium rounded-[7px] cursor-default select-none transition-[background-color,border-color,transform] duration-200";

  const variantClass =
    variant === "accent"
      ? `border border-[color:var(--accent-border)] bg-[var(--accent-dim)]
         text-[color:var(--accent)]
         hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] hover:border-[color:var(--accent)]
         active:bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] active:scale-[0.97]
         disabled:opacity-30 disabled:pointer-events-none`
      : variant === "destructive"
      ? `border border-red-500/25 bg-red-500/[0.10]
         text-red-400
         hover:bg-red-500/[0.16] hover:border-red-500/40
         active:bg-red-500/[0.22] active:scale-[0.97]
         disabled:opacity-30 disabled:pointer-events-none`
      : variant === "primary"
      ? `border border-white/[0.06] bg-white/[0.03]
         text-white/50
         hover:text-white/70 hover:bg-white/[0.06] hover:border-white/[0.10]
         active:bg-white/[0.08] active:scale-[0.97]
         disabled:opacity-30 disabled:pointer-events-none`
      : `border border-transparent bg-transparent
         text-white/30
         hover:text-white/50 hover:bg-white/[0.04]
         active:bg-white/[0.06] active:scale-[0.97]
         disabled:opacity-30 disabled:pointer-events-none`;

  const activeClass = active
    ? "border-white/[0.10] bg-white/[0.08] text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.10)]"
    : "";

  const iconSize = size === "sm" ? 11 : 12;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${SIZE_CLASSES[size]} ${variantClass} ${activeClass} ${className}`}
    >
      {Icon && <Icon size={iconSize} />}
      {children}
      {IconRight && <IconRight size={iconSize} />}
    </button>
  );
}
