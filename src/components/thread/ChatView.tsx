import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  BookOpen,
  ChevronDown,
  Eye,
  EyeOff,
  Bot,
} from "lucide-react";
import { usePtyOutput } from "../../hooks/usePtyOutput";
import { AddToJournalDialog } from "./AddToJournalDialog";
import { MarkdownContent } from "./MarkdownContent";
import { UserMessageText } from "./UserMessageText";
import { listThreadTurns } from "../../lib/commands";
import { registerThreadTimelineScroll, rebindChatTurnIds, findTurnElement, flashTurnHighlight } from "../../lib/threadTimelineScroll";
import type { ChatBlock, JournalKind } from "../../lib/types";

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function parseBlocksFromOutput(raw: string): ChatBlock[] {
  const clean = stripAnsi(raw);
  // Split on common prompt patterns (e.g., "> ", "$ ", "claude> ", "You: ")
  // We use a heuristic: lines starting with a prompt indicator
  const lines = clean.split("\n");
  const blocks: ChatBlock[] = [];
  let currentBlock: { type: "user" | "response"; lines: string[] } | null = null;
  let blockIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentBlock) {
        currentBlock.lines.push(line);
      }
      continue;
    }

    // Detect user input lines (heuristic: starts with "> " or "$ " or contains user prompt markers)
    const isUserInput =
      /^(>|(\$)|\?|human>|you>)\s/i.test(trimmed) ||
      /^(Enter|Type|Input)/i.test(trimmed);

    if (isUserInput && (!currentBlock || currentBlock.type !== "user")) {
      // Save previous block
      if (currentBlock && currentBlock.lines.length > 0) {
        blocks.push({
          id: `block-${blockIndex++}`,
          type: currentBlock.type,
          content: formatContent(currentBlock.lines.join("\n")),
          rawContent: currentBlock.lines.join("\n"),
          timestamp: Date.now(),
        });
      }
      currentBlock = { type: "user", lines: [line] };
    } else if (!isUserInput && (!currentBlock || currentBlock.type === "user")) {
      // Start response block
      if (currentBlock && currentBlock.lines.length > 0) {
        blocks.push({
          id: `block-${blockIndex++}`,
          type: currentBlock.type,
          content: formatContent(currentBlock.lines.join("\n")),
          rawContent: currentBlock.lines.join("\n"),
          timestamp: Date.now(),
        });
      }
      currentBlock = { type: "response", lines: [line] };
    } else {
      if (currentBlock) {
        currentBlock.lines.push(line);
      } else {
        currentBlock = { type: "response", lines: [line] };
      }
    }
  }

  // Push final block
  if (currentBlock && currentBlock.lines.length > 0) {
    blocks.push({
      id: `block-${blockIndex++}`,
      type: currentBlock.type,
      content: formatContent(currentBlock.lines.join("\n")),
      rawContent: currentBlock.lines.join("\n"),
      timestamp: Date.now(),
    });
  }

  return blocks;
}

function formatContent(text: string): string {
  // Trim trailing whitespace lines
  return text.replace(/\n\s*$/, "").replace(/^\s*\n/, "");
}

const JOURNAL_KINDS: JournalKind[] = [
  "Decision",
  "Convention",
  "CompletedWork",
  "KnownIssue",
  "Note",
  "Pin",
];

const kindColors: Record<JournalKind, string> = {
  Decision: "text-purple-400 hover:bg-purple-500/10",
  Convention: "text-blue-400 hover:bg-blue-500/10",
  CompletedWork: "text-green-400 hover:bg-green-500/10",
  KnownIssue: "text-amber-400 hover:bg-amber-500/10",
  Note: "text-zinc-400 hover:bg-zinc-500/10",
  Pin: "text-cyan-400 hover:bg-cyan-500/10",
};

interface ResponseBlockProps {
  block: ChatBlock;
  threadId: string;
}

