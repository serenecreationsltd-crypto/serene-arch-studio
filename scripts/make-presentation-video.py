# Regenerates public/media/video/serene-creations-presentation.mp4 (+ poster).
# Inputs (not in the repo): the original renders from Google Drive (front_zoom.jpg,
# Rdr_Sal_Photo_-_1.jpg, Perspective_front.jpg, View-01.jpg, design_workk1.jpg, tuio.jpg)
# in <renders_dir>, and Playfair Display 800 / 700-italic + Inter 400-700 as .ttf in <fonts_dir>.
# Then: ffmpeg -i <mp4> -c:v libvpx-vp9 -b:v 0 -crf 37 -row-mt 1 -an <webm>
"""Render the Serene Creations presentation video frame-by-frame and pipe to ffmpeg.

usage: python3 make_video.py <renders_dir> <fonts_dir> <logo_png> <out_mp4> <out_poster_jpg>
"""
import os, sys, subprocess, math
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter

RENDERS, FONTS, LOGO, OUT_MP4, OUT_POSTER = sys.argv[1:6]
W, H, FPS = 1280, 720, 25
XFADE = 0.6

NAVY = (7, 16, 30)
TEAL = (10, 126, 115)
TEAL_LT = (15, 184, 168)
GOLD = (200, 146, 15)
TEXT = (226, 234, 244)
MUTED = (122, 154, 184)

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

PF_800 = lambda s: font("playfair-display-latin-800-normal.ttf", s)
PF_IT = lambda s: font("playfair-display-latin-700-italic.ttf", s)
IN_400 = lambda s: font("inter-latin-400-normal.ttf", s)
IN_500 = lambda s: font("inter-latin-500-normal.ttf", s)
IN_600 = lambda s: font("inter-latin-600-normal.ttf", s)
IN_700 = lambda s: font("inter-latin-700-normal.ttf", s)

def ease(p):  # easeInOutSine
    return 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, p)))

def fade_in(t, start, dur=0.6):
    return ease((t - start) / dur)

def with_alpha(layer, a):
    if a >= 0.999:
        return layer
    out = layer.copy()
    out.putalpha(layer.getchannel("A").point(lambda v: int(v * a)))
    return out

def text_center(draw, y, txt, fnt, fill, spacing=0):
    w = draw.textlength(txt, font=fnt) + spacing * max(0, len(txt) - 1)
    x = (W - w) / 2
    if spacing:
        for ch in txt:
            draw.text((x, y), ch, font=fnt, fill=fill)
            x += draw.textlength(ch, font=fnt) + spacing
    else:
        draw.text((x, y), txt, font=fnt, fill=fill)

def pill(draw, cx, y, txt, fnt, fg, bg, border, pad_x=18, pad_y=8, spacing=2):
    tw = draw.textlength(txt, font=fnt) + spacing * (len(txt) - 1)
    asc, desc = fnt.getmetrics()
    h = asc + desc + pad_y * 2
    x0 = cx - tw / 2 - pad_x
    draw.rounded_rectangle([x0, y, x0 + tw + pad_x * 2, y + h], radius=h / 2, fill=bg, outline=border, width=2)
    x = x0 + pad_x
    for ch in txt:
        draw.text((x, y + pad_y), ch, font=fnt, fill=fg)
        x += draw.textlength(ch, font=fnt) + spacing
    return h

