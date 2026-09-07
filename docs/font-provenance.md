# CheGuevara Barry Brown font provenance

Inspected 2026-09-07 from the exact repository asset, without installing or changing it.
The earlier handoff checked only for a standalone license file; the TTF itself contains an
explicit notice in its OpenType `name` table:

```text
name ID 0: CC0 - No Rights Reserved
name ID 1: CheGuevara Barry
name ID 2: Brown
name ID 5: Version 1.000
name ID 9: DrJohnDee
name ID 12: http://www.fontspace.com/profile/DrJohnDee
name ID 1: CheGuevara Barry Brown
name ID 2: Bold
```

SHA-256: `f121fa2c8d8d9005d212f3738b1a8464bf5c26b2edd7bddee4a3fbf8d0a21141`.
The renderer public copy has identical bytes. The notice is embedded source evidence, not
an inferred license based on a download site's label or the absence of a README.

The [Creative Commons CC0 deed](https://creativecommons.org/publicdomain/zero/1.0/)
explains the rights waiver and permission to distribute. It does not verify any particular
work's ownership. The designer profile URL embedded in the file could not be retrieved by
the browser during this check. Third-party listings have inconsistent generic license labels;
none is used to replace the notice carried by this exact asset.

Astra decision: retain the requested font and preserve its embedded CC0 notice in the
packaged attribution material. Do not claim designer endorsement. No standalone attribution
file or Windows packaging configuration exists yet. `reference/omnigent/LICENSE` and
`reference/omnigent/NOTICE` describe the read-only reference tree and are not the capygen
font's attribution location. This document is the current repository evidence to carry into
the eventual package attribution file.

When Phase 12 packaging is implemented, the exact preservation/check steps are:

1. Keep `assets/fonts/CheGuevaraBarry-Brown.ttf` as the source and let
   `apps/renderer/scripts/sync-assets.ts` stage the identical bytes at
   `apps/renderer/public/fonts/CheGuevaraBarry-Brown.ttf`; do not convert it to SVG.
2. Add a package attribution file beside the packaged app's existing legal metadata (the
   final electron-builder resource path is still undecided) containing the font name,
   creator name as embedded (`DrJohnDee`), the literal embedded notice `CC0 - No Rights
   Reserved`, the embedded FontSpace URL, and this document's SHA-256. Do not describe this
   as designer endorsement or add a stronger legal claim.
3. After building the installer and portable artifact, locate the shipped TTF and calculate
   its SHA-256. Require
   `f121fa2c8d8d9005d212f3738b1a8464bf5c26b2edd7bddee4a3fbf8d0a21141`; inspect its OpenType
   name table for the CC0 notice. Record the artifact path and result as Phase 12 evidence.

This closes the missing-notice investigation, not the packaged-asset verification, which
remains Phase 12 work. No packaging implementation is implied by this record.
