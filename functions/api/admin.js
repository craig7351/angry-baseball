import { json, clientIp, rateLimited, audit } from './_lib.js'

// POST /api/admin — 管理面板查詢（純唯讀）
//   body: { key, view }；view = overview | audit | rate | scores | presence
//   限流放在驗證之前（同 IP 每 5 秒一次），猜密碼行為本身也會記入 audit
const DAY = 86400000

export const onRequestPost = async ({ request, env }) => {
  try {
    const ip = clientIp(request)
    if (await rateLimited(env, `admin:${ip}`, 5000)) {
      return json({ ok: false, error: 'too fast' }, 429)
    }
    const body = await request.json().catch(() => ({}))
    if (!env.ADMIN_KEY) return json({ ok: false, error: 'disabled' }, 403)
    if (!body.key || body.key !== env.ADMIN_KEY) {
      await audit(env, 'admin-forbidden', ip)
      return json({ ok: false, error: 'forbidden' }, 403)
    }
    const now = Date.now()
    // 機會性清理：audit 只留 7 天
    if (Math.random() < 0.2) {
      try { await env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(now - 7 * DAY).run() } catch {}
    }
    const view = String(body.view || 'overview')

    if (view === 'overview') {
      const cnt = async (sql, since) => {
        const r = await env.DB.prepare(sql).bind(since).first()
        return (r && r.n) || 0
      }
      const scores24 = await cnt('SELECT COUNT(*) AS n FROM scores WHERE created_at > ?', now - DAY)
      const msgs24 = await cnt('SELECT COUNT(*) AS n FROM messages WHERE created_at > ?', now - DAY)
      const dev24 = await cnt('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?', now - DAY)
      const dev1h = await cnt('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?', now - 3600000)
      const { results: kinds } = await env.DB.prepare(
        'SELECT kind, COUNT(*) AS n FROM audit WHERE at > ? GROUP BY kind ORDER BY n DESC',
      ).bind(now - DAY).all()
      const { results: blocked } = await env.DB.prepare(
        'SELECT k, hits, last_at FROM rate WHERE hits > 0 ORDER BY hits DESC LIMIT 10',
      ).all()
      return json({ ok: true, scores24, msgs24, dev24, dev1h, kinds, blocked })
    }
    if (view === 'audit') {
      const { results } = await env.DB.prepare(
        'SELECT at, kind, ip, detail FROM audit ORDER BY id DESC LIMIT 100',
      ).all()
      return json({ ok: true, rows: results })
    }
    if (view === 'rate') {
      const { results } = await env.DB.prepare(
        'SELECT k, hits, last_at FROM rate WHERE hits > 0 ORDER BY hits DESC LIMIT 30',
      ).all()
      return json({ ok: true, rows: results })
    }
    if (view === 'scores') {
      const { results } = await env.DB.prepare(
        'SELECT name, device_id, level, score, note, created_at FROM scores ORDER BY id DESC LIMIT 50',
      ).all()
      return json({ ok: true, rows: results })
    }
    if (view === 'presence') {
      const c1h = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?').bind(now - 3600000).first()
      const c24 = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?').bind(now - DAY).first()
      const { results } = await env.DB.prepare(
        'SELECT device_id, last_seen FROM presence ORDER BY last_seen DESC LIMIT 30',
      ).all()
      return json({ ok: true, n1h: (c1h && c1h.n) || 0, n24: (c24 && c24.n) || 0, rows: results })
    }
    return json({ ok: false, error: 'unknown view' }, 400)
  } catch {
    return json({ ok: false }, 500)
  }
}
