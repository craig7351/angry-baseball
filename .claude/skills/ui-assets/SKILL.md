---
name: ui-assets
description: 從參考圖（白底元件圖鑑或 AI 生成 mockup）切出遊戲 UI 素材：flood-fill 去白背景、裁切元件、轉 WebP 輸出到 public/assets/ui/。當使用者要「切素材」「去背」「處理參考圖」「加新的 UI 圖」「素材轉 webp」時使用。
---

# UI 素材加工流程（參考圖 → 去背 WebP）

把美術參考圖（通常是 AI 生成的白底元件圖鑑或完整 mockup）加工成遊戲可用的 UI 素材。
現成範本：`scripts/make-ui-assets.py`（首頁 LOGO/角色/背景就是用它切的），新素材直接在裡面加 `cut(...)` 行或仿照寫新腳本。

## 流程

1. **先用 Read 工具看原圖**，記下圖片實際尺寸（`file` 或 PIL 可查）。
2. **估裁切框**：在看圖時用「元素佔畫面的比例」換算成像素座標 `(left, top, right, bottom)`，框要留餘裕（寬鬆 10–20px），不要切到元素、也不要框到隔壁元素。
3. **跑腳本 → Read 輸出的 webp 檢查**：去背是否乾淨、有沒有切到、有沒有殘邊。有問題就微調座標重跑（殘邊通常是框到隔壁元素的碎片，收緊邊界即可）。
4. **更新引用**（index.html/CSS 的 `assets/ui/xxx.webp`）→ `npm run build` → 截圖驗證。

## 去背技術（白底元件圖）

用 PIL `ImageDraw.floodfill` 從裁切區的**四角 + 四邊中點**當種子，把「連通的白色背景」填成透明：

```python
seeds = [(0,0), (w-1,0), (0,h-1), (w-1,h-1), (w//2,0), (w//2,h-1), (0,h//2), (w-1,h//2)]
for s in seeds:
    r, g, b, a = im.getpixel(s)
    if a > 0 and r > 205 and g > 205 and b > 205:   # 種子必須是白的才清
        ImageDraw.floodfill(im, s, (255, 255, 255, 0), thresh=48)
```

- **只清連通白**：元素內部的白（棒球本體、字體亮面）不會被誤刪——這是不用全域白色門檻的原因。
- `thresh=48` 對付抗鋸齒邊緣；殘留白暈就調高、吃掉淺色邊緣就調低。
- 去背後用 `im.getchannel("A").getbbox()` 自動修邊，再限制最大寬度（`LANCZOS` 縮圖）。

## 輸出規格（一律 WebP）

```python
im.save(path, "WEBP", quality=88, method=6)   # 去背元件（帶 alpha）
im.save(path, "WEBP", quality=84, method=6)   # 照片感背景（無 alpha）
```

- `method=6` 壓最小（離線工具不在乎慢）；WebP 有損模式也保留 alpha，體積約為 PNG 的 1/5。
- 輸出到 `public/assets/ui/`（放 public 才會進 dist），檔名用途取名（logo.webp / landing-bg.webp）。
- 完成後刪除舊格式檔案，避免 dist 夾雜沒人引用的 png/jpg。

## Mockup 裁背景的注意事項

完整 mockup 常有「烙在圖上的假 UI」（按鈕、文字、資訊列）——裁背景時只取乾淨區域，
邊界貼著假 UI 的外緣往內收 30–40px，裁完務必 Read 檢查四個角落有沒有殘邊。

## 驗證清單

- [ ] Read 每個輸出檔：去背乾淨、無切邊、無鄰居殘片
- [ ] 檔案大小合理（元件 < 50KB、全幅背景 < 100KB）
- [ ] 引用處已改副檔名、`npm run build` 通過
- [ ] 無頭瀏覽器截圖確認實際顯示（桌面 + 手機直式）
