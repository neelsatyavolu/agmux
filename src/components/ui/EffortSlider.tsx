import { useCallback, useRef } from "react";

export interface EffortSliderOption {
  value: string;
  label: string;
}

export interface EffortSliderProps {
  options: EffortSliderOption[];
  /** Currently selected option value. Falls back to the first option. */
  value: string;
  onChange: (value: string) => void;
  /** Caption under the left end of the track. */
  minLabel?: string;
  /** Caption under the right end of the track. */
  maxLabel?: string;
  /**
   * Compact mode for composer toolbars: track only (no header / Faster-Smarter
   * captions). Parent should supply a `title` for the current value.
   */
  compact?: boolean;
}

/**
 * Discrete effort slider — a filled emerald track with a tick per step and a
 * round knob, in the spirit of a "Faster ↔ Smarter" control.
 *
 * Custom rather than a native `<input type="range">` so the fill, ticks, and
 * knob can share the app's glass language. Keyboard and pointer input are both
 * wired: arrows/Home/End step through options, and clicking or dragging the
 * track snaps to the nearest one.
 */
export function EffortSlider({
  options,
  value,
  onChange,
  minLabel = "Faster",
  maxLabel = "Smarter",
  compact = false,
}: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const count = options.length;
  const currentIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[currentIndex] ?? options[0];
  // A single-option ladder has no travel; pin the knob to the end.
  const ratio = count > 1 ? currentIndex / (count - 1) : 1;

  const selectIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(count - 1, index));
      const next = options[clamped];
      if (next && next.value !== value) onChange(next.value);
    },
    [count, options, value, onChange],
  );

  const indexFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || count <= 1) return 0;
      const rect = track.getBoundingClientRect();
      if (rect.width === 0) return 0;
      const pct = (clientX - rect.left) / rect.width;
      return Math.round(pct * (count - 1));
    },
    [count],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      selectIndex(indexFromClientX(e.clientX));
    },
    [indexFromClientX, selectIndex],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      selectIndex(indexFromClientX(e.clientX));
    },
    [indexFromClientX, selectIndex],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        selectIndex(currentIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        selectIndex(currentIndex - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        selectIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        selectIndex(count - 1);
      }
    },
    [count, currentIndex, selectIndex],
  );

  return (
    <div className={compact ? "px-0.5" : "px-2.5 pb-2.5 pt-1"} data-testid="effort-slider" data-value={value}>
      {!compact && (
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13.5px] font-medium tracking-[-0.015em] text-[var(--text-primary)]">
            {selected?.label}
          </span>
          <span className="ui-meta text-[10px] text-[var(--text-tertiary)]">
            {currentIndex + 1}/{count}
          </span>
        </div>
      )}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={currentIndex + 1}
        aria-valuetext={selected?.label}
        title={selected ? `Reasoning effort: ${value}` : "Reasoning effort"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className="effort-track relative flex h-[26px] w-full cursor-pointer touch-none items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
      >
        {/* Filled portion — grows toward "Smarter". Its right edge tracks the
            knob's trailing edge, so at either end the fill lands flush with the
            track instead of leaving a sliver of empty track beside the knob. */}
        <span
          aria-hidden
          className="effort-fill absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 ease-out"
          style={{ width: `calc(20px + ${ratio} * (100% - 20px))` }}
        />

        {/* One tick per step */}
        {options.map((option, i) => {
          const tickRatio = count > 1 ? i / (count - 1) : 1;
          return (
            <span
              key={option.value}
              aria-hidden
              data-filled={i <= currentIndex ? "" : undefined}
              className="effort-tick absolute h-[3px] w-[3px] rounded-full"
              style={{ left: `calc(10px + ${tickRatio} * (100% - 20px))`, transform: "translateX(-50%)" }}
            />
          );
        })}

        {/* Knob */}
        <span
          aria-hidden
          className="effort-knob absolute h-[20px] w-[20px] rounded-full transition-[left] duration-150 ease-out"
          style={{ left: `calc(10px + ${ratio} * (100% - 20px))`, transform: "translateX(-50%)" }}
        />
      </div>

      {!compact && (
        <div className="mt-1.5 flex items-center justify-between ui-eyebrow text-[var(--text-tertiary)]">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}
