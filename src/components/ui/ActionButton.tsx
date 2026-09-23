import type { LucideIcon } from "lucide-react";

interface ActionButtonProps {
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  size?: number;
  className?: string;
}

export function ActionButton({
  icon: Icon,
  active,
  disabled,
  onClick,
  title,
  size = 14,
  className = "",
}: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded-md p-1.5
        cursor-default select-none transition-[background-color,border-color,transform] duration-200
        ${active
          ? "text-[var(--accent)] bg-[var(--accent)]/[0.08]"
          : `text-white/30
             hover:text-white/60 hover:bg-white/[0.04]
             active:bg-white/[0.06] active:scale-[0.95]`
        }
        disabled:opacity-30 disabled:pointer-events-none
        ${className}`}
    >
      <Icon size={size} />
    </button>
  );
}
