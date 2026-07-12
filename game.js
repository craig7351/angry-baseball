import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'
import * as CANNON from 'cannon-es'
import { initAudio, sfx, music, setSfxVolume, setMusicVolume } from './sfx.js'
import {
  EYE, MOUND_Z, IS_TOUCH, canvas, renderer, scene, camera, world,
  matGround, matBox, matBall, buildStadium, buildCrowd, crowdCheer,
  applyBiome, updateEnv, wallDistAt, isFair,
} from './stadium.js'
import { setFXHooks, spawnFloater, addSpark, explode, firework, fireworkShow, drawBolt, updateFX, clearFX, getGlowTexture } from './fx.js'
import { BATS, batByKey, judgeSwing, CONTACT_Z } from './batting.js'

// ============================================================
//  第一人稱 3D 打棒球（three.js 渲染 + cannon-es 3D 物理）
//  投手投球 → 抓時機揮棒 → 球飛出去量距離 → 全壘打 / 目標加成
// ============================================================

const INTRO_DUR = 6.0
const ORBIT_CENTER = new THREE.Vector3(0, 8, -55)
const ORBIT_R = 85, ORBIT_H = 42
const SWING_CD = 0.4          // 揮棒冷卻
const BALL_R = 0.16

// ---- 資產 ----
const loader = new GLTFLoader()
const ASSETS = {
  crate: 'assets/Crate.glb',
  barrel: 'assets/ExplodingBarrel.glb',
  brick: 'assets/BrickWall_2.glb',
  plank: 'assets/WoodPlanks.glb',
  container: 'assets/Container_Small.glb',
  pig: 'assets/Pig.glb',
  sheep: 'assets/Sheep.glb',
  chicken: 'assets/Chicken.glb',
  cat: 'assets/Cat.glb',
  dog: 'assets/Dog.glb',
  raccoon: 'assets/Raccoon.glb',
  wolf: 'assets/Wolf.glb',
  horse: 'assets/Horse.glb',
  chick: 'assets/Chick.glb',
}
const protos = {}
const animClips = {}
const ANIMALS = ['pig', 'sheep', 'chicken', 'cat', 'dog', 'raccoon', 'wolf', 'horse', 'chick']
const isAnimal = (t) => ANIMALS.includes(t)
async function loadAll() {
  await Promise.all(Object.entries(ASSETS).map(async ([k, url]) => {
    const gltf = await loader.loadAsync(url)
    protos[k] = gltf.scene
    if (isAnimal(k)) animClips[k] = gltf.animations || []
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
  }))
}
function measure(obj) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3(); box.getSize(size)
  const center = new THREE.Vector3(); box.getCenter(center)
  return { size, center }
}
function idleClip(type) {
  const cs = animClips[type]
  if (!cs || !cs.length) return null
  return cs.find((c) => /idle/i.test(c.name)) || cs[0]
}
// 正規化模型：縮到目標高度、置中；回傳 wrap 與半尺寸
function makeVisual(type, targetH, tint = null) {
  const proto = protos[type]
  const inst = isAnimal(type) ? skeletonClone(proto) : proto.clone(true)
  if (tint) inst.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color = new THREE.Color(tint) } })
  const raw = measure(proto)
  const scale = targetH / (raw.size.y || 1)
  const holder = new THREE.Group()
  holder.add(inst); holder.scale.setScalar(scale)
  const box = new THREE.Box3().setFromObject(holder)
  const size = new THREE.Vector3(); box.getSize(size)
  const center = new THREE.Vector3(); box.getCenter(center)
  holder.position.sub(center)
  const wrap = new THREE.Group(); wrap.add(holder)
  return { wrap, hx: size.x / 2, hy: size.y / 2, hz: size.z / 2 }
}
// 靜態擺飾（觀眾席動物用；底部貼 y=0）
function makeStatic(type, targetH) {
  if (!protos[type]) return null
  const { wrap, hy } = makeVisual(type, targetH)
  const g = new THREE.Group(); g.add(wrap); wrap.position.y = hy
  return g
}

// ---- 實體（物理同步物件：目標物 / 球）----
const entities = []
function addBody(type, x, z, bottomY, opts = {}) {
  const cfg = { crate: { h: 1.2, m: 1.2 }, barrel: { h: 1.4, m: 1.0, explosive: 4.5 }, brick: { h: 1.6, m: 1.6 }, plank: { h: 0.5, m: 0.5 }, container: { h: 2.4, m: 6 } }[type] ||
    { h: opts.h || 1.1, m: 0.8 }
  const targetH = opts.h || cfg.h
  const { wrap, hx, hy, hz } = makeVisual(type, targetH, opts.tint)
  const cy = bottomY + hy
  const body = new CANNON.Body({ mass: opts.mass != null ? opts.mass : cfg.m, material: matBox, shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)) })
  body.position.set(x, cy, z)
  body.allowSleep = true; body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.6
  world.addBody(body)
  scene.add(wrap)
  const ent = { body, group: wrap, type, hy }
  if (isAnimal(type)) {
    const idle = idleClip(type)
    if (idle) { ent.mixer = new THREE.AnimationMixer(wrap); ent.mixer.clipAction(idle).play() }
    ent.target = true   // 觀眾目標：被球打中有賞金
  }
  if (cfg.explosive) {
    body.addEventListener('collide', (e) => {
      if (ent.dead || !game) return
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal())
      if (v > 6) {
        ent.dead = true; ent.popping = 0
        explode(body.position, cfg.explosive)
        awardBonus(body.position, ent.hy, '🛢️ 爆桶！+500', 500)
      }
    })
  }
  body._ent = ent
  entities.push(ent)
  return cy + hy
}

// ============================================================
//  分數 / 金幣 / 錢包（金幣跨場永久，買球棒用）
// ============================================================
const COINS_KEY = 'angrybb:coins', OWNED_KEY = 'angrybb:bats', EQUIP_KEY = 'angrybb:bat'
let wallet = 0
try { wallet = Math.max(0, parseInt(localStorage.getItem(COINS_KEY), 10) || 0) } catch {}
function saveWallet() { try { localStorage.setItem(COINS_KEY, String(wallet)) } catch {} }
let owned = { wood: true }
try { Object.assign(owned, JSON.parse(localStorage.getItem(OWNED_KEY)) || {}) } catch {}
function saveOwned() { try { localStorage.setItem(OWNED_KEY, JSON.stringify(owned)) } catch {} }
let equippedBat = localStorage.getItem(EQUIP_KEY) || 'wood'
if (!owned[equippedBat]) equippedBat = 'wood'
const bat = () => batByKey(equippedBat)

function addScore(v) { if (game) game.score += Math.round(v) }
function addCoins(v) {
  if (v <= 0) return
  if (bat().fx === 'lucky') v = Math.round(v * 1.1)
  wallet += v; if (game) game.coinsEarned = (game.coinsEarned || 0) + v
  saveWallet(); refreshHUD()
}
// 場上目標賞金（動物 / 爆桶 / JACKPOT 共用）
function awardBonus(pos, headY, text, score) {
  addScore(score); addCoins(Math.round(score / 10))
  spawnFloater(pos, (headY || 1) + 1.2, text, { fill: '#ffe27a', size: 60, life: 1.3, rise: 2.2, grow: 0.6, worldScale: 2.6 })
  refreshHUD()
}

// ============================================================
//  投手：站在投手丘的動物（挑戰關 / 生存高波會換投手與變色）
// ============================================================
const pitcher = { group: null, mixer: null, state: 'idle', t: 0, type: '' }
function buildPitcher(type = 'pig', tint = null, scale = 1) {
  if (pitcher.group) { scene.remove(pitcher.group); pitcher.group = null; pitcher.mixer = null }
  const { wrap, hy } = makeVisual(type, 1.5 * scale, tint)
  wrap.position.set(0, 0.4 + hy, MOUND_Z)
  scene.add(wrap)
  pitcher.group = wrap; pitcher.type = type; pitcher.state = 'idle'; pitcher.t = 0
  const idle = idleClip(type)
  if (idle) { pitcher.mixer = new THREE.AnimationMixer(wrap); pitcher.mixer.clipAction(idle).play() }
}
// 投球動作：後仰蓄力 → 甩臂（純程式 pose，release 時真的把球生出來）
function updatePitcher(dt) {
  if (pitcher.mixer) pitcher.mixer.update(dt)
  if (!pitcher.group) return
  if (pitcher.state === 'windup') {
    pitcher.t += dt
    const k = pitcher.t / 0.9
    if (k < 0.62) pitcher.group.rotation.x = -0.5 * Math.sin((k / 0.62) * Math.PI / 2)   // 後仰
    else pitcher.group.rotation.x = -0.5 + (k - 0.62) / 0.38 * 0.75                       // 甩臂前傾
    if (k >= 0.62 && !pitcher.released) { pitcher.released = true; releaseBall() }
    if (k >= 1) { pitcher.state = 'idle'; pitcher.group.rotation.x = 0 }
  } else {
    pitcher.group.rotation.x *= Math.max(0, 1 - dt * 6)
  }
}