# ── Shared backgrounds ─────────────────────────────────────────────────────
def brand_background():
    bg = Image.new("RGB", (W, H), NAVY)
    glow = Image.new("RGB", (W, H), NAVY)
    g = ImageDraw.Draw(glow)
    g.ellipse([W * 0.15, -H * 0.55, W * 0.85, H * 0.55], fill=(14, 52, 60))
    g.ellipse([W * 0.62, H * 0.62, W * 1.15, H * 1.25], fill=(40, 36, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(140))
    return Image.blend(bg, glow, 0.9)

BG = brand_background()
logo = Image.open(LOGO).convert("RGBA")

# ── Scene: title card ──────────────────────────────────────────────────────
def build_title_layers():
    layers = []
    # 1 badge
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    pill(d, W / 2, 168, "MUKONO · UGANDA", IN_600(17), GOLD, (34, 30, 18, 255), (110, 84, 22, 255))
    layers.append((0.3, l))
    # 2 logo + title
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    lg = logo.resize((84, 84), Image.LANCZOS)
    l.alpha_composite(lg, (W // 2 - 42, 228))
    text_center(d, 330, "Serene Creations", PF_800(88), (255, 255, 255))
    layers.append((0.7, l))
    # 3 subtitle
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    text_center(d, 456, "Architecture  ·  Structural Engineering  ·  Construction", IN_500(27), MUTED)
    layers.append((1.2, l))
    return layers

TITLE_LAYERS = build_title_layers()

def scene_title(t, dur):
    im = BG.copy().convert("RGBA")
    for start, layer in TITLE_LAYERS:
        a = fade_in(t, start)
        if a > 0:
            im.alpha_composite(with_alpha(layer, a))
    # teal rule grows under the title
    p = ease((t - 1.0) / 1.2)
    if p > 0:
        d = ImageDraw.Draw(im)
        half = 150 * p
        d.rounded_rectangle([W / 2 - half, 518, W / 2 + half, 522], radius=2, fill=TEAL_LT)
    return im.convert("RGB")

# ── Scene: render with Ken Burns + lower third ─────────────────────────────
def cover(img, w, h):
    s = max(w / img.width, h / img.height)
    img = img.resize((math.ceil(img.width * s), math.ceil(img.height * s)), Image.LANCZOS)
    x = (img.width - w) // 2; y = (img.height - h) // 2
    return img.crop((x, y, x + w, y + h))

LOWER = Image.new("RGBA", (W, H))
_ld = ImageDraw.Draw(LOWER)
_g0 = int(H * 0.42)
for y in range(_g0, H):
    a = int(238 * ((y - _g0) / (H - _g0)) ** 1.15)
    _ld.line([(0, y), (W, y)], fill=(4, 10, 20, a))
for y in range(0, 130):                      # faint top band behind the watermark
    a = int(120 * (1 - y / 130) ** 1.5)
    _ld.line([(0, y), (W, y)], fill=(4, 10, 20, a))

def with_shadow(layer, radius=6, strength=0.75):
    """Return layer composited over a soft dark shadow of itself."""
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    a = layer.getchannel("A").filter(ImageFilter.GaussianBlur(radius)).point(lambda v: int(v * strength))
    sh.putalpha(a)
    sh.alpha_composite(layer)
    return sh

def make_render_scene(fname, label, caption, pan):
    base_scale = 1.14
    src = ImageOps.exif_transpose(Image.open(os.path.join(RENDERS, fname))).convert("RGB")
    base = cover(src, int(W * base_scale), int(H * base_scale))
    txt = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(txt)
    lab_f = IN_700(17)
    x = 72
    d.rounded_rectangle([x, 566, x + 5, 650], radius=2, fill=GOLD)
    sx = x + 26
    for ch in label:
        d.text((sx, 568), ch, font=lab_f, fill=GOLD); sx += d.textlength(ch, font=lab_f) + 2.5
    d.text((x + 26, 598), caption, font=PF_IT(42), fill=(255, 255, 255))
    txt = with_shadow(txt)
    # small watermark top-left
    wm = Image.new("RGBA", (W, H)); dw = ImageDraw.Draw(wm)
    wm.alpha_composite(logo.resize((34, 34), Image.LANCZOS), (40, 34))
    dw.text((84, 40), "Serene Creations", font=IN_600(19), fill=(255, 255, 255, 240))
    wm = with_shadow(wm, radius=4, strength=0.6)

    def render(t, dur):
        p = t / dur
        z = 1.0 + 0.09 * ease(p)                       # slow push-in
        # crop window shrinks as z grows; keeps 16:9 and stays inside the base image
        cw = base.width / z
        ch = min(cw * H / W, base.height / z)
        cw = ch * W / H
        mx, my = (base.width - cw) / 2, (base.height - ch) / 2
        cx = base.width / 2 + pan[0] * mx * (2 * ease(p) - 1)
        cy = base.height / 2 + pan[1] * my * (2 * ease(p) - 1)
        x0 = min(max(0.0, cx - cw / 2), base.width - cw)
        y0 = min(max(0.0, cy - ch / 2), base.height - ch)
        box = (x0, y0, x0 + cw, y0 + ch)
        frame = base.resize((W, H), Image.BILINEAR, box=box).convert("RGBA")
        frame.alpha_composite(LOWER)
        frame.alpha_composite(wm)
        a = fade_in(t, 0.5, 0.7)
        if a > 0:
            frame.alpha_composite(with_alpha(txt, a))
        return frame.convert("RGB")
    return render

# ── Scene: end card ────────────────────────────────────────────────────────
def build_end_layers():
    layers = []
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    lg = logo.resize((72, 72), Image.LANCZOS)
    l.alpha_composite(lg, (W // 2 - 36, 150))
    text_center(d, 246, "Let's design your home.", PF_800(70), (255, 255, 255))
    layers.append((0.2, l))
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    pill(d, W / 2, 360, "BOOK A FREE CONSULTATION", IN_700(18), (255, 255, 255), (10, 126, 115, 255), (15, 184, 168, 255), pad_x=26, pad_y=12)
    layers.append((0.7, l))
    l = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(l)
    text_center(d, 466, "serenecreations.org", IN_700(34), TEXT)
    text_center(d, 520, "info@serenecreations.org   ·   +256 783 691 337", IN_500(26), MUTED)
    text_center(d, 610, "Serene Creations Ltd  ·  Mukono, Uganda", IN_400(19), (74, 106, 133))
    layers.append((1.1, l))
    return layers

END_LAYERS = build_end_layers()

def scene_end(t, dur):
    im = BG.copy().convert("RGBA")
    for start, layer in END_LAYERS:
        a = fade_in(t, start)
        if a > 0:
            im.alpha_composite(with_alpha(layer, a))
    return im.convert("RGB")

# ── Timeline ───────────────────────────────────────────────────────────────
RENDER_DUR = 4.8
scenes = [
    (4.2, scene_title),
    (RENDER_DUR, make_render_scene("front_zoom.jpg", "3D VISUALISATION", "See your home before you build it", (0.6, 0.2))),
    (RENDER_DUR, make_render_scene("Rdr_Sal_Photo_-_1.jpg", "ARCHITECTURAL DESIGN", "Contemporary homes, designed for Uganda", (-0.6, 0.0))),
    (RENDER_DUR, make_render_scene("Perspective_front.jpg", "HOUSE PLANS & APPROVALS", "Complete drawings, ready for submission", (0.5, -0.2))),
    (RENDER_DUR, make_render_scene("View-01.jpg", "STRUCTURAL ENGINEERING", "Bold forms, engineered to stand", (-0.5, 0.2))),
    (RENDER_DUR, make_render_scene("design_workk1.jpg", "BOQ & COST PLANNING", "Know your budget before the first block", (0.6, 0.0))),
    (RENDER_DUR, make_render_scene("tuio.jpg", "CONSTRUCTION SUPERVISION", "Quality checked on site, stage by stage", (-0.4, -0.2))),
    (5.4, scene_end),
]

starts, t0 = [], 0.0
for dur, _ in scenes:
    starts.append(t0); t0 += dur - XFADE
total = starts[-1] + scenes[-1][0]
nframes = int(round(total * FPS))

def frame_at(T):
    active = [(i, T - starts[i]) for i, (dur, _) in enumerate(scenes) if starts[i] <= T < starts[i] + dur]
    if not active:
        active = [(len(scenes) - 1, scenes[-1][0] - 1e-3)]
    i, lt = active[-1]
    im = scenes[i][1](lt, scenes[i][0])
    if len(active) == 2:
        j, ljt = active[0]
        prev = scenes[j][1](ljt, scenes[j][0])
        im = Image.blend(prev, im, ease(lt / XFADE))
    # global fade in/out from navy
    if T < 0.4:
        im = Image.blend(Image.new("RGB", (W, H), NAVY), im, T / 0.4)
    if T > total - 0.5:
        im = Image.blend(im, Image.new("RGB", (W, H), NAVY), (T - (total - 0.5)) / 0.5)
    return im

# poster: title card fully built
scene_title(3.6, 4.2).save(OUT_POSTER, quality=86)

ff = subprocess.Popen([
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-profile:v", "high", "-level", "4.0",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-tune", "film", OUT_MP4,
], stdin=subprocess.PIPE)
for n in range(nframes):
    ff.stdin.write(frame_at(n / FPS).tobytes())
    if n % 100 == 0:
        print(f"frame {n}/{nframes}", flush=True)
ff.stdin.close()
rc = ff.wait()
print("ffmpeg exit", rc, "duration", round(total, 2), "s frames", nframes)
sys.exit(rc)
