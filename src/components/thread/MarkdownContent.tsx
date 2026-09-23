import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Components } from "react-markdown";
import { Copy, Check, Terminal } from "lucide-react";
import { useState, useCallback, memo, useMemo, type MouseEvent, type ReactNode } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useThreadStore } from "../../stores/threadStore";
import {
  isHttpOrMailtoHref,
  isLocalFileHref,
  openMarkdownHref,
} from "../../lib/markdownLinks";
import { useWorkDir } from "./WorkDirContext";

function fallbackSessionWorkDir(): string {
  const ui = useUiStore.getState();
  if (ui.selectedCodexSessionCwd) return ui.selectedCodexSessionCwd;
  if (ui.selectedClaudeSessionCwd) return ui.selectedClaudeSessionCwd;
  const id = ui.selectedThreadId;
  if (id && ui.sessionCwdMap[id]) return ui.sessionCwdMap[id];
  if (id) {
    for (const list of Object.values(useThreadStore.getState().threads)) {
      const t = list.find((th) => th.id === id);
      if (t?.work_dir) return t.work_dir;
    }
  }
  return "";
}

// Strip Codex citation metadata blocks
const OAI_CITATION_REGEX = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;

function cleanContent(text: string): string {
  return text.replace(OAI_CITATION_REGEX, "").trimEnd();
}

/**
 * Close unclosed inline markdown formatting markers so that partial
 * streaming text renders with correct formatting as it types.
 * e.g. "Here is **bold" → "Here is **bold**" — renders bold mid-stream
 * instead of showing raw asterisks until the closing marker arrives.
 *
 * This is a no-op on fully-formed markdown (all markers already paired).
 */
function closeOpenMarkers(text: string): string {
  // Fenced code block — if inside one, just close it
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 !== 0) {
    return text + "\n```";
  }

  // Strip completed fenced code blocks for analysis
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");

  // Only analyze the LAST line for unclosed inline markers.
  // Streaming always cuts off at the tail, so unclosed markers from streaming
  // appear in the last line. Mid-text unmatched markers (e.g. keyboard shortcut
  // Cmd+`) are intentional and must NOT be "closed" at the end of the text.
  const lastNewline = withoutFences.lastIndexOf("\n");
  const lastLine = lastNewline === -1 ? withoutFences : withoutFences.slice(lastNewline + 1);
  const strippedLine = lastLine.replace(/`[^`]*`/g, "");

  // Unclosed inline code in last line — close and return (code suppresses other markers)
  if ((strippedLine.match(/`/g) || []).length % 2 !== 0) {
    return text + "`";
  }

  let suffix = "";

  // Bold (**)
  if ((strippedLine.match(/\*\*/g) || []).length % 2 !== 0) suffix += "**";

  // Italic — single * remaining after removing ** pairs
  const afterBold = strippedLine.replace(/\*\*/g, "");
  if ((afterBold.match(/\*/g) || []).length % 2 !== 0) suffix += "*";

  // Strikethrough (~~)
  if ((strippedLine.match(/~~/g) || []).length % 2 !== 0) suffix += "~~";

  return suffix ? text + suffix : text;
}

const CopyButton = memo(function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      });
    },
    [text],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="md-copy-btn inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide transition-colors"
      title="Copy"
      aria-label={copied ? "Copied" : "Copy code"}
    >
      {copied ? (
        <>
          <Check size={11} className="text-[color:var(--accent)]" />
          <span className="text-[color:var(--accent)]">Copied</span>
        </>
      ) : (
        <>
          <Copy size={11} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
});

function isShellLang(lang: string | undefined): boolean {
  if (!lang) return false;
  return /^(bash|sh|shell|zsh|fish|powershell|ps1|cmd)$/i.test(lang);
}

const CodeBlock = memo(function CodeBlock({
  lang,
  code,
}: {
  lang?: string;
  code: string;
}) {
  const shell = isShellLang(lang);
  const label = lang || (shell ? "bash" : "code");

  return (
    <div
      className={`md-code my-3 overflow-hidden rounded-[10px] ${shell ? "md-code-shell" : ""}`}
      // Isolate layout so streaming reflows of surrounding prose don't
      // thrash the code panel's paint/scroll metrics.
      style={{ contain: "layout style" }}
      data-testid="md-code"
      data-lang={label}
    >
      <div className="md-code-head flex items-center justify-between gap-2 px-3 py-[7px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          {shell ? <Terminal size={11} className="shrink-0 text-[color:var(--accent)]" /> : null}
          <span className="truncate">{label}</span>
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="md-code-body m-0 max-h-[min(420px,60vh)] overflow-auto px-3.5 py-3">
        <code className="block whitespace-pre font-mono text-[12px] leading-[1.65] text-[var(--text-secondary)]">
          {code}
        </code>
      </pre>
    </div>
  );
});