// ============================================================
//  球種與投球
// ============================================================
const PITCHES = {
  slowball: { name: '慢速球', spd: [16, 19], acc: () => [0, 0, 0] },
  fast:     { name: '直球',   spd: [24, 30], acc: () => [0, 0, 0] },
  curve:    { name: '曲球',   spd: [17, 21], acc: () => [0, -7, 0] },
  slider:   { name: '滑球',   spd: [19, 24], acc: () => [(Math.random() < 0.5 ? -1 : 1) * 6, 0, 0] },
  change:   { name: '變速球', spd: [15, 18], acc: () => [0, -3.5, 0] },
  knuckle:  { name: '蝴蝶球', spd: [14, 17], acc: () => [0, -2, 0], wobble: 9 },
  fire:     { name: '🔥火球', spd: [32, 37], acc: () => [0, 0, 0], fire: true },
}
// 棒球外觀：白底紅縫線
let ballTex = null
function makeBallTexture() {
  if (ballTex) return ballTex
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#f4f2ea'; ctx.fillRect(0, 0, s, s)
  ctx.strokeStyle = '#c33'; ctx.lineWidth = 3
  for (const off of [26, 102]) {
    ctx.beginPath(); ctx.arc(off < 64 ? -20 : s + 20, 64, 78, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.fillStyle = 'rgba(180,60,40,.5)'
  for (let i = 0; i < 26; i++) ctx.fillRect(20 + (i % 13) * 7, 30 + Math.floor(i / 13) * 66, 3, 2)
  ballTex = new THREE.CanvasTexture(c); ballTex.colorSpace = THREE.SRGBColorSpace
  return ballTex
}
function makeBallGroup(special) {
  const group = new THREE.Group()
  let mat
  if (special === 'gold') mat = new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xaa7700, emissiveIntensity: 0.6, roughness: 0.3 })
  else if (special === 'fire') mat = new THREE.MeshStandardMaterial({ color: 0xff6a3a, emissive: 0xdd2200, emissiveIntensity: 0.8, roughness: 0.4 })
  else mat = new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.55 })
  const m = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 20, 14), mat)
  m.castShadow = true; group.add(m)
  scene.add(group)
  return group
}
// 目前這一球（唯一的比賽用球）
let ball = null
function removeBall() {
  if (!ball) return
  world.removeBody(ball.body); scene.remove(ball.group)
  const i = entities.indexOf(ball); if (i >= 0) entities.splice(i, 1)
  ball = null
}
// 依球種＋目標點解出初速（含重力與變化球加速度的補償），球會準準通過好球帶
function releaseBall() {
  const cfg = game.nextPitch
  const P = PITCHES[cfg.type]
  const p0 = { x: 0.3, y: 2.0, z: MOUND_Z + 0.8 }
  const target = { x: (Math.random() - 0.5) * 0.9, y: 0.8 + Math.random() * 0.6 }
  const speed = (P.spd[0] + Math.random() * (P.spd[1] - P.spd[0])) * (cfg.speedMul || 1)
  const T = (CONTACT_Z - p0.z) / speed
  const acc = P.acc()
  const vx = (target.x - p0.x - 0.5 * acc[0] * T * T) / T
  const vy = (target.y - p0.y - 0.5 * (-9.82 + acc[1]) * T * T) / T
  let visual = cfg.special === 'chicken' ? null : makeBallGroup(cfg.special)
  let hy = BALL_R
  if (cfg.special === 'chicken') {   // 投手丟出一隻雞！
    const v = makeVisual('chicken', 0.7)
    visual = v.wrap; scene.add(visual); hy = v.hy
  } else if (cfg.special === 'bomb') {
    visual.children[0].material = new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.5 })
  }
  const body = new CANNON.Body({ mass: 0.6, material: matBall, shape: new CANNON.Sphere(cfg.special === 'chicken' ? 0.3 : BALL_R) })
  body.position.set(p0.x, p0.y, p0.z)
  body.velocity.set(vx, vy, speed)
  body.linearDamping = 0; body.angularDamping = 0.1
  body.angularVelocity.set(8, 2, 6)
  world.addBody(body)
  ball = { body, group: visual, type: 'gameball', state: 'incoming', hy,
    pitch: { ...cfg, name: P.name, speed, acc, wobble: P.wobble || 0, target }, born: 0 }
  body._ent = ball
  // 擊中場上目標（觀眾動物 / JACKPOT）→ 賞金；只在被打出去後有效
  body.addEventListener('collide', (e) => {
    if (!ball || ball.state !== 'hit') return
    const other = e.body && e.body._ent
    if (other && other.target && !other.dead) {
      other.dead = true; other.popping = 0
      sfx.die()
      awardBonus(other.body.position, other.hy, '🎯 命中觀眾！+800', 800)
    }
  })
  entities.push(ball)
  game.phase = 'fly'; game.phaseT = 0
  sfx.pitch()
  showPitchLabel(`${cfg.special === 'chicken' ? '🐔 ' : cfg.special === 'bomb' ? '⚠️ 炸彈球 ' : cfg.special === 'gold' ? '✨ 黃金球 ' : ''}${P.name} ${Math.round(speed * 3.6)} km/h`)
  ring.visible = true
  magnetDot.visible = bat().fx === 'magnet'
  if (magnetDot.visible) magnetDot.position.set(target.x, target.y, CONTACT_Z)
}

// ---- 好球帶框 + 時機縮圈 + 磁力棒預測點 ----
const zoneGroup = new THREE.Group()
{
  const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.1, 0.9))
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false }))
  line.renderOrder = 900
  zoneGroup.add(line)
  zoneGroup.position.set(0, 1.15, CONTACT_Z)
  zoneGroup.visible = false
  scene.add(zoneGroup)
}
function makeRingSprite(color) {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.strokeStyle = color; ctx.lineWidth = 7
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 6, 0, Math.PI * 2); ctx.stroke()
  const tex = new THREE.CanvasTexture(c)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sp.renderOrder = 901
  return sp
}
const ring = makeRingSprite('#ffffff'); ring.visible = false; scene.add(ring)
const ringPerfect = makeRingSprite('#5bff8a'); ringPerfect.visible = false; scene.add(ringPerfect)
const magnetDot = (() => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xff5544, transparent: true, depthTest: false }))
  sp.scale.set(0.3, 0.3, 1); sp.renderOrder = 902; sp.visible = false; scene.add(sp)
  return sp
})()
function hidePitchAids() { ring.visible = false; ringPerfect.visible = false; magnetDot.visible = false }   // 好球帶白框與準星常駐，不在此隱藏

// ---- 打擊準星：滑鼠只移動好球帶白框內的 3D 十字，鏡頭固定 ----
const AIM_SENS = 0.0035           // 滑鼠像素 → 公尺
const AIM_X = 0.55, AIM_Y0 = 0.7, AIM_Y1 = 1.6   // 準星活動範圍＝白框（1.1 × 0.9，中心 y 1.15）
const aimPos = { x: 0, y: 1.15 }
function clampAim() {
  aimPos.x = Math.max(-AIM_X, Math.min(AIM_X, aimPos.x))
  aimPos.y = Math.max(AIM_Y0, Math.min(AIM_Y1, aimPos.y))
}
const aimCross = (() => {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.lineCap = 'round'
  ctx.lineWidth = 16; ctx.strokeStyle = 'rgba(0,0,0,.75)'
  ctx.beginPath(); ctx.moveTo(64, 10); ctx.lineTo(64, 118); ctx.moveTo(10, 64); ctx.lineTo(118, 64); ctx.stroke()
  ctx.lineWidth = 9; ctx.strokeStyle = '#ffffff'
  ctx.beginPath(); ctx.moveTo(64, 12); ctx.lineTo(64, 116); ctx.moveTo(12, 64); ctx.lineTo(116, 64); ctx.stroke()
  const tex = new THREE.CanvasTexture(c)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sp.scale.set(0.2, 0.2, 1); sp.renderOrder = 903; sp.visible = false; scene.add(sp)
  return sp
})()

// ============================================================
//  第一人稱球棒 + 揮棒
// ============================================================
const batView = new THREE.Group()
{
  camera.add(batView)
  batView.position.set(0.4, -0.35, -0.7)
  batView.rotation.set(0.2, -0.35, -1.05)
}
let batMesh = null
function buildBatView() {
  if (batMesh) batView.remove(batMesh)
  const b = bat()
  const colors = { wood: 0xb8834a, bamboo: 0xc9d67a, alu: 0x9fb4c4, fish: 0x6a9ab0, hammer: 0x8a8f9a, flame: 0xd8542a, magnet: 0xb03a4a, thunder: 0xf2d43a, gold: 0xffd24a }
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: colors[b.key] || 0xb8834a, roughness: 0.5, metalness: b.key === 'alu' || b.key === 'gold' ? 0.7 : 0.05 })
  if (b.key === 'fish') {   // 鹹魚：橢球身 + 尾鰭
    const bodyM = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), mat)
    bodyM.scale.set(1, 0.55, 3.2); bodyM.position.y = 0.5
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 8), mat)
    tail.position.y = 1.05; tail.rotation.x = 0.2
    g.add(bodyM, tail)
  } else if (b.key === 'hammer') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.95, 10), new THREE.MeshStandardMaterial({ color: 0x7a5a34, roughness: 0.7 }))
    handle.position.y = 0.42
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.22), mat)
    head.position.y = 0.95
    g.add(handle, head)
  } else {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.03, 1.05, 12), mat)
    m.position.y = 0.5
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), mat)
    knob.position.y = -0.03
    g.add(m, knob)
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = false })
  batMesh = g
  batView.add(g)
}
let swingT = -1   // >=0 播放揮棒動畫
function updateBatView(dt) {
  if (swingT >= 0) {
    swingT += dt
    const k = Math.min(1, swingT / 0.22)
    const e = Math.sin(k * Math.PI)
    batView.rotation.z = -1.05 + e * 2.4
    batView.rotation.x = 0.2 - e * 0.5
    batView.position.x = 0.4 - e * 0.75
    if (swingT > 0.34) { swingT = -1 }
  } else {
    // 待機微晃
    const t = performance.now() / 1000
    batView.rotation.z = -1.05 + Math.sin(t * 1.7) * 0.03
    batView.position.y = -0.35 + Math.sin(t * 2.3) * 0.012
  }
}

let swingCd = 0
function doSwing() {
  if (!game || game.over || game.paused || game.intro || swingCd > 0 || game.ballcam) return
  swingCd = SWING_CD
  swingT = 0
  hintOnSwing()
  if (!ball || ball.state !== 'incoming' || ball.swung) { if (bat().fx === 'chaos') sfx.fish(); else sfx.whiff(); return }
  ball.swung = true
  // 揮棒位置＝白框內的打擊準星
  const aim = { x: aimPos.x, y: aimPos.y }
  const res = judgeSwing(ball.body.position, ball.body.velocity, aim, bat())
  if (window.__DBG) console.log('[swing]', JSON.stringify({ bz: +ball.body.position.z.toFixed(2), by: +ball.body.position.y.toFixed(2), bx: +ball.body.position.x.toFixed(2), vz: +ball.body.velocity.z.toFixed(1), aim: { x: +aim.x.toFixed(2), y: +aim.y.toFixed(2) }, res: res && { tier: res.tier, q: +res.q.toFixed(2), tErr: +res.tErr.toFixed(3) } }))
  if (!res) {   // 揮空
    sfx.whiff()
    spawnFloater({ x: 0, y: 1.4, z: 0 }, 0.6, '揮空！', { fill: '#cfd6e4', size: 60, life: 0.9, rise: 1.6, worldScale: 2.0 })
    registerMiss('揮空')
    return
  }
  hitBall(res)
}