function ResponseBlock({ block, threadId }: ResponseBlockProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [journalDropdownOpen, setJournalDropdownOpen] = useState(false);
  const [journalDialogOpen, setJournalDialogOpen] = useState(false);
  const [selectedJournalKind, setSelectedJournalKind] = useState<JournalKind>("Note");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!journalDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setJournalDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [journalDropdownOpen]);

  return (
    <>
      <div className="group relative rounded-xl transition-all duration-300">
        {/* Actions - Visible on Hover */}
        <div className="absolute -right-2 -top-3 z-10 flex items-center gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:translate-y-1">
          <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-xl shadow-black/50 ring-1 ring-white/5">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="flex items-center gap-1 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200 transition-colors"
              title={showRaw ? "Show formatted" : "Show raw"}
            >
              {showRaw ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <div className="h-4 w-[1px] bg-white/5 mx-0.5" />
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setJournalDropdownOpen(!journalDropdownOpen)}
                className="flex items-center gap-1 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200 transition-colors"
              >
                <BookOpen size={13} />
                <ChevronDown size={10} />
              </button>
              {journalDropdownOpen && (
                <div className="absolute right-0 top-full z-20 mt-2 w-40 rounded-lg border border-white/10 bg-[var(--surface-popover)] py-1.5 shadow-2xl ring-1 ring-black/50 overflow-hidden">
                  {JOURNAL_KINDS.map((kind) => (
                    <button
                      key={kind}
                      onClick={() => {
                        setSelectedJournalKind(kind);
                        setJournalDropdownOpen(false);
                        setJournalDialogOpen(true);
                      }}
                      className={`w-full px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-white/5 ${kindColors[kind]}`}
                    >
                      {kind === "CompletedWork"
                        ? "Completed Work"
                        : kind === "KnownIssue"
                          ? "Known Issue"
                          : kind}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="prose-modern">
          {showRaw ? (
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-zinc-400 bg-zinc-900/50 p-4 rounded-lg border border-white/5">
              {block.rawContent}
            </pre>
          ) : (
            <div className="text-zinc-300 leading-relaxed selection:bg-indigo-500/30">
              <MarkdownContent content={block.content} />
            </div>
          )}
        </div>
      </div>

      <AddToJournalDialog
        open={journalDialogOpen}
        threadId={threadId}
        initialContent={block.content}
        initialKind={selectedJournalKind}
        onClose={() => setJournalDialogOpen(false)}
      />
    </>
  );
}

interface Props {
  threadId: string;
  onExit?: (exitCode: number) => void;
}

export function ChatView({ threadId, onExit }: Props) {
  const [rawOutput, setRawOutput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => registerThreadTimelineScroll(threadId, async (turnId) => {
    const root = scrollRef.current;
    if (!root) return false;
    const turns = await listThreadTurns(threadId, 200);
    if (scrollRef.current !== root) return false;
    rebindChatTurnIds(root, turns);
    const target = findTurnElement(root, turnId);
    if (!target) return false;
    following.current = false;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    flashTurnHighlight(target);
    return true;
  }), [threadId]);

  // ChatView accumulates plain text from PTY output and parses it locally —
  // it does NOT use xterm, so it doesn't need snapshot rehydration or
  // offset-based dedup. Just unwrap the base64 from each event and append.
  const handleData = useCallback((event: import("../../lib/types").PtyOutputEvent) => {
    const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    setRawOutput((prev) => prev + text);
  }, []);

  usePtyOutput(threadId, handleData, onExit);

  const blocks = useMemo(() => parseBlocksFromOutput(rawOutput), [rawOutput]);

  // Auto-scroll on new content
  useEffect(() => {
    if (following.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [rawOutput]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="glass-seam pointer-events-none absolute inset-x-0 top-0 z-10 h-20" />

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-6 py-8 space-y-12 scroll-smooth scrollbar-none"
      >
        {blocks.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 opacity-40">
            <Bot size={40} strokeWidth={1.5} className="text-zinc-500" />
            <p className="text-sm font-medium tracking-wide text-zinc-400 uppercase">Awaiting input...</p>
          </div>
        )}
        {blocks.map((block) =>
          block.type === "user" ? (
            <div key={block.id} data-timeline-user-msg="" data-user-prompt={block.content.replace(/^\s*(?:[>$?]|human>|you>)\s*/i, "")} className="animate-fade-in flex flex-col gap-2 max-w-[90%] ml-auto">
              <div className="flex items-center gap-2 mb-1 justify-end">
                <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">You</span>
                <div className="h-[1px] w-8 bg-zinc-800" />
              </div>
              <div className="codex-bubble-user min-w-0 rounded-[16px_16px_5px_16px] px-[15px] py-[11px] text-[14.5px] leading-[1.55] text-[var(--text-primary)]">
                <UserMessageText content={block.content} />
              </div>
            </div>
          ) : (
            <div key={block.id} className="animate-fade-in max-w-[95%]">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-[1px] w-8 bg-indigo-500/30" />
                <span className="text-[10px] font-bold tracking-widest text-indigo-400/80 uppercase">Assistant</span>
              </div>
               <ResponseBlock
                block={block}
                threadId={threadId}
              />
            </div>
          )
        )}
      </div>
    </div>
  );
}
