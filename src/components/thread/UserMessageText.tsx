import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";

const TRUNCATE_CHAR_THRESHOLD = 2000;
const TRUNCATE_LINE_THRESHOLD = 25;

export const PROMPT_ACTION_BTN =
  "inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-black/20 text-indigo-100/55 shadow-sm transition-colors hover:border-indigo-200/25 hover:bg-indigo-400/10 hover:text-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-300/40";

interface UserMessageTextProps {
  content: string;
  className?: string;
  actions?: ReactNode;
}

function CopyPromptButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [content]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy prompt"
      aria-label="Copy prompt"
      className={PROMPT_ACTION_BTN}
    >
      {copied ? <Check size={13} className="text-[color:var(--accent)]" /> : <Copy size={13} />}
    </button>
  );
}

function PromptActionCluster({
  content,
  actions,
}: {
  content: string;
  actions?: ReactNode;
}) {
  return (
    <div className="absolute -left-12 top-1/2 flex -translate-y-1/2 flex-col items-center gap-1 opacity-0 transition-opacity group-hover/prompt-copy:opacity-100 group-hover/msg:opacity-100 focus-within:opacity-100">
      {actions}
      <CopyPromptButton content={content} />
    </div>
  );
}

export function UserMessageText({ content, className, actions }: UserMessageTextProps) {
  const [expanded, setExpanded] = useState(false);

  const { shouldTruncate, lineCount, charCount } = useMemo(() => {
    const charCount = content.length;
    const lineCount = content.split("\n").length;
    return {
      charCount,
      lineCount,
      shouldTruncate:
        charCount > TRUNCATE_CHAR_THRESHOLD || lineCount > TRUNCATE_LINE_THRESHOLD,
    };
  }, [content]);

  const baseTextClasses =
    "whitespace-pre-wrap break-words [overflow-wrap:anywhere] antialiased";

  if (!shouldTruncate) {
    return (
      <div className="group/prompt-copy relative w-full min-w-0">
        <PromptActionCluster content={content} actions={actions} />
        <p className={`${baseTextClasses} ${className ?? ""}`}>{content}</p>
      </div>
    );
  }

  if (expanded) {
    return (
      <div className="group/prompt-copy relative w-full min-w-0">
        <PromptActionCluster content={content} actions={actions} />
        <p className={`${baseTextClasses} ${className ?? ""}`}>{content}</p>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white/80"
        >
          <ChevronUp size={12} />
          Collapse
        </button>
      </div>
    );
  }

  return (
    <div className="group/prompt-copy relative w-full min-w-0">
      <PromptActionCluster content={content} actions={actions} />
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="group/large inline-flex w-full items-center justify-between gap-2 rounded-lg border border-indigo-400/20 bg-indigo-500/[0.08] px-3 py-2 text-left text-[12px] font-medium text-indigo-100/90 transition-colors hover:border-indigo-400/30 hover:bg-indigo-500/[0.14] hover:text-indigo-50"
      >
        <span className="min-w-0 truncate">
          Large message ({lineCount.toLocaleString()} lines,{" "}
          {charCount.toLocaleString()} chars) — click to see full text
        </span>
        <ChevronDown
          size={13}
          className="shrink-0 text-indigo-200/70 transition-transform group-hover/large:translate-y-0.5"
        />
      </button>
    </div>
  );
}