const LINK_CLASS =
  "text-[color:var(--accent)] underline decoration-[color:var(--accent-border)] underline-offset-[3px] transition-colors hover:text-[color:var(--accent)] hover:decoration-[color:var(--accent)]";

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const ctxWorkDir = useWorkDir();
  const local = !!href && isLocalFileHref(href);

  const openLocal = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!href) return;
    const workDir = ctxWorkDir || fallbackSessionWorkDir();
    void openMarkdownHref(href, workDir);
  };

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (local) {
      openLocal(e);
      return;
    }
    if (isHttpOrMailtoHref(href)) return;
    e.preventDefault();
  };

  return (
    <a
      href={local ? "#" : href}
      className={LINK_CLASS}
      target={local ? undefined : "_blank"}
      rel={local ? undefined : "noopener noreferrer"}
      onClick={onClick}
      onAuxClick={(e) => {
        if (local) openLocal(e);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = {
  // Code blocks with language labels — pre is a pass-through so `code` owns chrome.
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const lang = match?.[1];
    // Keep the trailing newline for block detection before stripping for display.
    // Fenced single-line blocks arrive as "line\n" (no language class); stripping
    // first would misclassify them as inline pills.
    const raw = String(children);
    const codeString = raw.replace(/\n$/, "");
    const isBlock = raw.includes("\n") || !!className;

    if (!isBlock) {
      return (
        <code className="md-inline-code" {...props}>
          {children}
        </code>
      );
    }

    return <CodeBlock lang={lang} code={codeString} />;
  },
  a: MarkdownLink,
  // Paragraphs
  p({ children }) {
    return (
      <p className="mb-3 last:mb-0 text-[length:inherit] leading-[1.65] text-[var(--text-body)]">
        {children}
      </p>
    );
  },
  // Bold
  strong({ children }) {
    return <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-[var(--text-secondary)]">{children}</em>;
  },
  // Lists
  ul({ children }) {
    return (
      <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0 marker:text-[var(--text-muted)]">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0 marker:text-[var(--text-muted)]">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="text-[var(--text-body)] leading-[1.6]">{children}</li>;
  },
  // Headings
  h1({ children }) {
    return (
      <h1 className="mb-3 mt-6 text-[17px] font-semibold tracking-tight text-[var(--text-primary)] first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-2.5 mt-5 text-[15px] font-semibold tracking-tight text-[var(--text-primary)] first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-2 mt-4 text-[13.5px] font-semibold text-[var(--text-secondary)] first:mt-0">
        {children}
      </h3>
    );
  },
  // Blockquote
  blockquote({ children }) {
    return (
      <blockquote className="md-quote my-3 rounded-r-[9px] border-l-2 border-[color:var(--accent)]/35 py-2 pl-3.5 pr-3 text-[var(--text-muted)] italic">
        {children}
      </blockquote>
    );
  },
  // Horizontal rule
  hr() {
    return <hr className="my-4 border-0 border-t border-[var(--glass-border)]" />;
  },
  // Table (GFM) — glass panel aligned with Codex tool chrome
  table({ children }) {
    return (
      <div
        className="md-table-wrap my-3 w-full overflow-x-auto"
        style={{ contain: "layout style" }}
        data-testid="md-table"
      >
        <table className="md-table w-full min-w-[28rem] border-collapse text-left text-[12.5px] leading-[1.5]">
          {children}
        </table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="md-table-head">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody className="md-table-body">{children}</tbody>;
  },
  tr({ children }) {
    return <tr className="md-table-row">{children}</tr>;
  },
  th({ children }) {
    return (
      <th className="md-table-th px-3.5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-muted)]">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="md-table-td px-3.5 py-2.5 align-top text-[var(--text-secondary)]">
        {children}
      </td>
    );
  },
};

interface Props {
  content: string;
}

export const MarkdownContent = memo(function MarkdownContent({ content }: Props) {
  // Memoize the cleaned stream so ReactMarkdown only re-parses when the
  // visible markdown actually changes (not on parent re-renders).
  const cleaned = useMemo(
    () => closeOpenMarkers(cleanContent(content)),
    [content],
  );

  return (
    <div className="md-root min-w-0 max-w-full leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
});
