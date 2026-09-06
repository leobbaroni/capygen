"""Build aligned pixel animations from the user's 240x134 reference (Pillow).

Run: python scripts/mascot-pixels.py
No image model, resampling filters, random state, or generated background.
The reference is already a 29-colour pixel drawing. Preserve its pixel clusters,
remove only border-connected white, and draw state-specific changes on that grid.
Output: 72px logical frames, 4x PNG atlas/static assets, and an animated preview.
"""
from collections import deque
import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/mascot'
NAMES = ['idle', 'thinking', 'working', 'waiting', 'success', 'error', 'sleeping', 'listening']
CELL, SCALE, FRAMES = 72, 4, 4
CLEAR = (0, 0, 0, 0)


def transparent(im):
    im = im.convert('RGBA')
    px = im.load()
    queue = deque([(x, y) for x in range(im.width) for y in (0, im.height - 1)] +
                  [(x, y) for y in range(im.height) for x in (0, im.width - 1)])
    seen = set()
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < im.width and 0 <= y < im.height):
            continue
        seen.add((x, y))
        if min(px[x, y][:3]) < 245:
            continue
        px[x, y] = CLEAR
        queue.extend([(x-1,y),(x+1,y),(x,y-1),(x,y+1)])
    return im


def eyes(draw, centers, y, phase, tan, ink):
    for x in centers:
        draw.rectangle((x-2, y-2, x+3, y+3), fill=tan)
        if phase == 1:
            draw.rectangle((x, y-1, x+1, y+1), fill=ink)
        elif phase == 2:
            draw.line((x-1, y+1, x+2, y+1), fill=ink)
        else:
            draw.line((x-1, y, x+2, y), fill=ink)


def move_mark(im, box, dy):
    patch = im.crop(box)
    ImageDraw.Draw(im).rectangle((box[0], box[1], box[2]-1, box[3]-1), fill=CLEAR)
    im.alpha_composite(patch, (box[0], box[1]+dy))