function hitBall(res) {
  const b = bat()
  const p = ball.body.position
  ball.state = 'hit'
  ball.tier = res.tier; ball.q = res.q
  ball.body.velocity.set(res.vel.x, res.vel.y, res.vel.z)
  ball.body.angularVelocity.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30)
  ball.body.linearDamping = b.fx === 'nodrag' || b.fx === 'lucky' ? 0.05 : 0.16
  ball.hitAt = { x: p.x, y: p.y, z: p.z }
  ball.maxH = p.y; ball.ms = 0
  hidePitchAids()
  // 炸彈球：打中直接爆炸，這球作廢
  if (ball.pitch.special === 'bomb') {
    explode(p, 4)
    addShake(1.0)
    spawnFloater(p, 1.2, '💣 打到炸彈！', { fill: '#ff7a5a', size: 66, life: 1.2, rise: 1.8, worldScale: 2.6 })
    registerMiss('炸彈')
    ball.state = 'dead'
    resolveDone(0.9)
    return
  }
  // 音效 + 打擊感（定格/慢動作已移除，正常速度看球飛出）
  if (b.fx === 'chaos') sfx.fish(); else sfx.crack(res.q)
  if (res.tier === 'perfect') addShake(0.5)
  else if (res.tier === 'good') addShake(0.28)
  if (ball.pitch.special === 'chicken') awardBonus(p, 0.6, '🐔 雞飛了！+1000', 1000)
  // 判定跳字
  const tierFx = {
    perfect: { t: 'PERFECT!', fill: '#ffd63a', size: 84 },
    good: { t: '強勁！', fill: '#9fe6ff', size: 70 },
    ok: { t: '打中', fill: '#ffffff', size: 58 },
    foul: { t: '擦棒…', fill: '#cfd6e4', size: 54 },
  }[res.tier]
  spawnFloater(p, 0.8, tierFx.t, { fill: tierFx.fill, size: tierFx.size, life: 1.0, rise: 2.2, grow: 0.7, worldScale: 2.6 })
  // Ball-Cam 追球（擦棒不追；設定可改為鏡頭留在原地）
  if (res.tier !== 'foul' && settings.ballcam) game.ballcam = true
  game.phase = 'resolve'; game.phaseT = 0
}

// ============================================================
//  投球排程 / 未揮判定 / 落地結算
// ============================================================
function schedulePitch(delay = 0.9) {
  game.phase = 'wait'; game.phaseT = -delay
}
// 決定下一球內容（依模式與進度）
function pickPitch() {
  let pool, speedMul = 1, special = null
  if (game.mode === 'level') {
    const L = LEVELS[game.levelIdx]
    pool = L.pool; speedMul = L.mul
  } else if (game.mode === 'survival') {
    const lv = Math.floor(game.hits / 8)
    pool = [['slowball', 'fast'], ['fast', 'curve'], ['fast', 'curve', 'slider'], ['fast', 'curve', 'slider', 'change'], ['fast', 'curve', 'slider', 'change', 'knuckle']][Math.min(4, lv)]
    speedMul = 1 + Math.min(0.5, lv * 0.06)
    if (game.pitchNum > 0 && game.pitchNum % 10 === 0) { pool = ['fire']; speedMul = 1 }   // 每 10 球一顆火球（×3 分）
    else if (game.hits >= 6 && Math.random() < 0.07) special = 'bomb'
    else if (Math.random() < 0.04) special = 'chicken'
    else if (Math.random() < 0.05) special = 'gold'
  } else {   // derby
    pool = ['slowball', 'fast', 'curve', 'slider', 'change']
    speedMul = 1
    if (game.pitchNum === 4 || game.pitchNum === 8) special = 'gold'   // 第 5、9 球必出黃金球
    else if (Math.random() < 0.06) special = 'chicken'
  }
  const type = pool[Math.floor(Math.random() * pool.length)]
  game.nextPitch = { type, speedMul, special }
}
function startWindup() {
  pickPitch()
  game.pitchNum++
  pitcher.state = 'windup'; pitcher.t = 0; pitcher.released = false
  game.phase = 'windup'; game.phaseT = 0
  refreshHUD()
}
// 沒揮（或揮空後球繼續飛）→ 球進捕手 / 落地
function resolveTake() {
  if (!ball || ball.state !== 'incoming') return
  ball.state = 'dead'
  sfx.glove()
  hidePitchAids()
  if (!ball.swung) {
    if (ball.pitch.special === 'bomb') {
      awardBonus({ x: 0, y: 1.2, z: 0 }, 0.4, '🧠 冷靜閃過炸彈 +100', 100)
    } else {
      spawnFloater({ x: 0, y: 1.3, z: 0.2 }, 0.5, '好球！', { fill: '#ffb0a0', size: 56, life: 0.9, rise: 1.4, worldScale: 2.0 })
      registerMiss('好球')
    }
  }
  resolveDone(0.7)
}
// miss 記錄（揮空 / 沒揮好球 / 炸彈）：生存扣心、大賽消耗球數、連擊歸零
function registerMiss() {
  game.combo = 0; hideCombo()
  if (game.mode === 'survival') {
    game.misses++
    addShake(0.2)
    refreshHUD()
  }
}
// 這一球處理完畢 → 排下一球或結束
function resolveDone(delay = 0.9) {
  game.resolveT = delay
}
function afterResolve() {
  removeBall()
  game.ballcam = false
  restoreCam()
  // 回合結束判定
  if (game.mode === 'survival' && game.misses >= 3) return endGame()
  if ((game.mode === 'derby' || game.mode === 'level') && game.pitchNum >= game.pitchesMax) return endGame()
  schedulePitch(0.7)
}

