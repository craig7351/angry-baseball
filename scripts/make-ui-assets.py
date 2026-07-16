# 首頁 UI 素材加工：從參考圖切出 LOGO / 角色（去白背景）與球場背景，全部輸出 WebP
#   來源：C:\Users\craig\Pictures\angry-baseball\
#   輸出：public/assets/ui/*.webp
#   去背方式：從裁切區四角+邊中點 flood-fill 連通的白色區域 → 透明，
#   只清「背景白」，保留元素內部的白（棒球本體、字體亮面不會被誤刪）
from PIL import Image, ImageDraw
import os

SRC = r"C:\Users\craig\Pictures\angry-baseball"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "ui")
os.makedirs(OUT, exist_ok=True)

sheet = Image.open(os.path.join(SRC, "73d238d3-e334-4032-8894-5f40de827c70.png")).convert("RGBA")
mock = Image.open(os.path.join(SRC, "e4624928-a1b7-430c-b079-7691b23ddb34.png")).convert("RGB")

def save_webp(im, name, quality=88):
    path = os.path.join(OUT, name)
    im.save(path, "WEBP", quality=quality, method=6)   # method=6：壓最小（慢一點沒差，離線工具）
    print(name, im.size, round(os.path.getsize(path) / 1024), "KB")

def cut(box, name, maxw=520):
    im = sheet.crop(box).copy()
    w, h = im.size
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for s in seeds:
        r, g, b, a = im.getpixel(s)
        if a > 0 and r > 205 and g > 205 and b > 205:   # 只從白色種子點開始清
            ImageDraw.floodfill(im, s, (255, 255, 255, 0), thresh=48)
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    save_webp(im, name)

# 元件圖鑑（白底）各區塊
cut((20, 60, 545, 365), "logo.webp", 640)          # 憤怒棒球 LOGO
cut((540, 25, 820, 385), "batter.webp", 420)       # 揮棒打者
cut((820, 75, 1045, 395), "pig.webp", 360)         # 豬投手
cut((1165, 855, 1402, 1060), "fireball.webp", 320) # 火焰球

# 球場背景：mockup 右側乾淨區域（避開烙在圖上的假 UI 與 LOGO 殘邊）
save_webp(mock.crop((665, 95, 1550, 775)), "landing-bg.webp", quality=84)
