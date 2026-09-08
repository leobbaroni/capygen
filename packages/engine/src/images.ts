/**
 * Reading a stored attachment back for the backends that want bytes rather than
 * a path (Claude's `MessageParam`, the API loop's provider adapters).
 *
 * Codex is the exception and does not come through here: its app-server takes
 * `{type:"localImage", path}` and reads the file itself.
 *
 * A read failure is surfaced as an error, never as a missing image: a turn that
 * quietly lost its picture would leave the model answering a question about
 * something it was never shown.
 */
import { readFile } from "node:fs/promises";
import type { TurnImage } from "./harness.js";

export interface EncodedImage {
  mediaType: TurnImage["mediaType"];
  /** Base64 of the file as stored. */
  data: string;
  name: string;
}

export async function encodeTurnImage(image: TurnImage): Promise<EncodedImage> {
  let bytes: Buffer;
  try {
    bytes = await readFile(image.path);
  } catch (err) {
    throw new Error(
      `The attached image "${image.name}" could not be read back from the ` +
        `attachment store, so the message was not sent: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  return { mediaType: image.mediaType, data: bytes.toString("base64"), name: image.name };
}

export function encodeTurnImages(
  images: readonly TurnImage[] | undefined,
): Promise<EncodedImage[]> {
  return Promise.all((images ?? []).map(encodeTurnImage));
}

/** `data:` URL form, which is what the OpenAI Responses API takes. */
export function dataUrl(image: EncodedImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
