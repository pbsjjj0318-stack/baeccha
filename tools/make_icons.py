#!/usr/bin/env python3
"""앱 아이콘(PNG)을 만든다. 실행: python3 tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "icons")
BLUE = (29, 78, 216, 255)
WHITE = (255, 255, 255, 255)
DARK = (13, 33, 84, 255)


def bus(size, pad=0.0, bg_radius=0.22):
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if pad:
        inset = S * pad
        d.rounded_rectangle([inset, inset, S - inset, S - inset], radius=S * bg_radius, fill=BLUE)
    else:
        d.rounded_rectangle([0, 0, S, S], radius=S * bg_radius, fill=BLUE)

    k = 1.0 - 2 * pad  # 그림 영역 축소 비율
    off = S * pad

    def X(f):
        return off + f * S * k

    def Y(f):
        return off + f * S * k

    # 차체
    d.rounded_rectangle([X(0.14), Y(0.28), X(0.86), Y(0.70)], radius=S * 0.05 * k, fill=WHITE)
    # 앞 유리 / 창문 3개
    d.rounded_rectangle([X(0.19), Y(0.34), X(0.44), Y(0.50)], radius=S * 0.022 * k, fill=BLUE)
    d.rounded_rectangle([X(0.48), Y(0.34), X(0.65), Y(0.50)], radius=S * 0.022 * k, fill=BLUE)
    d.rounded_rectangle([X(0.69), Y(0.34), X(0.81), Y(0.50)], radius=S * 0.022 * k, fill=BLUE)
    # 앞문
    d.rounded_rectangle([X(0.19), Y(0.55), X(0.30), Y(0.66)], radius=S * 0.018 * k, fill=BLUE)
    # 옆 창
    d.rounded_rectangle([X(0.35), Y(0.55), X(0.81), Y(0.63)], radius=S * 0.016 * k, fill=BLUE)
    # 바퀴
    for cx in (0.33, 0.67):
        r = S * 0.085 * k
        x, y = X(cx), Y(0.735)
        d.ellipse([x - r, y - r, x + r, y + r], fill=DARK)
        r2 = r * 0.42
        d.ellipse([x - r2, y - r2, x + r2, y + r2], fill=WHITE)
    return img


def save(img, name):
    p = os.path.join(OUT, name)
    img.convert("RGBA").save(p, "PNG")
    print("saved", p, img.size)


def main():
    os.makedirs(OUT, exist_ok=True)
    save(bus(192), "icon-192.png")
    save(bus(512), "icon-512.png")
    save(bus(512, pad=0.12), "icon-maskable-512.png")
    save(bus(180, bg_radius=0.0).convert("RGB"), "apple-touch-icon.png")


if __name__ == "__main__":
    main()
