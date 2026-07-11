// ============================================================
//  渲染核心 + 棒球場（three.js 場景 / cannon-es 世界 / 球場幾何 / biome 換景）
//  打者在本壘（原點附近，看 -Z），投手丘在 z=-18.4，外野牆 92~112m 弧線
// ============================================================
import * as THREE from 'three'
import * as CANNON from 'cannon-es'

export const EYE = new THREE.Vector3(0, 1.7, 1.9)   // 打者眼睛位置
export const MOUND_Z = -18.4                          // 投手丘
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
if (IS_TOUCH) document.body.classList.add('touch')

// ---- three ----
export const canvas = document.getElementById('game')
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.08

export const scene = new THREE.Scene()
function makeSkyTexture(stops) {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, stops[0]); g.addColorStop(0.55, stops[1]); g.addColorStop(1, stops[2])
  ctx.fillStyle = g; ctx.fillRect(0, 0, 2, 256)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
scene.background = makeSkyTexture(['#3f9fe6', '#8fd0f2', '#e9f6d6'])
scene.fog = new THREE.Fog(0xcfeaf5, 120, 420)

export const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 800)
camera.rotation.order = 'YXZ'
camera.position.copy(EYE)
scene.add(camera)   // 讓第一人稱球棒（掛在 camera 下）能被渲染

export const hemiLight = new THREE.HemisphereLight(0xbfe4ff, 0x6b7a3a, 0.95)
scene.add(hemiLight)
export const sun = new THREE.DirectionalLight(0xfff0d0, 2.7)
sun.position.set(-30, 55, 20)
sun.castShadow = true
sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048)
sun.shadow.bias = -0.0004
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 })
scene.add(sun)
export const ambLight = new THREE.AmbientLight(0xffffff, 0.32)
scene.add(ambLight)

// ---- cannon 世界 ----
export const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
world.broadphase = new CANNON.SAPBroadphase(world)
world.allowSleep = true
world.solver.iterations = 12

export const matGround = new CANNON.Material('ground')
export const matBox = new CANNON.Material('box')
export const matBall = new CANNON.Material('ball')
world.addContactMaterial(new CANNON.ContactMaterial(matBox, matGround, { friction: 0.5, restitution: 0.1 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBox, matBox, { friction: 0.5, restitution: 0.05 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matBox, { friction: 0.3, restitution: 0.45 }))
world.addContactMaterial(new CANNON.ContactMaterial(matBall, matGround, { friction: 0.35, restitution: 0.42 }))

export const groundBody = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Plane() })
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
world.addBody(groundBody)

// ============================================================
//  外野牆幾何：wallDistAt(θ)＝離本壘距離；θ＝偏離中外野的角度（弧度）
//  中外野 112m、邊線 92m；界內＝z<0 且 |x| <= -z（左右 45° 界線內）
// ============================================================
export const wallDistAt = (theta) => 92 + 20 * Math.cos(2 * Math.min(Math.PI / 4, Math.abs(theta)))
export const isFair = (x, z) => z < -2 && Math.abs(x) <= -z + 0.5

// ============================================================
//  環境（草地 / 內野土 / 遠山 / 雲 / 觀眾席）
// ============================================================
const clouds = []
const crowd = []   // 觀眾動物（純視覺，輕微上下彈跳）
const env = { hills: [] }

const GRASS_DEF = { base: '#57b53a', a: '#63c043', b: '#4fa833', lite: 'rgba(120,200,80,0.35)', dark: 'rgba(40,110,30,0.30)' }
function makeGrassTexture(pal = GRASS_DEF) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  ctx.fillStyle = pal.base; ctx.fillRect(0, 0, s, s)
  const stripes = 4, sw = s / stripes
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? pal.a : pal.b
    ctx.fillRect(i * sw, 0, sw, s)
  }
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * s, y = Math.random() * s
    ctx.fillStyle = Math.random() < 0.5 ? pal.lite : pal.dark
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(56, 56)
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return tex
}
const DIRT_DEF = { c0: '176,128,82', c1: '160,115,70', c2: '145,103,62', sp0: '110,78,48', sp1: '205,170,120' }
function makeDirtTexture(pal = DIRT_DEF) {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.18, s / 2, s / 2, s * 0.5)
  g.addColorStop(0, `rgba(${pal.c0},1)`); g.addColorStop(0.7, `rgba(${pal.c1},0.95)`)
  g.addColorStop(1, `rgba(${pal.c2},0)`)
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s)
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * s * 0.46
    const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(${pal.sp0},0.5)` : `rgba(${pal.sp1},0.45)`
    const d = 1 + Math.random() * 2.5; ctx.fillRect(x, y, d, d)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
// 土色圓（本壘區 / 投手丘 / 壘包區共用）
function dirtCircle(x, z, r, y = 0.02) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(r, 40),
    new THREE.MeshStandardMaterial({ map: makeDirtTexture(), roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }))
  m.rotation.x = -Math.PI / 2
  m.position.set(x, y, z)
  m.receiveShadow = true
  scene.add(m)
  env.dirts = env.dirts || []; env.dirts.push(m)
  return m
}
// 文字 Sprite（牆上距離標示）
function textSprite(text, { size = 64, fill = '#ffffff', w = 4 } = {}) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128
  const ctx = c.getContext('2d')
  ctx.font = `900 ${size}px "Segoe UI", sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(text, 128, 66)
  ctx.fillStyle = fill; ctx.fillText(text, 128, 66)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
  sp.scale.set(w, w / 2, 1)
  return sp
}

