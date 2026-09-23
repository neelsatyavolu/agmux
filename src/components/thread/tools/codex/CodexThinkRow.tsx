import { memo } from "react";
import { Sparkles } from "lucide-react";
import { CodexToolRow } from "./CodexToolRow";
import { CodexCollapse } from "./CodexCollapse";

export interface CodexThinkRowProps {
  content: string;
  /** True while reasoning text is still streaming in. */
  streaming?: boolean;
  open: boolean;
  onToggle: () => void;
}

/** Reasoning row with a violet-railed, italic body.
 *
 *  Carries no duration: turn wall-time lives on the turn summary row that
 *  folds this one away once the turn finishes. */
export const CodexThinkRow = memo(function CodexThinkRow({
  content,
  streaming = false,
  open,
  onToggle,
}: CodexThinkRowProps) {
  const lead = streaming ? "Thinking" : "Thought";
  const hasBody = content.trim().length > 0;

  return (
    <div data-testid="codex-think-row">
      <CodexToolRow
        icon={<Sparkles size={13} />}
        lead={lead}
        tone="thinking"
        status={streaming ? "running" : "idle"}
        toggle={
          hasBody ? { open, openLabel: "hide", closedLabel: "show", onToggle } : undefined
        }
      />
      <CodexCollapse open={open && hasBody}>
        <div className="mb-3 ml-[23px] mt-0.5 whitespace-pre-wrap border-l-2 border-violet-400/30 pl-[13px] text-[13px] italic leading-[1.62] text-[var(--text-secondary)]">
          {content.trimEnd()}
        </div>
      </CodexCollapse>
    </div>
  );
});
