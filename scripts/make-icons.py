"""Generate the app icon, tray icon and favicon from the idle mascot sprite.

Usage: python scripts/make-icons.py [assets/mascot/states/idle.png]

Source of truth is the 256px transparent idle mascot (Task B3, SPEC §Design
Reference — "Windows-first: app icon, tray icon, favicon"). Writes, all
pixel-nearest-resized so the pixel-art edges stay crisp at small sizes:

  assets/icons/icon.png              512px master (sharpened up from the
                                      256px source; still nearest-neighbour,
                                      never blurred, so the pixel art reads
                                      the same at every size)
  assets/icons/icon.ico              256/128/64/48/32/16, Windows multi-res
  assets/icons/tray.png              32px (Electron resizes for the actual
                                      16px tray slot; see apps/desktop's
                                      TRAY_ICON, which currently copies
                                      assets/mascot/states/idle.png directly
                                      at build time instead of this file —
                                      both are valid 32-ish px sources, kept
                                      in sync by hand for now)
  assets/icons/favicon.ico           16/32, for the renderer's browser tab

...then copies the ones an integrator actually wires up into their
conventional locations:

  apps/desktop/build/icons/icon.ico  electron-builder's Windows icon (Phase 12
                                      packaging; not wired into anything yet)
  apps/desktop/build/icons/icon.png  Linux/generic fallback + BrowserWindow
                                      `icon` option, if that gets added
  apps/desktop/build/icons/tray.png  spare tray source, see note above
  apps/renderer/public/favicon.ico   browsers request `/favicon.ico` by
                                      convention with no `<link>` tag needed;
                                      this is a direct copy (not stitched into
                                      apps/renderer/scripts/sync-assets.ts,
                                      which this task does not own) — an
                                      integrator should add it to that job
                                      list so a fresh clone regenerates it
                                      instead of relying on this committed
                                      copy alone.
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/mascot/states/idle.png"

ICONS_DIR = ROOT / "assets/icons"
DESKTOP_ICONS_DIR = ROOT / "apps/desktop/build/icons"
RENDERER_PUBLIC = ROOT / "apps/renderer/public"

ICO_SIZES = [256, 128, 64, 48, 32, 16]
FAVICON_SIZES = [32, 16]
MASTER_SIZE = 512
TRAY_SIZE = 32


def resize(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.NEAREST)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"make-icons: missing source sprite {SRC}")
    master_src = Image.open(SRC).convert("RGBA")
    if master_src.size[0] != master_src.size[1]:
        raise SystemExit(f"make-icons: expected a square source, got {master_src.size}")

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    DESKTOP_ICONS_DIR.mkdir(parents=True, exist_ok=True)

    # 512px master PNG.
    master = resize(master_src, MASTER_SIZE)
    master.save(ICONS_DIR / "icon.png")

    # Windows multi-resolution .ico. Pillow builds every requested size from
    # the frame it's given and embeds them all in one file when `sizes` lists
    # more than one — no separate per-size images needed.
    icon_frames = [resize(master_src, s) for s in ICO_SIZES]
    icon_frames[0].save(
        ICONS_DIR / "icon.ico",
        sizes=[(s, s) for s in ICO_SIZES],
    )

    # Tray source (Electron resizes to 16px at runtime; see module docstring).
    resize(master_src, TRAY_SIZE).save(ICONS_DIR / "tray.png")

    # Favicon: smaller multi-res .ico for the renderer's browser tab.
    favicon_frames = [resize(master_src, s) for s in FAVICON_SIZES]
    favicon_frames[0].save(
        ICONS_DIR / "favicon.ico",
        sizes=[(s, s) for s in FAVICON_SIZES],
    )

    # Copy the electron-builder / renderer conventional locations. Byte-level
    # copies, not a re-open-and-save: Pillow's ICO writer defaults to a fixed
    # size list when `sizes` isn't passed again, which would silently widen
    # (or narrow) the multi-res set baked in above.
    for name in ("icon.ico", "icon.png", "tray.png"):
        shutil.copyfile(ICONS_DIR / name, DESKTOP_ICONS_DIR / name)
    RENDERER_PUBLIC.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ICONS_DIR / "favicon.ico", RENDERER_PUBLIC / "favicon.ico")

    print(
        "wrote "
        f"{ICONS_DIR / 'icon.png'} ({MASTER_SIZE}px), "
        f"{ICONS_DIR / 'icon.ico'} ({ICO_SIZES}), "
        f"{ICONS_DIR / 'tray.png'} ({TRAY_SIZE}px), "
        f"{ICONS_DIR / 'favicon.ico'} ({FAVICON_SIZES}); "
        f"copied into {DESKTOP_ICONS_DIR} and {RENDERER_PUBLIC / 'favicon.ico'}"
    )


if __name__ == "__main__":
    main()
