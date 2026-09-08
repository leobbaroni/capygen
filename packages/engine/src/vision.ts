/**
 * Which models capygen will actually hand a picture to.
 *
 * This is an allowlist, not a guess, and it fails closed: a model nobody has
 * written down here is not sent a picture, and the turn says so. The
 * alternative — assuming support and sending the image anyway — produces the
 * failure this whole feature exists to avoid: a backend that silently drops the
 * attachment (or errors deep inside a provider SDK) while the transcript still
 * shows a picture next to the question, implying it was read.
 *
 * What the *message* claims is narrower than what the gate does, and
 * deliberately so (`imageSupport`): a model on the text-only list is stated as
 * unable to read images, while a model nobody has listed either way is stated
 * as **unverified** — capygen has not confirmed it, which is not the same as
 * knowing it cannot. Saying "cannot" about a model that can would be its own
 * false claim, and the user is the one who can settle it.
 *
 * Verified per backend:
 *   - **claude** — the Claude Agent SDK takes an Anthropic `MessageParam`, so a
 *     `{type:"image", source:{type:"base64", …}}` block is exactly what the
 *     Messages API accepts. Every Claude 3+ model is multimodal.
 *   - **codex** — the app-server's user-input union carries `localImage`
 *     (`{type:"localImage", path}`, pinned `v2/UserInput.ts`); the GPT-5/4.1/4o
 *     families behind it take image input. `o1-mini`/`o3-mini` do not.
 *   - **api** — capygen's own loop; the provider adapters translate
 *     `ChatContent.image` to Anthropic `image` / OpenAI `input_image`.
 */
import type { Backend } from "@capygen/shared";

/** Model-id prefixes (lower-cased, vendor prefix stripped) that take images. */
const VISION_PREFIXES = [
  "claude-3", "claude-4", "claude-5",
  "claude-opus", "claude-sonnet", "claude-haiku", "claude-fable",
  "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5", "gpt-6",
  "o3", "o4-mini",
] as const;

/** Explicitly text-only ids that would otherwise match a prefix above. */
const TEXT_ONLY = ["o3-mini", "gpt-4o-audio", "gpt-4o-realtime"] as const;

/**
 * What capygen knows about one model's image input:
 *
 *   - `"yes"` — a listed multimodal family;
 *   - `"no"` — a listed text-only id, which is a fact worth stating;
 *   - `"unknown"` — nobody has written this id down. Treated as "do not send",
 *     but never *described* as unsupported.
 */
export type ImageSupport = "yes" | "no" | "unknown";

export function imageSupport(model: string): ImageSupport {
  const id = model.trim().toLowerCase().split("/").pop() ?? "";
  if (!id) return "unknown";
  if (TEXT_ONLY.some((prefix) => id.startsWith(prefix))) return "no";
  return VISION_PREFIXES.some((prefix) => id.startsWith(prefix)) ? "yes" : "unknown";
}

/**
 * `true` when this model accepts image input. `model` may carry an OpenRouter
 * style `vendor/model` prefix, which is stripped before matching. Unknown is
 * false: the gate fails closed even where the wording does not commit.
 */
export function modelAcceptsImages(model: string): boolean {
  return imageSupport(model) === "yes";
}

/**
 * The sentence shown when an agent is not sent the images the user attached.
 * Names both the agent and the model so the user can see *which* participant
 * did not get the picture — in a round table the others may well have — and
 * distinguishes a model known to be text-only from one capygen simply has no
 * record for.
 */
export function imageUnsupportedMessage(agentName: string, backend: Backend, model: string): string {
  const who = `${agentName} (${backend} · ${model})`;
  const tail =
    " The image is still in the transcript; ask an agent on a model capygen " +
    "knows reads images (Claude 3+, GPT-4o/4.1/5) to look at it.";
  return imageSupport(model) === "no"
    ? `${who} cannot read images, so the attached picture was not sent to it.${tail}`
    : `${who} is not a model capygen has verified for image input, so the ` +
      `attached picture was not sent to it — it may or may not read images.${tail}`;
}