const WALL_SEGS = 26
export function buildStadium() {
  // --- 大草地 ---
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1, metalness: 0 }))
  grass.rotation.x = -Math.PI / 2
  grass.receiveShadow = true
  scene.add(grass)
  env.grass = grass

  // --- 內野：本壘土圈 + 投手丘 + 壘包 ---
  dirtCircle(0, -1, 8)                       // 本壘區
  dirtCircle(0, MOUND_Z, 4, 0.021)           // 投手丘土圈
  const mound = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 3.1, 0.4, 24),
    new THREE.MeshStandardMaterial({ color: 0xb08052, roughness: 1 }))
  mound.position.set(0, 0.2, MOUND_Z)
  mound.receiveShadow = true; mound.castShadow = true
  scene.add(mound)
  env.mound = mound
  // 壘包（一二三壘 + 本壘板）
  const baseGeo = new THREE.BoxGeometry(1.0, 0.12, 1.0)
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 })
  const D = 26
  for (const [bx, bz] of [[D * 0.707, -D * 0.707], [0, -D * 1.414], [-D * 0.707, -D * 0.707]]) {
    const b = new THREE.Mesh(baseGeo, baseMat)
    b.position.set(bx, 0.06, bz); b.rotation.y = Math.PI / 4
    b.castShadow = true; scene.add(b)
    dirtCircle(bx, bz, 3, 0.019)
  }
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 5), baseMat)
  plate.position.set(0, 0.03, 0)
  scene.add(plate)

  // --- 界外線（白線，本壘 → 左右外野牆）---
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 })
  for (const s of [-1, 1]) {
    const L = wallDistAt(Math.PI / 4)
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.16, L), lineMat)
    line.rotation.x = -Math.PI / 2
    line.rotation.z = s * Math.PI / 4
    line.position.set(s * L * 0.354, 0.03, -L * 0.354)
    scene.add(line)
  }

  // --- 外野全壘打牆（弧線；有物理，滾地球會彈回）+ 黃色頂線 + 距離標示 ---
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2e6db4, roughness: 0.9 })
  const wallTopMat = new THREE.MeshStandardMaterial({ color: 0xffd24a, roughness: 0.8 })
  env.wallMats = [wallMat]
  const H = 3.4
  const pts = []
  for (let i = 0; i <= WALL_SEGS; i++) {
    const th = -Math.PI / 4 + (i / WALL_SEGS) * Math.PI / 2
    const d = wallDistAt(th)
    pts.push(new THREE.Vector3(Math.sin(th) * d, 0, -Math.cos(th) * d))
  }
  for (let i = 0; i < WALL_SEGS; i++) {
    const a = pts[i], b = pts[i + 1]
    const len = a.distanceTo(b) + 0.25
    const mid = a.clone().add(b).multiplyScalar(0.5)
    const rotY = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2
    const seg = new THREE.Mesh(new THREE.BoxGeometry(len, H, 0.5), wallMat)
    seg.position.set(mid.x, H / 2, mid.z); seg.rotation.y = rotY
    seg.castShadow = true; seg.receiveShadow = true
    scene.add(seg)
    const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.54), wallTopMat)
    top.position.set(mid.x, H + 0.07, mid.z); top.rotation.y = rotY
    scene.add(top)
    // 物理牆段
    const body = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Box(new CANNON.Vec3(len / 2, H / 2, 0.25)) })
    body.position.set(mid.x, H / 2, mid.z)
    body.quaternion.setFromEuler(0, rotY, 0)
    world.addBody(body)
  }
  // 距離標示（公尺）
  for (const th of [-Math.PI / 4, -Math.PI / 8, 0, Math.PI / 8, Math.PI / 4]) {
    const d = wallDistAt(th)
    const sp = textSprite(String(Math.round(d)), { fill: '#fff', w: 6 })
    sp.position.set(Math.sin(th) * (d - 0.6), H * 0.62, -Math.cos(th) * (d - 0.6))
    scene.add(sp)
  }

  // --- 觀眾席（牆後三層彩色看台）---
  const standCols = [0xd45a4a, 0x4a8fd4, 0xe0b23a]
  for (let row = 0; row < 3; row++) {
    const mat = new THREE.MeshStandardMaterial({ color: standCols[row], roughness: 1 })
    for (let i = 0; i < WALL_SEGS; i++) {
      const th = -Math.PI / 4 + ((i + 0.5) / WALL_SEGS) * Math.PI / 2
      const d = wallDistAt(th) + 4 + row * 5
      const len = (d * Math.PI / 2) / WALL_SEGS + 0.3
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 2.2 + row * 1.4, 4.6), mat)
      seg.position.set(Math.sin(th) * d, (2.2 + row * 1.4) / 2, -Math.cos(th) * d)
      seg.rotation.y = -th   // 長邊沿弧線切線
      scene.add(seg)
    }
  }

  // --- 遠景低多邊形山丘 ---
  const hillGeo = new THREE.IcosahedronGeometry(1, 0)
  const hillGreens = [0x4e9e38, 0x5aac42, 0x459132, 0x66b84c]
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (i % 2) * 0.3
    const dist = 210 + (i % 4) * 40
    const r = 42 + (i % 3) * 22
    const mat = new THREE.MeshStandardMaterial({ color: hillGreens[i % 4], roughness: 1, flatShading: true })
    const hill = new THREE.Mesh(hillGeo, mat)
    hill.scale.set(r, r * (0.45 + (i % 3) * 0.12), r)
    hill.position.set(Math.cos(a) * dist, -r * 0.55, -40 + Math.sin(a) * dist)
    scene.add(hill)
    env.hills.push(hill)
  }

  // --- 蓬鬆雲朵 ---
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, fog: true })
  env.cloudMat = cloudMat
  const puffGeo = new THREE.SphereGeometry(1, 10, 8)
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group()
    const puffs = 4 + (i % 3)
    for (let p = 0; p < puffs; p++) {
      const s = 6 + Math.random() * 7
      const puff = new THREE.Mesh(puffGeo, cloudMat)
      puff.scale.set(s, s * 0.7, s)
      puff.position.set((p - puffs / 2) * 7 + Math.random() * 4, Math.random() * 3, Math.random() * 4)
      g.add(puff)
    }
    g.position.set(-260 + Math.random() * 520, 90 + Math.random() * 50, -80 - Math.random() * 220)
    scene.add(g)
    clouds.push({ mesh: g, speed: 1.2 + Math.random() * 1.8 })
  }
}