def main():
    source = Image.open(OUT / 'pixel-reference.png').convert('RGBA')
    assert source.size == (240, 134), 'Reference layout changed; review cell coordinates first'
    palette = {rgb for count, rgb in source.getcolors(10000)}
    ink = min(palette, key=lambda c: sum(c[:3]))
    tan = source.getpixel((25, 18))
    pink = source.getpixel((25, 48))
    gold = source.getpixel((30, 12))
    states = []
    for index, name in enumerate(NAMES):
        col, row = index % 4, index // 4
        base = transparent(source.crop((col*60, row*67, col*60+60, row*67+67)))
        if name == 'listening':
            # The enclosed space under the headband is background, unlike eye/bubble whites.
            for y in range(18):
                for x in range(60):
                    if min(base.getpixel((x,y))[:3]) >= 245:
                        base.putpixel((x,y), CLEAR)
        animation = []
        for frame in range(FRAMES):
            im = base.copy()
            d = ImageDraw.Draw(im)
            if frame:
                if name == 'idle':
                    eyes(d, (20,43), 24, frame, tan, ink)
                elif name == 'thinking':
                    eyes(d, (20,42), 24, frame, tan, ink)
                    move_mark(im, (46,1,59,21), (0,-1,1,0)[frame])
                    # A changing finger position inside the thinking paw.
                    d = ImageDraw.Draw(im)
                    d.point((36,40 + (frame % 2)), fill=ink)
                elif name == 'working':
                    # Draw alternate paw/finger contact with the fixed keyboard.
                    d.rectangle((24,47,28,49), fill=tan)
                    d.line((24,48+(frame%2),28,48+(frame%2)), fill=ink)
                    d.line((38,48,40,48), fill=gold if frame == 2 else ink)
                    d.point((42 + frame,42), fill=gold)
                    if frame == 2:
                        eyes(d, (21,43), 25, frame, tan, ink)
                elif name == 'waiting':
                    # Keep the whites, close the eyelids on the middle frame.
                    if frame == 2:
                        eyes(d, (18,41), 23, frame, tan, ink)
                    move_mark(im, (46,0,59,20), (0,1,0,1)[frame])
                    d = ImageDraw.Draw(im)
                    d.point((31,35), fill=pink if frame == 3 else ink)
                elif name == 'success':
                    # Four sparkle patterns, no movement of the complete image.
                    for x,y in ((6,20),(53,11),(55,20)):
                        d.rectangle((x-2,y-3,x+2,y+3), fill=CLEAR)
                        radius = 1 + ((frame+x) % 2)
                        d.line((x-radius,y,x+radius,y), fill=ink)
                        d.line((x,y-radius,x,y+radius), fill=ink)
                        d.point((x,y), fill=gold)
                    if frame == 2:
                        eyes(d, (21,43), 22, frame, tan, ink)
                    d.line((7,35,9,34 if frame == 1 else 35), fill=tan)
                elif name == 'error':
                    # Distinct worried blink; the cross changes size, not position.
                    if frame == 2:
                        eyes(d, (20,42), 21, frame, tan, ink)
                    d.rectangle((49,3,57,11), fill=CLEAR)
                    red = source.getpixel((112,73))
                    radius = (3,2,3,1)[frame]
                    d.line((53-radius,7-radius,53+radius,7+radius), fill=red, width=2)
                    d.line((53-radius,7+radius,53+radius,7-radius), fill=red, width=2)
                    d.point((28+frame,32), fill=ink)
                elif name == 'sleeping':
                    move_mark(im, (46,1,59,18), (0,1,0,-1)[frame])
                    d = ImageDraw.Draw(im)
                    # Breathing is drawn in the muzzle and sleeve contour.
                    d.line((34,36,35+(frame%2),36), fill=ink)
                    d.line((24,49,26,49), fill=tan if frame == 2 else pink)
                elif name == 'listening':
                    move_mark(im, (47,1,59,19), (0,1,-1,0)[frame])
                    d = ImageDraw.Draw(im)
                    # Alternate eye expression and headphone cup highlights.
                    eyes(d, (19,41), 23, frame, tan, ink)
                    d.line((5,26,5,28), fill=gold if frame == 2 else ink)
            canvas = Image.new('RGBA', (CELL,CELL), CLEAR)
            canvas.alpha_composite(im, (6,2))
            assert set(canvas.getchannel('A').tobytes()) <= {0,255}
            assert all(c[3] == 0 or c in palette for _, c in canvas.getcolors(CELL*CELL))
            animation.append(canvas)
        assert len({im.tobytes() for im in animation}) == FRAMES, name
        states.append(animation)
    atlas = Image.new('RGBA', (CELL*FRAMES,CELL*len(NAMES)), CLEAR)
    strip = Image.new('RGBA', (CELL*len(NAMES),CELL), CLEAR)
    (OUT/'states').mkdir(exist_ok=True)
    for row, (name, frames) in enumerate(zip(NAMES,states)):
        for col, frame in enumerate(frames):
            atlas.alpha_composite(frame, (col*CELL,row*CELL))
        frames[0].resize((CELL*SCALE,CELL*SCALE), Image.Resampling.NEAREST).save(OUT/'states'/f'{name}.png')
        strip.alpha_composite(frames[0], (row*CELL,0))
    atlas.resize((atlas.width*SCALE,atlas.height*SCALE),Image.Resampling.NEAREST).save(OUT/'pixel-animations.png')
    # Preserve the legacy static strip filename; its current dimensions are in the manifest.
    strip.resize((strip.width*SCALE,strip.height*SCALE),Image.Resampling.NEAREST).save(OUT/'capybara-states-256.png')
    (OUT/'capybara-states.json').write_text(json.dumps({
        'cell':CELL*SCALE,'logicalCell':CELL,'scale':SCALE,'frames':FRAMES,
        'atlas':'pixel-animations.png','columns':FRAMES,'rows':len(NAMES),
        'states':[{'name':n,'index':i} for i,n in enumerate(NAMES)]
    },indent=2)+'\n')
    preview = []
    for f in range(FRAMES):
        board = Image.new('RGBA',(CELL*4,CELL*2),(35,32,32,255))
        for i in range(8): board.alpha_composite(states[i][f],((i%4)*CELL,(i//4)*CELL))
        preview.append(board.convert('RGB').resize((CELL*4*3,CELL*2*3),Image.Resampling.NEAREST))
    preview[0].save(OUT/'pixel-preview.gif',save_all=True,append_images=preview[1:],duration=250,loop=0,disposal=2)
    print('PASS: 8 states x 4 distinct drawn frames; 72px logical grid; 4x nearest-neighbor; binary alpha; original palette')


if __name__ == '__main__':
    main()
