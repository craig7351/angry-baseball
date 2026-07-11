// ============================================================
//  特效系統：飄升跳字 / 發光光點 / 爆炸 / 煙火（沿用 angry-pig 的做法）
// ============================================================
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { scene } from './stadium.js'

// 主程式注入：爆炸要震屏 / 推飛實體 / 播音效
let hooks = { shake: () => {}, entities: () => [], sfxExplode: () => {} }
export function setFXHooks(h) { Object.assign(hooks, h) }

// ---- 一次性飄升文字 ----
const floaters = []
export function makeTextTexture(text, { fill = '#ffd63a', stroke = 'rgba(50,25,0,.9)', size = 76, weight = 900 } = {}) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128
  const ctx = c.getContext('2d')
  ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft JhengHei", sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke; ctx.strokeText(text, 256, 66)
  ctx.fillStyle = fill; ctx.fillText(text, 256, 66)
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
export function spawnFloater(pos, headY, text, opts = {}) {
  const w = opts.worldScale || 2.2
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeTextTexture(text, opts), transparent: true, depthTest: false }))
  sp.position.set(pos.x, pos.y + headY, pos.z)
  sp.scale.set(w * 2, w / 2, 1); sp.renderOrder = 999
  scene.add(sp)
  floaters.push({ sprite: sp, t: 0, w, life: opts.life || 1.0, rise: opts.rise || 1.8, grow: opts.grow ?? 0.6 })
}

// ---- 發光貼圖（光點 / 拖尾共用）----
let glowTex = null
export function getGlowTexture() {
  if (glowTex) return glowTex
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,220,140,0.8)'); g.addColorStop(1, 'rgba(255,180,60,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s)
  glowTex = new THREE.CanvasTexture(c)
  return glowTex
}

// ---- 光點（billboard，可帶速度/重力/成長）----
const sparks = []
export function addSpark(x, y, z, size, color, o = {}) {
  const mat = new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, depthWrite: false, blending: o.blend || THREE.AdditiveBlending })
  mat.color.copy(color)
  const sp = new THREE.Sprite(mat); sp.position.set(x, y, z); sp.scale.set(size, size, 1); sp.renderOrder = 997
  scene.add(sp)
  sparks.push({ sprite: sp, t: 0, life: o.life || 0.5, s0: size, vx: o.vx, vy: o.vy, vz: o.vz, g: o.g, grow: o.grow, op0: o.op != null ? o.op : 1 })
}

// ---- 膨脹淡出網格（火球 / 衝擊波環）----
const flashes = []
function addFlash(mesh, size0, grow, life) { mesh.scale.setScalar(size0); scene.add(mesh); flashes.push({ mesh, t: 0, size0, grow, life }) }
export function fireSphere(pos, color, size0, grow, life) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  m.position.set(pos.x, pos.y, pos.z)
  addFlash(m, size0, grow, life)
}

// ---- 爆炸（爆桶 / 雷神棒落雷共用）----
export function explode(pos, R = 4) {
  const px = pos.x, py = pos.y, pz = pos.z
  hooks.sfxExplode(); hooks.shake(Math.min(1.1, 0.6 + R * 0.06))
  fireSphere(pos, 0xfff2c0, R * 0.28, R * 0.7, 0.20)
  fireSphere(pos, 0xff8a2a, R * 0.30, R * 1.15, 0.34)
  fireSphere(pos, 0xd23a12, R * 0.34, R * 1.5, 0.46)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.9, 36),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2; ring.position.set(px, 0.12, pz)
  addFlash(ring, 1, R * 2.2, 0.42)
  const embers = 8 + Math.round(R * 2)
  for (let i = 0; i < embers; i++) {
    const a = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 8
    addSpark(px, py, pz, 0.35 + Math.random() * 0.4, new THREE.Color().setHSL(0.06 + Math.random() * 0.06, 1, 0.6),
      { vx: Math.cos(a) * sp, vy: (0.3 + Math.random() * 1.1) * sp * 0.7, vz: Math.sin(a) * sp, g: -16, life: 0.5 + Math.random() * 0.5 })
  }
  for (let i = 0; i < 4; i++) {
    addSpark(px + (Math.random() - 0.5) * R, py + 0.3, pz + (Math.random() - 0.5) * R, 1 + Math.random(),
      new THREE.Color(0.55, 0.53, 0.5), { blend: THREE.NormalBlending, op: 0.5, vy: 1.5 + Math.random() * 1.5, grow: 1.6, life: 0.9 + Math.random() * 0.5 })
  }
  // 推飛周圍實體
  for (const e of hooks.entities()) {
    if (e.dead || !e.body) continue
    const dx = e.body.position.x - px, dy = e.body.position.y - py, dz = e.body.position.z - pz
    const d = Math.hypot(dx, dy, dz)
    if (d > R || d < 0.01) continue
    const f = (1 - d / R) * e.body.mass
    e.body.wakeUp()
    e.body.applyImpulse(new CANNON.Vec3(dx / d * f * 18, (dy / d + 1) * f * 13, dz / d * f * 18))
  }
}

