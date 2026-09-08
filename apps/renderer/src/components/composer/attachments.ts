import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  INPUT_IMAGE_MEDIA_TYPES,
  sniffImageMediaType,
  unsupportedAttachmentMessage,
  type InputImageAttachment,
} from "@capygen/shared";

export interface TextAttachment { name: string; text: string; size: number }
export const ATTACHMENT_MAX_BYTES = 64 * 1024;
export const ATTACHMENT_TOTAL_BYTES = 256 * 1024;
export const ATTACHMENT_MAX_COUNT = 8;
/** Read selected user files only; a binary file never becomes a misleading text chip. */
export async function readTextAttachment(file: File): Promise<TextAttachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(`${file.name}: text attachments are limited to 64 KiB each.`);
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error(`${file.name}: could not read this file.`));
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("Invalid file read."));
    reader.readAsArrayBuffer(file);
  });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error(`${file.name}: choose a UTF-8 text or code file. Binary attachments are not supported here.`); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /^(?:image|audio|video)\//.test(file.type) || file.type === "application/pdf") throw new Error(`${file.name}: binary attachments are not supported here. Choose a text or code file.`);
  return { name: file.name, text, size: data.byteLength };
}
export function attachmentMessage(text: string, files: TextAttachment[]): string {
  if (!files.length) return text;
  return `${text}${text ? "\n\n" : ""}Attached text files (user-provided source content):\n${JSON.stringify(files.map(({ name, text }) => ({ name, content: text })), null, 2)}`;
}

// ---------------------------------------------------------------------------
// Images (PNG/JPEG/WebP) — real attachments, not text
// ---------------------------------------------------------------------------

/** One picked image, held in the composer until the message is sent. */
export interface ImageAttachment extends InputImageAttachment {
  /** Object URL for the chip preview; revoked when the chip goes away. */
  previewUrl: string;
}

/** Which of the two attachment paths a picked file belongs to. */
export function isImageFile(file: File): boolean {
  return (INPUT_IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type);
}

/**
 * Read one image into the shape `chat.send` takes.
 *
 * Nothing here interprets the picture: the bytes are base64-encoded and handed
 * to the main process, which sniffs them and stores them. The composer never
 * claims a model has seen an image — it only says the file was attached.
 */
export async function readImageAttachment(file: File): Promise<ImageAttachment> {
  if (!isImageFile(file)) throw new Error(unsupportedAttachmentMessage(file.name, file.type));
  if (file.size > IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${file.name}: images are limited to ${IMAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB each.`,
    );
  }
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name}: could not read this file.`));
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error("Invalid file read."));
    reader.readAsArrayBuffer(file);
  });
  const bytes = new Uint8Array(data);
  // The same magic-byte check the main process repeats: a `.png` that is really
  // something else is refused here, where the user can still fix it.
  const sniffed = sniffImageMediaType(bytes);
  if (!sniffed || sniffed !== file.type) {
    throw new Error(
      `${file.name}: this is not a valid ${file.type || "image"} file. Attach a PNG, JPEG or WebP image.`,
    );
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return {
    name: file.name,
    mediaType: sniffed,
    size: bytes.byteLength,
    data: btoa(binary),
    previewUrl: URL.createObjectURL(file),
  };
}

/** What `chat.send` carries: the preview URL is composer-local and dropped. */
export function toSendableImages(images: readonly ImageAttachment[]): InputImageAttachment[] {
  return images.map(({ name, mediaType, size, data }) => ({ name, mediaType, size, data }));
}
