import puppeteer from 'puppeteer-core'
const SHOT = process.argv[2] || '.'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1440,810', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.setViewport({ width: 1440, height: 810 })
await page.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))
await page.screenshot({ path: `${SHOT}/19-landing-desktop.png` })
// 輸入名字 → 快速入口啟用 → 直接開生存
await page.type('#name-input', '測試打者')
await page.screenshot({ path: `${SHOT}/20-landing-named.png` })
await page.click('#quick-survival')
await new Promise((r) => setTimeout(r, 1500))
console.log('quick-survival started:', await page.evaluate(() => document.getElementById('level')?.textContent))
// 手機直式
const p2 = await browser.newPage()
await p2.setViewport({ width: 390, height: 780, hasTouch: true, isMobile: true })
await p2.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))
await p2.screenshot({ path: `${SHOT}/21-landing-mobile.png` })
await browser.close()
console.log('done')
