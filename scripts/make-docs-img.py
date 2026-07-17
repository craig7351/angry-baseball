# 介紹頁（docs/）圖片加工：遊戲截圖 → 縮寬 1400 → WebP
from PIL import Image
import os, shutil

SRC = r"C:\Users\craig\Pictures\angry-baseball"
ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "docs", "img")
os.makedirs(OUT, exist_ok=True)

MAP = {
    "螢幕擷取畫面 2026-07-17 000246.png": "play.webp",       # 白天打擊視角
    "螢幕擷取畫面 2026-07-17 000319.png": "ballcam.webp",    # Ball-Cam 追球飛越樹林
    "螢幕擷取畫面 2026-07-17 000341.png": "superhr.webp",    # 超級全壘打 152.8m
    "螢幕擷取畫面 2026-07-17 000442.png": "boss-night.webp", # 夜間傳說對決 Boss
    "螢幕擷取畫面 2026-07-17 000519.png": "ring-sunset.webp",# 黃昏時機縮圈
    "螢幕擷取畫面 2026-07-17 000543.png": "snow-wolf.webp",  # 雪地狼投手
    "螢幕擷取畫面 2026-07-17 000622.png": "home.webp",       # 遊戲首頁
    "螢幕擷取畫面 2026-07-17 011118.png": "menu.webp",       # 模式選單
}
for src, dst in MAP.items():
    im = Image.open(os.path.join(SRC, src)).convert("RGB")
    if im.width > 1400:
        im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
    p = os.path.join(OUT, dst)
    im.save(p, "WEBP", quality=82, method=6)
    print(dst, im.size, round(os.path.getsize(p) / 1024), "KB")

# Hero 背景：乾淨的插畫球場（白天空留白給 LOGO/CTA）
hero = Image.open(os.path.join(SRC, "df68a3a1-707f-4ccd-98b1-876cfe6114c6.png")).convert("RGB")
if hero.width > 1680:
    hero = hero.resize((1680, round(hero.height * 1680 / hero.width)), Image.LANCZOS)
p = os.path.join(OUT, "hero-field.webp")
hero.save(p, "WEBP", quality=84, method=6)
print("hero-field.webp", hero.size, round(os.path.getsize(p) / 1024), "KB")

# LOGO 直接沿用遊戲內的去背版
shutil.copy(os.path.join(ROOT, "public", "assets", "ui", "logo.webp"), os.path.join(OUT, "logo.webp"))
print("logo.webp copied")