const MS_DIST = [{ v: 50, t: '飛遠！' }, { v: 80, t: '超遠！' }, { v: 110, t: '爆遠！' }]
// 打出去的球落地（第一次觸地）→ 結算這一打席
function resolveLanding() {
  const p = ball.body.position
  const dist = Math.hypot(p.x, p.z)
  const fair = isFair(p.x, p.z) && ball.tier !== 'foul'
  ball.state = 'landed'
  // 落地塵土
  for (let i = 0; i < 6; i++) addSpark(p.x, 0.3, p.z, 0.5 + Math.random() * 0.4, new THREE.Color(0.7, 0.62, 0.5),
    { blend: THREE.NormalBlending, op: 0.6, vx: (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 2, vz: (Math.random() - 0.5) * 4, g: -8, life: 0.5 })
  if (!fair) {
    addScore(50)
    spawnFloater(p, 0.5, '界外 +50', { fill: '#cfd6e4', size: 54, life: 1.0, rise: 1.6, worldScale: 2.2 })
    sfx.foul()
    resolveDone(1.0)
    return
  }
  // ---- 界內安打結算 ----
  const theta = Math.atan2(Math.abs(p.x), -p.z)
  const isHR = dist >= wallDistAt(theta) + 0.5
  const superHR = isHR && dist >= 135
  let pts = Math.round(dist * 10)
  if (isHR) pts += 2500
  if (superHR) pts += 3000
  if (ball.tier === 'perfect') pts += 500
  else if (ball.tier === 'good') pts += 150
  const pitchMult = ball.pitch.special === 'gold' ? 2 : (ball.pitch.fire || PITCHES[ball.pitch.type].fire) ? 3 : 1
  game.combo++
  const comboMult = 1 + 0.1 * Math.min(10, game.combo - 1)
  const total = Math.round(pts * pitchMult * comboMult)
  addScore(total)
  game.hits++
  addCoins(20 + (isHR ? 100 : 0) + (ball.tier === 'perfect' ? 10 : 0))
  if (dist > game.maxDist) { game.maxDist = dist; showDistBig(dist) }
  // 跳字與演出
  const label = superHR ? '💥 超級全壘打!!' : isHR ? '💥 全壘打！' : dist >= 60 ? '深遠安打！' : '安打！'
  spawnFloater(p, 1.0, `${dist.toFixed(1)}m ${label}`, { fill: isHR ? '#ffd63a' : '#ffffff', size: isHR ? 76 : 60, life: 1.5, rise: 1.6, grow: 0.5, worldScale: 3.2 })
  spawnFloater(p, 0.2, `+${total.toLocaleString()}`, { fill: '#ffe27a', size: 64, life: 1.4, rise: 2.4, grow: 0.6, worldScale: 2.6 })
  if (pitchMult > 1) spawnFloater(p, 2.2, pitchMult === 2 ? '✨ 黃金球 x2' : '🔥 火球 x3', { fill: '#ffd24a', size: 56, life: 1.2, rise: 2.0, worldScale: 2.4 })
  if (game.combo >= 2) { showCombo(game.combo, `x${comboMult.toFixed(1)}`); sfx.combo(game.combo) }
  sfx.cheer(Math.min(1, dist / 120))
  crowdCheer(isHR ? 3 : 1.5)
  if (isHR) {
    game.hrs++
    pendingHR++
    sfx.homer()
    showBanner(superHR ? '💥 超級全壘打!!' : '💥 全壘打！', `${dist.toFixed(1)} 公尺`, true)
    fireworkShow(p.x, p.z, superHR ? 8 : 5)
    addShake(0.7)
  }
  // 雷神棒：PERFECT 擊球 → 落點降雷
  if (bat().fx === 'thunder' && ball.tier === 'perfect') {
    setTimeout(() => {
      if (!game) return
      sfx.zap()
      drawBolt({ x: p.x, y: 26, z: p.z }, { x: p.x, y: 0.3, z: p.z })
      explode({ x: p.x, y: 0.8, z: p.z }, 7)
    }, 120)
  }
  refreshHUD()
  resolveDone(isHR ? 1.6 : 1.1)
}

// ============================================================
//  場上目標佈置（每場重建）：觀眾動物塔 / 爆桶塔 / JACKPOT 飛天金豬
// ============================================================
let blimp = null
function buildTargets() {
  // 外野觀眾動物塔（打中 +800）
  const spots = [[-38, -62], [30, -70], [-15, -80], [48, -55], [8, -95], [-52, -48]]
  spots.forEach(([x, z], i) => {
    let top = addBody('crate', x, z, 0)
    if (i % 2 === 0) top = addBody('crate', x, z, top)
    addBody(ANIMALS[(i * 3) % ANIMALS.length], x, z, top, { h: 1.1, mass: 0.8 })
  })
  // 爆桶塔（連環爆）
  for (const [x, z] of [[-25, -72], [22, -85]]) {
    const t = addBody('crate', x, z, 0)
    addBody('barrel', x, z, t, { mass: 1.0 })
  }
  // 磚牆看板
  addBody('brick', 0, -88, 0)
  addBody('brick', 2.9, -88, 0)
  addBody('plank', 1.4, -88, 1.7, { mass: 0.5 })
  // JACKPOT 飛天金豬（慢速橫越深遠外野，打中 +5000）
  const { wrap } = makeVisual('pig', 4.5, 0xffd24a)
  wrap.position.set(-90, 17, -75)
  scene.add(wrap)
  blimp = { group: wrap, dir: 1, hit: false, respawnT: 0 }
}
function updateBlimp(dt) {
  if (!blimp) return
  const g = blimp.group
  if (blimp.hit) {   // 被打中：旋轉墜落 → 幾秒後重生
    g.position.y -= dt * 9
    g.rotation.z += dt * 7
    if (g.position.y < -6) {
      blimp.respawnT += dt
      if (blimp.respawnT > 6) { blimp.hit = false; blimp.respawnT = 0; g.rotation.z = 0; g.position.set(-90, 17, -75); blimp.dir = 1 }
    }
    return
  }
  g.position.x += blimp.dir * dt * 6
  g.position.y = 17 + Math.sin(performance.now() / 900) * 0.8
  g.rotation.y = blimp.dir > 0 ? Math.PI / 2 : -Math.PI / 2
  if (Math.abs(g.position.x) > 92) blimp.dir *= -1
  // 被打飛的球碰到金豬 → JACKPOT
  if (ball && ball.state === 'hit') {
    const d = ball.body.position.distanceTo(g.position)
    if (d < 4.2) {
      blimp.hit = true
      awardBonus(g.position, 3, '🐷💰 JACKPOT!! +5000', 5000)
      sfx.homer(); addShake(0.8)
      firework(g.position.x, g.position.y, g.position.z)
    }
  }
}

// ============================================================
//  模式與關卡
// ============================================================
const DERBY_KEY = '大賽', SURVIVAL_KEY = '生存', FAR_KEY = '最遠'
const LEVELS = [
  { name: '熱身賽',   pitches: 8,  pool: ['slowball'],                                  mul: 1.0,  target: 2500 },
  { name: '直球對決', pitches: 8,  pool: ['fast'],                                      mul: 0.9,  target: 3500 },
  { name: '慢速陷阱', pitches: 8,  pool: ['slowball', 'change'],                        mul: 1.0,  target: 4000 },
  { name: '曲球初見', pitches: 9,  pool: ['fast', 'curve'],                             mul: 0.95, target: 4500 },
  { name: '滑球襲來', pitches: 9,  pool: ['fast', 'slider'],                            mul: 1.0,  target: 5000 },
  { name: '變化多端', pitches: 10, pool: ['curve', 'slider', 'change'],                 mul: 1.0,  target: 6000 },
  { name: '蝴蝶亂舞', pitches: 10, pool: ['knuckle', 'slowball'],                       mul: 1.0,  target: 6000 },
  { name: '速球考驗', pitches: 10, pool: ['fast'],                                      mul: 1.15, target: 7500 },
  { name: '狼投手',   pitches: 10, pool: ['fast', 'slider', 'curve'],                   mul: 1.15, target: 9000,  pitcher: 'wolf' },
  { name: '全武行',   pitches: 11, pool: ['fast', 'curve', 'slider', 'change', 'knuckle'], mul: 1.1, target: 10000 },
  { name: '火球手',   pitches: 11, pool: ['fast', 'fire'],                              mul: 1.1,  target: 12000, pitcher: 'horse' },
  { name: '傳說對決', pitches: 12, pool: ['fast', 'curve', 'slider', 'knuckle', 'fire'], mul: 1.2, target: 15000, pitcher: 'wolf', boss: true },
]
const STARS_KEY = 'angrybb:stars'
function loadStars() { try { const a = JSON.parse(localStorage.getItem(STARS_KEY)); return Array.isArray(a) ? a : [] } catch { return [] } }
function saveStars() { try { localStorage.setItem(STARS_KEY, JSON.stringify(levelStars)) } catch {} }
const levelStars = loadStars()
const levelUnlocked = (i) => i === 0 || (levelStars[i - 1] || 0) >= 1

let game = null
function baseGame(mode) {
  return { mode, score: 0, pitchNum: 0, pitchesMax: 0, hits: 0, hrs: 0, misses: 0, combo: 0,
    maxDist: 0, coinsEarned: 0, over: false, paused: false, intro: true, introT: 0,
    phase: 'wait', phaseT: -1.2, resolveT: 0, ballcam: false, nextPitch: null }
}
function startCommon() {
  initAudio()
  if (musicEnabled) music.start()
  clearWorld()
  buildTargets()
  bumpPlays()
  buildBatView()
  overlay.classList.add('hidden'); hud.msg.classList.add('hidden')
  document.getElementById('landing').classList.add('hidden')
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.toggle('hidden', IS_TOUCH)
  updateIntroCamera(0)
  maybeStartHint()
  if (!IS_TOUCH) canvas.requestPointerLock()
}
function startDerby() {
  game = baseGame('derby')
  game.pitchesMax = 10
  applyBiome(Math.floor(Math.random() * 2))   // 白天或黃昏
  buildPitcher('pig')
  startCommon()
  refreshHUD()
}
function startSurvival() {
  game = baseGame('survival')
  game.pitchesMax = Infinity
  applyBiome(0)
  buildPitcher('pig')
  startCommon()
  refreshHUD()
}
function startLevel(idx) {
  const L = LEVELS[idx]
  game = baseGame('level')
  game.levelIdx = idx
  game.pitchesMax = L.pitches
  applyBiome(Math.floor(idx / 3))
  buildPitcher(L.pitcher || 'pig', L.boss ? 0xff5a4a : null, L.boss ? 1.6 : 1)
  startCommon()
  refreshHUD()
}
function modeLabel() {
  if (!game) return ''
  if (game.mode === 'derby') return DERBY_KEY
  if (game.mode === 'survival') return SURVIVAL_KEY
  return LEVELS[game.levelIdx].name
}
function calcStars(L) {
  if (game.score >= L.target * 2.4) return 3
  if (game.score >= L.target * 1.6) return 2
  if (game.score >= L.target) return 1
  return 0
}
function endGame() {
  if (game.over) return
  game.over = true
  hideHint(); hidePitchAids()
  removeBall()
  game.ballcam = false
  restoreCam()
  // 最遠紀錄送「最遠」榜（公尺 ×10）
  if (game.maxDist > 0) submitScore(Math.round(game.maxDist * 10), FAR_KEY, modeLabel())
  const summary = `得分 ${game.score.toLocaleString()}　💥 全壘打 ×${game.hrs}　🚀 最遠 ${game.maxDist.toFixed(1)}m　💰 +${(game.coinsEarned || 0).toLocaleString()}`
  hud.stars.innerHTML = ''
  if (game.mode === 'level') {
    const L = LEVELS[game.levelIdx]
    const stars = calcStars(L)
    const passed = stars >= 1
    if (passed) { levelStars[game.levelIdx] = Math.max(levelStars[game.levelIdx] || 0, stars); saveStars() }
    hud.msgTitle.textContent = passed ? (game.levelIdx >= LEVELS.length - 1 ? '🏆 全破！' : '🎉 過關！') : '😢 未達標'
    hud.msgText.textContent = `目標 ${L.target.toLocaleString()} 分 · ` + summary
    const els = []
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span'); s.className = 'star'; s.textContent = '★'
      hud.stars.appendChild(s); els.push(s)
    }
    if (passed) { sfx.win(); for (let i = 0; i < stars; i++) setTimeout(() => { els[i].classList.add('on'); sfx.star(i + 1) }, 450 + i * 380) }
    else sfx.lose()
    hud.next.style.display = passed && game.levelIdx < LEVELS.length - 1 ? '' : 'none'
    showLevelRank(LEVELS[game.levelIdx].name, game.score)
  } else {
    const derby = game.mode === 'derby'
    hud.msgTitle.textContent = derby ? '⚾ 大賽結束' : '☠️ 三振出局'
    hud.msgText.textContent = (derby ? '' : `連續安打 ${game.hits} 支 · `) + summary
    hud.next.style.display = 'none'
    sfx.win()
    showLevelRank(derby ? DERBY_KEY : SURVIVAL_KEY, game.score, String(derby ? game.hrs : game.hits))
  }
  document.getElementById('pause-hint').classList.add('hidden')
  hud.msg.classList.remove('hidden'); exitLock()
}

function clearWorld() {
  removeBall()
  for (const e of entities) { world.removeBody(e.body); scene.remove(e.group) }
  entities.length = 0
  if (blimp) { scene.remove(blimp.group); blimp = null }
  clearFX()
  hitStop = 0; hideCombo(); hidePitchAids()
}

// ============================================================
//  HUD / 橫幅 / 提示
// ============================================================
const hud = {
  level: document.getElementById('level'), score: document.getElementById('score'),
  count: document.getElementById('count'), coins: document.getElementById('coins'),
  best: document.getElementById('best'),
  msg: document.getElementById('msg'), msgTitle: document.getElementById('msg-title'),
  msgText: document.getElementById('msg-text'), stars: document.getElementById('stars'),
  next: document.getElementById('next'),
  msgRank: document.getElementById('msg-rank'), msgLb: document.getElementById('msg-lb'),
  distBig: document.getElementById('dist-big'), distBigVal: document.getElementById('db-val'),
}
function refreshHUD() {
  if (!game) return
  hud.score.textContent = game.score.toLocaleString()
  hud.level.textContent = game.mode === 'derby' ? '⚾ 全壘打大賽' : game.mode === 'survival' ? '🔥 生存連打' : `${game.levelIdx + 1}. ${LEVELS[game.levelIdx].name}`
  if (game.mode === 'survival') hud.count.textContent = '❤️'.repeat(Math.max(0, 3 - game.misses)) + '🖤'.repeat(Math.min(3, game.misses))
  else hud.count.textContent = `⚾ ${Math.min(game.pitchNum, game.pitchesMax)}／${game.pitchesMax}`
  hud.coins.textContent = '💰 ' + wallet.toLocaleString()
  hud.best.textContent = game.maxDist.toFixed(1) + ' m'
}
// 大字距離（刷新本場紀錄時）
let distBigHold = 0
function showDistBig(d) {
  if (!hud.distBig) return
  hud.distBigVal.textContent = d.toFixed(1)
  hud.distBig.classList.remove('hidden')
  hud.distBig.classList.remove('pop'); void hud.distBig.offsetWidth; hud.distBig.classList.add('pop')
  distBigHold = 1.2
}
// 中央橫幅（全壘打 / 波數）
function showBanner(title, sub, boss = false) {
  const el = document.getElementById('banner')
  if (!el) return
  el.innerHTML = `<div class="wb-title">${title}</div><div class="wb-sub">${sub || ''}</div>`
  el.classList.toggle('boss', boss)
  el.classList.remove('hidden'); el.classList.remove('show'); void el.offsetWidth; el.classList.add('show')
}
// 投球資訊（球種 / 球速）
let pitchLabelT = 0
function showPitchLabel(text) {
  const el = document.getElementById('pitch-label')
  if (!el) return
  el.textContent = text
  el.classList.add('show')
  pitchLabelT = 1.4
}
// Combo
const comboEl = document.getElementById('combo')
const comboNEl = document.getElementById('combo-n'), comboBEl = document.getElementById('combo-b')
function showCombo(n, sub) {
  if (!comboEl) return
  comboNEl.textContent = n
  comboBEl.textContent = sub
  comboEl.classList.remove('hidden')
  comboEl.classList.remove('pop'); void comboEl.offsetWidth; comboEl.classList.add('pop')
  clearTimeout(showCombo._t)
  showCombo._t = setTimeout(hideCombo, 1600)
}
function hideCombo() { if (comboEl) comboEl.classList.add('hidden') }
// 新手提示
const HINTED_KEY = 'angrybb:hinted'
let hinted = false; try { hinted = !!localStorage.getItem(HINTED_KEY) } catch {}
let hintStep = 0
const hintEl = document.getElementById('hint')
function showHint(t) { if (hintEl) { hintEl.textContent = t; hintEl.classList.add('show') } }
function hideHint() { if (hintEl) hintEl.classList.remove('show'); hintStep = 0 }
function maybeStartHint() {
  if (hinted || hintStep !== 0) return
  showHint(IS_TOUCH ? '👆 球飛到本壘時按「揮棒」！' : '🖱️ 移動滑鼠瞄準，球到本壘瞬間點左鍵揮棒！')
  hintStep = 1
}
function hintOnSwing() {
  if (hintStep !== 1) return
  showHint('🎯 縮圈貼合好球帶＝完美時機；瞄球心下緣打高飛球！')
  hintStep = 2
  try { localStorage.setItem(HINTED_KEY, '1') } catch {}
  setTimeout(hideHint, 5000)
}

