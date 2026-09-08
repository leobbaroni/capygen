/**
 * A picture the user attached, as the transcript records it.
 *
 * The bytes are not in the block row: the image is loaded from the app's
 * attachment store over the `capygen-attachment://` scheme, which is why it is
 * still here after a restart. If the file is gone the card says so — it never
 * renders an empty frame that could be mistaken for a picture the model saw.
 */
import { useState } from "react";
import type { ImageBlock } from "@capygen/shared";

const SCHEME = "capygen-attachment";
const EXTENSIONS: Record<ImageBlock["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Kept in step with `apps/desktop/src/ipc/attachments.ts`'s `attachmentUrl`. */
export function attachmentUrl(block: ImageBlock): string {
  return `${SCHEME}://file/${block.attachmentId}.${EXTENSIONS[block.mediaType]}`;
}

export function ImageBlockView({ block }: { block: ImageBlock }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure data-testid="block-image" className="my-1 max-w-sm">
      {failed ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {block.name} is no longer in the attachment store.
        </p>
      ) : (
        <img
          src={attachmentUrl(block)}
          alt={block.name}
          onError={() => setFailed(true)}
          className="max-h-72 rounded-md border border-border object-contain"
        />
      )}
      <figcaption className="pt-1 text-xs text-muted-foreground">{block.name}</figcaption>
    </figure>
  );
}
