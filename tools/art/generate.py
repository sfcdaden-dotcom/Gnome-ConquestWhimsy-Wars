#!/usr/bin/env python3
"""
Whimsy Wars icon art.

Every garden type and every unit is drawn here, by hand, in shape primitives —
no emoji font, no traced clip art. The drawings live in code so the whole set
can be re-rendered at a new size or re-tuned as one (a palette change should
never mean re-editing seven files by eye), and so a reviewer can read how a
mushroom is built instead of diffing a binary.

Run:  python3 tools/art/generate.py
Out:  src/assets/art/*.png   (128px, transparent, 4× supersampled)

House style
  - flat storybook shapes, one dark ink outline, one lighter highlight;
  - built inside a 0..1 unit square, so sizes below read as fractions of the
    icon and every drawing scales together;
  - a white sticker halo around unit art, because a gnome token sits on the
    seat's colour and must stay legible on all four of them.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

SIZE = 128          # exported edge, px
SS = 4              # supersample factor (drawn at SIZE*SS, resized down)
OUT = Path(__file__).resolve().parents[2] / "src" / "assets" / "art"

# --------------------------------------------------------------------------
# Palette — a warm garden-party set, kept small on purpose.
# --------------------------------------------------------------------------

INK = (58, 40, 32, 255)          # outline brown-black
CREAM = (247, 233, 202, 255)
CREAM_D = (219, 197, 158, 255)
WHITE = (255, 255, 255, 255)

RED = (198, 66, 54, 255)
RED_D = (156, 44, 38, 255)
ROOF = (176, 84, 64, 255)
WOOD = (124, 78, 48, 255)
WOOD_D = (92, 56, 34, 255)

GREEN = (76, 142, 62, 255)
GREEN_D = (48, 100, 44, 255)
GREEN_L = (126, 182, 88, 255)

GOLD = (232, 190, 60, 255)
GOLD_D = (196, 148, 34, 255)
GOLD_L = (250, 224, 122, 255)

ICE = (150, 212, 234, 255)
ICE_D = (94, 166, 200, 255)
ICE_L = (216, 243, 252, 255)

DARK = (38, 32, 56, 255)
PURPLE = (110, 88, 142, 255)

SKIN = (238, 190, 152, 255)
SKIN_D = (206, 152, 116, 255)
TUNIC = (74, 122, 156, 255)
SHELL = (214, 152, 78, 255)
SHELL_D = (168, 108, 52, 255)
SNAIL_BODY = (222, 226, 198, 255)

# --------------------------------------------------------------------------
# Drawing helpers — all take unit-square coordinates (0..1).
# --------------------------------------------------------------------------

N = SIZE * SS       # working canvas edge
LINE = 0.030        # default outline width, in units


def px(v: float) -> float:
    return v * N


def box(x0: float, y0: float, x1: float, y1: float):
    return [px(x0), px(y0), px(x1), px(y1)]


def pts(seq):
    return [(px(x), px(y)) for x, y in seq]


def w(units: float) -> int:
    """Outline width in device pixels (never thinner than 1)."""
    return max(1, round(px(units)))


def ellipse(d, b, fill, outline=INK, width=LINE):
    d.ellipse(box(*b), fill=fill, outline=outline, width=w(width))


def polygon(d, seq, fill, outline=INK, width=LINE):
    p = pts(seq)
    d.polygon(p, fill=fill)
    if outline is not None:
        d.line(p + [p[0]], fill=outline, width=w(width), joint="curve")


def pie(d, b, start, end, fill, outline=INK, width=LINE):
    d.pieslice(box(*b), start, end, fill=fill, outline=outline, width=w(width))


def rrect(d, b, r, fill, outline=INK, width=LINE):
    d.rounded_rectangle(box(*b), radius=px(r), fill=fill, outline=outline, width=w(width))


def stroke(d, seq, color, width, cap_round=True):
    p = pts(seq)
    d.line(p, fill=color, width=w(width), joint="curve")
    if cap_round:
        r = width / 2
        for x, y in seq:
            d.ellipse(box(x - r, y - r, x + r, y + r), fill=color)


def blob(cx: float, cy: float, rx: float, ry: float, angle: float, steps: int = 28):
    """An ellipse as a polygon, so it can be rotated (petals, leaves, husks)."""
    a = math.radians(angle)
    out = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x, y = rx * math.cos(t), ry * math.sin(t)
        out.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    return out


def teardrop(cx: float, cy: float, r: float, angle: float, stretch: float = 1.9, steps: int = 30):
    """A petal/leaf: round at the far end, pointed at the centre."""
    a = math.radians(angle)
    out = []
    for i in range(steps + 1):
        t = math.pi * i / steps
        # A half-circle swept outward, pinched back to a point at t=0/pi.
        d = math.sin(t)
        x = r * stretch * (1 - math.cos(t)) / 2
        y = r * d * 0.55
        out.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    for i in range(steps, -1, -1):
        t = math.pi * i / steps
        d = math.sin(t)
        x = r * stretch * (1 - math.cos(t)) / 2
        y = -r * d * 0.55
        out.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    return out


def canvas():
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def halo(img: Image.Image, amount: float = 0.042, color=WHITE) -> Image.Image:
    """A sticker outline: the art's own silhouette, grown and filled flat."""
    grow = max(1, round(px(amount)))
    a = img.split()[3].filter(ImageFilter.MaxFilter(grow * 2 + 1))
    ring = Image.new("RGBA", img.size, color[:3] + (0,))
    ring.putalpha(a)
    return Image.alpha_composite(ring, img)


