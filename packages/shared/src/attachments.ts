/**
 * Image attachments the user adds to a message — the one binary input capygen
 * accepts (SPEC R6's "what the user actually sent" applied to pictures).
 *
 * Two rules shape everything here:
 *
 *   1. **Nothing is described as read that was not read.** An image is only
 *      ever handed to a backend as a real image block (Claude `image`, Codex
 *      `localImage`, API `input_image`); it is never flattened into prose,
 *      never turned into a base64 blob inside the prompt text, and never
 *      represented by a chip the model cannot see. A model that cannot take
 *      images fails the turn with a message that says so.
 *   2. **The renderer is not trusted.** `mediaType` here is what the browser
 *      claimed; the main process sniffs the magic bytes before storing
 *      anything (`sniffImageMediaType`) and refuses a mismatch.
 *
 * Text/code attachments are a different, older mechanism (they are embedded in
 * the message text by the composer) and keep their own 64 KiB / 256 KiB budget.
 * These limits are deliberately separate.
 */
import { z } from "zod";

/** The three raster formats every backend capygen drives accepts today. */
export const INPUT_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type InputImageMediaType = (typeof INPUT_IMAGE_MEDIA_TYPES)[number];

export const InputImageMediaTypeSchema = z.enum(INPUT_IMAGE_MEDIA_TYPES);

/** Per-image and per-message ceilings, enforced in the composer *and* on IPC. */
export const IMAGE_ATTACHMENT_MAX_COUNT = 4;
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

/** Base64 grows by 4/3; the schema bound is on the encoded string. */
const MAX_BASE64_LENGTH = Math.ceil((IMAGE_ATTACHMENT_MAX_BYTES / 3) * 4) + 4;

/**
 * One picture on its way from the composer to the main process. `data` is the
 * raw file, base64-encoded — it exists only for this hop: the main process
 * writes the bytes to the attachment store and everything downstream (blocks,
 * harnesses, logs) refers to the stored file, never to this string.
 */
export const InputImageAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: InputImageMediaTypeSchema,
  /** Decoded byte length; checked against the decoded buffer on arrival. */
  size: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_BYTES),
  data: z.string().min(1).max(MAX_BASE64_LENGTH),
});
export type InputImageAttachment = z.infer<typeof InputImageAttachmentSchema>;

export const InputImageAttachmentsSchema = z
  .array(InputImageAttachmentSchema)
  .max(IMAGE_ATTACHMENT_MAX_COUNT)
  .default([]);

export const IMAGE_EXTENSIONS: Readonly<Record<InputImageMediaType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Identify a buffer by its magic bytes. Returns null for anything that is not
 * one of the three supported formats — including a GIF, a PDF or a renamed
 * archive — so a wrong or spoofed `mediaType` is refused rather than forwarded
 * to a backend that will reject it with something unreadable.
 */
export function sniffImageMediaType(bytes: Uint8Array): InputImageMediaType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a
    && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42
    && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * The refusal a caller shows for a file capygen will not attach. Written as a
 * complete sentence naming the file, because it is displayed verbatim in the
 * composer and (for the IPC path) thrown as an error message.
 */
export function unsupportedAttachmentMessage(name: string, declaredType?: string): string {
  const what = declaredType === "application/pdf"
    ? "PDFs are not supported"
    : declaredType && /^(?:audio|video)\//.test(declaredType)
      ? "audio and video are not supported"
      : "this file type is not supported";
  return `${name}: ${what}. Attach a PNG, JPEG or WebP image, or a UTF-8 text or code file.`;
}
