// Page chrome shared by the standalone settings sections, matching the
// PageHeader / SettingsCard / SettingsRow / Toggle primitives in SettingsDialog.

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 flex items-baseline gap-3 border-b border-white/[0.05] pb-4">
      <h1
        className="m-0 text-[26px] font-semibold leading-[1.1] text-[var(--text-primary)]"
        style={{ letterSpacing: "-0.02em" }}
      >
        {title}
      </h1>
      {description ? (
        <span
          className="text-[12.5px] text-[var(--text-muted)]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}

export function SettingsCard({
  children,
  className,
  eyebrow,
  title,
  description,
}: {
  children: React.ReactNode;
  className?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
}) {
  const hasHeader = !!(eyebrow || title || description);
  return (
    <div className={`settings-card mb-5 overflow-hidden rounded-xl ${className ?? ""}`}>
      {hasHeader ? (
        <div className="settings-card-header px-6 pb-3.5 pt-[22px]">
          {eyebrow ? (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--accent, #f7ad3c)",
                textTransform: "uppercase",
                letterSpacing: "0.2em",
                marginBottom: 8,
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          {title ? (
            <h3
              className="m-0"
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: "var(--text-primary, #fff)",
                letterSpacing: "-0.015em",
              }}
            >
              {title}
            </h3>
          ) : null}
          {description ? (
            <p
              className="m-0 mt-1.5"
              style={{
                fontSize: 12.5,
                color: "var(--text-tertiary, #a1a1aa)",
                lineHeight: 1.55,
                letterSpacing: "-0.01em",
                maxWidth: 560,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="settings-card-rows">{children}</div>
    </div>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  stacked,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  stacked?: boolean;
}) {
  const labelText = (
    <p
      style={{
        fontSize: 13.5,
        color: "var(--text-primary, #fff)",
        letterSpacing: "-0.015em",
        margin: 0,
      }}
    >
      {label}
    </p>
  );
  const descriptionText = description ? (
    <p
      className="mt-[3px]"
      style={{
        fontSize: 12,
        color: "var(--text-muted, #71717a)",
        lineHeight: 1.45,
        letterSpacing: "-0.01em",
        margin: 0,
      }}
    >
      {description}
    </p>
  ) : null;
  if (stacked) {
    return (
      <div className="settings-row px-6 py-3.5 transition-colors">
        <div className={children ? "mb-3" : undefined}>
          {labelText}
          {descriptionText}
        </div>
        {children ? <div>{children}</div> : null}
      </div>
    );
  }
  return (
    <div className="settings-row flex items-start justify-between gap-6 px-6 py-3.5 transition-colors">
      <div className="min-w-0 flex-1">
        {labelText}
        {descriptionText}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function Toggle({
  enabled,
  onChange,
  disabled,
  label,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      aria-label={label}
      aria-pressed={enabled}
      role="switch"
      aria-checked={enabled}
      className={`settings-toggle ${enabled ? "settings-toggle-on" : "settings-toggle-off"} relative inline-flex h-[18px] w-8 items-center rounded-full border transition-all disabled:opacity-50`}
      style={{
        background: enabled ? "var(--accent, #f7ad3c)" : undefined,
        borderColor: enabled ? "var(--accent, #f7ad3c)" : undefined,
        boxShadow: enabled ? "0 0 0 4px var(--accent-dim, rgba(247,173,60,0.15))" : "none",
        transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)",
        transitionDuration: "200ms",
      }}
    >
      <span
        className={`settings-toggle-knob ${enabled ? "settings-toggle-knob-on" : "settings-toggle-knob-off"} inline-block h-[14px] w-[14px] rounded-full`}
        style={{
          transform: enabled ? "translateX(15px)" : "translateX(1px)",
          transition: "transform 200ms cubic-bezier(0.16,1,0.3,1)",
        }}
      />
    </button>
  );
}
