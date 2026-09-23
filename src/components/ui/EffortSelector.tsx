import { useEffect, useRef, useState } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { DropdownPopover, DropdownHeader } from "./ComposerDropdown";
import { EffortSlider, type EffortSliderOption } from "./EffortSlider";

export interface EffortSelectorProps {
  options: EffortSliderOption[];
  value: string;
  onChange: (value: string) => void;
  /** Popover title. */
  title?: string;
  /**
   * Visual chrome for the trigger. Defaults to Codex amber effort pill.
   * Pass a full className string to restyle (e.g. Claude PILL_BASE styles).
   */
  triggerClassName?: string;
  /** Optional keyboard shortcut hint on the popover header. */
  kbd?: string;
  /** Caption under the left end of the track. Defaults to Faster. */
  minLabel?: string;
  /** Caption under the right end of the track. Defaults to Smarter. */
  maxLabel?: string;
  /** When true, only show the icon (compact toolbars). */
  iconOnly?: boolean;
  disabled?: boolean;
  /** null/omitted is unrestricted; an empty list disables every option. */
  allowedValues?: readonly string[] | null;
}

const DEFAULT_TRIGGER =
  "inline-flex h-[29px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-[9px] " +
  "font-sans text-[12px] font-medium tracking-[-0.01em] whitespace-nowrap transition-colors " +
  "composer-selector-amber " +
  "disabled:pointer-events-none disabled:opacity-40";

/** Square amber icon trigger used when toolbars go icon-only (narrow chat). */
const ICON_ONLY_TRIGGER =
  "inline-flex h-[29px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-transparent " +
  "composer-selector-amber " +
  "disabled:pointer-events-none disabled:opacity-40";

/**
 * Codex-style effort control: a selector pill that opens a popover with the
 * Faster ↔ Smarter slider. Shared by Codex, Claude, Grok, OpenCode, and Draft.
 */
export function EffortSelector({
  options,
  value,
  onChange,
  title = "Reasoning effort",
  triggerClassName = DEFAULT_TRIGGER,
  kbd,
  minLabel,
  maxLabel,
  iconOnly = false,
  disabled = false,
  allowedValues,
}: EffortSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const available = allowedValues == null ? options : options.filter((o) => allowedValues.includes(o.value));
  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? value;
  // Prefer the dedicated square chrome when icon-only so a custom full-pill
  // triggerClassName doesn't leave empty horizontal padding in narrow toolbars.
  const resolvedTrigger = iconOnly
    ? ICON_ONLY_TRIGGER
    : triggerClassName;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (options.length === 0) return null;

  return (
    <div className="relative" ref={rootRef} data-testid="effort-selector">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={resolvedTrigger}
        title={`Reasoning effort: ${label}`}
        aria-label={`Reasoning effort: ${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Zap size={15} className="shrink-0" />
        {!iconOnly && <span className="whitespace-nowrap">{label}</span>}
        {!iconOnly && (
          <ChevronDown
            size={12}
            className={`-ml-0.5 shrink-0 opacity-45 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 z-50 mb-2"
          style={{ width: 280 }}
          role="dialog"
          aria-label={title}
        >
          <DropdownPopover>
            <DropdownHeader title={title} kbd={kbd} />
            {allowedValues != null && !available.some((o) => o.value === value) && (
              <p className="px-3 py-2 text-xs text-[var(--text-secondary)]">{available.length ? "This choice is blocked by team restrictions. Choose an allowed value." : "No choices are allowed by your team restrictions."}</p>
            )}
            {available.length > 0 && <EffortSlider
              options={available}
              value={value}
              onChange={(next) => {
                onChange(next);
                // Keep the popover open so the user can fine-tune; only
                // outside-click or a second trigger click dismisses it.
              }}
              minLabel={minLabel}
              maxLabel={maxLabel}
            />}
          </DropdownPopover>
        </div>
      )}
    </div>
  );
}
