// 音效與背景音樂：多數為 Web Audio 即時合成；動物被打中另用外部 die.mp3
import dieUrl from './die.mp3'
import musicUrl from './music.mp3'
let ctx = null, master = null, noiseBuf = null, musicGain = null
let dieBuf = null   // 解碼後的音效 AudioBuffer
let lastDie = 0     // 上次播放的時間（去疊音）
let sfxVol = 1.0, musVol = 0.14   // 目前 gain（設定選單可調；ctx 尚未建立時先存著，initAudio 再套用）

// 設定音量：傳入 0~1 的滑桿比例
export function setSfxVolume(frac) { sfxVol = Math.max(0, Math.min(1, frac)) * 2; if (master) master.gain.value = sfxVol }
export function setMusicVolume(frac) { musVol = Math.max(0, Math.min(1, frac)) * 0.3; if (musicGain) musicGain.gain.value = musVol }

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  ctx = new AC()
  master = ctx.createGain(); master.gain.value = sfxVol; master.connect(ctx.destination)
  musicGain = ctx.createGain(); musicGain.gain.value = musVol; musicGain.connect(ctx.destination)
  const len = Math.floor(ctx.sampleRate * 1.0)
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = noiseBuf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  loadDie()
  loadMusic()
}

async function loadDie() {
  if (dieBuf || !ctx) return
  try {
    const res = await fetch(dieUrl)
    dieBuf = await ctx.decodeAudioData(await res.arrayBuffer())
  } catch (e) { console.warn('die.mp3 載入失敗，改用合成音', e) }
}

const t0 = () => ctx.currentTime

// 單一振盪器音（可頻率滑音）
function blip({ freq = 440, type = 'sine', dur = 0.15, gain = 0.3, sweep = null, delay = 0 }) {
  if (!ctx) return
  const t = t0() + delay
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t)
  if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.03)
}

// 雜訊（可過濾 + 頻率滑音）—— 撞擊 / 群眾 / 風聲
function noise({ dur = 0.3, gain = 0.3, type = 'lowpass', freq = 1000, sweep = null, delay = 0, attack = 0 }) {
  if (!ctx) return
  const t = t0() + delay
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = dur > 0.95
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t)
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(1, sweep), t + dur)
  const g = ctx.createGain()
  if (attack > 0) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack) }
  else g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(master); src.start(t); src.stop(t + dur + 0.05)
}

