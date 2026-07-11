// ============================================================
//  打擊判定核心（純數學，無相依）＋ 球棒資料
//  不做真實球棒剛體碰撞：改用「時機 + 準星」混合判定，
//  把結果轉成出速/仰角/噴角，再交給 cannon-es 讓球真飛。
// ============================================================

export const CONTACT_Z = 0        // 觸擊平面（本壘板）
export const REACH = 0.85         // 準星離球預測點的最大有效半徑（公尺，寬鬆）
const BASE_WINDOW = 0.115         // 基準時機窗（秒）；乘上球棒 sweet 倍率

// ---- 球棒（商店商品）----
//   power：出速倍率　sweet：時機窗倍率（越大越好打中）
//   fx：特效鉤子 —— trail 拖尾色 / nodrag 無空氣阻力 / thunder perfect 落雷 /
//        magnet 顯示進壘預測點 / chaos 亂飛（鹹魚） / lucky 金幣 +10%
export const BATS = [
  { key: 'wood',    emoji: '🪵', name: '木棒',     price: 0,     power: 1.00, sweet: 1.00, desc: '基準球棒，全能平衡' },
  { key: 'bamboo',  emoji: '🥢', name: '竹棒',     price: 500,   power: 0.85, sweet: 1.60, desc: '超大甜蜜點，新手/刷連擊神器' },
  { key: 'alu',     emoji: '⚙️', name: '鋁棒',     price: 1200,  power: 1.10, sweet: 1.15, desc: '力量與容錯小升級，清脆手感' },
  { key: 'fish',    emoji: '🐟', name: '鹹魚',     price: 800,   power: 0.70, sweet: 1.30, desc: '啪嘰！球會亂飛，純搞笑', fx: 'chaos' },
  { key: 'hammer',  emoji: '🔨', name: '大鎚',     price: 2500,  power: 1.45, sweet: 0.55, desc: '打中必轟天，但甜蜜點極小', fx: 'trail:#ff8a2a' },
  { key: 'flame',   emoji: '🔥', name: '火焰棒',   price: 4000,  power: 1.15, sweet: 1.00, desc: '擊球無空氣阻力，距離 +25%', fx: 'nodrag' },
  { key: 'magnet',  emoji: '🧲', name: '磁力棒',   price: 5000,  power: 1.00, sweet: 1.20, desc: '顯示來球進壘預測點，變化球剋星', fx: 'magnet' },
  { key: 'thunder', emoji: '⚡', name: '雷神棒',   price: 6000,  power: 1.20, sweet: 1.00, desc: 'PERFECT 擊球時落點降下落雷', fx: 'thunder' },
  { key: 'gold',    emoji: '🌟', name: '傳說金棒', price: 15000, power: 1.35, sweet: 1.40, desc: '全屬性頂級 + 金色軌跡 + 金幣 +10%', fx: 'lucky' },
]
export const batByKey = (k) => BATS.find((b) => b.key === k) || BATS[0]

// ---- 擊球品質分級 ----
//   perfect > good > ok > foul（擦棒）；whiff = 揮空
export const TIERS = {
  perfect: { label: 'PERFECT!', mult: 1.0 },
  good:    { label: '強勁！',    mult: 1.0 },
  ok:      { label: '打中',      mult: 1.0 },
  foul:    { label: '擦棒',      mult: 0.4 },
}

/**
 * 揮棒判定。
 * @param {{x,y,z}} ballPos 目前球位置
 * @param {{x,y,z}} ballVel 目前球速度（vz > 0 朝打者）
 * @param {{x,y}} aim 準星射線與觸擊平面的交點
 * @param {object} bat 球棒（BATS 之一）
 * @returns {null | {tier, q, tErr, vel:{x,y,z}, exitSpeed}} null = 揮空
 */
export function judgeSwing(ballPos, ballVel, aim, bat) {
  const vz = ballVel.z
  if (!(vz > 1)) return null                       // 球不在飛向打者（已彈開/未投）
  const W = BASE_WINDOW * bat.sweet
  const tErr = (CONTACT_Z - ballPos.z) / vz        // >0 提早（球未到）、<0 太晚（球已過）
  if (Math.abs(tErr) > W * 1.35) return null       // 時機差太多 → 揮空
  // 用目前速度外推到觸擊平面的預測點，跟準星比對
  const px = ballPos.x + ballVel.x * tErr
  const py = ballPos.y + ballVel.y * tErr
  const offX = aim.x - px, offY = aim.y - py
  const missR = Math.hypot(offX, offY * 1.2)       // 高低比左右更難救 → 垂直加權
  if (missR > REACH) return null                   // 準星離球太遠 → 揮空
  // 品質：時機 65% + 準度 35%
  const q = 0.65 * (1 - Math.min(1, Math.abs(tErr) / W)) + 0.35 * (1 - missR / REACH)
  const tier = q >= 0.78 ? 'perfect' : q >= 0.5 ? 'good' : q >= 0.28 ? 'ok' : 'foul'
  // 噴角：提早揮 → 拉打（左外野 -x）、晚揮 → 推打（右外野 +x）；準星偏移小幅加成
  let spray = Math.max(-1, Math.min(1, tErr / W)) * 0.62 + offX * 0.45 + (Math.random() - 0.5) * 0.07
  // 仰角：準星壓球下緣（offY<0）→ 高飛；壓上緣 → 滾地
  let launch = 0.42 - offY * 1.5 + (Math.random() - 0.5) * 0.05
  let speedMul = 1
  if (tier === 'foul') {                            // 擦棒：亂飛的弱球（常出界）
    spray = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.8)
    launch = 0.5 + Math.random() * 0.9
    speedMul = TIERS.foul.mult
  }
  if (bat.fx === 'chaos') {                         // 鹹魚：每球隨機亂噴
    spray += (Math.random() - 0.5) * 1.4
    launch += (Math.random() - 0.5) * 0.7
  }
  launch = Math.max(-0.18, Math.min(1.15, launch))
  const pitchSpeed = Math.hypot(ballVel.x, ballVel.y, ballVel.z)
  const exitSpeed = Math.min(78, (21 + 22 * q) * bat.power * speedMul + pitchSpeed * 0.1)
  const cosL = Math.cos(launch), sinL = Math.sin(launch)
  return {
    tier, q, tErr, exitSpeed,
    vel: {
      x: -Math.sin(spray) * cosL * exitSpeed,
      y: sinL * exitSpeed,
      z: -Math.cos(spray) * cosL * exitSpeed,
    },
  }
}
