/**
 * Drop-in replacement for Omnigent's `BrandLogo`
 * (reference/omnigent/web/src/components/BrandLogo.tsx): same two props,
 * `className` and `variant`, so a page ported from the reference only needs
 * its import swapped —
 *
 *   import { BrandLogo } from "@/brand/BrandLogo";   // was "@/components/BrandLogo"
 *
 * Omnigent's version fetches an operator-configured logo (or an operator
 * icon) over the network and falls back to the Otto mascot; capygen has no
 * such per-deployment logo, so it always renders capygen's own mark — the
 * idle capybara — sized to match the reference's two call sites:
 * `variant="eyes"` is the hero mark (reference: `h-14 w-auto`, NewChatDialog's
 * landing), `variant="icon"` is the small inline mark (reference: `h-4
 * w-auto`, chatBubbleParts' working indicator).
 */
import { Mascot } from "./Mascot";

const VARIANT_SIZE_PX = {
  eyes: 56, // h-14
  icon: 16, // h-4
} as const;

export interface BrandLogoProps {
  className?: string;
  variant?: keyof typeof VARIANT_SIZE_PX;
}

export function BrandLogo({ className, variant = "eyes" }: BrandLogoProps) {
  return (
    <Mascot state="idle" size={VARIANT_SIZE_PX[variant]} className={className} />
  );
}