// ============================================================
//  設定（靈敏度 / 音量 / FOV / 震動）
// ============================================================
const SETTINGS_KEY = 'angrybb:settings'
const SETTINGS_DEFAULTS = { sens: 1.0, sfxVol: 50, musVol: 50, fov: 72, shake: true, ballcam: true }   // ballcam：擊球後鏡頭跟著球；關閉＝留在打擊區
const settings = { ...SETTINGS_DEFAULTS }
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) } catch {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch {} }
function applySettings() {
  setSfxVolume(settings.sfxVol / 100)
  setMusicVolume(settings.musVol / 100)
  resize()
}
let shakeMag = 0
function addShake(v) { if (!settings.shake) return; shakeMag = Math.min(1.5, shakeMag + v) }

// ============================================================
//  玩家名字 + 排行榜（後端離線自動退回 localStorage）
// ============================================================
const NAME_KEY = 'angrybb:name', LB_KEY = 'angrybb:scores', DEVICE_KEY = 'angrybb:device'
let playerName = (localStorage.getItem(NAME_KEY) || '').trim()
function setPlayerName(n) { playerName = (n || '').trim().slice(0, 12); localStorage.setItem(NAME_KEY, playerName) }
let deviceId = localStorage.getItem(DEVICE_KEY)
if (!deviceId) { deviceId = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(DEVICE_KEY, deviceId) }

function loadLB() { try { const a = JSON.parse(localStorage.getItem(LB_KEY)); return Array.isArray(a) ? a : [] } catch { return [] } }
async function submitScore(score, levelName, note) {
  if (!playerName || !(score > 0)) return null
  const a = loadLB()
  a.push({ name: playerName, score, level: levelName, note: note || '', at: Date.now() })
  a.sort((x, y) => y.score - x.score)
  try { localStorage.setItem(LB_KEY, JSON.stringify(a.slice(0, 100))) } catch {}
  try {
    const res = await fetch('/api/score', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: playerName, score, level: levelName, note: note || '', deviceId }),
    })
    if (res.ok) { const j = await res.json(); if (j && j.ok) return j }
  } catch {}
  return null
}
function localRank(score, levelName) {
  const best = {}
  for (const r of loadLB()) if (r.level === levelName) best[r.name] = Math.max(best[r.name] || 0, r.score)
  const mine = best[playerName] != null ? best[playerName] : score
  const vals = Object.values(best)
  return { rank: 1 + vals.filter((v) => v > mine).length, total: Math.max(1, vals.length), best: mine, local: true }
}
function localTop(levelName, n) {
  if (levelName) {
    const best = {}
    for (const r of loadLB()) {
      if (r.level !== levelName) continue
      if (!best[r.name] || r.score > best[r.name].score) best[r.name] = { name: r.name, score: r.score, note: r.note || '' }
    }
    return Object.values(best).sort((x, y) => y.score - x.score).slice(0, n)
  }
  const byName = {}
  for (const r of loadLB()) {
    if (r.level === FAR_KEY) continue
    const m = (byName[r.name] = byName[r.name] || {})
    if (!(r.level in m) || r.score > m[r.level]) m[r.level] = r.score
  }
  return Object.entries(byName)
    .map(([name, levels]) => ({ name, score: Object.values(levels).reduce((a, b) => a + b, 0) }))
    .sort((x, y) => y.score - x.score).slice(0, n)
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtScore = (level, v) => level === FAR_KEY ? (Number(v) / 10).toFixed(1) + ' 公尺' : Number(v).toLocaleString()
function lbNote(level, note) {
  if (!note) return ''
  if (level === SURVIVAL_KEY) return `<span class="lb-note">${escapeHtml(note)} 安打</span>`
  if (level === DERBY_KEY) return `<span class="lb-note">${escapeHtml(note)} 轟</span>`
  if (level === FAR_KEY) return `<span class="lb-note">${escapeHtml(note)}</span>`
  return ''
}
function lbRowsHtml(rows, level) {
  return rows.map((r, i) =>
    `<div class="lb-row${r.name === playerName ? ' me' : ''}"><span class="lb-rank${i < 3 ? ' top' : ''}">${i + 1}</span>` +
    `<span class="lb-name">${escapeHtml(r.name)}</span>` +
    lbNote(level, r.note) +
    `<span class="lb-score">${fmtScore(level, r.score)}</span></div>`).join('')
}
async function renderLeaderboard(levelName) {
  const list = document.getElementById('lb-list')
  const label = levelName ? `🌐 ${levelName}` : '🌐 總分（各榜最高分加總）'
  const src = (remote) => `<div class="lb-src">${remote ? label : label.replace('🌐', '📱') + '（本機）'}</div>`
  const draw = (rows, remote) =>
    list.innerHTML = rows.length ? src(remote) + lbRowsHtml(rows, levelName)
      : src(remote) + `<div class="lb-empty">還沒有紀錄，搶頭香！</div>`
  draw(localTop(levelName, 10), false)
  try {
    const res = await fetch(`/api/leaderboard?limit=10${levelName ? '&level=' + encodeURIComponent(levelName) : ''}`)
    if (res.ok) { const rows = await res.json(); if (Array.isArray(rows)) draw(rows, true) }
  } catch {}
}
async function showLevelRank(levelName, score, note) {
  hud.msgRank.textContent = '結算名次中…'; hud.msgLb.innerHTML = ''
  if (score > 0) {
    const info = (await submitScore(score, levelName, note)) || localRank(score, levelName)
    const src = info.local ? '📱 本機' : '🌐 全球'
    hud.msgRank.innerHTML = `排名 <b>第 ${info.rank}</b> / ${info.total} 名　<span class="rank-src">${src}</span>`
  } else {
    hud.msgRank.innerHTML = '<span class="rank-src">本場 0 分，未計入排行</span>'
  }
  let rows = localTop(levelName, 5), remote = false
  try {
    const res = await fetch(`/api/leaderboard?limit=5&level=${encodeURIComponent(levelName)}`)
    if (res.ok) { const r = await res.json(); if (Array.isArray(r)) { rows = r; remote = true } }
  } catch {}
  hud.msgLb.innerHTML = rows.length
    ? `<div class="lb-src">${remote ? '🌐 前 5 名' : '📱 前 5 名（本機）'}</div>` + lbRowsHtml(rows, levelName)
    : ''
}

// ============================================================
//  社群：線上人數 / 全服統計 / 留言板
// ============================================================
// 進場記錄 + 取線上人數（近 3 小時活躍）：只在進場呼叫一次，取代舊的心跳輪詢
async function enterOnline() {
  try {
    const r = await fetch('/api/online', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    if (r.ok) { const j = await r.json(); const el = document.getElementById('online-n'); if (el && j.online != null) el.textContent = j.online }
  } catch {}
}
async function refreshOnline() {   // 只讀人數（開「上線」視窗時用），不寫入
  try { const r = await fetch('/api/online'); if (r.ok) { const j = await r.json(); const el = document.getElementById('online-n'); if (el && j.online != null) el.textContent = j.online } } catch {}
}
const fmtDuration = (sec) => {
  sec = Math.max(0, Math.round(sec))
  if (sec < 3600) return Math.round(sec / 60) + ' 分'
  if (sec < 86400) return (sec / 3600).toFixed(1) + ' 小時'
  return (sec / 86400).toFixed(1) + ' 天'
}
async function refreshTotals() {
  try {
    const r = await fetch('/api/totals'); if (!r.ok) return
    const j = await r.json()
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v }
    set('total-plays', Number(j.plays || 0).toLocaleString())
    set('total-kills', Number(j.kills || 0).toLocaleString())
    set('total-time', fmtDuration(j.seconds || 0))
  } catch {}
}
function bumpPlays() { fetch('/api/totals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs: 1 }) }).catch(() => {}) }
let pendingHR = 0, pendingSeconds = 0
function flushTotals() {
  const k = pendingHR, s = Math.floor(pendingSeconds)
  if (k <= 0 && s <= 0) return
  fetch('/api/totals', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kills: k, seconds: s }),
  }).then((r) => { if (r.ok) { pendingHR -= k; pendingSeconds -= s } }).catch(() => {})
}
const timeAgo = (at) => {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return '剛剛'
  if (s < 3600) return Math.floor(s / 60) + ' 分鐘前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小時前'
  return Math.floor(s / 86400) + ' 天前'
}
// ---- 留言板（分層顯示 + 回覆 + 刪除；刪除需管理密碼；同 angry-pig 修正版）----
let replyTo = null   // { id, name } 目前正在回覆的留言
function setReply(id, name) {
  replyTo = id ? { id, name } : null
  const hint = document.getElementById('msg-reply-hint'); if (!hint) return
  hint.classList.toggle('hidden', !replyTo)
  if (replyTo) {
    hint.innerHTML = `↩ 回覆 <b>@${escapeHtml(replyTo.name)}</b><button id="msg-reply-cancel">✕ 取消</button>`
    const t = document.getElementById('msg-input'); if (t) t.focus()
  }
}
function msgItemHtml(m, isReply) {
  const acts = '<div class="m-acts">' +
    (isReply ? '' : `<button class="m-act" data-reply="${m.id}" data-name="${escapeHtml(m.name)}">↩ 回覆</button>`) +
    `<button class="m-act" data-del="${m.id}">🗑 刪除</button></div>`
  return `<div class="msg-item${isReply ? ' m-reply' : ''}">` +
    `<div><span class="m-name">${escapeHtml(m.name)}</span><span class="m-when">${timeAgo(m.at)}</span></div>` +
    `<div class="m-text">${escapeHtml(m.text)}</div>${acts}</div>`
}
async function loadMessages() {
  const list = document.getElementById('msg-list')
  list.innerHTML = '<div class="m-empty">載入中…</div>'
  let msgs = null
  try { const r = await fetch('/api/messages'); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) msgs = j } } catch {}
  if (msgs === null) { list.innerHTML = '<div class="m-empty">留言板需連線到伺服器（線上版才可用）</div>'; return }
  if (!msgs.length) { list.innerHTML = '<div class="m-empty">還沒有留言，搶頭香！</div>'; return }
  const tops = msgs.filter((m) => m.parentId == null)                         // 頂層留言（API 已依新→舊）
  const byParent = {}
  for (const m of msgs) if (m.parentId != null) (byParent[m.parentId] = byParent[m.parentId] || []).push(m)
  list.innerHTML = tops.map((t) => {
    const reps = (byParent[t.id] || []).sort((a, b) => a.id - b.id)            // 回覆舊→新
    return msgItemHtml(t, false) + reps.map((r) => msgItemHtml(r, true)).join('')
  }).join('')
}
async function sendMessage() {
  const input = document.getElementById('msg-input')
  const text = input.value.trim()
  if (!text) return
  const btn = document.getElementById('msg-send'); btn.disabled = true
  try {
    const nameEl = document.getElementById('msg-name')
    const name = (nameEl && nameEl.value.trim()) || playerName || '匿名'
    try { localStorage.setItem('angrybb:msgname', name) } catch {}   // 記住自訂名字
    const body = { name, text, deviceId }
    if (replyTo) body.parentId = replyTo.id
    const r = await fetch('/api/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.ok) { input.value = ''; setReply(null); await loadMessages() }
    else if (j.error === 'too fast') alert('留言太頻繁，請稍候再試')
    else if (j.error === 'blocked') alert('留言含不當字詞，已擋下')
    else alert('留言失敗（需連線到線上版）')
  } catch { alert('留言失敗（需連線到線上版）') }
  btn.disabled = false
}
async function deleteMessage(id) {
  const key = prompt('刪除留言需要管理密碼：')
  if (key == null || key === '') return
  try {
    const r = await fetch('/api/messages', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: +id, key }),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.ok) await loadMessages()
    else if (j.error === 'forbidden') alert('密碼錯誤')
    else if (j.error === 'disabled') alert('刪除功能未啟用')
    else alert('刪除失敗')
  } catch { alert('刪除失敗') }
}
const dayLabel = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()}` }
async function openOnline() {
  const body = document.getElementById('online-body')
  body.innerHTML = '<div class="on-empty">載入中…</div>'
  document.getElementById('online-modal').classList.remove('hidden')
  let online = null, hist = []
  try { const r = await fetch('/api/online'); if (r.ok) online = (await r.json()).online } catch {}
  try { const r = await fetch('/api/online-history'); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) hist = j } } catch {}
  const nowLine = `<div class="on-now">目前線上 <b>${online != null ? online : '–'}</b> 人 · 最近 7 天每日尖峰</div>`
  if (!hist.length) { body.innerHTML = nowLine + '<div class="on-empty">還沒有歷史資料</div>'; return }
  const W = 300, H = 120, padX = 24, padY = 18
  const max = Math.max(1, ...hist.map((d) => d.peak))
  const n = hist.length
  const pts = hist.map((d, i) => {
    const x = n <= 1 ? W / 2 : padX + (i / (n - 1)) * (W - 2 * padX)
    const y = padY + (1 - d.peak / max) * (H - 2 * padY)
    return { x, y, peak: d.peak, label: dayLabel(d.at) }
  })
  const poly = pts.map((p) => `${p.x},${p.y}`).join(' ')
  const dots = pts.map((p) =>
    `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#e0533b"/>` +
    `<text x="${p.x}" y="${p.y - 7}" fill="#666" font-size="10" font-weight="bold" text-anchor="middle">${p.peak}</text>` +
    `<text x="${p.x}" y="${H - 3}" fill="#999" font-size="9" text-anchor="middle">${p.label}</text>`).join('')
  body.innerHTML = nowLine +
    `<svg viewBox="0 0 ${W} ${H}"><polyline points="${poly}" fill="none" stroke="#e0533b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`
}

