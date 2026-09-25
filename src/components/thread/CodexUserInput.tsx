import { useState } from "react";
import { Check, MessageCircle } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";

export interface CodexQuestion {
  id: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
}

export type CodexAnswers = Record<string, { answers: string[] }>;

export function CodexUserInput({ questions, onSubmit }: {
  questions: CodexQuestion[];
  onSubmit: (answers: CodexAnswers) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="codex-glass max-h-[40vh] overflow-y-auto space-y-4 rounded-[20px] border border-[var(--glass-border)] p-4 shadow-lg text-[var(--text-primary)] antialiased fx-dialog" onSubmit={async (event) => {
      event.preventDefault();
      if (sending || questions.some((q) => !values[q.id]?.trim())) return;
      setSending(true);
      setError(null);
      try {
        await onSubmit(Object.fromEntries(questions.map((q) => [q.id, { answers: [values[q.id].trim()] }])));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    }}>
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]"><MessageCircle size={14} aria-hidden />Your input</div>
      {questions.map((q) => (
        <fieldset key={q.id} disabled={sending} className="space-y-2">
          <legend className="w-full text-sm leading-relaxed"><MarkdownContent content={q.question} /></legend>
          {q.options?.map((option) => (
            <button key={option.label} type="button" aria-pressed={values[q.id] === option.label}
              data-active={values[q.id] === option.label ? "true" : undefined}
              className="ui-choice-item flex w-full items-start gap-3 rounded-lg bg-[var(--surface-1)] text-left transition-colors hover:bg-[var(--surface-hover)] border border-[var(--glass-border)] px-3 py-2.5 text-sm aria-pressed:border-[var(--glass-border-strong)] aria-pressed:bg-[var(--surface-active)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-muted)]"
              onClick={() => setValues((prev) => ({ ...prev, [q.id]: option.label }))}>
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--glass-border-strong)]" aria-hidden>{values[q.id] === option.label && <Check size={11} />}</span>
              <span>{option.label}{option.description && <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-muted)]">{option.description}</span>}</span>
            </button>
          ))}
          <input aria-label={q.question} value={values[q.id] ?? ""} placeholder="Type your answer…"
            className="block w-full rounded-lg border border-[var(--glass-border)] bg-[var(--surface-1)] px-3 py-2 text-sm outline-none focus:border-[var(--text-muted)] fx-input"
            onChange={(event) => setValues((prev) => ({ ...prev, [q.id]: event.target.value }))} />
        </fieldset>
      ))}
      {error && <p role="alert" className="text-sm">{error}</p>}
      <button type="submit" disabled={sending || questions.some((q) => !values[q.id]?.trim())}
        className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-sm font-medium text-[var(--surface-popover)] transition-opacity hover:opacity-90 disabled:opacity-40 fx-accent">
        {sending ? "Sending…" : "Send answers"}
      </button>
    </form>
  );
}
