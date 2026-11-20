#!/usr/bin/env python3
"""
Render SYNTHETIC rehearsal form images (Governor 37A / 37B) from
fixtures/forms/governor-rehearsal.json into fixtures/forms/*.png.

These are deliberately plain mock-ups for testing capture and verification.
Every image carries a "SYNTHETIC REHEARSAL COPY - NOT AN IEBC FORM" banner and
watermark. They do not reproduce the official form layout, stamps or signatures.

    python3 scripts/fixtures/generate-form-images.py

Requires Pillow. Output is deterministic for a given Pillow version.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FORMS = os.path.join(ROOT, "fixtures", "forms")
FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def font(size, bold=False, mono=False):
    name = "DejaVuSansMono.ttf" if mono else ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    except OSError:
        return ImageFont.load_default()


INK = (30, 34, 40)
MUTED = (95, 102, 112)
RULE = (170, 176, 184)
BANNER = (176, 32, 32)
PAPER = (250, 249, 245)


def watermark(img):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font(64, bold=True)
    for y in range(140, img.size[1], 360):
        d.text((60, y), "SYNTHETIC - NOT AN IEBC FORM", font=f, fill=(176, 32, 32, 28))
    rotated = layer.rotate(18, resample=Image.BICUBIC)
    img.alpha_composite(rotated)


def render(title, subtitle, ids, rows, footer, out_path):
    w, h = 1240, 1754  # A4 at ~150 dpi
    img = Image.new("RGBA", (w, h), PAPER + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 70], fill=BANNER)
    d.text((40, 18), "SYNTHETIC REHEARSAL COPY - NOT AN IEBC FORM - NOT A RESULT", font=font(28, bold=True), fill=(255, 255, 255))
    d.text((60, 110), title, font=font(40, bold=True), fill=INK)
    d.text((60, 165), subtitle, font=font(24), fill=MUTED)
    y = 230
    for label, value in ids:
        d.text((60, y), label, font=font(22), fill=MUTED)
        d.text((520, y), str(value), font=font(24, mono=True), fill=INK)
        y += 40
    y += 20
    d.line([60, y, w - 60, y], fill=RULE, width=2)
    y += 25
    d.text((60, y), "Item", font=font(24, bold=True), fill=INK)
    d.text((w - 320, y), "Figure (as printed)", font=font(24, bold=True), fill=INK)
    y += 45
    for label, value in rows:
        d.line([60, y - 8, w - 60, y - 8], fill=(220, 223, 228), width=1)
        d.text((60, y), label, font=font(24), fill=INK)
        d.rectangle([w - 320, y - 6, w - 80, y + 34], outline=RULE, width=2)
        d.text((w - 300, y), str(value), font=font(28, mono=True), fill=INK)
        y += 56
    y += 30
    for line in footer:
        d.text((60, y), line, font=font(20), fill=MUTED)
        y += 32
    watermark(img)
    img.convert("RGB").quantize(colors=32).save(out_path, "PNG", optimize=True)
    print("wrote", os.path.relpath(out_path, ROOT))


def main():
    data = json.load(open(os.path.join(FORMS, "governor-rehearsal.json")))
    cands = data["candidates"]
    footer = [
        "Stamp and signature areas intentionally left blank: this is a synthetic test image.",
        "Fictional candidates, synthetic station and invented figures (NGAO360 rehearsal fixture).",
    ]
    for s in data["stationForms"]:
        rows = [("Registered voters in the polling station", s["registeredVoters"])]
        rows += [(f"Votes - {name}", v) for name, v in zip(cands, s["candidateVotes"])]
        rows += [
            ("Total valid votes", s["totalValidVotes"]),
            ("Rejected ballot papers", s["rejectedBallots"]),
            ("Total votes cast", s["totalVotesCast"]),
        ]
        render(
            "Synthetic Form 37A (rehearsal)",
            "County Governor - polling station result (synthetic)",
            [("County", "039 Bungoma"), ("Constituency", s["stationCode"][:7]), ("Polling station code", s["stationCode"])],
            rows,
            footer,
            os.path.join(FORMS, s["file"]),
        )
    c = data["collationForm"]
    rows = [("Polling stations included", c["stationsCount"])]
    rows += [(f"Votes - {name}", v) for name, v in zip(cands, c["candidateVotes"])]
    rows += [
        ("Total valid votes", c["totalValidVotes"]),
        ("Rejected ballot papers", c["rejectedBallots"]),
        ("Total votes cast", c["totalVotesCast"]),
    ]
    render(
        "Synthetic Form 37B (rehearsal)",
        "County Governor - constituency collation (synthetic)",
        [("County", "039 Bungoma"), ("Constituency", c["constituencyCode"]), ("Tally centre", c["tallyCentreCode"])],
        rows,
        footer,
        os.path.join(FORMS, c["file"]),
    )


if __name__ == "__main__":
    sys.exit(main())
