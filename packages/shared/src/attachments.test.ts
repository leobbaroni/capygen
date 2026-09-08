import { describe, expect, it } from "vitest";
import {
  InputImageAttachmentSchema,
  IMAGE_ATTACHMENT_MAX_BYTES,
  sniffImageMediaType,
  unsupportedAttachmentMessage,
} from "./attachments.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

describe("image attachment contract", () => {
  it("identifies the three supported formats by their magic bytes", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
  });

  it("refuses every other binary rather than guessing — a GIF and a PDF included", () => {
    expect(sniffImageMediaType(GIF)).toBeNull();
    expect(sniffImageMediaType(PDF)).toBeNull();
    expect(sniffImageMediaType(new Uint8Array([0, 1, 2]))).toBeNull();
    // A PNG signature truncated below 8 bytes is not a PNG.
    expect(sniffImageMediaType(PNG.slice(0, 4))).toBeNull();
  });

  it("names the reason a file cannot be attached", () => {
    expect(unsupportedAttachmentMessage("spec.pdf", "application/pdf")).toContain(
      "PDFs are not supported",
    );
    expect(unsupportedAttachmentMessage("clip.mp4", "video/mp4")).toContain(
      "audio and video are not supported",
    );
  });

  it("bounds one attachment: type, size and payload", () => {
    const ok = InputImageAttachmentSchema.safeParse({
      name: "a.png",
      mediaType: "image/png",
      size: 10,
      data: "AAAA",
    });
    expect(ok.success).toBe(true);

    expect(
      InputImageAttachmentSchema.safeParse({
        name: "a.gif",
        mediaType: "image/gif",
        size: 10,
        data: "AAAA",
      }).success,
    ).toBe(false);

    expect(
      InputImageAttachmentSchema.safeParse({
        name: "a.png",
        mediaType: "image/png",
        size: IMAGE_ATTACHMENT_MAX_BYTES + 1,
        data: "AAAA",
      }).success,
    ).toBe(false);
  });
});
