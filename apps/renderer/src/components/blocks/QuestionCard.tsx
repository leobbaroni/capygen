/**
 * Question block (`AskUserQuestion`). Look ported from
 * reference/omnigent/web/src/components/blocks/AskUserQuestionForm.tsx: the
 * option list, each option's description under its label, and the custom
 * ("Other") row that participates in the same selection group.
 *
 * The custom row is not decoration — SPEC R32 requires "option buttons,
 * multi-select, free text 'Other'". Without it a question whose options do not
 * fit ("Vite / Next / Remix", when the answer is Astro) is unanswerable and the
 * turn stays blocked on `canUseTool` until the session is interrupted.
 *
 * capygen's `question.answer` contract stores one string per question
 * (`Record<question, string>`) — there is no `string[]` slot for a
 * multi-select answer, so a multi-select question's selected labels are
 * joined with ", " (the SDK documents the field as comma-separated).
 */
import { CheckIcon, CircleSlashIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import type { QuestionBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export function QuestionCard({ block }: { block: QuestionBlock }) {
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  const stale = useAppStore((s) => s.staleRequests.includes(block.requestId));
  // question text → selected option labels (order preserved for the joined answer).
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // question text → the free-text answer, when the user picked "Other".
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOn, setCustomOn] = useState<Record<string, boolean>>({});

  if (block.answers) {
    return (
      <Alert data-testid="block-question" data-state="responded" variant="success">
        <CheckIcon className="size-4 text-success" />
        <AlertTitle>Submitted</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-0.5">
            {Object.entries(block.answers).map(([question, answer]) => (
              <li key={question} className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-muted-foreground">{question}</span>
                <span className="font-medium text-foreground">{answer}</span>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  if (stale) {
    return (
      <Alert data-testid="block-question" data-state="stale" variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>No longer waiting</AlertTitle>
        <AlertDescription>
          Nothing is waiting on this question any more, so the answer was not delivered.
          Send a new message to ask the agent again.
        </AlertDescription>
      </Alert>
    );
  }

  function toggle(question: string, label: string, multiSelect: boolean): void {
    setSelections((prev) => {
      const current = prev[question] ?? [];
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [question]: next };
      }
      return { ...prev, [question]: current.includes(label) ? [] : [label] };
    });
    // A single-select question has one answer: picking an option drops "Other".
    if (!multiSelect) setCustomOn((prev) => ({ ...prev, [question]: false }));
  }

  function toggleCustom(question: string, multiSelect: boolean): void {
    setCustomOn((prev) => {
      const on = !prev[question];
      if (on && !multiSelect) setSelections((s) => ({ ...s, [question]: [] }));
      return { ...prev, [question]: on };
    });
  }

  /** Every label chosen for a question, the free-text one included. */
  function answerFor(question: string): string[] {
    const picked = selections[question] ?? [];
    const typed = customOn[question] ? (custom[question] ?? "").trim() : "";
    return typed === "" ? picked : [...picked, typed];
  }

  const allAnswered = block.questions.every((q) => answerFor(q.question).length > 0);

  function submit(): void {
    const answers: Record<string, string> = {};
    for (const q of block.questions) {
      answers[q.question] = answerFor(q.question).join(", ");
    }
    void answerQuestion(block.requestId, answers);
  }

  return (
    <Alert data-testid="block-question" data-state="pending" variant="info">
      <MessageCircleQuestionIcon className="size-4 text-info" />
      <AlertTitle>Claude has questions</AlertTitle>
      <AlertDescription>
        {block.questions.map((q) => {
          const selected = selections[q.question] ?? [];
          const otherOn = customOn[q.question] ?? false;
          return (
            <div key={q.question} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <span>{q.question}</span>
                {q.header ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {q.header}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5" data-testid="block-question-options">
                {q.options.map((opt) => (
                  <Button
                    key={opt.label}
                    type="button"
                    size="sm"
                    variant={selected.includes(opt.label) ? "default" : "outline"}
                    onClick={() => toggle(q.question, opt.label, q.multiSelect)}
                    className={cn(
                      "h-auto flex-col items-start gap-0 py-1.5 text-left",
                      selected.includes(opt.label) && "ring-2 ring-ring",
                    )}
                  >
                    <span>{opt.label}</span>
                    {opt.description ? (
                      <span className="max-w-56 truncate text-xs font-normal opacity-70">
                        {opt.description}
                      </span>
                    ) : null}
                  </Button>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant={otherOn ? "default" : "outline"}
                  data-testid="block-question-other"
                  aria-pressed={otherOn}
                  onClick={() => toggleCustom(q.question, q.multiSelect)}
                  className={cn(otherOn && "ring-2 ring-ring")}
                >
                  Other…
                </Button>
              </div>
              {otherOn ? (
                <input
                  type="text"
                  autoFocus
                  value={custom[q.question] ?? ""}
                  onChange={(e) =>
                    setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))
                  }
                  placeholder="Type something"
                  aria-label={`Other answer for: ${q.question}`}
                  data-testid="block-question-other-input"
                  className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
                />
              ) : null}
            </div>
          );
        })}
        <div className="pt-1">
          <Button
            size="sm"
            data-testid="block-question-submit"
            disabled={!allAnswered}
            onClick={submit}
          >
            <CheckIcon className="size-3.5" />
            Submit
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