// ============================================================
//  商店（球棒）
// ============================================================
const shopModal = document.getElementById('shop-modal')
function starsOf(v, max = 1.6, n = 6) {   // 屬性條（0~n 顆）
  const k = Math.round((v / max) * n)
  return '<span class="bat-bar">' + '●'.repeat(Math.max(1, Math.min(n, k))) + '<span class="dim">' + '●'.repeat(n - Math.max(1, Math.min(n, k))) + '</span></span>'
}
function renderShop() {
  const list = document.getElementById('shop-list'); if (!list) return
  const head = document.getElementById('shop-count')
  if (head) head.textContent = `💰 ${wallet.toLocaleString()} 金幣`
  list.innerHTML = BATS.map((b) => {
    const own = !!owned[b.key]
    const eq = equippedBat === b.key
    let btn
    if (eq) btn = `<button class="shop-toggle on" data-bat="${b.key}">已裝備</button>`
    else if (own) btn = `<button class="shop-toggle" data-bat="${b.key}">裝備</button>`
    else btn = `<button class="shop-buy${wallet >= b.price ? '' : ' poor'}" data-bat="${b.key}">💰 ${b.price.toLocaleString()}</button>`
    return `<div class="shop-item"><div class="shop-emoji">${b.emoji}</div>` +
      `<div class="shop-info"><div class="shop-name">${b.name}</div><div class="shop-desc">${b.desc}</div>` +
      `<div class="bat-stats">力量 ${starsOf(b.power)}　甜蜜點 ${starsOf(b.sweet)}</div></div>` + btn + `</div>`
  }).join('')
}
function openShop() { renderShop(); shopModal.classList.remove('hidden') }
document.getElementById('shop-list').addEventListener('click', (e) => {
  const el = e.target.closest('[data-bat]'); if (!el) return
  const key = el.dataset.bat
  const b = batByKey(key)
  const head = document.getElementById('shop-count')
  if (!owned[key]) {
    if (wallet < b.price) { if (head) { head.classList.add('warn'); setTimeout(() => head.classList.remove('warn'), 900) } return }
    wallet -= b.price; saveWallet()
    owned[key] = true; saveOwned()
    sfx.coin()
  }
  equippedBat = key
  try { localStorage.setItem(EQUIP_KEY, key) } catch {}
  sfx.pop()
  buildBatView()
  renderShop()
})

