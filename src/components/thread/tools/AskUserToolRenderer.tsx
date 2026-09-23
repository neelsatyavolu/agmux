import { HelpCircle, Check } from "lucide-react";
import type { ToolRendererProps } from "./types";

interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
}

function parseQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw
    .filter((q): q is Record<string, unknown> => q != null && typeof q === "object" && !Array.isArray(q))
    .map((q) => ({
      question: typeof q.question === "string" ? q.question : "",
      header: typeof q.header === "string" ? q.header : "",
      options: Array.isArray(q.options)
        ? q.options
          .filter((o): o is Record<string, unknown> => o != null && typeof o === "object" && !Array.isArray(o))
          .map((o) => ({
            label: typeof o.label === "string" ? o.label : "",
            description: typeof o.description === "string" ? o.description : "",
          }))
        : [],
    }));
}

export function AskUserToolRenderer({ input, result, isPending }: ToolRendererProps): React.ReactElement {
  const questions = parseQuestions(input);
  const firstQ = questions[0];

  return (
    <div
      className={`rounded-md border bg-blue-500/5 p-3 space-y-3 transition-all ${
        isPending ? "border-blue-500/40 shadow-[0_0_12px_-4px_rgba(59,130,246,0.3)]" : "border-blue-500/20"
      }`}
    >
      {firstQ ? (
        <>
          {firstQ.header && (
            <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/70">{firstQ.header}</p>
          )}
          <div className="flex items-start gap-2">
            <HelpCircle size={14} className="shrink-0 text-blue-400 mt-0.5" />
            <p className="text-xs text-zinc-200 leading-relaxed">{firstQ.question}</p>
          </div>
          {firstQ.options.length > 0 && (
            <div className="space-y-1 pl-5">
              {firstQ.options.map((opt, idx) => (
                <div
                  key={idx}
                  className={`rounded-md border px-2.5 py-1.5 text-[11px] transition-colors ${
                    result === opt.label
                      ? "border-blue-500/50 bg-blue-500/20 text-blue-300"
                      : "border-white/10 bg-white/5 text-zinc-400"
                  }`}
                >
                  <span className="font-medium text-zinc-300">{opt.label}</span>
                  {opt.description && (
                    <span className="block text-[10px] text-zinc-400 mt-0.5">{opt.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-start gap-2">
          <HelpCircle size={14} className="shrink-0 text-blue-400 mt-0.5" />
          <p className="text-xs text-zinc-200 leading-relaxed">Question</p>
        </div>
      )}

      {result != null && (
        <div className="flex items-center gap-1.5 pl-5">
          <Check size={12} className="text-[color:var(--accent)]" />
          <span className="text-xs text-zinc-300">{result}</span>
        </div>
      )}
    </div>
  );
}
