import puppeteer from 'puppeteer-core'
const SHOT = process.argv[2] || '.'
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1280,760', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 760 })
page.on('console', (m) => { if (m.text().startsWith('[swing]')) console.log(m.text()) })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5181', { waitUntil: 'networkidle2' })
await page.evaluate(() => { window.__DBG = true })
await new Promise((r) => setTimeout(r, 2000))
await page.type('#name-input', 'Bot'); await page.click('#start-btn')
await new Promise((r) => setTimeout(r, 400)); await page.click('#derby-btn')
await new Promise((r) => setTimeout(r, 1200)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 400)); await page.mouse.click(640, 380)
await new Promise((r) => setTimeout(r, 500))
let swung = false, shots = 0
const t0 = Date.now()
while (Date.now() - t0 < 170000) {
  const s = await page.evaluate(() => ({
    z: window.__dbgBallZ,
    over: !document.getElementById('msg')?.classList.contains('hidden'),
    score: document.getElementById('score')?.textContent,
    count: document.getElementById('count')?.textContent,
  }))
  if (s.over) { console.log('GAME OVER', s.score, s.count); break }
  if (s.z == null) { swung = false }
  else if (!swung && s.z > -1.2) {
    swung = true
    await page.mouse.click(640, 380)
    console.log('swing at z=', s.z.toFixed(2), '| score', s.score, s.count)
    if (shots < 2) { shots++; await new Promise((r) => setTimeout(r, 1800)); await page.screenshot({ path: `${SHOT}/6-ballcam-${shots}.png` }) }
  }
  await new Promise((r) => setTimeout(r, 25))
}
await page.screenshot({ path: `${SHOT}/7-end.png` })
const final = await page.evaluate(() => ({
  title: document.getElementById('msg-title')?.textContent,
  text: document.getElementById('msg-text')?.textContent,
  rank: document.getElementById('msg-rank')?.textContent,
  coins: document.getElementById('coins')?.textContent,
}))
console.log('FINAL:', JSON.stringify(final))
await browser.close()
