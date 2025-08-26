// /api/chat.js
//
// Spirit Guide API — Supabase-first, JSON fallback
// - Queries Supabase "knowledge" first (by name/content; filtered by role)
// - If no hit or Supabase error -> falls back to local JSON (env or body payload)
// - Preserves staff/guest rendering, 'yes' follow-up for single build, and spirits orange labels
//
// ENV it will read (supports both styles):
//   SUPABASE_URL  or superbaseURL
//   SUPABASE_SERVICE_ROLE_KEY  or superbaseServiceRoleKey
//   COCKTAILS_JSON (optional)
//   SPIRITS_JSON   (optional)
//
// NOTE: No client keys are exposed. This runs server-side only.

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------- Parse request ----------
    const body = req.body || {};
    const mode = body.mode === 'staff' ? 'staff' : 'guest';
    const queryRaw = body.query;
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const qLower = query.toLowerCase();

    // ---------- Load JSON knowledge (for fallback) ----------
    // Prefer payload from client (when front-end sends loaded files),
    // otherwise env JSON as a server-side fallback.
    let cocktails = {};
    let spiritsRaw = {};

    // From client (best, freshest)
    if (body.cocktails && typeof body.cocktails === 'object') cocktails = body.cocktails;
    if (body.spirits && typeof body.spirits === 'object') spiritsRaw = body.spirits;

    // From env (backup)
    if (!Object.keys(cocktails).length) {
      try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    }
    if (!Object.keys(spiritsRaw).length) {
      try { spiritsRaw = JSON.parse(process.env.SPIRITS_JSON || '{}'); } catch { spiritsRaw = {}; }
    }

    // Spirits may be nested under SPIRITS -> Category -> Name
    const flattenSpirits = (obj) => {
      const out = {};
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === 'object') {
            const isLeaf =
              'price' in v ||
              'tasting_notes' in v || 'tastingNotes' in v ||
              'type_category' in v || 'typeAndCategory' in v ||
              'region_distillery' in v || 'regionAndDistillery' in v;
            if (isLeaf) out[k] = v;
            else walk(v);
          }
        }
      };
      walk(obj);
      return out;
    };
    const spirits = flattenSpirits(spiritsRaw);

    // ---------- Session memory (very lightweight) ----------
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;

    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;

    // Probabilistic cleanup
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20; // 20 minutes
      for (const [k, v] of state.entries()) {
        if (!v || (now - (v.at || 0)) > TTL) state.delete(k);
      }
    }
    const sess = state.get(sessionKey) || { at: now };
    sess.at = now;
    state.set(sessionKey, sess);

    // ---------- Helpers ----------
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .replace(/[\u2019']/g, '')            // smart quotes/apostrophes
      .replace(/[^\p{L}\p{N}]+/gu, ' ')     // non-alphanum -> space
      .replace(/\s+/g, ' ')
      .trim();

    const escapeHTML = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const priceLine = (price) => price ? ` (${escapeHTML(price)})` : '';
    const joinLines = (lines) => lines.filter(Boolean).join('<br>');

    // Cocktail getters (supporting multiple shapes)
    const getBatchBuild = (item) =>
      Array.isArray(item?.batchBuild) ? item.batchBuild :
      Array.isArray(item?.build?.batchBuild) ? item.build.batchBuild :
      null;

    const getSingleBuild = (item) =>
      Array.isArray(item?.build) ? item.build :
      Array.isArray(item?.recipe) ? item.recipe :
      Array.isArray(item?.build?.singleBuild) ? item.build.singleBuild :
      null;

    const getIngredients = (item) =>
      Array.isArray(item?.ingredients) ? item.ingredients : null;

    const getGlass = (item) => item?.glass ? `Glass: ${item.glass}` : null;
    const getGarnish = (item) =>
      item?.garnish
        ? `Garnish: ${Array.isArray(item.garnish) ? item.garnish.join(', ') : item.garnish}`
        : null;

    const isAffirmative = (text) => /\b(yes|yep|yup|yeah|sure|ok(ay)?|please|show\s*me|do\s*it)\b/i.test(text || '');
    const isQuizRequest = (text) => /\bquiz|test\s*(me|knowledge)?\b/i.test(text || '');

    // Name matching
    const keysCocktails = Object.keys(cocktails || {});
    const keysSpirits   = Object.keys(spirits   || {});
    const qNorm = normalize(qLower);

    const findBestKey = (keys) => {
      if (!keys?.length || !qNorm) return null;
      // exact contains either direction
      let found = keys.find(k => qNorm.includes(normalize(k)));
      if (found) return found;
      found = keys.find(k => normalize(k).includes(qNorm));
      if (found) return found;

      // token overlap
      const qTokens = new Set(qNorm.split(' '));
      let best = null, scoreBest = 0;
      for (const k of keys) {
        const tokens = normalize(k).split(' ');
        const score = tokens.reduce((a, t) => a + (qTokens.has(t) ? 1 : 0), 0);
        if (score > scoreBest) { scoreBest = score; best = k; }
      }
      return scoreBest > 0 ? best : null;
    };

    // ---------- Formatters ----------
    const formatHeaderHTML = (name, price) =>
      `<span class="accent-teal">${escapeHTML(name)}</span>${priceLine(price)}`;

    const formatBulletsHTML = (lines) =>
      lines.filter(Boolean).map(l => `• ${escapeHTML(l)}`).join('<br>');

    function formatCocktailStaffBatch(name, item) {
      const batch = getBatchBuild(item);
      const single = getSingleBuild(item);
      const lines = [];

      if (batch?.length) lines.push(...batch);
      else if (single?.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass) lines.push(glass);
      if (garnish) lines.push(garnish);

      const bubble1 = joinLines([
        formatHeaderHTML(name, item.price),
        formatBulletsHTML(lines)
      ]);
      const bubble2 = `Do you want to see the single cocktail build without batch?`;
      return [bubble1, bubble2];
    }

    function formatCocktailStaffSingle(name, item) {
      const single = getSingleBuild(item);
      const lines = [];

      if (single?.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass) lines.push(glass);
      if (garnish) lines.push(garnish);

      const bubble1 = joinLines([
        formatHeaderHTML(name, item.price),
        formatBulletsHTML(lines)
      ]);
      const bubble2 = `Want a quick quiz on ${escapeHTML(name)} (glass, garnish, or first ingredient)?`;
      return [bubble1, bubble2];
    }

    function characterToLine(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${String(last).toLowerCase()} finish.`;
    }

    function upsellFor(name) {
      const n = String(name || '').toLowerCase();
      if (n.includes('highland picnic')) {
        return `This would go great with our chicken tinga tacos.<br>They're only $2.75 each on happy hour til 8pm!`;
      }
      if (n.includes('margarita') || n.includes('paloma')) {
        return `Great with our chips & queso — happy hour pricing til 8pm!`;
      }
      if (n.includes('carajillo') || n.includes('espresso')) {
        return `Try it with our churro bites — dessert-worthy combo.`;
      }
      return `This would go great with our chicken tinga tacos.<br>They're only $2.75 each on happy hour til 8pm!`;
    }

    function formatCocktailGuest(name, item) {
      const ingredients = getIngredients(item);
      const top = formatHeaderHTML(name, item.price);
      const desc = characterToLine(item.character) ||
                   (ingredients?.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
      const ing = (ingredients && ingredients.length)
        ? `Ingredients: ${escapeHTML(ingredients.join(', '))}`
        : null;
      const block = joinLines([top, '', desc, '', ing || '']);
      return [block, upsellFor(name)];
    }

    // Spirits: NO bullets; orange bold label per field, each on its own line
    function formatSpirit(name, item) {
      const lines = [];
      const push = (label, value) => {
        if (value == null || value === '') return;
        const text = Array.isArray(value) ? value.join('; ') : String(value);
        lines.push(`<span class="accent-medium">${escapeHTML(label)}:</span> ${escapeHTML(text)}`);
      };

      const m = {};
      for (const [k, v] of Object.entries(item || {})) {
        m[k] = v;
        m[k.toLowerCase()] = v;
      }

      push('Type & Category',
        m['type_category'] ?? m['typeandcategory'] ?? m['typeAndCategory'] ?? m['type'] ?? m['category']);
      push('Agave Variety / Base Ingredient',
        m['agave_variety'] ?? m['agavevariety'] ?? m['agaveVariety'] ?? m['agave'] ?? m['base'] ?? m['base_ingredient']);
      push('Region & Distillery',
        m['region_distillery'] ?? m['regiondistillery'] ?? m['regionAndDistillery'] ?? m['region'] ?? m['distillery']);
      push('Tasting Notes',
        m['tasting_notes'] ?? m['tastingnotes'] ?? m['tastingNotes']);
      push('Production Notes',
        m['production_notes'] ?? m['productionnotes'] ?? m['productionNotes']);
      push('Distillery / Brand Identity',
        m['distillery_brand_identity'] ?? m['brandidentity'] ?? m['brandIdentity'] ?? m['distillery_brand']);
      push('Guest Talking Point / Fun Fact',
        m['guest_talking_point'] ?? m['guesttalkingpoint'] ?? m['funfact'] ?? m['fun_fact']);
      push('Reviews', m['reviews']);

      // include any extra fields except price if present
      const used = new Set([
        'price','type_category','typeandcategory','typeAndCategory','type','category',
        'agave_variety','agavevariety','agaveVariety','agave','base','base_ingredient',
        'region_distillery','regiondistillery','regionAndDistillery','region','distillery',
        'tasting_notes','tastingnotes','tastingNotes',
        'production_notes','productionnotes','productionNotes',
        'distillery_brand_identity','brandidentity','brandIdentity','distillery_brand',
        'guest_talking_point','guesttalkingpoint','funfact','fun_fact','reviews'
      ]);
      for (const [rawKey, rawVal] of Object.entries(item || {})) {
        const lk = rawKey.toLowerCase();
        if (lk === 'price' || used.has(lk)) continue;
        if (rawVal == null || rawVal === '') continue;
        const label = rawKey
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
        push(label, rawVal);
      }

      const header = formatHeaderHTML(name, item.price);
      return [joinLines([header, ...lines])];
    }

    // ---------- Supabase (REST) ----------
    const SUPABASE_URL =
      process.env.SUPABASE_URL ||
      process.env.superbaseURL ||
      '';
    const SUPABASE_SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.superbaseServiceRoleKey ||
      '';

    async function supabaseSearch(q, roleMode) {
      // If envs are missing, pretend Supabase is unavailable (so we can fallback)
      if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, rows: [] };

      // PostgREST query:
      // - Filter role by ('guest','both') or ('staff','both')
      // - Search name/content ilike *q*
      // - Order by updated_at desc, limit 5
      // NOTE: We keep it simple; "tags" is skipped to avoid operator class issues.
      const roles = roleMode === 'staff' ? 'staff,both' : 'guest,both';
      const like = `*${q.replace(/[\s]+/g, ' *')}*`; // basic wildcard between words

      const params = new URLSearchParams();
      params.set('select', 'id,category,role,name,price,content,tags,source,updated_at');
      params.append('or', `name.ilike.${like},content.ilike.${like}`);
      params.set('role', `in.(${roles})`);
      params.set('order', 'updated_at.desc');
      params.set('limit', '5');

      const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/knowledge?${params.toString()}`;

      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Accept-Profile': 'public',
            'Content-Type': 'application/json',
          }
        });
        if (!r.ok) return { ok: false, rows: [] };
        const rows = await r.json();
        return { ok: true, rows: Array.isArray(rows) ? rows : [] };
      } catch {
        return { ok: false, rows: [] };
      }
    }

    // ---------- Branch 1: Follow-ups (yes / quiz) ----------
    if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
      const item = cocktails[sess.lastItemName];
      if (item) {
        const bubbles = formatCocktailStaffSingle(sess.lastItemName, item);
        sess.askedSingle = false;
        sess.lastMode = 'staff';
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }
    }

    if (mode === 'staff' && isQuizRequest(query) && sess.lastItemType === 'cocktail' && sess.lastItemName) {
      const item = cocktails[sess.lastItemName];
      if (item) {
        const quizQs = [];
        if (item.glass) quizQs.push(`What’s the correct glass for ${sess.lastItemName}?`);
        if (item.garnish) quizQs.push(`Name one garnish on ${sess.lastItemName}.`);
        const single = getSingleBuild(item);
        const batch  = getBatchBuild(item);
        const firstFrom = (batch && batch[0]) || (single && single[0]) || null;
        if (firstFrom) quizQs.push(`What’s the first ingredient (with quantity) in ${sess.lastItemName}?`);
        const bubbles = quizQs.length ? [quizQs[Math.floor(Math.random() * quizQs.length)]] :
          [`Ready for a flashcard? What’s one ingredient in ${sess.lastItemName}?`];
        sess.lastMode = 'staff';
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }
    }

    // ---------- Branch 2: Supabase-first search ----------
    // We do one search round via Supabase (by query text), then try to map to a local JSON key if possible.
    let sbRows = [];
    const sb = await supabaseSearch(query, mode);
    if (sb.ok && sb.rows?.length) sbRows = sb.rows;

    // Try to pick a best row by category preference (cocktail/spirits), else first row
    let chosen = null;
    if (sbRows.length) {
      const want = qLower.includes('mezcal') || qLower.includes('tequila') || qLower.includes('gin') || qLower.includes('vodka')
        ? ['spirit','spirits']
        : (qLower.includes('cocktail') || qLower.includes('drink') ? ['cocktail','cocktails'] : []);
      if (want.length) chosen = sbRows.find(r => want.includes(String(r.category || '').toLowerCase())) || sbRows[0];
      else chosen = sbRows[0];
    }

    if (chosen) {
      // If Supabase has a name, try to link to JSON for rich formatting (specs).
      const nameFromSB = chosen.name || '';
      const cocktailKeyMatch = nameFromSB ? findBestKey(keysCocktails) : null;
      const spiritKeyMatch   = nameFromSB ? findBestKey(keysSpirits)   : null;

      if (spiritKeyMatch) {
        const item = spirits[spiritKeyMatch] || {};
        const bubbles = formatSpirit(spiritKeyMatch, item);
        sess.lastItemName = spiritKeyMatch;
        sess.lastItemType = 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = false;
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }

      if (cocktailKeyMatch) {
        const item = cocktails[cocktailKeyMatch] || {};
        const bubbles = (mode === 'staff')
          ? formatCocktailStaffBatch(cocktailKeyMatch, item)
          : formatCocktailGuest(cocktailKeyMatch, item);
        sess.lastItemName = cocktailKeyMatch;
        sess.lastItemType = 'cocktail';
        sess.lastMode = mode;
        sess.askedSingle = (mode === 'staff'); // we asked for single next
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }

      // If we can’t link to JSON, at least return the Supabase content plainly
      const header = `<span class="accent-teal">${escapeHTML(chosen.name || query)}</span>${priceLine(chosen.price)}`;
      const content = chosen.content ? escapeHTML(chosen.content) : `I found a match in the knowledge base.`;
      const bubbles = [joinLines([header, '', content])];
      // Don’t set askedSingle because we don’t know build lines here
      sess.lastItemName = chosen.name || query;
      sess.lastItemType = (String(chosen.category || '').toLowerCase().includes('spirit') ? 'spirit' : 'cocktail');
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ---------- Branch 3: JSON fallback (when Supabase empty / miss) ----------
    let matchedCocktailKey = findBestKey(keysCocktails);
    let matchedSpiritKey   = matchedCocktailKey ? null : findBestKey(keysSpirits);

    if (matchedSpiritKey) {
      const item = spirits[matchedSpiritKey] || {};
      const bubbles = formatSpirit(matchedSpiritKey, item);
      sess.lastItemName = matchedSpiritKey;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    if (matchedCocktailKey) {
      const item = cocktails[matchedCocktailKey] || {};
      const bubbles = (mode === 'staff')
        ? formatCocktailStaffBatch(matchedCocktailKey, item)
        : formatCocktailGuest(matchedCocktailKey, item);
      sess.lastItemName = matchedCocktailKey;
      sess.lastItemType = 'cocktail';
      sess.lastMode = mode;
      sess.askedSingle = (mode === 'staff');
      state.set(sessionKey, sess);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ---------- Last fallback ----------
    const fallback = [`Sorry, I don't have this answer yet. I'm still learning...`];
    return res.status(200).json({ bubbles: fallback, answer: fallback.join('\n\n') });

  } catch (e) {
    console.error('API error:', e);
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 500) });
  }
}
