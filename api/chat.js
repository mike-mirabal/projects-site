// /api/chat.js
//
// Spirit Guide backend with Supabase + JSON fallbacks
//
// What this does now:
// 1) Tries to find a match in Supabase "knowledge" by name (ilike) and tags (array overlap) based on the user query,
//    filtered by role: staff -> ('staff','both'), guest -> ('guest','both').
// 2) If not found in Supabase, falls back to env JSON (COCKTAILS_JSON / SPIRITS_JSON).
// 3) If still nothing, uses an LLM fallback with formatting rules.
// 4) Keeps lightweight, per-session memory so “yes” can show the single build for the last cocktail.
//
// Notes:
// - Keep your COCKTAILS_JSON and SPIRITS_JSON env vars for now. They’re used as fallback until you finish migrating data.
// - SUPABASE_SERVICE_ROLE_KEY is server-only (never expose it to the client).
// - Supabase schema assumed: table "knowledge" with fields:
//     id uuid, category text, role text, name text, price text, content jsonb, tags text[],
//     source text, created_at timestamptz, updated_at timestamptz
//
// Spirits formatting rule (no bullets):
//   <span class="accent-teal">NAME</span> (PRICE)
//   <span class="accent-medium">Type & Category:</span> ...
//   <span class="accent-medium">Agave Variety / Base Ingredient:</span> ...
//   <span class="accent-medium">Region & Distillery:</span> ...
//   <span class="accent-medium">Distillery / Brand Identity:</span> ...
//   <span class="accent-medium">Tasting Notes:</span> ...
//   <span class="accent-medium">Production Notes:</span> ...
//
// Cocktails (staff):
//   Bubble 1: teal name (price) + bullets for batch build (or single build / ingredients) + Glass/Garnish
//   Bubble 2: “Do you want to see the single cocktail build without batch?”
// Cocktails (guest):
//   Bubble 1: teal name (price) + short description + “Ingredients: …” (no quantities)
//   Bubble 2: upsell line

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ===== Parse input =====
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest';
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const qLower = query.toLowerCase();

    // ===== Env JSON fallbacks =====
    let cocktails = {};
    let spiritsRaw = {};
    try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    try { spiritsRaw = JSON.parse(process.env.SPIRITS_JSON   || '{}'); } catch { spiritsRaw = {}; }

    // Flatten possible nested spirits JSON into { "Name": {...} }
    function flattenSpirits(obj) {
      const out = {};
      (function walk(node) {
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
      })(spiritsRaw);
      return out;
    }
    const spirits = flattenSpirits(spiritsRaw);

    // ===== Session memory (very lightweight) =====
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;
    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20; // 20 minutes
      for (const [k, v] of state.entries()) {
        if (!v || (now - (v.at || 0)) > TTL) state.delete(k);
      }
    }
    const sess = state.get(sessionKey) || { at: now };
    sess.at = now;
    state.set(sessionKey, sess);

    // ===== Helpers =====
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .replace(/[\u2019']/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const escapeHTML = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const priceSuffix = (price) => price ? ` (${escapeHTML(price)})` : '';

    const joinLines = (lines) => lines.filter(Boolean).join('<br>');

    const asArray = (v) => Array.isArray(v) ? v.slice() : (v ? [v] : []);

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

    // Simple key matchers for env JSON fallback
    const keysCocktails = Object.keys(cocktails || {});
    const keysSpirits   = Object.keys(spirits   || {});
    const qNorm = normalize(qLower);

    function findBestKey(keys) {
      if (!keys.length || !qNorm) return null;
      // contains either direction
      let found = keys.find(k => qNorm.includes(normalize(k)));
      if (found) return found;
      found = keys.find(k => normalize(k).includes(qNorm));
      if (found) return found;

      // token overlap
      const qTokens = new Set(qNorm.split(' '));
      let best = null; let bestScore = 0;
      for (const k of keys) {
        const t = normalize(k).split(' ');
        const score = t.reduce((acc, tok) => acc + (qTokens.has(tok) ? 1 : 0), 0);
        if (score > bestScore) { best = k; bestScore = score; }
      }
      return bestScore > 0 ? best : null;
    }

    // ===== HTML formatters =====
    const headerHTML = (name, price) =>
      `<span class="accent-teal">${escapeHTML(name)}</span>${priceSuffix(price)}`;

    const bulletsHTML = (lines) =>
      lines.filter(Boolean).map(l => `• ${escapeHTML(l)}`).join('<br>');

    function formatCocktailStaffBatch(name, item) {
      const batch = getBatchBuild(item);
      const single = getSingleBuild(item);
      const lines = [];

      if (batch && batch.length) lines.push(...batch);
      else if (single && single.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass)   lines.push(glass);
      if (garnish) lines.push(garnish);

      const bubble1 = joinLines([headerHTML(name, item.price), bulletsHTML(lines)]);
      const bubble2 = `Do you want to see the single cocktail build without batch?`;
      return [bubble1, bubble2];
    }

    function formatCocktailStaffSingle(name, item) {
      const single = getSingleBuild(item);
      const lines = [];

      if (single && single.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass)   lines.push(glass);
      if (garnish) lines.push(garnish);

      const bubble1 = joinLines([headerHTML(name, item.price), bulletsHTML(lines)]);
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
      const top = headerHTML(name, item.price);
      const desc = characterToLine(item.character) ||
                   (ingredients?.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
      const ing = (ingredients && ingredients.length)
        ? `Ingredients: ${escapeHTML(ingredients.join(', '))}`
        : null;
      const block = joinLines([top, '', desc, '', ing || '']);
      return [block, upsellFor(name)];
    }

    // Spirits: no bullets; each field on its own line w/ orange label
    function formatSpiritFromJSON(name, item) {
      const lines = [];
      const push = (label, val) => {
        if (val == null || val === '') return;
        const text = Array.isArray(val) ? val.join('; ') : String(val);
        lines.push(`<span class="accent-medium">${escapeHTML(label)}:</span> ${escapeHTML(text)}`);
      };
      const m = {};
      for (const [k, v] of Object.entries(item || {})) {
        m[k] = v; m[k.toLowerCase()] = v;
      }
      push('Type & Category', m['type_category'] ?? m['typeandcategory'] ?? m['typeAndCategory'] ?? m['type'] ?? m['category']);
      push('Agave Variety / Base Ingredient', m['agave_variety'] ?? m['agavevariety'] ?? m['agaveVariety'] ?? m['agave'] ?? m['base'] ?? m['base_ingredient']);
      push('Region & Distillery', m['region_distillery'] ?? m['regiondistillery'] ?? m['regionAndDistillery'] ?? m['region'] ?? m['distillery']);
      push('Distillery / Brand Identity', m['distillery_brand_identity'] ?? m['brandidentity'] ?? m['brandIdentity'] ?? m['distillery_brand']);
      push('Tasting Notes', m['tasting_notes'] ?? m['tastingnotes'] ?? m['tastingNotes']);
      push('Production Notes', m['production_notes'] ?? m['productionnotes'] ?? m['productionNotes']);

      // extras except price
      const used = new Set([
        'price','type_category','typeandcategory','typeAndCategory','type','category',
        'agave_variety','agavevariety','agaveVariety','agave','base','base_ingredient',
        'region_distillery','regiondistillery','regionAndDistillery','region','distillery',
        'tasting_notes','tastingnotes','tastingNotes',
        'production_notes','productionnotes','productionNotes',
        'distillery_brand_identity','brandidentity','brandIdentity','distillery_brand'
      ]);
      for (const [rawKey, rawVal] of Object.entries(item || {})) {
        const lk = rawKey.toLowerCase();
        if (used.has(lk) || lk === 'price') continue;
        if (rawVal == null || rawVal === '') continue;
        const label = rawKey
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
        push(label, rawVal);
      }

      return [joinLines([headerHTML(name, item.price), ...lines])];
    }

    // ===== Supabase helpers =====
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    async function sbFetch(pathWithQuery) {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, data: null };
      const url = `${SUPABASE_URL}/rest/v1${pathWithQuery}`;
      const r = await fetch(url, {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      });
      if (!r.ok) {
        // console.warn('Supabase fetch failed', r.status, await r.text().catch(()=>'')); // optional
        return { ok: false, data: null };
      }
      return { ok: true, data: await r.json() };
    }

    function urlEnc(s) { return encodeURIComponent(s); }

    function rolesForMode(m) {
      return m === 'staff' ? ['staff','both'] : ['guest','both'];
    }

    // Try to find a knowledge row by name (best-effort)
    async function supabaseFindByNameLike(q, mode) {
      // role filter: role=in.(staff,both) or role=in.(guest,both)
      const roles = rolesForMode(mode);
      const rolesParam = `(${roles.join(',')})`;
      const nameLike = `*${q}*`;

      // Primary: name ilike; order by length(name) asc then created_at desc (basic relevance)
      const q1 = `/knowledge?select=*&role=in.${urlEnc(rolesParam)}&name=ilike.${urlEnc(nameLike)}&order=name.asc&order=created_at.desc.nullslast&limit=10`;
      const r1 = await sbFetch(q1);
      if (r1.ok && Array.isArray(r1.data) && r1.data.length) return r1.data;

      // Secondary: tags overlap a token from query (single word)
      const firstToken = q.trim().split(/\s+/)[0];
      if (firstToken) {
        const ov = `{${firstToken.toLowerCase()}}`; // tags=ov.{token}
        const q2 = `/knowledge?select=*&role=in.${urlEnc(rolesParam)}&tags=ov.${urlEnc(ov)}&order=created_at.desc.nullslast&limit=10`;
        const r2 = await sbFetch(q2);
        if (r2.ok && Array.isArray(r2.data) && r2.data.length) return r2.data;
      }
      return [];
    }

    // Render a Supabase knowledge record as bubbles
    function formatFromSupabaseRow(rec, mode) {
      const category = String(rec.category || '').toLowerCase();
      const name = rec.name || rec.title || 'Item';
      const price = rec.price || '';
      const c = rec.content || {}; // jsonb, may be object or string

      // Generic object-to-lines helper (orange labels)
      const linesFromObject = (obj, includeKeys = []) => {
        const out = [];
        const push = (label, val) => {
          if (val == null || val === '') return;
          const text = Array.isArray(val) ? val.join('; ') : String(val);
          out.push(`<span class="accent-medium">${escapeHTML(label)}:</span> ${escapeHTML(text)}`);
        };
        // Preferred spirit-ish keys first if present
        push('Type & Category', obj.type_category ?? obj.typeAndCategory ?? obj.type ?? obj.category);
        push('Agave Variety / Base Ingredient', obj.agave_variety ?? obj.agave ?? obj.base ?? obj.base_ingredient);
        push('Region & Distillery', obj.region_distillery ?? obj.region ?? obj.distillery);
        push('Distillery / Brand Identity', obj.distillery_brand_identity ?? obj.brandIdentity);
        push('Tasting Notes', obj.tasting_notes ?? obj.tastingNotes);
        push('Production Notes', obj.production_notes ?? obj.productionNotes);

        // Any includeKeys explicitly passed
        for (const k of includeKeys) {
          if (k in obj) {
            const label = k.replace(/([A-Z])/g,' $1').replace(/_/g,' ').replace(/\b\w/g, x => x.toUpperCase());
            push(label, obj[k]);
          }
        }
        // Remaining keys (excluding obvious ones and price)
        const used = new Set([
          'type_category','typeAndCategory','type','category',
          'agave_variety','agave','base','base_ingredient',
          'region_distillery','region','distillery',
          'distillery_brand_identity','brandIdentity',
          'tasting_notes','tastingNotes',
          'production_notes','productionNotes',
          'price'
        ]);
        for (const [rk, rv] of Object.entries(obj)) {
          if (used.has(rk)) continue;
          if (rv == null || rv === '') continue;
          const label = rk.replace(/([A-Z])/g,' $1').replace(/_/g,' ').replace(/\b\w/g, x => x.toUpperCase()).trim();
          push(label, rv);
        }
        return out;
      };

      // COCKTAIL
      if (category.includes('cocktail')) {
        // Expect optional structured arrays in content: batchBuild, build/recipe, ingredients, glass, garnish, character
        const top = headerHTML(name, price);
        const batch = asArray(c.batchBuild || (c.build && c.build.batchBuild));
        const single = asArray(c.build) || asArray(c.recipe) || asArray(c?.build?.singleBuild);
        const ingredients = asArray(c.ingredients);
        const glass = c.glass ? `Glass: ${c.glass}` : null;
        const garnish = c.garnish ? `Garnish: ${Array.isArray(c.garnish) ? c.garnish.join(', ') : c.garnish}` : null;

        if (mode === 'staff') {
          const lines = [];
          if (batch.length) lines.push(...batch);
          else if (single.length) lines.push(...single);
          else if (ingredients.length) lines.push(...ingredients);
          if (glass) lines.push(glass);
          if (garnish) lines.push(garnish);
          const b1 = joinLines([top, bulletsHTML(lines)]);
          const b2 = `Do you want to see the single cocktail build without batch?`;

          // set memory for follow-up
          sess.lastItemName = name;
          sess.lastItemType = 'cocktail';
          sess.lastMode = 'staff';
          sess.askedSingle = true;
          state.set(sessionKey, sess);

          return [b1, b2];
        } else {
          const desc = characterToLine(c.character) ||
                       (ingredients.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
          const ing = ingredients.length ? `Ingredients: ${escapeHTML(ingredients.join(', '))}` : null;
          const b1 = joinLines([top, '', desc, '', ing || '']);
          const b2 = upsellFor(name);

          // memory
          sess.lastItemName = name;
          sess.lastItemType = 'cocktail';
          sess.lastMode = 'guest';
          sess.askedSingle = false;
          state.set(sessionKey, sess);

          return [b1, b2];
        }
      }

      // SPIRIT (or any non-cocktail item): no bullets, orange labels per-line
      if (category.includes('spirit') || category.includes('mezcal') || category.includes('tequila') || typeof c === 'object') {
        const lines = Array.isArray(c) ? c.map(String) : linesFromObject(c || {});
        const b1 = joinLines([headerHTML(name, price), ...lines]);

        // memory
        sess.lastItemName = name;
        sess.lastItemType = 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = false;
        state.set(sessionKey, sess);

        // optional follow-up bubble for staff mode
        const b2 = mode === 'staff'
          ? `Want some quick talking points or reviews about ${escapeHTML(name)}?`
          : null;

        return b2 ? [b1, b2] : [b1];
      }

      // Generic text item: show name header and plain text/summary
      const asText = (typeof c === 'string') ? c : (c?.summary || c?.text || JSON.stringify(c));
      const b1 = joinLines([headerHTML(name, price), String(asText || '').trim()]);
      return [b1];
    }

    // ===== Follow-ups (memory-driven) BEFORE searching =====
    if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
      // Try to show single from env JSON if present
      const envItem = cocktails[sess.lastItemName];
      if (envItem) {
        const bubbles = formatCocktailStaffSingle(sess.lastItemName, envItem);
        sess.askedSingle = false;
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }
      // If not in env JSON, try Supabase (expects content.build / content.recipe etc.)
      // We query by exact name to be safe
      const roles = rolesForMode(mode);
      const rolesParam = `(${roles.join(',')})`;
      const qExact = `/knowledge?select=*&role=in.${encodeURIComponent(rolesParam)}&name=eq.${encodeURIComponent(sess.lastItemName)}&limit=1`;
      const r = await sbFetch(qExact);
      if (r.ok && Array.isArray(r.data) && r.data[0]) {
        const bubbles = formatFromSupabaseRow(r.data[0], mode);
        sess.askedSingle = false;
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }
      // else fall through to normal flow
    }

    if (mode === 'staff' && isQuizRequest(query) && sess.lastItemType === 'cocktail' && sess.lastItemName) {
      // Env JSON quiz
      const item = cocktails[sess.lastItemName];
      if (item) {
        const quizQs = [];
        if (item.glass) quizQs.push(`What’s the correct glass for ${sess.lastItemName}?`);
        if (item.garnish) quizQs.push(`Name one garnish on ${sess.lastItemName}.`);
        const single = getSingleBuild(item);
        const batch = getBatchBuild(item);
        const firstFrom = (batch && batch[0]) || (single && single[0]) || null;
        if (firstFrom) quizQs.push(`What’s the first ingredient (with quantity) in ${sess.lastItemName}?`);

        const bubbles = quizQs.length
          ? [quizQs[Math.floor(Math.random() * quizQs.length)]]
          : [`Ready for a flashcard? What’s one ingredient in ${sess.lastItemName}?`];

        sess.lastMode = 'staff';
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }
      // Could add a Supabase quiz path here if needed.
    }

    // ===== 1) Supabase search by name/tags =====
    let sbRows = [];
    try {
      sbRows = await supabaseFindByNameLike(query, mode);
    } catch { /* ignore */ }

    if (sbRows && sbRows.length) {
      // Pick the best match by shortest name distance / contains
      const ranked = sbRows
        .map(r => ({ r, score: normalize(r.name || '').includes(qNorm) ? 2 : (qNorm.includes(normalize(r.name || '')) ? 1 : 0), len: (r.name || '').length }))
        .sort((a, b) => (b.score - a.score) || (a.len - b.len));
      const best = ranked[0].r;
      const bubbles = formatFromSupabaseRow(best, mode);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== 2) Fallback: env JSON direct match =====
    let matchedCocktailKey = findBestKey(keysCocktails);
    let matchedSpiritKey   = matchedCocktailKey ? null : findBestKey(keysSpirits);

    if (matchedSpiritKey) {
      const item = spirits[matchedSpiritKey] || {};
      const bubbles = formatSpiritFromJSON(matchedSpiritKey, item);

      sess.lastItemName = matchedSpiritKey;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    if (matchedCocktailKey) {
      const item = cocktails[matchedCocktailKey] || {};
      let bubbles;
      if (mode === 'staff') {
        bubbles = formatCocktailStaffBatch(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'staff';
        sess.askedSingle = true;
      } else {
        bubbles = formatCocktailGuest(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
      }
      state.set(sessionKey, sess);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== 3) LLM fallback =====
    const staffDirectives = `
You are the Spirit Guide (STAFF mode). Respond in HTML only (no markdown).

COCKTAILS:
- Bubble 1:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each build line (prefer batchBuild; else single build/recipe; else ingredients)
  • Glass: ...
  • Garnish: ...
- Bubble 2: exactly
  Do you want to see the single cocktail build without batch?

SPIRITS (IMPORTANT — NO BULLETS):
Bubble 1:
  <span class="accent-teal">NAME</span> (PRICE)
  <span class="accent-medium">Type & Category:</span> ...
  <span class="accent-medium">Agave Variety / Base Ingredient:</span> ...
  <span class="accent-medium">Region & Distillery:</span> ...
  <span class="accent-medium">Distillery / Brand Identity:</span> ...
  <span class="accent-medium">Tasting Notes:</span> ...
  <span class="accent-medium">Production Notes:</span> ...
(One field per line, use <br> between lines, no bullets.)
Bubble 2:
Would you like some talking points & fun facts, or reviews?
`.trim();

    const guestDirectives = `
You are the Spirit Guide (GUEST mode). Respond in HTML only (no markdown).

COCKTAILS:
- Return ONLY two bubbles:
  Bubble 1:
    <span class="accent-teal">Name</span> (PRICE)
    <br>
    Short one-sentence description from character.
    <br>
    Ingredients: comma-separated list (no quantities).
  Bubble 2:
    An upsell/pairing recommendation. You may use <br>.

SPIRITS (IMPORTANT — NO BULLETS):
- Same format as staff (labels in orange bold, one field per line, no bullets).
`.trim();

    const systemPrompt = `
You have two structured JSON knowledge bases:

COCKTAILS:
${process.env.COCKTAILS_JSON || "{}"}

SPIRITS:
${process.env.SPIRITS_JSON || "{}"}

Follow the mode-specific formatting exactly.

${mode === 'staff' ? staffDirectives : guestDirectives}

Return either:
1) {"bubbles": ["<html...>","<html...>"]}  (up to 2 bubbles)
or
2) Plain HTML (two blocks separated by a blank line). Prefer the JSON format above.
`.trim();

    let llmBubbles = null;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5-mini',
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
          ]
        })
      });

      if (r.ok) {
        const data = await r.json();
        const content = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.bubbles)) {
              llmBubbles = parsed.bubbles.slice(0, 2).map(String);
            }
          } catch {}
        }
        if (!llmBubbles) {
          const split = content.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 2);
          if (split.length) llmBubbles = split;
        }
      }
    } catch { /* ignore */ }

    if (llmBubbles && llmBubbles.length) {
      const allKeys = [...keysCocktails, ...keysSpirits];
      const hit = allKeys.find(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(llmBubbles.join(' ')));
      if (hit) {
        sess.lastItemName = hit;
        sess.lastItemType = keysCocktails.includes(hit) ? 'cocktail' : 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = mode === 'staff' && sess.lastItemType === 'cocktail';
        state.set(sessionKey, sess);
      }
      return res.status(200).json({ bubbles: llmBubbles, answer: llmBubbles.join('\n\n') });
    }

    // ===== Final fallback =====
    const fallback = [`Sorry, I don't have this answer yet. I'm still learning...`];
    return res.status(200).json({ bubbles: fallback, answer: fallback.join('\n\n') });

  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