// 觀眾動物：載入資產後由主程式呼叫；站在看台上，輕微彈跳（純視覺無物理）
export function buildCrowd(makeStatic) {
  const types = ['pig', 'sheep', 'chicken', 'cat', 'dog', 'raccoon', 'wolf', 'chick', 'horse']
  for (let i = 0; i < 26; i++) {
    const th = -Math.PI / 4 + ((i + 0.5) / 26) * Math.PI / 2
    const row = i % 3
    const d = wallDistAt(th) + 4 + row * 5
    const obj = makeStatic(types[(i * 5 + row) % types.length], 1.5 + row * 0.5)
    if (!obj) continue
    const y = 2.2 + row * 1.4
    obj.position.set(Math.sin(th) * d + (Math.random() - 0.5) * 2, y, -Math.cos(th) * d)
    obj.rotation.y = -th   // 面向本壘
    scene.add(obj)
    crowd.push({ mesh: obj, baseY: y, phase: Math.random() * Math.PI * 2, speed: 2 + Math.random() * 2 })
  }
}
let cheerT = 0
export function crowdCheer(sec = 1.6) { cheerT = Math.max(cheerT, sec) }   // 全場歡呼：跳更高

// ============================================================
//  Biome 場景換膚（幾何不動，只換色盤）
// ============================================================
export const BIOMES = [
  { name: '🌿 白天球場',
    sky: ['#3f9fe6', '#8fd0f2', '#e9f6d6'], fog: 0xcfeaf5,
    hemi: [0xbfe4ff, 0x6b7a3a, 0.95], sun: [0xfff0d0, 2.7, [-30, 55, 20]], amb: [0xffffff, 0.32],
    grass: GRASS_DEF,
    hills: [0x4e9e38, 0x5aac42, 0x459132, 0x66b84c], cloud: [0xffffff, 0.92], wall: 0x2e6db4 },
  { name: '🌅 黃昏球場',
    sky: ['#ff7e3d', '#ffb066', '#ffe3b0'], fog: 0xf0b878,
    hemi: [0xffd0a0, 0x7a5636, 0.92], sun: [0xffa050, 2.6, [40, 32, 22]], amb: [0xffe0c0, 0.36],
    grass: { base: '#7aa544', a: '#86b04e', b: '#6e983c', lite: 'rgba(220,200,120,0.3)', dark: 'rgba(90,90,40,0.3)' },
    hills: [0xc79a5a, 0xb98a4a, 0xd4a866, 0xa87a3e], cloud: [0xffd9a0, 0.82], wall: 0x8a4a3a },
  { name: '❄️ 雪地球場',
    sky: ['#8fb8e0', '#cfe4f5', '#eef6fb'], fog: 0xdfeaf2,
    hemi: [0xdfeeff, 0x9aa8b0, 1.0], sun: [0xeaf2ff, 2.4, [-25, 50, 20]], amb: [0xffffff, 0.42],
    grass: { base: '#e6edf2', a: '#f2f6f9', b: '#d7e1e9', lite: 'rgba(255,255,255,0.5)', dark: 'rgba(175,190,205,0.3)' },
    hills: [0xcdd9e2, 0xdbe6ee, 0xbccad6, 0xe6eef4], cloud: [0xf2f6fb, 0.9], wall: 0x3a6a8a },
  { name: '🌃 夜間球場',
    sky: ['#0b1030', '#1a2350', '#33406e'], fog: 0x1a2246,
    hemi: [0x6070b0, 0x24283e, 0.78], sun: [0xcfe0ff, 2.0, [-20, 45, 15]], amb: [0x9aa8d8, 0.55],
    grass: { base: '#2c5a38', a: '#346844', b: '#244c2e', lite: 'rgba(90,230,180,0.22)', dark: 'rgba(10,28,20,0.4)' },
    hills: [0x223055, 0x2a3a66, 0x1c2848, 0x30407a], cloud: [0x3a4680, 0.5], wall: 0x28407a },
]
let currentBiome = -1
export function applyBiome(i) {
  const idx = ((i % BIOMES.length) + BIOMES.length) % BIOMES.length
  if (idx === currentBiome) return
  currentBiome = idx
  const b = BIOMES[idx]
  const old = scene.background; scene.background = makeSkyTexture(b.sky); if (old && old.dispose) old.dispose()
  scene.fog.color.set(b.fog)
  hemiLight.color.set(b.hemi[0]); hemiLight.groundColor.set(b.hemi[1]); hemiLight.intensity = b.hemi[2]
  sun.color.set(b.sun[0]); sun.intensity = b.sun[1]; sun.position.set(b.sun[2][0], b.sun[2][1], b.sun[2][2])
  ambLight.color.set(b.amb[0]); ambLight.intensity = b.amb[1]
  if (env.grass) { env.grass.material.map.dispose(); env.grass.material.map = makeGrassTexture(b.grass); env.grass.material.needsUpdate = true }
  env.hills.forEach((h, k) => h.material.color.set(b.hills[k % b.hills.length]))
  if (env.cloudMat) { env.cloudMat.color.set(b.cloud[0]); env.cloudMat.opacity = b.cloud[1] }
  if (env.wallMats) env.wallMats.forEach((m) => m.color.set(b.wall))
}

// 主迴圈呼叫：雲飄移 + 觀眾彈跳
export function updateEnv(dt) {
  for (const c of clouds) {
    c.mesh.position.x += c.speed * dt
    if (c.mesh.position.x > 280) c.mesh.position.x = -280
  }
  if (cheerT > 0) cheerT -= dt
  const excited = cheerT > 0
  for (const s of crowd) {
    s.phase += dt * s.speed * (excited ? 3 : 1)
    s.mesh.position.y = s.baseY + Math.abs(Math.sin(s.phase)) * (excited ? 0.9 : 0.18)
  }
}
