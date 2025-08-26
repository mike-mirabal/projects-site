// /api/health.js
export default async function handler(req, res) {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return res.status(500).json({ ok: false, reason: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    }

    // simple ping: count rows so we know the DB works and RLS isn’t blocking us
    const r = await fetch(`${url}/rest/v1/knowledge?select=count`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'count=exact'
      }
    });

    const count = Number(r.headers.get('content-range')?.split('/')?.[1] || 0);

    return res.status(200).json({
      ok: true,
      supabaseUrlPresent: !!url,
      rowsInKnowledge: isNaN(count) ? null : count
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
