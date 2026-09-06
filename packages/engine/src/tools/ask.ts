/**
 * `ask_user_question` — the API harness's equivalent of Claude Code's
 * `AskUserQuestion` (SPEC R32).
 *
 * The input shape is **deliberately identical** to Claude's
 * (`questions[].{question, header, multiSelect, options[].{label, description}}`)
 * and so is the answer (`answers[question] = optionLabel`), because that is what
 * `QuestionBlock` and the renderer's `QuestionCard` already speak. A different
 * shape here would mean a second card component for no gain.
 *
 * Its permission class is `interaction`: it is never gated, in any permission
 * mode. Asking the user for permission to ask the user a question is a loop with
 * no exit, and Claude's own SDK reaches `canUseTool` for this tool even under
 * `bypassPermissions` for the same reason (COMPAT.md).
 */
import type { Question } from "@capygen/shared";
import { isRecord, type ToolDefinition, type ToolResult } from "./types.js";

/** Tool input → the domain `Question[]`; mirrors `ClaudeHarness.parseQuestions`. */
export function parseAskInput(input: unknown): Question[] {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const questions: Question[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = typeof item.question === "string" ? item.question : "";
    if (question.length === 0) continue;
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isRecord(option)) continue;
        const label = typeof option.label === "string" ? option.label : "";
        if (label.length === 0) continue;
        const description = typeof option.description === "string" ? option.description : undefined;
        options.push({ label, ...(description ? { description } : {}) });
      }
    }
    const header = typeof item.header === "string" && item.header.length > 0 ? item.header : undefined;
    questions.push({
      question,
      ...(header ? { header } : {}),
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return questions;
}

export const askUserQuestionTool: ToolDefinition = {
  name: "ask_user_question",
  description:
    "Ask the user one or more multiple-choice questions and wait for the answer. " +
    "Use it when a decision is the user's to make (which approach, which file, which name) " +
    "rather than guessing. Each question needs 2-4 concrete options; the user can also " +
    "type their own answer unless allow_other is false.",
  permissionClass: "interaction",
  family: "other",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "One to three questions to ask together.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, as a full sentence." },
            header: { type: "string", description: "A two- or three-word label for the card." },
            multiSelect: { type: "boolean", description: "Allow more than one option. Default false." },
            options: {
              type: "array",
              description: "The choices offered.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
      allow_other: {
        type: "boolean",
        description: 'Offer a free-text "Other" answer. Default true.',
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const questions = parseAskInput(input);
    if (questions.length === 0) {
      return {
        content: "ask_user_question needs at least one question with a non-empty options list.",
        isError: true,
      };
    }
    const allowOther = input.allow_other === undefined ? true : input.allow_other === true;
    const answers = await ctx.ask(questions, allowOther);
    const entries = Object.entries(answers);
    if (entries.length === 0) {
      return { content: "The user did not answer (the turn was cancelled or the card was dismissed)." };
    }
    return {
      content: entries.map(([question, answer]) => `${question}\n→ ${answer}`).join("\n\n"),
    };
  },
};
