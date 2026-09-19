"""Render the Open Graph card from the real brand kit.

Writes public/og.png (1200x630) and public/icon.png (512). Deliberately a
one-shot generator run by hand, not a build step: the card changes when the
brand does, which is approximately never, and adding a Python dependency to
`npm run build` for one static image would be a worse trade.
"""
import io
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

PAPER = (255, 255, 255)
INK = (17, 17, 17)
GRID = (236, 236, 236)
YELLOW = (251, 188, 4)
BLUE = (66, 133, 244)
GREEN = (52, 168, 83)
RED = (234, 67, 53)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.getcwd()
FONTS = os.path.join(ROOT, 'public', 'fonts')


def ttf(name):
    """woff2 -> in-memory ttf, so PIL can use the actual brand typeface."""
    f = TTFont(os.path.join(FONTS, name))
    buf = io.BytesIO()
    f.flavor = None
    f.save(buf)
    buf.seek(0)
    return buf


BLACK_TTF = ttf('Archivo-Black.woff2')
BOLD_TTF = ttf('Archivo-Bold.woff2')


def font(buf, size):
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def graph_paper(d, w, h, step):
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=GRID, width=2)
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=GRID, width=2)


def sticker(d, x, y, w, h, fill, radius=18, drop=10):
    """The kit's card: hard ink shadow straight down, no blur, ink outline."""
    d.rounded_rectangle([x, y + drop, x + w, y + h + drop], radius, fill=INK)
    d.rounded_rectangle([x, y, x + w, y + h], radius, fill=fill, outline=INK, width=6)


def centred(d, text, fnt, cx, cy, fill):
    box = d.textbbox((0, 0), text, font=fnt)
    d.text((cx - (box[2] - box[0]) / 2 - box[0], cy - (box[3] - box[1]) / 2 - box[1]),
           text, font=fnt, fill=fill)


# ------------------------------------------------------------------ OG card
W, H = 1200, 630
img = Image.new('RGB', (W, H), PAPER)
d = ImageDraw.Draw(img)
graph_paper(d, W, H, 40)

def fit(buf, text, max_w, start):
    size = start
    while size > 10:
        f = font(buf, size)
        box = ImageDraw.Draw(Image.new('RGB', (1, 1))).textbbox((0, 0), text, font=f)
        if box[2] - box[0] <= max_w:
            return f
        size -= 2
    return font(buf, 10)


title = fit(BLACK_TTF, 'MOTION ARCADE', 880 - 80, 104)
sub = font(BOLD_TTF, 34)
tag = font(BOLD_TTF, 26)

# Yellow slab behind the wordmark: yellow is a surface, ink goes on top.
slab_w, slab_h = 880, 150
slab_x, slab_y = (W - slab_w) // 2, 150
sticker(d, slab_x, slab_y, slab_w, slab_h, YELLOW, radius=20, drop=12)
centred(d, 'MOTION ARCADE', title, W / 2, slab_y + slab_h / 2, INK)

sub = fit(BOLD_TTF, 'PLAY WITH YOUR WHOLE BODY — NO CONTROLLER', W - 160, 34)
centred(d, 'PLAY WITH YOUR WHOLE BODY — NO CONTROLLER', sub, W / 2, 370, INK)

# Four brand chips, the same object the menu uses.
labels = [('67 SPEED', RED), ('FRUIT NINJA', GREEN), ('RED LIGHT', BLUE), ('+ 4 MORE', YELLOW)]
cw, gap = 250, 20
total = cw * len(labels) + gap * (len(labels) - 1)
cx = (W - total) // 2
for text, colour in labels:
    sticker(d, cx, 440, cw, 74, colour, radius=16, drop=8)
    centred(d, text, tag, cx + cw / 2, 440 + 37, INK)
    cx += cw + gap

d.rectangle([0, H - 14, W, H], fill=INK)
img.save(os.path.join(ROOT, 'public', 'og.png'), optimize=True)
print('og.png', os.path.getsize(os.path.join(ROOT, 'public', 'og.png')), 'bytes')

# ------------------------------------------------------------------ app icon
S = 512
icon = Image.new('RGB', (S, S), YELLOW)
di = ImageDraw.Draw(icon)
# A body: head + shoulders, flat ink. Reads at 16px as a figure, which is what
# every one of these games is about.
di.ellipse([S * 0.36, S * 0.16, S * 0.64, S * 0.44], fill=INK)
di.rounded_rectangle([S * 0.24, S * 0.50, S * 0.76, S * 0.86], S * 0.10, fill=INK)
di.rectangle([0, 0, S - 1, S - 1], outline=INK, width=int(S * 0.06))
icon.save(os.path.join(ROOT, 'public', 'icon.png'), optimize=True)
print('icon.png', os.path.getsize(os.path.join(ROOT, 'public', 'icon.png')), 'bytes')
