"""
Generate simple icons for the Video Downloader Pro extension.
Run: python generate_icons.py
Requires: pip install Pillow
"""
import os

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Installing Pillow...")
    os.system("pip install Pillow")
    from PIL import Image, ImageDraw, ImageFont

sizes = [16, 32, 48, 128]
os.makedirs("icons", exist_ok=True)

for size in sizes:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle
    margin = size * 0.05
    draw.ellipse([margin, margin, size - margin, size - margin], fill=(231, 76, 60, 255))

    # Play triangle (white)
    cx, cy = size / 2, size / 2
    r = size * 0.28
    points = [
        (cx - r * 0.6, cy - r),
        (cx - r * 0.6, cy + r),
        (cx + r, cy),
    ]
    draw.polygon(points, fill=(255, 255, 255, 255))

    # Small download arrow at bottom right (for sizes >= 32)
    if size >= 32:
        ar = size * 0.18
        ax = size * 0.72
        ay = size * 0.72
        draw.rectangle([ax - ar * 0.2, ay - ar, ax + ar * 0.2, ay], fill=(255, 255, 255, 200))
        draw.polygon([
            (ax - ar * 0.5, ay),
            (ax + ar * 0.5, ay),
            (ax, ay + ar * 0.6)
        ], fill=(255, 255, 255, 200))

    img.save(f"icons/icon{size}.png")
    print(f"Generated icons/icon{size}.png")

print("Done!")