export const sfx = {
  // 投手出手：短促風切
  pitch() { noise({ dur: 0.22, gain: 0.16, type: 'bandpass', freq: 1100, sweep: 2200 }) },
  // 捕手手套「啪」（沒揮或揮空後球進手套）
  glove() {
    noise({ dur: 0.06, gain: 0.5, type: 'bandpass', freq: 900, sweep: 400 })
    blip({ freq: 180, type: 'sine', dur: 0.08, gain: 0.3, sweep: 90 })
  },
  // 揮空：大幅風切「咻——」
  whiff() { noise({ dur: 0.3, gain: 0.32, type: 'bandpass', freq: 700, sweep: 2600 }) },
  // 擊中：木棒「鏗」，品質越高越清脆；perfect 加金屬泛音
  crack(q = 0.5) {
    const g = 0.3 + q * 0.4
    noise({ dur: 0.07, gain: g, type: 'bandpass', freq: 1800 + q * 1200, sweep: 700 })
    blip({ freq: 240 + q * 160, type: 'square', dur: 0.06, gain: g * 0.6, sweep: 130 })
    blip({ freq: 95, type: 'sine', dur: 0.1, gain: g * 0.5, sweep: 50 })   // 低頻重量感
    if (q > 0.75) {   // PERFECT：金屬鈴音餘韻
      blip({ freq: 1250, type: 'triangle', dur: 0.5, gain: 0.22, sweep: 1180, delay: 0.015 })
      blip({ freq: 2500, type: 'sine', dur: 0.35, gain: 0.1, delay: 0.02 })
    }
  },
  // 擦棒：小聲「喀」
  foul() {
    noise({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 2400 })
    blip({ freq: 500, type: 'square', dur: 0.04, gain: 0.15, sweep: 300 })
  },
  // 鹹魚棒：濕答答「啪嘰」
  fish() {
    noise({ dur: 0.16, gain: 0.42, type: 'lowpass', freq: 700, sweep: 150 })
    blip({ freq: 320, type: 'sine', dur: 0.25, gain: 0.3, sweep: 60 })
  },
  // 群眾歡呼：依距離漸強（v 0~1）
  cheer(v = 0.5) {
    const g = 0.1 + v * 0.35
    noise({ dur: 1.1 + v * 0.8, gain: g, type: 'bandpass', freq: 1000, sweep: 1600, attack: 0.18 })
    noise({ dur: 0.9 + v * 0.7, gain: g * 0.6, type: 'highpass', freq: 2500, attack: 0.25, delay: 0.1 })
  },
  // 全壘打：歡呼 + 煙火砰砰
  homer() {
    this.cheer(1)
    for (let i = 0; i < 4; i++) {
      blip({ freq: 180 + Math.random() * 120, type: 'sine', dur: 0.3, gain: 0.3, sweep: 60, delay: 0.35 + i * 0.22 })
      noise({ dur: 0.2, gain: 0.2, type: 'highpass', freq: 2500, delay: 0.38 + i * 0.22 })
    }
  },
  // 金幣入袋
  coin() {
    blip({ freq: 940, type: 'triangle', dur: 0.09, gain: 0.24 })
    blip({ freq: 1400, type: 'triangle', dur: 0.16, gain: 0.24, delay: 0.07 })
  },
  pop() {
    blip({ freq: 520, type: 'triangle', dur: 0.12, gain: 0.35, sweep: 950 })
    noise({ dur: 0.08, gain: 0.18, type: 'highpass', freq: 1200 })
  },
  // 連擊：音階隨連擊數往上疊
  combo(n = 2) {
    const f = Math.min(1400, 440 * Math.pow(1.09, n))
    blip({ freq: f, type: 'triangle', dur: 0.16, gain: 0.32, sweep: f * 1.5 })
    blip({ freq: f * 1.5, type: 'sine', dur: 0.1, gain: 0.14, delay: 0.02 })
  },
  // 雷神棒落雷
  zap() {
    blip({ freq: 1600, type: 'sawtooth', dur: 0.16, gain: 0.28, sweep: 300 })
    noise({ dur: 0.18, gain: 0.32, type: 'highpass', freq: 3000, sweep: 1200 })
  },
  // 動物被打中：die.mp3（未載入時退回 pop）
  die() {
    if (!ctx) return
    if (!dieBuf) { this.pop(); return }
    const now = t0()
    if (now - lastDie < 0.05) return
    lastDie = now
    const src = ctx.createBufferSource(); src.buffer = dieBuf
    const g = ctx.createGain(); g.gain.value = 0.9
    src.connect(g).connect(master); src.start(now)
  },
  explode() {
    noise({ dur: 0.5, gain: 0.5, type: 'lowpass', freq: 1800, sweep: 110 })
    blip({ freq: 80, type: 'sine', dur: 0.45, gain: 0.5, sweep: 38 })
  },
  win() {
    const notes = [523, 659, 784, 1047]
    notes.forEach((f, i) => blip({ freq: f, type: 'triangle', dur: 0.32, gain: 0.28, delay: i * 0.11 }))
  },
  star(i) {
    const f = [0, 700, 900, 1200][i] || 900
    blip({ freq: f, type: 'sine', dur: 0.45, gain: 0.34 })
    blip({ freq: f * 2, type: 'sine', dur: 0.3, gain: 0.12 })
  },
  lose() {
    const notes = [440, 330, 220]
    notes.forEach((f, i) => blip({ freq: f, type: 'sawtooth', dur: 0.32, gain: 0.22, delay: i * 0.14 }))
  },
}

// ============================================================
//  背景音樂：外部 mp3 循環播放（透過 musicGain → 音量滑桿可調）
// ============================================================
let musicBuf = null, musicSrc = null, musicOn = false

async function loadMusic() {
  if (musicBuf || !ctx) return
  try {
    const res = await fetch(musicUrl)
    musicBuf = await ctx.decodeAudioData(await res.arrayBuffer())
    if (musicOn) startMusicSource()
  } catch (e) { console.warn('背景音樂載入失敗', e) }
}
function startMusicSource() {
  if (!ctx || !musicBuf || musicSrc) return
  musicSrc = ctx.createBufferSource()
  musicSrc.buffer = musicBuf; musicSrc.loop = true
  musicSrc.connect(musicGain); musicSrc.start()
}
export const music = {
  start() {
    if (!ctx || musicOn) return
    musicOn = true
    if (musicBuf) startMusicSource(); else loadMusic()
  },
  stop() {
    musicOn = false
    if (musicSrc) { try { musicSrc.stop() } catch {} musicSrc.disconnect(); musicSrc = null }
  },
  get playing() { return musicOn },
}
