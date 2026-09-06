/**
 * Elicitation block — a backend's structured input request that is neither a
 * permission prompt nor `AskUserQuestion` (MCP `elicitation/create`, or a
 * future Codex user-input request; R32). Renders one control per schema
 * property (`elicitationForm.ts`'s `schemaFields`): a select for `enum`, a
 * checkbox for `boolean`, a number input for `number`/`integer`, text
 * otherwise. A schema with no properties (or none `schemaFields` can read)
 * falls back to a bare Accept/Decline consent prompt, since there is nothing
 * to fill in.
 *
 * Submit sends `elicitation.answer` with the gathered content; Cancel sends
 * it with `answers: null` (the contract's own "the user cancelled/declined"
 * shape) — there is no separate accept/decline verb on the wire, only
 * content vs. no content.
 */
import { CheckIcon, CircleSlashIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ElicitationBlock } from "@capygen/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/appStore";
import {
  enumLabel,
  enumValues,
  initialValue,
  isComplete,
  schemaFields,
  toContent,
  type ElicitationDraft,
  type ElicitValue,
} from "./elicitationForm";

export function ElicitationCard({ block }: { block: ElicitationBlock }) {
  const answerElicitation = useAppStore((s) => s.answerElicitation);
  const stale = useAppStore((s) => s.staleRequests.includes(block.id));
  const fields = schemaFields(block.schema);
  const [answers, setAnswers] = useState<ElicitationDraft>(() =>
    Object.fromEntries(fields.map((field) => [field.name, initialValue(field)])),
  );
  const scope = useId();

  if (block.status === "accepted") {
    return (
      <Alert data-testid="block-elicitation" data-state="accepted" variant="success">
        <CheckIcon className="size-4 text-success" />
        <AlertTitle>{block.title ?? "Answered"}</AlertTitle>
        {block.answers && Object.keys(block.answers).length > 0 ? (
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {Object.entries(block.answers).map(([key, value]) => (
                <li key={key} className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="font-medium text-foreground">{String(value)}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        ) : null}
      </Alert>
    );
  }
  if (block.status === "declined" || block.status === "cancelled") {
    return (
      <Alert data-testid="block-elicitation" data-state={block.status} variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>
          {block.status === "declined" ? "Declined" : (block.title ?? "Request dismissed")}
        </AlertTitle>
      </Alert>
    );
  }
  if (stale) {
    return (
      <Alert data-testid="block-elicitation" data-state="stale" variant="default">
        <CircleSlashIcon className="size-4 text-muted-foreground" />
        <AlertTitle>No longer waiting</AlertTitle>
        <AlertDescription>
          Nothing is waiting on this request any more, so the answer was not delivered.
        </AlertDescription>
      </Alert>
    );
  }

  function set(name: string, value: ElicitValue): void {
    setAnswers((prev) => ({ ...prev, [name]: value }));
  }
  function submit(): void {
    void answerElicitation(block.turnId, block.id, toContent(fields, answers));
  }
  function cancel(): void {
    void answerElicitation(block.turnId, block.id, null);
  }

  const complete = isComplete(fields, answers);

  return (
    <Alert data-testid="block-elicitation" data-state="pending" variant="info">
      <MessageCircleQuestionIcon className="size-4 text-info" />
      <AlertTitle>{block.title ?? "The agent needs more information"}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {block.description ? <span>{block.description}</span> : null}
        {fields.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="elicitation-form">
            {fields.map((field) => {
              const { name, prop, required } = field;
              const label = prop.title || name;
              const options = enumValues(prop);
              const value = answers[name];
              const controlId = `${scope}-${name}`;
              const describedBy = prop.description ? `${controlId}-description` : undefined;
              return (
                <div key={name} className="flex flex-col gap-1" data-testid={`elicit-field-${name}`}>
                  <label htmlFor={controlId} className="text-sm text-foreground">
                    {label}
                    {required ? <span className="ml-1 text-muted-foreground">*</span> : null}
                  </label>
                  {prop.description ? (
                    <span id={describedBy} className="text-xs text-muted-foreground">
                      {prop.description}
                    </span>
                  ) : null}
                  {options.length > 0 ? (
                    <select
                      id={controlId}
                      aria-required={required}
                      aria-describedby={describedBy}
                      value={String(value ?? "")}
                      onChange={(e) => set(name, e.target.value)}
                      className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
                    >
                      <option value="">Choose…</option>
                      {options.map((option, index) => (
                        <option key={option} value={option}>
                          {enumLabel(prop, index, option)}
                        </option>
                      ))}
                    </select>
                  ) : prop.type === "boolean" ? (
                    <input
                      id={controlId}
                      type="checkbox"
                      className="size-4 self-start"
                      aria-required={required}
                      aria-describedby={describedBy}
                      checked={value === true}
                      onChange={(e) => set(name, e.target.checked)}
                    />
                  ) : (
                    <input
                      id={controlId}
                      type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
                      aria-required={required}
                      aria-describedby={describedBy}
                      value={String(value ?? "")}
                      onChange={(e) => set(name, e.target.value)}
                      className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={!complete}
            data-testid="elicitation-submit"
            onClick={submit}
          >
            <CheckIcon className="size-3.5" />
            {fields.length > 0 ? "Submit" : "Accept"}
          </Button>
          <Button size="sm" variant="outline" data-testid="elicitation-cancel" onClick={cancel}>
            <XIcon className="size-3.5" />
            {fields.length > 0 ? "Cancel" : "Decline"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
