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
await page.goto('http://localhost:8788', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))
await page.click('#admin-btn-landing')
await new Promise((r) => setTimeout(r, 300))
// 錯誤密碼
await page.type('#admin-key', '1234')
await page.click('#admin-login')
await new Promise((r) => setTimeout(r, 1200))
console.log('wrong pw err:', await page.evaluate(() => document.getElementById('admin-err').textContent))
// 等限流過，輸入正確密碼
await new Promise((r) => setTimeout(r, 6000))
await page.evaluate(() => { document.getElementById('admin-key').value = '' })
await page.type('#admin-key', '0501')
await page.click('#admin-login')
await new Promise((r) => setTimeout(r, 1500))
console.log('panel shown:', await page.evaluate(() => !document.getElementById('admin-panel').classList.contains('hidden')))
await page.screenshot({ path: `${SHOT}/17-admin-overview.png` })
// 切到異常事件分頁（等限流）
await new Promise((r) => setTimeout(r, 6000))
await page.click('[data-k="audit"]')
await new Promise((r) => setTimeout(r, 1500))
await page.screenshot({ path: `${SHOT}/18-admin-audit.png` })
console.log('audit rows:', await page.evaluate(() => document.querySelectorAll('#admin-body .ad-row').length))
await browser.close()
