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
// 開設定 → 截圖 → 把擊球鏡頭切成「留在原地」
await page.click('#settings-btn-landing')
await new Promise((r) => setTimeout(r, 300))
await page.screenshot({ path: `${SHOT}/11-settings.png` })
console.log('toggle before:', await page.evaluate(() => document.getElementById('set-ballcam').textContent))
await page.click('#set-ballcam')
console.log('toggle after:', await page.evaluate(() => document.getElementById('set-ballcam').textContent))
await page.click('.mclose[data-close="settings-modal"]')
// 進大賽打一球，確認鏡頭留在原地
await page.type('#name-input', 'Bot'); await page.click('#start-btn')
await new Promise((r) => setTimeout(r, 400)); await page.click('#derby-btn')
await new Promise((r) => setTimeout(r, 1200)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 400)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 500))
let swung = false
const t0 = Date.now()
while (Date.now() - t0 < 60000) {
  const s = await page.evaluate(() => ({ z: window.__dbgBallZ, score: document.getElementById('score')?.textContent }))
  if (!swung && s.z != null && s.z > -1.2) {
    swung = true
    await page.mouse.click(640, 380)
    await new Promise((r) => setTimeout(r, 2500))
    await page.screenshot({ path: `${SHOT}/12-stay-cam.png` })
  }
  if (swung && s.score !== '0') { console.log('LANDED, score', s.score); break }
  await new Promise((r) => setTimeout(r, 30))
}
await browser.close()
