#!/usr/bin/env python3
"""生成 PWA 应用图标。

设计要点：
- 背景完整出血（full-bleed），不留内缩的深色 padding（旧图标因此出现"黑影"）。
- 主色为红（A 股上涨色），曲线为"低位横盘企稳 → 强势拉升"的波段线。
- 圆角交由系统 / PWA maskable 遮罩处理，图标本身为纯方形。
- maskable 变体把内容缩进安全区（中心 80% 圆内），避免被遮罩裁切。

产物（public/icons/）：
  icon-192.png              192x192  purpose=any
  icon-512.png              512x512  purpose=any
  icon-maskable-512.png     512x512  purpose=maskable
  apple-touch-icon-180.png  180x180  iOS 主屏图标
用法：python3 scripts/gen-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 超采样倍数，抗锯齿

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")

# 背景：竖向红色渐变（上亮下暗），整体为红主色
BG_TOP = (214, 58, 44)
BG_BOT = (104, 12, 8)

LINE = (255, 255, 255)          # 波段线：白色
LINE_GLOW = (255, 255, 255)
PEAK = (255, 214, 79)           # 末端高点标记：金黄
GRID = (255, 255, 255)

# 波段线控制点，512 坐标系（y 向下）
WAVE = [
    (64, 380), (95, 362), (125, 374), (155, 358), (185, 370),
    (215, 352), (245, 344),          # 低位横盘企稳
    (280, 300), (315, 250), (350, 196),
    (388, 148), (430, 112), (452, 100),  # 强势拉升
]

GRID_YS = [170, 268, 366]        # 参考网格线
STROKE = 30                      # 512 坐标系线宽
DOT_R = 21


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def build_background(size):
    W = size * SS
    img = Image.new("RGB", (W, W))
    d = ImageDraw.Draw(img)
    for y in range(W):
        t = y / (W - 1)
        d.line([(0, y), (W, y)], fill=lerp(BG_TOP, BG_BOT, t))
    # 左上柔和高光，避免死板
    hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse([-W * 0.35, -W * 0.55, W * 0.85, W * 0.45], fill=(255, 120, 90, 70))
    hl = hl.filter(ImageFilter.GaussianBlur(W * 0.12))
    img = Image.alpha_composite(img.convert("RGBA"), hl).convert("RGB")
    return img


def draw_content(size, content_scale=1.0):
    """在透明层上绘制波段线等内容。

    坐标以 512 画布为基准；unit 为「1 个 512 坐标单位」在超采样空间里的像素数，
    content_scale 再围绕画布中心缩放（用于 maskable 安全区）。
    """
    W = size * SS
    unit = W / 512.0
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def tf(p):
        x = (p[0] - 256) * unit * content_scale + W / 2.0
        y = (p[1] - 256) * unit * content_scale + W / 2.0
        return (x, y)

    pts = [tf(p) for p in WAVE]
    w = STROKE * unit * content_scale

    # 参考网格（虚线）
    seg = 26 * unit * content_scale
    gap = 20 * unit * content_scale
    for gy in GRID_YS:
        y = tf((0, gy))[1]
        x = tf((48, gy))[0]
        end = tf((464, gy))[0]
        while x < end:
            d.line([(x, y), (min(x + seg, end), y)], fill=GRID + (46,),
                   width=max(1, int(4 * unit * content_scale)))
            x += seg + gap

    # 波段线外发光
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.line(pts, fill=LINE_GLOW + (110,), width=int(w * 1.9), joint="curve")
    glow = glow.filter(ImageFilter.GaussianBlur(w * 0.75))
    layer = Image.alpha_composite(layer, glow)
    d = ImageDraw.Draw(layer)

    # 主波段线
    d.line(pts, fill=LINE + (255,), width=int(w), joint="curve")
    r = w / 2.0
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=LINE + (255,))

    # 末端高点标记
    ex, ey = pts[-1]
    dr = DOT_R * unit * content_scale
    d.ellipse([ex - dr, ey - dr, ex + dr, ey + dr], fill=PEAK + (255,))
    return layer


def render(size, content_scale=1.0):
    bg = build_background(size)
    content = draw_content(size, content_scale)
    img = Image.alpha_composite(bg.convert("RGBA"), content)
    return img.resize((size, size), Image.LANCZOS).convert("RGB")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        # maskable：内容收进安全区，背景仍完整出血
        ("icon-maskable-512.png", 512, 0.80),
        # iOS apple-touch-icon 标准尺寸 180，内容比例与 any 一致
        ("apple-touch-icon-180.png", 180, 1.0),
    ]
    for name, size, scale in jobs:
        path = os.path.join(OUT_DIR, name)
        render(size, scale).save(path, "PNG", optimize=True)
        print("wrote", path, size)


if __name__ == "__main__":
    main()
