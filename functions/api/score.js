import { json, clampInt, sanitizeText, clientIp, rateLimited, audit } from './_lib.js'

// POST /api/score — 送出一場得分 { name, score, level, note, deviceId }
//   note＝額外資訊（不影響排名）：大賽＝全壘打數、生存＝安打數、最遠＝達成模式
//   回傳該榜名次 { ok, best, rank, total }（best=此玩家該榜最高分）

// 合理性上限：擋掉「明顯不可能」的灌分。刻意寬鬆（遠高於實際最佳成績）以免誤殺正常玩家。
//   大賽：10 球，單球理論極限（超遠 HR + 目標 + JACKPOT + 連擊倍率）給 30k → 上限 300k
//   生存：依安打數估算（安打數也設上限，避免連 note 一起灌來繞過）
//   最遠：分數＝公尺×10，給 400m 的荒謬上限
function maxPlausibleScore(level, note) {
  if (level === '生存') {
    let hits = parseInt(note, 10)
    if (!Number.isFinite(hits) || hits < 1) hits = 1
    hits = Math.min(hits, 500)              // 安打數封頂 → 絕對天花板 ~15M
    return 50_000 + hits * 30_000
  }
  if (level === '大賽') return 300_000
  if (level === '最遠') return 4_000         // 400 公尺
  return 300_000                             // 挑戰關等：單場寬鬆上限
}

export const onRequestPost = async ({ request, env }) => {
  if (await rateLimited(env, `score:${clientIp(request)}`, 3000)) {
    return json({ ok: false, error: 'too fast' }, 429)
  }
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const name = sanitizeText(body.name, 12) || '玩家'
  const level = sanitizeText(body.level, 24)
  const score = clampInt(body.score, 0, 100_000_000)
  const note = sanitizeText(body.note, 24)
  const device = sanitizeText(body.deviceId, 64)
  if (score <= 0) return json({ ok: false })
  // 合理性檢查：分數與安打數/模式明顯不符 → 拒收 + 記安全事件（前端會自動退回本機名次，不影響遊玩）
  if (score > maxPlausibleScore(level, note)) {
    await audit(env, 'score-implausible', clientIp(request), `${name} ${level} ${score.toLocaleString()}`)
    return json({ ok: false, error: 'implausible' }, 422)
  }
  try {
    await env.DB.prepare('INSERT INTO scores (device_id,name,level,score,note,created_at) VALUES (?,?,?,?,?,?)')
      .bind(device, name, level, score, note, Date.now()).run()
    // 該榜名次：以「各名字最高分」計算
    const mine = await env.DB.prepare('SELECT MAX(score) AS s FROM scores WHERE name=? AND level=?')
      .bind(name, level).first()
    const best = mine && mine.s != null ? mine.s : score
    const hi = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT name, MAX(score) AS ms FROM scores WHERE level=? GROUP BY name) t WHERE t.ms > ?',
    ).bind(level, best).first()
    const tot = await env.DB.prepare('SELECT COUNT(DISTINCT name) AS c FROM scores WHERE level=?')
      .bind(level).first()
    return json({ ok: true, best, rank: (hi ? hi.c : 0) + 1, total: tot && tot.c ? tot.c : 1 })
  } catch {
    return json({ error: 'db error' }, 500)
  }
}
