import type { KeyboardEvent } from "react";

export interface Choice<T extends string> { value: T; label: string; disabled?: boolean }

/** Compact radio group used in place of native selects on the Accounts tab. */
export function ChoiceGroup<T extends string>({ label, choices, value, onChange, disabled = false }: {
  label: string; choices: Choice<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean;
}) {
  const enabled = choices.filter(choice => !choice.disabled);
  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled || enabled.length === 0) return;
    event.preventDefault();
    const index = enabled.findIndex(choice => choice.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    onChange(next.value);
    (event.currentTarget.querySelector(`[data-value="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="ui-seg inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-[var(--glass-border)] p-1">
      {choices.map(choice => {
        const active = choice.value === value;
        return <button key={choice.value} type="button" role="radio" aria-checked={active} data-value={choice.value}
          data-active={active ? "true" : undefined}
          tabIndex={active ? 0 : -1} disabled={disabled || choice.disabled} onClick={() => onChange(choice.value)}
          className={`ui-choice-item min-h-8 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? "bg-[var(--accent-dim)] text-[var(--accent)]"
            : "text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"}`}>
          {choice.label}
        </button>;
      })}
    </div>
  );
}
