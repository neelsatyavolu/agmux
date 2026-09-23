import { useEffect, useRef, useState, useCallback } from "react";
import { X, ArrowUp, Loader2, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { askAi } from "../../lib/commands";
import { handleTextFieldCmdArrowNav } from "../../lib/textFieldNav";

interface Props {
  open: boolean;
  onClose: () => void;
  terminalContext: string;
  workDir: string;
  onInsertCommand: (command: string) => void;
}

type Provider = "claude" | "codex";

const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Haiku",
  codex: "Codex",
};

const PROVIDER_MODEL: Record<Provider, string | undefined> = {
  claude: "claude-haiku-4-5-20251001",
  codex: undefined,
};

const STORAGE_KEY = "agmux-cmdk-provider";

function getStoredProvider(): Provider {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "claude" || stored === "codex") return stored;
  } catch {
    // localStorage unavailable
  }
  return "claude";
}

export default function TerminalCmdK({
  open,
  onClose,
  terminalContext,
  workDir,
  onInsertCommand,
}: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<Provider>(getStoredProvider);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);

  // Reset state and focus on open
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError("");
    setLoading(false);
    setShowProviderMenu(false);
    abortRef.current = false;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);

  // Clear error timer on unmount
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(""), 3000);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    abortRef.current = false;

    try {
      const result = await askAi(
        provider,
        query.trim(),
        terminalContext,
        workDir,
        PROVIDER_MODEL[provider],
      );

      if (abortRef.current) return;

      // Only ever insert a single line. The model reply is derived from raw
      // terminal scrollback, which is attacker-controllable (build logs, cloned
      // repos, package output), so a multi-line reply must not be able to smuggle
      // extra commands into the shell — keep the first line only.
      const cleaned = result
        .replace(/^```[\w]*\n?/, "")
        .replace(/\n?```$/, "")
        .split(/\r?\n/)[0]
        .trim();

      if (cleaned) {
        setLoading(false);
        onInsertCommand(cleaned);
      } else {
        showError("No command generated");
        setLoading(false);
      }
    } catch (err) {
      if (abortRef.current) return;
      showError(String(err));
      setLoading(false);
    }
  }, [query, loading, provider, terminalContext, workDir, onInsertCommand, showError]);

  const handleClose = useCallback(() => {
    abortRef.current = true;
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleTextFieldCmdArrowNav(e, e.currentTarget)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }
    },
    [handleClose, handleSubmit],
  );

  const switchProvider = useCallback((p: Provider) => {
    setProvider(p);
    setShowProviderMenu(false);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // localStorage unavailable
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setQuery(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 72)}px`;
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: "spring", stiffness: 500, damping: 30, mass: 0.8 }}
          className="absolute bottom-3 left-1/2 z-30 w-[min(70%,560px)] -translate-x-1/2"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cmdk-bar overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900/95 shadow-xl shadow-black/40 backdrop-blur-sm">
            {/* Input row */}
            <div className="flex items-start gap-2 px-3 pt-2.5 pb-1">
              <textarea
                ref={inputRef}
                value={query}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder="Command instructions"
                disabled={loading}
                rows={1}
                className="flex-1 resize-none bg-transparent text-[13px] text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50"
                style={{ lineHeight: "1.5", maxHeight: 72 }}
              />
              <button
                onClick={handleClose}
                className="mt-0.5 shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="px-3 pb-1">
                <span className="text-[11px] text-red-400">{error}</span>
              </div>
            )}

            {/* Bottom row: provider + submit */}
            <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
              {/* Provider toggle */}
              <div className="relative">
                <button
                  onClick={() => setShowProviderMenu((v) => !v)}
                  disabled={loading}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-300 disabled:opacity-50"
                >
                  {PROVIDER_LABELS[provider]}
                  <ChevronDown size={10} />
                </button>

                {/* Dropdown */}
                {showProviderMenu && (
                  <div className="absolute bottom-full left-0 mb-1 min-w-[100px] overflow-hidden rounded-lg border border-white/[0.08] bg-zinc-900 shadow-lg">
                    {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => switchProvider(p)}
                        className={`flex w-full items-center px-3 py-1.5 text-left text-[11px] transition-colors ${
                          p === provider
                            ? "bg-blue-600/20 text-blue-400"
                            : "text-zinc-300 hover:bg-white/[0.06]"
                        }`}
                      >
                        {PROVIDER_LABELS[p]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={!query.trim() || loading}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600"
                aria-label={loading ? "Generating" : "Submit"}
              >
                {loading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ArrowUp size={13} />
                )}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
