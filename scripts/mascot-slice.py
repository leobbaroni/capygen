"""Slice the generated capybara sheet into per-state transparent sprites + a strip.

Usage: python scripts/mascot-slice.py [assets/mascot/capybara-sheet-v1.png]
Writes assets/mascot/states/<state>.png (256px square, transparent),
assets/mascot/capybara-states-256.png (8 cells in a row) and capybara-states.json.
"""
import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/mascot/capybara-sheet-v1.png"
OUT = ROOT / "assets/mascot"
STATES = ["idle", "thinking", "working", "waiting", "success", "error", "sleeping", "listening"]
COLS, ROWS = 4, 2
CELL = 256
WHITE_T = 235  # channel threshold for "background white"


def knock_out_background(cell: Image.Image) -> Image.Image:
    """Flood-fill from the border: only white connected to the edge becomes transparent."""
    rgba = cell.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        q.append((x, 0)); q.append((x, h - 1))
    for y in range(h):
        q.append((0, y)); q.append((w - 1, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        r, g, b, a = px[x, y]
        if r >= WHITE_T and g >= WHITE_T and b >= WHITE_T:
            px[x, y] = (0, 0, 0, 0)
            q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return rgba


def main() -> None:
    sheet = Image.open(SRC).convert("RGB")
    W, H = sheet.size
    cw, ch = W // COLS, H // ROWS
    states_dir = OUT / "states"
    states_dir.mkdir(parents=True, exist_ok=True)
    strip = Image.new("RGBA", (CELL * len(STATES), CELL), (0, 0, 0, 0))
    manifest = {"cell": CELL, "states": []}
    for idx, name in enumerate(STATES):
        c, r = idx % COLS, idx // COLS
        cell = sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
        cell = knock_out_background(cell)
        bbox = cell.getbbox()
        if not bbox:
            raise SystemExit(f"empty cell for {name}")
        cell = cell.crop(bbox)
        # pad to square with a little margin, keep bottom-aligned so feet line up
        side = int(max(cell.size) * 1.08)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(cell, ((side - cell.width) // 2, side - cell.height - int(side * 0.03)))
        sprite = canvas.resize((CELL, CELL), Image.NEAREST)
        sprite.save(states_dir / f"{name}.png")
        strip.paste(sprite, (idx * CELL, 0))
        manifest["states"].append({"name": name, "index": idx})
    strip.save(OUT / "capybara-states-256.png")
    (OUT / "capybara-states.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(STATES)} states, strip {strip.size}")


if __name__ == "__main__":
    main()
