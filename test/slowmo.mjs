// 驗證打擊定格 + 超慢動作：揮一棒 → 定格/慢動作截圖 → 等落地計分
import puppeteer from 'puppeteer-core'
const SHOT = process.argv[2] || '.'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1280,760', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 760 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await page.evaluate(() => { window.__DBG = true })
await new Promise((r) => setTimeout(r, 2000))
await page.type('#name-input', 'Bot'); await page.click('#start-btn')
await new Promise((r) => setTimeout(r, 400)); await page.click('#derby-btn')
await new Promise((r) => setTimeout(r, 1200)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 400)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 500))
let swungAt = 0
const t0 = Date.now()
while (Date.now() - t0 < 90000) {
  const s = await page.evaluate(() => ({ z: window.__dbgBallZ, score: document.getElementById('score')?.textContent }))
  if (!swungAt && s.z != null && s.z > -1.2) {
    await page.mouse.click(640, 380)
    swungAt = Date.now()
    console.log('swung at z=', s.z.toFixed(2))
    await new Promise((r) => setTimeout(r, 900)); await page.screenshot({ path: `${SHOT}/8-freeze.png` })
    await new Promise((r) => setTimeout(r, 2500)); await page.screenshot({ path: `${SHOT}/9-slowmo.png` })
    await new Promise((r) => setTimeout(r, 3500)); await page.screenshot({ path: `${SHOT}/10-flight.png` })
  }
  if (swungAt && s.score !== '0') { console.log('LANDED, score', s.score, 'after', ((Date.now() - swungAt) / 1000).toFixed(1), 's'); break }
  await new Promise((r) => setTimeout(r, 30))
}
await browser.close()
