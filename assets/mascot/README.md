# Pixel mascot

`pixel-reference.png` is the user's supplied eight-state capybara sheet (240×134).
`scripts/mascot-pixels.py` preserves its 29-colour pixel grid and draws four different frames
per state: blink, thinking gaze/bubble, typing paws, waiting, sparkles, error, breathing and
headphone/listening cues. The cell is 72×72 logical pixels with consistent padding.

Run from the repository root with Python and Pillow already available:

```sh
python scripts/mascot-pixels.py
```

No packages are installed by that command. The generator asserts binary alpha, original
palette membership and four distinct frames for every state, then writes:

- `pixel-animations.png`: 4 columns × 8 rows, 288px output cells (4× nearest-neighbour).
- `states/*.png`: first frame for static consumers; same output scale.
- `capybara-states-256.png`: legacy-named static strip; actual cell size is in the manifest.
- `capybara-states.json`: atlas layout and logical/output sizes.
- `pixel-preview.gif`: animated review board showing all eight states.

The app stages these from assets; never edit renderer/public. `Mascot.tsx` reads the atlas in
CSS steps, labelled for accessibility, with a stationary first frame for OS/app reduced motion.
The landing is 144px (exact 2× logical pixels). Small existing brand/header marks retain their
layout size. Old generated sheets are historical source assets, not the current atlas.

Two imagegen drafts were evaluated using prompts for a 4×8 capybara atlas with four drawn
frames per state and transparent pixel edges. They returned RGB backgrounds and were rejected.
The user explicitly authorized deterministic code finishing; the shipped art uses the original
reference, not those drafts. No generated draft is a production dependency.