// ============================================================
//  UI 佈線（登入 / 選單 / 暫停 / 彈窗）
// ============================================================
const overlay = document.getElementById('overlay')
const landing = document.getElementById('landing')
const nameInput = document.getElementById('name-input')
const startBtn = document.getElementById('start-btn')
const lbModal = document.getElementById('lb-modal')
function refreshStartBtn() {
  const ok = nameInput.value.trim().length > 0
  startBtn.disabled = !ok
  document.getElementById('name-hint').style.visibility = ok ? 'hidden' : 'visible'
  if (ok) setPlayerName(nameInput.value)
}
function showLanding() {
  exitLock()
  hud.msg.classList.add('hidden')
  overlay.classList.add('hidden')
  lbModal.classList.add('hidden')
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.add('hidden')
  if (game) game.paused = false
  nameInput.value = playerName
  refreshStartBtn()
  updateMusicBtn()
  landing.classList.remove('hidden')
  nameInput.focus()
  flushTotals(); refreshOnline(); setTimeout(refreshTotals, 400)
}
function buildLevelSelect() {
  const list = document.getElementById('level-list')
  list.innerHTML = ''
  LEVELS.forEach((L, i) => {
    const unlocked = levelUnlocked(i)
    const got = levelStars[i] || 0
    const btn = document.createElement('button')
    btn.className = 'level-card' + (unlocked ? '' : ' locked')
    let stars = ''
    for (let s = 0; s < 3; s++) stars += `<span class="cs${s < got ? ' on' : ''}">★</span>`
    btn.innerHTML =
      `<div class="lv-num">${unlocked ? (i + 1) : '🔒'}</div>` +
      `<div class="lv-name">${L.name}</div>` +
      `<div class="lv-stars">${stars}</div>`
    if (unlocked) btn.addEventListener('click', () => startLevel(i))
    else btn.disabled = true
    list.appendChild(btn)
  })
}
function showMenu() {
  exitLock()
  hud.msg.classList.add('hidden')
  document.getElementById('pause').classList.add('hidden')
  document.getElementById('pause-hint').classList.add('hidden')
  if (game) game.paused = false
  buildLevelSelect()
  const who = document.getElementById('who')
  if (who) who.innerHTML = playerName ? `打者：<b>${escapeHtml(playerName)}</b>　💰 ${wallet.toLocaleString()}` : ''
  overlay.classList.remove('hidden')
}
function beginFromLanding() {
  if (nameInput.value.trim().length === 0) return
  setPlayerName(nameInput.value)
  landing.classList.add('hidden')
  showMenu()
}
nameInput.addEventListener('input', refreshStartBtn)
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') beginFromLanding() })
startBtn.addEventListener('click', beginFromLanding)
document.getElementById('to-home').addEventListener('click', showLanding)
document.getElementById('derby-btn').addEventListener('click', startDerby)
document.getElementById('survival-btn').addEventListener('click', startSurvival)
document.getElementById('retry').addEventListener('click', () => {
  if (!game) return
  if (game.mode === 'derby') startDerby()
  else if (game.mode === 'survival') startSurvival()
  else startLevel(game.levelIdx)
})
document.getElementById('next').addEventListener('click', () => startLevel(game.levelIdx + 1))
for (const id of ['to-menu', 'to-menu2']) {
  const el = document.getElementById(id)
  if (el) el.addEventListener('click', showMenu)
}
// 排行榜分頁
const LB_TABS = [
  { k: '', label: '🏆 總分' },
  { k: DERBY_KEY, label: '⚾ 大賽' },
  { k: SURVIVAL_KEY, label: '🔥 生存' },
  { k: FAR_KEY, label: '🚀 最遠' },
]
let lbTab = ''
const lbTabsEl = document.getElementById('lb-tabs')
lbTabsEl.innerHTML = LB_TABS.map((t) => `<button class="lb-tab" data-k="${t.k}">${t.label}</button>`).join('')
function setLbTab(k) {
  lbTab = k
  for (const b of lbTabsEl.children) b.classList.toggle('active', b.dataset.k === k)
  renderLeaderboard(k)
}
lbTabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]')
  if (b) setLbTab(b.dataset.k)
})
function openLB() { setLbTab(''); lbModal.classList.remove('hidden') }
document.getElementById('lb-close').addEventListener('click', () => lbModal.classList.add('hidden'))
lbModal.addEventListener('click', (e) => { if (e.target === lbModal) lbModal.classList.add('hidden') })
document.getElementById('lb-btn-landing').addEventListener('click', openLB)
document.getElementById('shop-btn-landing').addEventListener('click', openShop)
document.getElementById('shop-btn-menu').addEventListener('click', openShop)
const msgModal = document.getElementById('msg-modal')
function openMsg() {
  const mn = document.getElementById('msg-name')
  if (mn && !mn.value) { let saved = ''; try { saved = localStorage.getItem('angrybb:msgname') || '' } catch {}; mn.value = saved || playerName || '' }
  setReply(null); loadMessages(); msgModal.classList.remove('hidden')
}
document.getElementById('msg-btn-landing').addEventListener('click', openMsg)
document.getElementById('online-btn-landing').addEventListener('click', openOnline)
document.getElementById('msg-send').addEventListener('click', sendMessage)
document.getElementById('msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage() })
// 留言列表：回覆 / 刪除（事件委派）
document.getElementById('msg-list').addEventListener('click', (e) => {
  const rep = e.target.closest('[data-reply]'); if (rep) { setReply(+rep.dataset.reply, rep.dataset.name); return }
  const del = e.target.closest('[data-del]'); if (del) { deleteMessage(del.dataset.del) }
})
document.getElementById('msg-reply-hint').addEventListener('click', (e) => { if (e.target.closest('#msg-reply-cancel')) setReply(null) })
for (const btn of document.querySelectorAll('.mclose[data-close]')) {
  btn.addEventListener('click', () => document.getElementById(btn.dataset.close).classList.add('hidden'))
}
const settingsModal = document.getElementById('settings-modal')
const onlineModal = document.getElementById('online-modal')
const debugModal = document.getElementById('debug-modal')
for (const m of [msgModal, onlineModal, shopModal, settingsModal, debugModal]) m.addEventListener('click', (e) => {
  if (e.target === m) m.classList.add('hidden')
})
// ---- Debug 選單（測試用）----
function renderDebug() {
  const el = document.getElementById('debug-wallet')
  if (el) el.textContent = wallet.toLocaleString()
}
document.getElementById('debug-open').addEventListener('click', () => { renderDebug(); debugModal.classList.remove('hidden') })
document.getElementById('debug-coins').addEventListener('click', () => {
  wallet += 10000; saveWallet()
  sfx.coin()
  renderDebug(); refreshHUD()
})
// 設定選單
const setSens = document.getElementById('set-sens'), setSensV = document.getElementById('set-sens-v')
const setSfx = document.getElementById('set-sfx'), setSfxV = document.getElementById('set-sfx-v')
const setMus = document.getElementById('set-mus'), setMusV = document.getElementById('set-mus-v')
const setFov = document.getElementById('set-fov'), setFovV = document.getElementById('set-fov-v')
const setShakeBtn = document.getElementById('set-shake')
const setBallcamBtn = document.getElementById('set-ballcam')
function syncSettingsUI() {
  setSens.value = settings.sens; setSensV.textContent = settings.sens.toFixed(1) + '×'
  setSfx.value = settings.sfxVol; setSfxV.textContent = settings.sfxVol + '%'
  setMus.value = settings.musVol; setMusV.textContent = settings.musVol + '%'
  setFov.value = settings.fov; setFovV.textContent = settings.fov + '°'
  setShakeBtn.textContent = settings.shake ? '開' : '關'; setShakeBtn.classList.toggle('on', settings.shake)
  setBallcamBtn.textContent = settings.ballcam ? '跟著球' : '留在原地'; setBallcamBtn.classList.toggle('on', settings.ballcam)
}
function openSettings() { syncSettingsUI(); settingsModal.classList.remove('hidden') }
document.getElementById('settings-btn-landing').addEventListener('click', openSettings)
document.getElementById('settings-btn-pause').addEventListener('click', openSettings)
setSens.addEventListener('input', () => { settings.sens = +setSens.value; setSensV.textContent = settings.sens.toFixed(1) + '×'; saveSettings() })
setSfx.addEventListener('input', () => { settings.sfxVol = +setSfx.value; setSfxV.textContent = settings.sfxVol + '%'; setSfxVolume(settings.sfxVol / 100); saveSettings() })
setMus.addEventListener('input', () => { settings.musVol = +setMus.value; setMusV.textContent = settings.musVol + '%'; setMusicVolume(settings.musVol / 100); saveSettings() })
setFov.addEventListener('input', () => { settings.fov = +setFov.value; setFovV.textContent = settings.fov + '°'; resize(); saveSettings() })
setShakeBtn.addEventListener('click', () => { settings.shake = !settings.shake; setShakeBtn.textContent = settings.shake ? '開' : '關'; setShakeBtn.classList.toggle('on', settings.shake); saveSettings() })
setBallcamBtn.addEventListener('click', () => { settings.ballcam = !settings.ballcam; syncSettingsUI(); saveSettings() })
document.getElementById('set-reset').addEventListener('click', () => {
  Object.assign(settings, SETTINGS_DEFAULTS)
  saveSettings(); applySettings(); syncSettingsUI()
})
// 音樂
let musicEnabled = localStorage.getItem('angrybb:music') !== 'off'
function updateMusicBtn() {
  const b = document.getElementById('music-toggle')
  if (b) b.innerHTML = `<span class="ico">${musicEnabled ? '🔊' : '🔇'}</span>${musicEnabled ? '音樂開' : '音樂關'}`
}
function toggleMusic() {
  musicEnabled = !musicEnabled
  localStorage.setItem('angrybb:music', musicEnabled ? 'on' : 'off')
  if (musicEnabled) { initAudio(); music.start() } else music.stop()
  updateMusicBtn()
}
document.getElementById('music-toggle').addEventListener('click', toggleMusic)
document.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') toggleMusic() })
// 暫停
function pauseGame() {
  if (!game || game.over || game.paused || game.intro) return
  game.paused = true
  document.getElementById('pause-text').textContent = `${modeLabel()}・目前得分 ${game.score.toLocaleString()}`
  document.getElementById('end-btn').textContent = game.mode === 'survival' ? '☠️ 結束生存' : '← 結束本場'
  document.getElementById('pause').classList.remove('hidden')
}
function resumeGame() {
  if (!game) return
  game.paused = false
  document.getElementById('pause').classList.add('hidden')
  if (!IS_TOUCH) canvas.requestPointerLock()
}
document.getElementById('resume-btn').addEventListener('click', resumeGame)
document.getElementById('end-btn').addEventListener('click', () => {
  game.paused = false
  document.getElementById('pause').classList.add('hidden')
  endGame()
})
document.getElementById('pause-btn').addEventListener('click', pauseGame)
// 進場只上報一次（不再心跳輪詢）：線上人數 = 近 3 小時活躍人數 → 大幅降低 Functions 請求數
enterOnline(); refreshTotals()
setInterval(() => { if (!document.hidden) flushTotals() }, 30000)
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTotals() })

