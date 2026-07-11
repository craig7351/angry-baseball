import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1280,760', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2000))
await page.click('#settings-btn-landing')
await page.click('#debug-open')
const before = await page.evaluate(() => document.getElementById('debug-wallet').textContent)
await page.click('#debug-coins')
await page.click('#debug-coins')
const after = await page.evaluate(() => document.getElementById('debug-wallet').textContent)
const stored = await page.evaluate(() => localStorage.getItem('angrybb:coins'))
console.log('wallet before:', before, '→ after 2 clicks:', after, '| localStorage:', stored)
await browser.close()
