import { useState, useRef, useCallback, useEffect } from "react";
import { getLocalCompletion } from "../lib/completionSpecs";
import { terminalAutocomplete } from "../lib/commands";

interface UseTerminalAutocompleteOptions {
  input: string;
  cwd: string;
  gitBranch: string | null;
  history: string[];
  enabled: boolean;
}

interface UseTerminalAutocompleteResult {
  suggestion: string;
  accept: () => string;  // Returns full text (input + suggestion)
  dismiss: () => void;
}

const DEBOUNCE_MS = 200;
const MIN_INPUT_FOR_AI = 3;

/**
 * Validate that a suggestion is not a nonsensical repeat of what's typed.
 * Keep this minimal — only reject clear garbage, not edge cases.
 */
function isUsefulSuggestion(input: string, suggestion: string): boolean {
  if (!suggestion || !suggestion.trim()) return false;

  const trimmedSuggestion = suggestion.trim();

  // Reject if suggestion is the entire input repeated
  if (trimmedSuggestion === input.trim()) return false;

  // Reject if suggestion exactly equals the last typed word (e.g. "npx tauri" → "tauri")
  const lastWord = input.trimEnd().split(/\s+/).pop() ?? "";
  if (lastWord && trimmedSuggestion === lastWord) return false;

  return true;
}

export function useTerminalAutocomplete({
  input,
  cwd,
  gitBranch,
  history,
  enabled,
}: UseTerminalAutocompleteOptions): UseTerminalAutocompleteResult {
  const [suggestion, setSuggestion] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;
  const historyRef = useRef(history);
  historyRef.current = history;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const gitBranchRef = useRef(gitBranch);
  gitBranchRef.current = gitBranch;

  // Clear suggestion when disabled or input changes
  useEffect(() => {
    if (!enabled) {
      setSuggestion("");
      return;
    }

    // Clear previous suggestion immediately on input change
    setSuggestion("");

    if (!input.trim()) return;

    // Cancel pending debounce
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const currentRequestId = ++requestIdRef.current;

    // Step 1: Try local spec completion (instant)
    getLocalCompletion(input).then((localResult) => {
      if (currentRequestId !== requestIdRef.current) return;
      if (inputRef.current !== input) return;

      if (localResult && isUsefulSuggestion(input, localResult)) {
        console.log("[autocomplete] local spec:", JSON.stringify(localResult));
        setSuggestion(localResult);
        return; // Local spec matched, skip AI
      }

      // Step 2: Debounce then try AI
      if (input.trim().length >= MIN_INPUT_FOR_AI) {
        timerRef.current = setTimeout(() => {
          if (currentRequestId !== requestIdRef.current) return;
          if (inputRef.current !== input) return;

          terminalAutocomplete(
            input,
            cwdRef.current,
            gitBranchRef.current ?? "",
            historyRef.current.slice(-5),
          )
            .then((aiResult) => {
              if (currentRequestId !== requestIdRef.current) return;
              if (inputRef.current !== input) return;
              console.log("[autocomplete] groq raw:", JSON.stringify(aiResult), "useful:", isUsefulSuggestion(input, aiResult));
              if (aiResult && isUsefulSuggestion(input, aiResult)) {
                setSuggestion(aiResult);
              }
            })
            .catch(() => {
              // Silent failure
            });
        }, DEBOUNCE_MS);
      }
    }).catch(() => {
      // Silent failure for local specs too
    });

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  // Only input and enabled should trigger re-evaluation.
  // cwd/gitBranch/history are read via refs to avoid spurious effect re-runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, enabled]);

  const accept = useCallback((): string => {
    const full = inputRef.current + suggestion;
    setSuggestion("");
    return full;
  }, [suggestion]);

  const dismiss = useCallback(() => {
    setSuggestion("");
  }, []);

  return { suggestion, accept, dismiss };
}
