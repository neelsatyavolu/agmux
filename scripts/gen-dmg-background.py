#!/usr/bin/env python3
"""Generate the macOS DMG window background for agmux releases.

Simple drag-to-Applications layout (no Gatekeeper / xattr instructions).

Output:  src-tauri/dmg-background.png
         (referenced by tauri.conf.json -> bundle.macOS.dmg.background)

IMPORTANT: the geometry below MUST stay in sync with the `dmg` block in
src-tauri/tauri.conf.json (windowSize / appPosition / applicationFolderPosition).
Finder uses a top-left origin for icon positions.

Run:
    python3 -m venv /tmp/dmgvenv && /tmp/dmgvenv/bin/pip install pillow
    /tmp/dmgvenv/bin/python scripts/gen-dmg-background.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

# --- geometry (points; MUST match tauri.conf.json dmg config) ---------------
W, H = 680, 400
APP_POS = (195, 185)   # center of agmux.app icon       (appPosition)
APPS_POS = (485, 185)  # center of Applications symlink (applicationFolderPosition)
SS = 3                 # supersample factor; downscaled at the end for crisp edges

# --- palette (agmux zinc dark theme, from src/index.css) --------------------
BG = "#0a0a0b"
ARROW = "#52525b"

def S(v):
    """Scale a point value into supersampled pixel space."""
    return v * SS


img = Image.new("RGB", (S(W), S(H)), BG)
d = ImageDraw.Draw(img)

# arrow between the two icons, at icon-center height
ay = S(APP_POS[1])
ax1 = S(392)
d.line([(S(288), ay), (ax1, ay)], fill=ARROW, width=S(3))
head = S(9)
d.polygon([(ax1, ay - head), (ax1 + S(14), ay), (ax1, ay + head)], fill=ARROW)

out = Path(__file__).resolve().parent.parent / "src-tauri" / "dmg-background.png"
img.resize((W, H), Image.LANCZOS).save(out)
print(f"wrote {out}  ({W}x{H})")
