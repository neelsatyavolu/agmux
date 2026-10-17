import { MarkdownContent } from "../MarkdownContent";
import type { ToolRendererProps } from "./types";
import { agentLabel, formatSeconds, parseConsultAnswers, type ConsultAnswer } from "../../../lib/consultTools";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function AnswerSection({ answer, showAgent }: { answer: ConsultAnswer; showAgent: boolean }) {
  const meta = [answer.model, formatSeconds(answer.seconds)].filter(Boolean).join(" · ");
  return (
    <div className="px-3.5 py-2.5" data-testid="consult-answer">
      {(showAgent || meta) && (
        <div className="mb-1.5 flex items-baseline gap-2 text-[11px]">
          {showAgent && (
            <span className={answer.failed ? "font-medium text-red-400" : "font-medium text-[var(--text-primary)]"}>
              {agentLabel(answer.agent)}
            </span>
          )}
          {meta && <span className="font-mono text-[var(--text-tertiary)]">{meta}</span>}
          {answer.failed && <span className="text-red-400">failed</span>}
        </div>
      )}
      {answer.failed ? (
        <div className="text-[12px] text-[var(--text-secondary)]">{answer.answer}</div>
      ) : (
        <div className="text-[12.5px]">
          <MarkdownContent content={answer.answer} />
        </div>
      )}
    </div>
  );
}

/** Expanded body of a consult call: what was asked, then each advisor's answer. */
export function ConsultToolRenderer({ input, result, isError, isPending }: ToolRendererProps): React.ReactElement {
  const prompt = str(input.question) || str(input.message) || str(input.task) || str(input.focus);
  const answers = isError ? null : parseConsultAnswers(result);
  return (
    <div className="divide-y divide-white/[0.06]">
      {prompt && (
        <div className="px-3.5 py-2.5 text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap" data-testid="consult-prompt">
          {prompt}
        </div>
      )}
      {answers ? (
        answers.map((a, i) => <AnswerSection key={`${a.agent}-${i}`} answer={a} showAgent={answers.length > 1 || i === 0} />)
      ) : result ? (
        <div className={`px-3.5 py-2.5 text-[12px] whitespace-pre-wrap ${isError ? "text-red-400" : "text-[var(--text-secondary)]"}`}>
          {result}
        </div>
      ) : isPending ? (
        <div className="px-3.5 py-2.5 text-[12px] text-[var(--text-tertiary)]">Waiting for the answer…</div>
      ) : null}
    </div>
  );
}