def save(img: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT / f"{name}.png", optimize=True)
    print(f"  {name}.png")


# --------------------------------------------------------------------------
# Gardens
# --------------------------------------------------------------------------


def home():
    """A gnome cottage: pitched roof, round door, one lit window."""
    img, d = canvas()
    # Walls first, so the roof overhangs them.
    rrect(d, (0.20, 0.46, 0.80, 0.90), 0.04, CREAM)
    # Plank shading.
    stroke(d, [(0.24, 0.70), (0.76, 0.70)], CREAM_D, 0.018)
    # Chimney, behind the roof line.
    rrect(d, (0.64, 0.14, 0.76, 0.36), 0.02, WOOD)
    # Roof.
    polygon(d, [(0.50, 0.08), (0.92, 0.50), (0.08, 0.50)], ROOF)
    stroke(d, [(0.50, 0.13), (0.86, 0.49)], (206, 120, 96, 255), 0.020)
    # Door.
    pie(d, (0.40, 0.56, 0.62, 0.78), 180, 360, WOOD)
    d.rectangle(box(0.40, 0.67, 0.62, 0.90), fill=WOOD)
    d.line(pts([(0.40, 0.67), (0.40, 0.90)]), fill=INK, width=w(LINE))
    d.line(pts([(0.62, 0.67), (0.62, 0.90)]), fill=INK, width=w(LINE))
    ellipse(d, (0.555, 0.755, 0.595, 0.795), GOLD, outline=None)  # handle
    # Window.
    ellipse(d, (0.24, 0.56, 0.36, 0.68), GOLD_L)
    return img


def dandelion():
    """A fat yellow bloom over a leafy stem."""
    img, d = canvas()
    stroke(d, [(0.50, 0.94), (0.52, 0.72), (0.50, 0.56)], GREEN_D, 0.055)
    polygon(d, teardrop(0.52, 0.78, 0.13, 20), GREEN, width=0.022)
    polygon(d, teardrop(0.50, 0.70, 0.13, 165), GREEN_L, width=0.022)
    # Two rings of petals, the back ring darker so the head reads as a dome.
    for i in range(11):
        polygon(d, teardrop(0.50, 0.42, 0.115, i * 360 / 11 + 16), GOLD_D, width=0.018)
    for i in range(9):
        polygon(d, teardrop(0.50, 0.42, 0.095, i * 360 / 9), GOLD, width=0.018)
    ellipse(d, (0.42, 0.34, 0.58, 0.50), GOLD_L)
    return img


def mushroom():
    """Red cap, cream spots, a stout stalk."""
    img, d = canvas()
    # Stalk with a slight flare at the foot.
    polygon(
        d,
        [(0.39, 0.50), (0.61, 0.50), (0.66, 0.86), (0.60, 0.91), (0.40, 0.91), (0.34, 0.86)],
        CREAM,
    )
    stroke(d, [(0.44, 0.62), (0.44, 0.84)], CREAM_D, 0.020)
    # Cap.
    pie(d, (0.06, 0.14, 0.94, 0.78), 180, 360, RED)
    d.line(pts([(0.06, 0.46), (0.94, 0.46)]), fill=INK, width=w(LINE))
    ellipse(d, (0.20, 0.22, 0.34, 0.33), CREAM, outline=None)
    ellipse(d, (0.44, 0.17, 0.60, 0.29), CREAM, outline=None)
    ellipse(d, (0.64, 0.28, 0.76, 0.38), CREAM, outline=None)
    ellipse(d, (0.28, 0.36, 0.38, 0.44), CREAM, outline=None)
    return img