// ============================================================
//  第一人稱控制（指標鎖定；打擊只需小幅瞄準）
// ============================================================
let locked = false
const yaw = 0, pitch = -0.3   // 鏡頭固定：微微下望正對好球帶
function exitLock() { if (document.pointerLockElement) document.exitPointerLock() }
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas
  if (!locked) {
    if (game && !game.over && !game.paused && !game.intro) pauseGame()
  } else {
    overlay.classList.add('hidden')
  }
})
document.addEventListener('mousemove', (e) => {
  if (!locked || (game && game.intro) || (game && game.ballcam)) return
  // 鏡頭固定：滑鼠只移動白框內的打擊準星
  aimPos.x += e.movementX * AIM_SENS * settings.sens
  aimPos.y -= e.movementY * AIM_SENS * settings.sens
  clampAim()
})
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (game && game.intro) { endIntro(); return }
  if (!locked) { if (!IS_TOUCH && game && !game.over && !game.paused) canvas.requestPointerLock(); return }
  doSwing()
})
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && game && game.intro) endIntro()
})
// 手機：虛擬搖桿（移動打擊準星）+ 揮棒鈕
const LOOK_RATE = 1.8   // 搖桿滿舵時準星移動速度（公尺/秒）；好球帶寬 1.1m，約 0.6 秒掃過全區
let lookX = 0, lookY = 0
const touchControls = document.getElementById('touch-controls')
const hudEl = document.getElementById('hud')
{
  const base = document.getElementById('joystick'), knob = document.getElementById('joy-knob')
  const swingBtn = document.getElementById('swing-btn')
  const JOY_R = 40
  let joyId = null, cx = 0, cy = 0
  const setKnob = (kx, ky) => { knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))` }
  const updateJoy = (t) => {
    const dx = t.clientX - cx, dy = t.clientY - cy
    const d = Math.hypot(dx, dy) || 1, m = Math.min(d, JOY_R), a = Math.atan2(dy, dx)
    const kx = Math.cos(a) * m, ky = Math.sin(a) * m
    setKnob(kx, ky); lookX = kx / JOY_R; lookY = ky / JOY_R
  }
  base.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; joyId = t.identifier
    const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2
    updateJoy(t); e.preventDefault()
  }, { passive: false })
  window.addEventListener('touchmove', (e) => {
    if (joyId == null) return
    for (const t of e.changedTouches) if (t.identifier === joyId) { updateJoy(t); e.preventDefault() }
  }, { passive: false })
  const endJoy = (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; lookX = lookY = 0; setKnob(0, 0) } }
  window.addEventListener('touchend', endJoy); window.addEventListener('touchcancel', endJoy)
  swingBtn.addEventListener('touchstart', (e) => {
    e.preventDefault()
    if (game && game.intro) { endIntro(); return }
    doSwing()
  }, { passive: false })
}

// ---- 開場運鏡 ----
const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t) }
function updateIntroCamera(kRaw) {
  const k = Math.max(0, Math.min(1, kRaw))
  if (k < 0.7) {
    const a = Math.PI / 2 + (k / 0.7) * Math.PI * 2
    camera.position.set(ORBIT_CENTER.x + Math.cos(a) * ORBIT_R, ORBIT_H, ORBIT_CENTER.z + Math.sin(a) * ORBIT_R)
    camera.lookAt(ORBIT_CENTER)
  } else {
    const e = smoothstep((k - 0.7) / 0.3)
    const frontHigh = new THREE.Vector3(ORBIT_CENTER.x, ORBIT_H, ORBIT_CENTER.z + ORBIT_R)
    camera.position.lerpVectors(frontHigh, EYE, e)
    const look = new THREE.Vector3().lerpVectors(ORBIT_CENTER, new THREE.Vector3(0, 1.6, -10), e)
    camera.lookAt(look)
  }
}
function endIntro() {
  if (!game || !game.intro) return
  game.intro = false
  restoreCam()
  schedulePitch(0.8)
}
function restoreCam() {
  camera.position.copy(EYE)
  camera.rotation.set(pitch, yaw, 0)
}

// ============================================================
//  主迴圈
// ============================================================
const clock = new THREE.Clock()
let acc = 0
const FIXED = 1 / 60
let hitStop = 0   // 目前僅保留機制（定格/慢動作演出已移除，不再設定）
const camTmp = new THREE.Vector3()

function loop() {
  requestAnimationFrame(loop)
  const dt = Math.min(clock.getDelta(), 0.05)
  if (game && game.paused) { renderer.render(scene, camera); return }
  if (hitStop > 0) { hitStop -= dt; renderer.render(scene, camera); return }
  const sdt = dt
  updateEnv(sdt)
  updateBlimp(sdt)
  updateFX(sdt)
  updatePitcher(sdt)
  updateBatView(dt)
  if (swingCd > 0) swingCd -= dt
  if (pitchLabelT > 0) { pitchLabelT -= dt; if (pitchLabelT <= 0) document.getElementById('pitch-label').classList.remove('show') }
  if (distBigHold > 0) { distBigHold -= dt; if (distBigHold <= 0 && hud.distBig) hud.distBig.classList.add('hidden') }

  if (game && !game.over) {
    // 物理固定步進（含變化球加速度）
    acc += sdt
    let n = 0
    while (acc >= FIXED && n < 5) {
      if (ball && ball.state === 'incoming') {
        const a = ball.pitch.acc, m = ball.body.mass
        let ax = a[0], ay = a[1]
        if (ball.pitch.wobble) {
          ball.wob = (ball.wob || 0) + FIXED
          ax += Math.sin(ball.wob * 7 + 1) * ball.pitch.wobble
          ay += Math.cos(ball.wob * 9) * ball.pitch.wobble * 0.5
        }
        ball.body.applyForce(new CANNON.Vec3(ax * m, ay * m, 0))
      }
      world.step(FIXED); acc -= FIXED; n++
    }

    if (game.intro) {
      game.introT += dt
      updateIntroCamera(game.introT / INTRO_DUR)
      if (game.introT >= INTRO_DUR) endIntro()
    } else {
      // 手機搖桿：移動打擊準星（鏡頭固定）
      if (IS_TOUCH && (lookX || lookY) && !game.ballcam) {
        aimPos.x += lookX * LOOK_RATE * settings.sens * dt
        aimPos.y -= lookY * LOOK_RATE * settings.sens * dt
        clampAim()
      }
      pendingSeconds += dt
      // ---- 投球狀態機 ----
      game.phaseT += dt
      if (game.phase === 'wait' && game.phaseT >= 0) startWindup()
      if (window.__DBG) { window.__dbgBallZ = (ball && ball.state === 'incoming') ? ball.body.position.z : null; window.__dbgAim = { x: aimPos.x, y: aimPos.y } }
      if (game.phase === 'fly' && ball && ball.state === 'incoming') {
        const p = ball.body.position
        // 時機縮圈：跟著剩餘時間收縮
        const vz = ball.body.velocity.z
        const tRem = vz > 0.5 ? (CONTACT_Z - p.z) / vz : 0
        if (ring.visible) {
          const s = Math.max(0.5, 0.5 + tRem * 3.2)
          ring.position.set(ball.pitch.target.x, ball.pitch.target.y, CONTACT_Z + 0.01)
          ring.scale.set(s, s, 1)
          ring.material.color.set(tRem < 0.12 ? 0x5bff8a : 0xffffff)
        }
        if (p.z > CONTACT_Z + 1.3 || p.y < 0.1) resolveTake()   // 進捕手（或觸地暴投）
      }
      if (game.resolveT > 0) {
        game.resolveT -= dt
        if (game.resolveT <= 0) afterResolve()
      }
      // 打出去的球：落地 / 里程碑 / 拖尾
      if (ball && ball.state === 'hit') {
        const p = ball.body.position
        const dist = Math.hypot(p.x, p.z)
        while (ball.ms < MS_DIST.length && dist >= MS_DIST[ball.ms].v && p.y > 2) {
          spawnFloater(p, 1.2, MS_DIST[ball.ms].t, { fill: '#9fe6ff', size: 58, life: 0.85, rise: 2.4, grow: 0.9, worldScale: 2.4 })
          ball.ms++
        }
        // 拖尾（依球棒特效換色）；用真實時間節流，慢動作中拖尾依然綿密
        ball.trailT = (ball.trailT || 0) + dt
        if (ball.trailT > 0.03) {
          ball.trailT = 0
          const fx = bat().fx
          const col = fx === 'nodrag' ? new THREE.Color().setHSL(0.05, 1, 0.6)
            : fx === 'lucky' ? new THREE.Color().setHSL(0.13, 1, 0.65)
            : ball.pitch.special === 'gold' ? new THREE.Color().setHSL(0.13, 1, 0.7)
            : new THREE.Color(0.9, 0.95, 1)
          addSpark(p.x, p.y, p.z, 0.5, col, { life: 0.4 })
        }
        if (p.y <= BALL_R + 0.05 && ball.body.velocity.y <= 0.01) resolveLanding()
        else if (ball.born > 12) { ball.state = 'dead'; resolveDone(0.3) }   // 保險
      }
      if (ball) ball.born += sdt
      // 投手火球 / 特殊球拖尾（進來的球）
      if (ball && ball.state === 'incoming' && (ball.pitch.special === 'gold' || PITCHES[ball.pitch.type].fire)) {
        ball.trailT = (ball.trailT || 0) + sdt
        if (ball.trailT > 0.03) {
          ball.trailT = 0
          const p = ball.body.position
          addSpark(p.x, p.y, p.z, 0.4, ball.pitch.special === 'gold' ? new THREE.Color(1, 0.85, 0.3) : new THREE.Color(1, 0.4, 0.15), { life: 0.3 })
        }
      }
    }
  }

  // 實體同步 + 動畫 + 消滅縮小
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]
    e.group.position.copy(e.body.position)
    e.group.quaternion.copy(e.body.quaternion)
    if (e.mixer) e.mixer.update(sdt)
    if (e.dead && e.popping !== undefined) {
      e.popping += sdt
      const k = Math.max(0, 1 - e.popping / 0.35)
      e.group.scale.setScalar(k)
      if (k <= 0.001 && !e.removed) { e.removed = true; world.removeBody(e.body); scene.remove(e.group); entities.splice(i, 1) }
    }
  }

  // Ball-Cam：慢動作追球
  if (game && game.ballcam && ball && (ball.state === 'hit' || ball.state === 'landed')) {
    const p = ball.body.position
    const v = ball.body.velocity
    const sp = Math.hypot(v.x, v.y, v.z)
    if (sp > 1) {
      camTmp.set(p.x - v.x / sp * 7, Math.max(2, p.y - v.y / sp * 7 + 2.5), p.z - v.z / sp * 7)
    } else {
      camTmp.set(p.x, p.y + 4, p.z + 9)
    }
    camera.position.lerp(camTmp, Math.min(1, dt * 5))
    camera.lookAt(p.x, p.y, p.z)
  }

  // 只在實際遊玩中顯示 HUD / 手機控制
  const inGame = !!game && !game.over && !game.paused &&
    overlay.classList.contains('hidden') && landing.classList.contains('hidden')
  hudEl.style.display = inGame ? '' : 'none'
  batView.visible = inGame && !game.intro && !game.ballcam
  // 好球帶白框 + 打擊準星：打擊視角時常駐顯示
  const aimUi = inGame && !game.intro && !game.ballcam
  zoneGroup.visible = aimUi
  aimCross.visible = aimUi
  if (aimUi) aimCross.position.set(aimPos.x, aimPos.y, CONTACT_Z + 0.02)
  if (touchControls) touchControls.classList.toggle('show', IS_TOUCH && inGame)

  // 畫面震動
  if (shakeMag > 0.001 && game && !game.intro && !game.over && !game.paused && !game.ballcam) {
    const s = shakeMag, R = () => (Math.random() * 2 - 1)
    camera.position.set(EYE.x + R() * s * 0.15, EYE.y + R() * s * 0.15, EYE.z + R() * s * 0.15)
    camera.rotation.set(pitch + R() * s * 0.025, yaw + R() * s * 0.025, R() * s * 0.025)
    shakeMag = Math.max(0, shakeMag - dt * 4)
    if (shakeMag <= 0.001) restoreCam()
  }

  renderer.render(scene, camera)
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.fov = camera.aspect >= 1 ? settings.fov : Math.max(settings.fov - 8, Math.min(settings.fov + 6, settings.fov - 14 + camera.aspect * 24))
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
window.addEventListener('orientationchange', resize)
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize)

// FX 掛鉤：爆炸需要震屏 / 推飛實體 / 播音效
setFXHooks({ shake: addShake, entities: () => entities, sfxExplode: () => sfx.explode() })

loadAll().then(() => {
  buildStadium()
  buildCrowd(makeStatic)
  applyBiome(0)
  applySettings()
  resize()
  camera.rotation.set(pitch, yaw, 0)
  buildBatView()
  showLanding()
  loop()
  document.getElementById('loading').remove()
}).catch((err) => { document.getElementById('loading').textContent = '載入失敗：' + err; console.error(err) })
