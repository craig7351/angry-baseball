// 手機模擬測試：觸控裝置 → 搖桿移動準星 → 揮棒鈕打擊
import puppeteer from 'puppeteer-core'
const SHOT = process.argv[2] || '.'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=900,460', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 460, hasTouch: true, isMobile: true })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await page.evaluate(() => { window.__DBG = true })
await new Promise((r) => setTimeout(r, 2000))
console.log('touch mode:', await page.evaluate(() => document.body.classList.contains('touch')))
await page.type('#name-input', 'MobileBot')
await page.tap('#start-btn')
await new Promise((r) => setTimeout(r, 500))
await page.tap('#derby-btn')
await new Promise((r) => setTimeout(r, 1500))
await page.tap('#swing-btn')   // 跳過運鏡
await new Promise((r) => setTimeout(r, 800))
const ui = await page.evaluate(() => ({
  controlsShown: document.getElementById('touch-controls').classList.contains('show'),
  aim: window.__dbgAim,
}))
console.log('controls shown:', ui.controlsShown, '| aim start:', JSON.stringify(ui.aim))
// 搖桿：按住往右上撥 1 秒
const joy = await page.evaluate(() => { const r = document.getElementById('joystick').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
await page.touchscreen.touchStart(joy.x, joy.y)
await page.touchscreen.touchMove(joy.x + 35, joy.y - 30)
await new Promise((r) => setTimeout(r, 1000))
await page.touchscreen.touchEnd()
const aim2 = await page.evaluate(() => window.__dbgAim)
console.log('aim after joystick:', JSON.stringify(aim2))
await page.screenshot({ path: `${SHOT}/13-mobile.png` })
// 自動打擊：球接近本壘時按揮棒鈕
let swings = 0
const t0 = Date.now()
while (Date.now() - t0 < 60000 && swings < 3) {
  const s = await page.evaluate(() => ({ z: window.__dbgBallZ, score: document.getElementById('score')?.textContent }))
  if (s.z != null && s.z > -1.2) {
    await page.tap('#swing-btn'); swings++
    console.log('tap swing at z=', s.z.toFixed(2), '| score', s.score)
    await new Promise((r) => setTimeout(r, 3000))
  }
  await new Promise((r) => setTimeout(r, 30))
}
const final = await page.evaluate(() => document.getElementById('score')?.textContent)
console.log('score after mobile swings:', final)
await browser.close()
