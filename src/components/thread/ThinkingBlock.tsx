import { useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { CodexThinkRow } from "./tools/codex";

interface ThinkingBlockProps {
  thinking: string;
  onExpand?: () => void;
  /** Optional elapsed-time label shown when collapsed/expanded. */
  elapsed?: string;
  /** True while reasoning is still streaming. Defaults to empty content. */
  streaming?: boolean;
}

/**
 * Reasoning UI shared by Claude SDK / Grok / OpenCode / MLX.
 * Codex-style mono think row with violet collapse body.
 */
export function ThinkingBlock({ thinking, onExpand, elapsed, streaming }: ThinkingBlockProps) {
  const globalShow = useSettingsStore((s) => s.settings.showThinking);
  const [localOverride, setLocalOverride] = useState<boolean | null>(null);
  const open = localOverride ?? globalShow;
  const hasContent = thinking.trim().length > 0;
  const isStreaming = streaming ?? !hasContent;

  const toggle = () => {
    const next = !open;
    setLocalOverride(next);
    useSettingsStore.getState().updateSettings({ showThinking: next });
    if (next) onExpand?.();
  };

  // Streaming with no body yet — still show the row so the turn feels alive.
  if (!hasContent) {
    return (
      <div data-testid="thinking-block" data-streaming="true">
        <CodexThinkRow content="" streaming open={false} onToggle={() => {}} />
        {elapsed ? (
          <div className="mb-1 ml-[23px] text-[13px] text-[var(--text-muted)]">{elapsed}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid="thinking-block"
      data-expanded={open ? "true" : "false"}
      data-elapsed={elapsed ?? undefined}
    >
      <CodexThinkRow
        content={thinking}
        streaming={isStreaming}
        open={open}
        onToggle={toggle}
      />
      {/* Collapsed: header only (no preview). Expanded body lives in CodexThinkRow. */}
      {elapsed && (
        <div className="mb-1 ml-[23px] text-[13px] text-[var(--text-muted)]">{elapsed}</div>
      )}
    </div>
  );
}