// ---- 煙火（全壘打慶祝）：夜空綻放的彩色光點球 ----
export function firework(x, y, z) {
  const hue = Math.random()
  fireSphere({ x, y, z }, new THREE.Color().setHSL(hue, 1, 0.7).getHex(), 0.6, 3, 0.25)
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), sp = 7 + Math.random() * 7
    addSpark(x, y, z, 0.5 + Math.random() * 0.4,
      new THREE.Color().setHSL(hue + (Math.random() - 0.5) * 0.12, 1, 0.62),
      { vx: Math.sin(b) * Math.cos(a) * sp, vy: Math.cos(b) * sp, vz: Math.sin(b) * Math.sin(a) * sp, g: -6, life: 0.9 + Math.random() * 0.5 })
  }
}
export function fireworkShow(cx, cz, n = 5) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => firework(cx + (Math.random() - 0.5) * 40, 22 + Math.random() * 18, cz + (Math.random() - 0.5) * 30), i * 300)
  }
}

// ---- 落雷（雷神棒）----
const bolts = []
export function drawBolt(a, b) {
  const seg = 8, pts = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, j = (i > 0 && i < seg) ? 1.2 : 0
    pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t + (Math.random() - 0.5) * j, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * j, a.z + (b.z - a.z) * t + (Math.random() - 0.5) * j))
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xcfefff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  line.renderOrder = 998; scene.add(line); bolts.push({ line, t: 0, life: 0.3 })
}

// ---- 主迴圈更新 ----
export function updateFX(dt) {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]; f.t += dt
    const k = Math.min(1, f.t / f.life), e = 1 - (1 - k) * (1 - k)
    f.mesh.scale.setScalar(f.size0 + f.grow * e)
    f.mesh.material.opacity = Math.max(0, 1 - k)
    if (f.t >= f.life) { scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); flashes.splice(i, 1) }
  }
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i]; b.t += dt
    b.line.material.opacity = Math.max(0, 1 - b.t / b.life)
    if (b.t >= b.life) { scene.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose(); bolts.splice(i, 1) }
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const p = floaters[i]; p.t += dt
    p.sprite.position.y += dt * p.rise
    const s = 1 + p.t * p.grow
    p.sprite.scale.set(p.w * 2 * s, p.w / 2 * s, 1)
    p.sprite.material.opacity = Math.max(0, 1 - p.t / p.life)
    if (p.t > p.life) {
      scene.remove(p.sprite); p.sprite.material.map.dispose(); p.sprite.material.dispose()
      floaters.splice(i, 1)
    }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]; s.t += dt
    const k = 1 - s.t / s.life
    if (s.vx !== undefined) {
      s.vy = (s.vy || 0) + (s.g || 0) * dt
      s.sprite.position.x += s.vx * dt; s.sprite.position.y += s.vy * dt; s.sprite.position.z += s.vz * dt
      const sc = s.s0 * (1 + (s.grow || 0) * s.t)
      s.sprite.scale.set(sc, sc, 1)
    } else {
      s.sprite.scale.setScalar(s.s0 * (0.4 + 0.6 * k))
    }
    s.sprite.material.opacity = Math.max(0, k) * (s.op0 || 1)
    if (s.t >= s.life) { scene.remove(s.sprite); s.sprite.material.dispose(); sparks.splice(i, 1) }
  }
}

export function clearFX() {
  flashes.forEach((f) => { scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose() }); flashes.length = 0
  bolts.forEach((b) => { scene.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose() }); bolts.length = 0
  floaters.forEach((p) => { scene.remove(p.sprite); p.sprite.material.map.dispose(); p.sprite.material.dispose() }); floaters.length = 0
  sparks.forEach((s) => { scene.remove(s.sprite); s.sprite.material.dispose() }); sparks.length = 0
}
