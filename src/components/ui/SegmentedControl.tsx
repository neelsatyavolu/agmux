import type { LucideIcon } from "lucide-react";

interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** When true, show only icons (no labels). */
  compact?: boolean;
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  compact = false,
}: SegmentedControlProps<T>) {
  return (
    <div className="ui-seg inline-flex items-center gap-px rounded-[10px] border border-white/[0.04] bg-white/[0.02] p-[3px]">
      {segments.map((seg) => {
        const isActive = seg.value === value;
        const Icon = seg.icon;
        return (
          <button
            key={seg.value}
            onClick={() => onChange(seg.value)}
            data-active={isActive ? "true" : undefined}
            className={`ui-seg-item relative flex items-center gap-1.5 rounded-[7px] px-3 py-[5px] text-xs
              cursor-default select-none transition-[background-color,border-color,transform] duration-200
              ${isActive
                ? "font-semibold text-white"
                : "font-medium text-white/30 hover:text-white/50"
              }`}
          >
            {/* Active pill — soft glow behind text */}
            {isActive && (
              <span
                className="ui-seg-pill absolute inset-0 rounded-[7px] bg-white/[0.08] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12),0_1px_3px_rgba(0,0,0,0.2)]"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {Icon && <Icon size={12} />}
              {!compact && seg.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
