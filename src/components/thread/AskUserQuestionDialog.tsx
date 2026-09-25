import { useState, useEffect, useRef } from "react";
import { HelpCircle, Send, Check } from "lucide-react";
import type { AskQuestion } from "../../lib/types";

interface Props {
  questions: AskQuestion[];
  /** Called with answers keyed by question text (multi-select values are comma-joined). */
  onSubmit: (answers: Record<string, string>) => void;
  /** Called when the user dismisses the dialog without answering. */
  onCancel: () => void;
}

/** Per-question selection state. */
interface QState {
  /** Selected option labels — single-select keeps at most one. */
  picked: string[];
  /** Whether the free-text "Other" choice is active. */
  otherOn: boolean;
  /** Free-text content for the "Other" choice (also used for option-less questions). */
  otherText: string;
}

function emptyState(): QState {
  return { picked: [], otherOn: false, otherText: "" };
}

/** Resolve the answer string for one question — "" when still unanswered. */
function answerFor(q: AskQuestion, s: QState): string {
  // Option-less question (legacy / free-form): the answer is the raw text.
  if (q.options.length === 0) return s.otherText.trim();
  const parts = [...s.picked];
  if (s.otherOn) {
    const t = s.otherText.trim();
    if (t) parts.push(t);
  }
  return parts.join(", ");
}

/**
 * Interactive dialog for the SDK `AskUserQuestion` tool. Renders each question's
 * multiple-choice options as clickable buttons (plus a free-text "Other"), and
 * submits answers keyed by question text — the shape the CLI tool consumes via
 * `updatedInput.answers`.
 */
export function AskUserQuestionDialog({ questions, onSubmit, onCancel }: Props) {
  const [states, setStates] = useState<QState[]>(() => questions.map(emptyState));

  const update = (i: number, patch: Partial<QState>) =>
    setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const toggleOption = (i: number, label: string, multi: boolean) =>
    setStates((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        if (multi) {
          const picked = s.picked.includes(label)
            ? s.picked.filter((l) => l !== label)
            : [...s.picked, label];
          return { ...s, picked };
        }
        // Single-select: replace selection, clear the "Other" choice.
        return { ...s, picked: [label], otherOn: false };
      }),
    );

  const toggleOther = (i: number, multi: boolean) =>
    setStates((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        if (multi) return { ...s, otherOn: !s.otherOn };
        return { ...s, otherOn: true, picked: [] };
      }),
    );

  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    answers[q.question] = answerFor(q, states[i] ?? emptyState());
  });
  const allAnswered =
    questions.length > 0 && questions.every((q) => (answers[q.question] ?? "").length > 0);

  const submit = () => {
    if (allAnswered) onSubmit(answers);
  };

  // Keep the keyboard handler pointed at the latest submit closure without
  // re-subscribing on every keystroke.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm fx-scrim" />
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-[20px] border border-blue-500/20 bg-gradient-to-b from-[var(--surface-popover-gradient-from)] to-[var(--surface-popover-gradient-to)] shadow-2xl shadow-black/50 backdrop-blur-xl animate-glass-in fx-dialog">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3.5 text-blue-400">
          <HelpCircle size={16} />
          <span className="text-sm font-semibold">
            {questions.length > 1 ? `${questions.length} questions` : "Question"}
          </span>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {questions.map((q, i) => {
            const s = states[i] ?? emptyState();
            const multi = q.multiSelect === true;
            const noOptions = q.options.length === 0;
            return (
              <div key={i} className="space-y-2">
                {q.header && (
                  <p className="ui-eyebrow font-semibold text-blue-400/70">
                    {q.header}
                  </p>
                )}
                <p className="text-sm leading-relaxed text-[var(--text-primary)]">
                  {q.question}
                </p>
                {multi && (
                  <p className="text-[10px] text-zinc-500">Select all that apply</p>
                )}

                {noOptions ? (
                  <input
                    type="text"
                    value={s.otherText}
                    onChange={(e) => update(i, { otherText: e.target.value })}
                    placeholder="Type your answer..."
                    autoFocus={i === 0}
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-blue-400/60 focus:bg-white/[0.06] fx-input"
                  />
                ) : (
                  <div className="space-y-1.5">
                    {q.options.map((opt) => {
                      const selected = s.picked.includes(opt.label);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => toggleOption(i, opt.label, multi)}
                          data-active={selected ? "true" : undefined}
                          className={`ui-choice-item flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-blue-500/60 bg-blue-500/15"
                              : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.08]"
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
                              multi ? "rounded" : "rounded-full"
                            } ${
                              selected
                                ? "border-blue-400 bg-blue-500 text-white"
                                : "border-white/25"
                            }`}
                          >
                            {selected && <Check size={11} strokeWidth={3} />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-zinc-100">
                              {opt.label}
                            </span>
                            {opt.description && (
                              <span className="mt-0.5 block text-[11px] text-zinc-400">
                                {opt.description}
                              </span>
                            )}
                            {opt.preview && selected && (
                              <pre className="mt-1.5 overflow-x-auto rounded bg-black/40 p-2 text-[10px] text-zinc-300">
                                {opt.preview}
                              </pre>
                            )}
                          </span>
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => toggleOther(i, multi)}
                      data-active={s.otherOn ? "true" : undefined}
                      className={`ui-choice-item flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                        s.otherOn
                          ? "border-blue-500/60 bg-blue-500/15"
                          : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.08]"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                          multi ? "rounded" : "rounded-full"
                        } ${
                          s.otherOn ? "border-blue-400 bg-blue-500 text-white" : "border-white/25"
                        }`}
                      >
                        {s.otherOn && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="text-xs font-medium text-zinc-300">Other…</span>
                    </button>
                    {s.otherOn && (
                      <input
                        type="text"
                        value={s.otherText}
                        onChange={(e) => update(i, { otherText: e.target.value })}
                        placeholder="Type your answer..."
                        autoFocus
                        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-blue-400/60 focus:bg-white/[0.06] fx-input"
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!allAnswered}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 fx-accent"
          >
            <Send size={12} />
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