def flytrap():
    """Two toothed jaws, held open on a stem, with the gullet showing."""
    img, d = canvas()
    stroke(d, [(0.50, 0.98), (0.44, 0.84), (0.50, 0.74)], GREEN_D, 0.060)
    polygon(d, teardrop(0.42, 0.88, 0.12, 185), GREEN, width=0.022)
    # The gullet, behind both lobes and visible through the gap.
    ellipse(d, (0.18, 0.26, 0.82, 0.72), RED_D)
    # Lobes: two half-ellipses held far enough apart that the mouth reads.
    pie(d, (0.10, 0.54, 0.90, 0.94), 0, 180, GREEN)
    pie(d, (0.10, 0.04, 0.90, 0.44), 180, 360, GREEN_L)
    # Teeth, interlocking across the gap.
    for i in range(5):
        x = 0.22 + i * 0.135
        polygon(d, [(x, 0.42), (x + 0.075, 0.42), (x + 0.037, 0.60)], CREAM, width=0.014)
        polygon(d, [(x + 0.068, 0.56), (x + 0.143, 0.56), (x + 0.105, 0.38)], CREAM, width=0.014)
    return img


def maize():
    """A cob of kernels in a husk."""
    img, d = canvas()
    polygon(d, teardrop(0.48, 0.62, 0.20, 150), GREEN, width=0.024)
    polygon(d, teardrop(0.52, 0.62, 0.20, 30), GREEN_L, width=0.024)
    ellipse(d, (0.33, 0.06, 0.67, 0.86), GOLD)
    # Kernels: offset rows, clipped to the cob by simple distance testing.
    for row in range(9):
        y = 0.14 + row * 0.075
        for col in range(4):
            x = 0.375 + col * 0.085 + (0.042 if row % 2 else 0)
            dx, dy = (x - 0.50) / 0.17, (y - 0.46) / 0.40
            if dx * dx + dy * dy > 0.80:
                continue
            ellipse(d, (x - 0.035, y - 0.032, x + 0.035, y + 0.032), GOLD_L, outline=GOLD_D, width=0.012)
    return img


def slippery():
    """An ice shard with a cold gleam."""
    img, d = canvas()
    hexagon = [(0.50, 0.05), (0.90, 0.28), (0.90, 0.72), (0.50, 0.95), (0.10, 0.72), (0.10, 0.28)]
    polygon(d, hexagon, ICE)
    polygon(d, [(0.50, 0.05), (0.90, 0.28), (0.50, 0.50), (0.10, 0.28)], ICE_L, outline=None)
    polygon(d, [(0.50, 0.50), (0.90, 0.72), (0.50, 0.95)], ICE_D, outline=None)
    d.line(pts(hexagon + [hexagon[0]]), fill=INK, width=w(LINE), joint="curve")
    stroke(d, [(0.50, 0.05), (0.50, 0.95)], ICE_D, 0.018)
    stroke(d, [(0.10, 0.28), (0.90, 0.72)], ICE_D, 0.018)
    stroke(d, [(0.24, 0.24), (0.34, 0.34)], WHITE, 0.036)
    return img


def tunnel():
    """A burrow mouth in a mound of earth."""
    img, d = canvas()
    # The mound: a wide, low bank of earth running off the bottom edge.
    pie(d, (-0.10, 0.40, 1.10, 1.44), 180, 360, WOOD)
    d.rectangle(box(0.0, 0.88, 1.0, 1.0), fill=WOOD)
    d.line(pts([(0.005, 0.89), (0.005, 1.0)]), fill=INK, width=w(LINE))
    d.line(pts([(0.995, 0.89), (0.995, 1.0)]), fill=INK, width=w(LINE))
    # The burrow mouth: a small arch, rimmed, with darkness inside.
    pie(d, (0.28, 0.54, 0.72, 1.06), 180, 360, WOOD_D)
    d.rectangle(box(0.28, 0.80, 0.72, 1.0), fill=WOOD_D)
    pie(d, (0.33, 0.60, 0.67, 1.02), 180, 360, DARK, outline=None)
    d.rectangle(box(0.33, 0.81, 0.67, 1.0), fill=DARK)
    d.line(pts([(0.28, 0.80), (0.28, 1.0)]), fill=INK, width=w(LINE))
    d.line(pts([(0.72, 0.80), (0.72, 1.0)]), fill=INK, width=w(LINE))
    # Grass tufts on the crown, and pebbles turned out of the earth.
    for x, lean in ((0.16, -0.05), (0.24, 0.04), (0.78, 0.05), (0.86, -0.04)):
        stroke(d, [(x, 0.66), (x + lean, 0.48)], GREEN, 0.030)
    ellipse(d, (0.10, 0.78, 0.19, 0.85), WOOD_D, outline=None)
    ellipse(d, (0.83, 0.76, 0.93, 0.84), WOOD_D, outline=None)
    return img


