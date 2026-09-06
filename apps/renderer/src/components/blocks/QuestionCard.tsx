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
 * Three things the reference form does that this now does too:
 *
 *  - **Radio vs. checkbox.** The reference "renders radio inputs (single-select)
 *    or checkboxes (multi-select)". Both branches used to render the same
 *    outline buttons, so nothing on screen said whether a second choice would
 *    add to the first or replace it.
 *  - **Decline.** The reference wires `onReject` to `submitBinary("decline")`.
 *    With `allowOther === false` and no acceptable option — a shape
 *    `QuestionSchema` explicitly anticipates for a Codex user-input field that
 *    forbids free text — a Submit-only card is a dead end whose only exit is
 *    interrupting the turn.
 *  - **State keyed by index, not by question text.** Two identically-worded
 *    questions in one payload used to share one selection, collide as React
 *    keys, and submit a single merged entry.
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
  // Absent → "yes" (see domain.ts's own comment on `allowOther`): every
  // harness that predates this field still gets the Other row it always had.
  const allowOther = block.allowOther !== false;
  // Index → selected option labels (order preserved for the joined answer).
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  // Index → the free-text answer, when the user picked "Other".
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [customOn, setCustomOn] = useState<Record<number, boolean>>({});

  // `{}` is truthy, which is how an interrupted question used to render as a
  // green "Submitted" with an empty list. A settled question has at least one
  // answer; anything else is pending, cancelled, or stale.
  const answered = block.answers && Object.keys(block.answers).length > 0;

  if (answered) {
    return (
      <Alert data-testid="block-question" data-state="responded" variant="success">
        <CheckIcon className="size-4 text-success" />
        <AlertTitle>Submitted</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-0.5">
            {Object.entries(block.answers ?? {}).map(([question, answer]) => (
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

  if (block.status === "cancelled") {
    return (
      <Alert data-testid="block-question" data-state="cancelled" variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>Cancelled</AlertTitle>
        <AlertDescription>
          The turn ended before this question was answered, so nothing was sent to the
          agent.
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

  function toggle(index: number, label: string, multiSelect: boolean): void {
    setSelections((prev) => {
      const current = prev[index] ?? [];
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [index]: next };
      }
      return { ...prev, [index]: current.includes(label) ? [] : [label] };
    });
    // A single-select question has one answer: picking an option drops "Other".
    if (!multiSelect) setCustomOn((prev) => ({ ...prev, [index]: false }));
  }

  function toggleCustom(index: number, multiSelect: boolean): void {
    setCustomOn((prev) => {
      const on = !prev[index];
      if (on && !multiSelect) setSelections((s) => ({ ...s, [index]: [] }));
      return { ...prev, [index]: on };
    });
  }

  /** Every label chosen for a question, the free-text one included. */
  function answerFor(index: number): string[] {
    const picked = selections[index] ?? [];
    const typed = customOn[index] ? (custom[index] ?? "").trim() : "";
    return typed === "" ? picked : [...picked, typed];
  }

  const allAnswered = block.questions.every((_, i) => answerFor(i).length > 0);

  function submit(): void {
    const answers: Record<string, string> = {};
    block.questions.forEach((q, i) => {
      answers[q.question] = answerFor(i).join(", ");
    });
    void answerQuestion(block.requestId, answers);
  }

  /**
   * Decline: the same channel Submit uses, with no answers. The harness reads
   * an empty map as "cancelled" and denies the tool rather than handing the
   * model a blank answer (`CodexHarness.askUserInput`, `ClaudeHarness`).
   */
  function decline(): void {
    void answerQuestion(block.requestId, {});
  }

  return (
    <Alert data-testid="block-question" data-state="pending" variant="info">
      <MessageCircleQuestionIcon className="size-4 text-info" />
      <AlertTitle>Claude has questions</AlertTitle>
      <AlertDescription>
        {block.questions.map((q, index) => {
          const selected = selections[index] ?? [];
          const otherOn = customOn[index] ?? false;
          const groupName = `${block.id}-q${index}`;
          return (
            <div key={groupName} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <span>{q.question}</span>
                {q.header ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {q.header}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {q.multiSelect ? "choose any" : "choose one"}
                </span>
              </div>
              <div
                className="flex flex-col gap-1"
                data-testid="block-question-options"
                role={q.multiSelect ? "group" : "radiogroup"}
                aria-label={q.question}
              >
                {q.options.map((opt) => (
                  <label
                    key={opt.label}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border border-border px-2 py-1.5 text-sm hover:bg-accent",
                      selected.includes(opt.label) && "border-ring bg-accent",
                    )}
                  >
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={groupName}
                      className="mt-0.5"
                      checked={selected.includes(opt.label)}
                      onChange={() => toggle(index, opt.label, q.multiSelect)}
                    />
                    <span className="flex flex-col">
                      <span className="text-foreground">{opt.label}</span>
                      {opt.description ? (
                        <span className="text-xs text-muted-foreground">{opt.description}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {allowOther ? (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm hover:bg-accent",
                      otherOn && "border-ring bg-accent",
                    )}
                    data-testid="block-question-other"
                  >
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={groupName}
                      checked={otherOn}
                      onChange={() => toggleCustom(index, q.multiSelect)}
                    />
                    <span className="text-foreground">Other…</span>
                  </label>
                ) : null}
              </div>
              {allowOther && otherOn ? (
                <input
                  type="text"
                  autoFocus
                  value={custom[index] ?? ""}
                  onChange={(e) =>
                    setCustom((prev) => ({ ...prev, [index]: e.target.value }))
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
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            data-testid="block-question-submit"
            disabled={!allAnswered}
            onClick={submit}
          >
            <CheckIcon className="size-3.5" />
            Submit
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="block-question-decline"
            onClick={decline}
          >
            <CircleSlashIcon className="size-3.5" />
            Decline
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
