// 留言板測試：送出留言 → 回覆 → 驗證分層顯示
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
page.on('dialog', async (d) => { console.log('[dialog]', d.message()); await d.dismiss() })
await page.goto('http://localhost:8788', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))
await page.click('#msg-btn-landing')
await new Promise((r) => setTimeout(r, 800))
// 自訂名字 + 留言
await page.click('#msg-name'); await page.type('#msg-name', '測試員')
await page.type('#msg-input', '全壘打大賽好好玩！')
await page.click('#msg-send')
await new Promise((r) => setTimeout(r, 9000))   // 限流 8 秒
let n = await page.evaluate(() => document.querySelectorAll('#msg-list .msg-item').length)
console.log('after post, items:', n)
// 點「↩ 回覆」→ 送出回覆
await page.click('[data-reply]')
const hint = await page.evaluate(() => document.getElementById('msg-reply-hint').textContent)
console.log('reply hint:', hint)
await page.type('#msg-input', '我也覺得！')
await new Promise((r) => setTimeout(r, 500))
await page.click('#msg-send')
await new Promise((r) => setTimeout(r, 1500))
const state = await page.evaluate(() => ({
  items: document.querySelectorAll('#msg-list .msg-item').length,
  replies: document.querySelectorAll('#msg-list .msg-item.m-reply').length,
  firstName: document.querySelector('#msg-list .m-name')?.textContent,
}))
console.log('final:', JSON.stringify(state))
await page.screenshot({ path: `${SHOT}/14-msgboard.png` })
// 刪除（未設 ADMIN_KEY → 應回「刪除功能未啟用」）
await browser.close()
