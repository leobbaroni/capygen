/**
 * Question block (`AskUserQuestion`). Look ported from
 * reference/omnigent/web/src/components/blocks/AskUserQuestionForm.tsx,
 * simplified to plain option buttons per the task brief ("options as
 * buttons, multiSelect support") rather than the reference's radio/checkbox
 * + free-text carousel.
 *
 * capygen's `question.answer` contract stores one string per question
 * (`Record<question, string>`) — there is no `string[]` slot for a
 * multi-select answer, so a multi-select question's selected labels are
 * joined with ", " into that single string.
 */
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import type { QuestionBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export function QuestionCard({ block }: { block: QuestionBlock }) {
  const answerQuestion = useAppStore((s) => s.answerQuestion);
  // question text → selected option labels (order preserved for the joined answer).
  const [selections, setSelections] = useState<Record<string, string[]>>({});

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
  }

  const allAnswered = block.questions.every((q) => (selections[q.question] ?? []).length > 0);

  function submit(): void {
    const answers: Record<string, string> = {};
    for (const q of block.questions) {
      answers[q.question] = (selections[q.question] ?? []).join(", ");
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
                    title={opt.description}
                    onClick={() => toggle(q.question, opt.label, q.multiSelect)}
                    className={cn(selected.includes(opt.label) && "ring-2 ring-ring")}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
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