# --------------------------------------------------------------------------
# Units — worn on a seat-coloured token, so these get the white halo.
# --------------------------------------------------------------------------


def gnome():
    """Pointed hat, round nose, beard doing most of the work at 20px."""
    img, d = canvas()
    # Tunic and arms, mostly hidden behind the beard.
    rrect(d, (0.26, 0.62, 0.74, 0.92), 0.10, TUNIC)
    ellipse(d, (0.16, 0.62, 0.34, 0.80), TUNIC)
    ellipse(d, (0.66, 0.62, 0.84, 0.80), TUNIC)
    rrect(d, (0.30, 0.86, 0.46, 0.96), 0.04, WOOD_D)
    rrect(d, (0.54, 0.86, 0.70, 0.96), 0.04, WOOD_D)
    # Face.
    ellipse(d, (0.29, 0.28, 0.71, 0.66), SKIN)
    # Hat: a curved cone with a rolled brim.
    polygon(d, [(0.50, 0.03), (0.24, 0.34), (0.76, 0.34)], RED)
    rrect(d, (0.20, 0.28, 0.80, 0.40), 0.06, RED_D)
    # Beard: a broad wedge from ear to ear down to a point.
    polygon(
        d,
        [(0.28, 0.44), (0.72, 0.44), (0.70, 0.68), (0.50, 0.86), (0.30, 0.68)],
        WHITE,
    )
    stroke(d, [(0.42, 0.62), (0.50, 0.76), (0.58, 0.62)], CREAM_D, 0.018)
    # Nose over the beard, eyes under the brim.
    ellipse(d, (0.43, 0.44, 0.57, 0.58), SKIN_D)
    ellipse(d, (0.355, 0.415, 0.395, 0.455), INK, outline=None)
    ellipse(d, (0.605, 0.415, 0.645, 0.455), INK, outline=None)
    return halo(img)


def snail():
    """Spiral shell, two eyestalks, unbothered."""
    img, d = canvas()
    # Foot.
    polygon(
        d,
        [(0.06, 0.86), (0.10, 0.74), (0.30, 0.70), (0.74, 0.66), (0.86, 0.50),
         (0.95, 0.52), (0.94, 0.70), (0.78, 0.84), (0.20, 0.90)],
        SNAIL_BODY,
    )
    # Eyestalks.
    stroke(d, [(0.86, 0.56), (0.90, 0.36)], SNAIL_BODY, 0.055)
    stroke(d, [(0.76, 0.58), (0.72, 0.40)], SNAIL_BODY, 0.055)
    ellipse(d, (0.845, 0.245, 0.955, 0.355), SNAIL_BODY)
    ellipse(d, (0.665, 0.285, 0.775, 0.395), SNAIL_BODY)
    ellipse(d, (0.878, 0.278, 0.922, 0.322), INK, outline=None)
    ellipse(d, (0.698, 0.318, 0.742, 0.362), INK, outline=None)
    # Shell: a filled disc with a spiral groove wound into it.
    ellipse(d, (0.10, 0.20, 0.68, 0.78), SHELL)
    spiral = []
    for i in range(140):
        t = i / 139 * 4.6 * math.pi
        r = 0.275 * (1 - i / 139 * 0.92)
        spiral.append((0.39 + r * math.cos(t), 0.49 + r * math.sin(t)))
    stroke(d, spiral, SHELL_D, 0.030, cap_round=False)
    return halo(img)


# --------------------------------------------------------------------------

ICONS = {
    "garden-home": home,
    "garden-dandelion": dandelion,
    "garden-mushroom": mushroom,
    "garden-flytrap": flytrap,
    "garden-maize": maize,
    "garden-slippery": slippery,
    "garden-tunnel": tunnel,
    "unit-gnome": gnome,
    "unit-snail": snail,
}


def main() -> None:
    print(f"drawing {len(ICONS)} icons at {SIZE}px → {OUT}")
    for name, fn in ICONS.items():
        save(fn(), name)


if __name__ == "__main__":
    main()
