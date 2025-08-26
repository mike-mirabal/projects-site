// /api/chat.js
//
// Spirit Guide – chat backend (Supabase + JSON fallback)
//
// What this does:
// - Loads cocktails & spirits from env JSON (fallback) and formats output:
//   * Cocktails (STAFF): bullets (batch build first), ask to show single build next.
//   * Cocktails (GUEST): short description + ingredients, plus an upsell.
//   * Spirits (both modes): NO bullets; each field on its own line, label in orange.
// - Connects to Supabase (server-side) and searches table `knowledge` to:
//   * Answer general questions (e.g., “what is this?”, “hours?”, “what’s mezcal?”).
//   * Find staff/guest specific content by role.
//   * Be more conversational when your query isn’t an exact cocktail/spirit match.
// - Keeps lightweight per-session memory so “yes” shows the single build, and “quiz” works.
//
// Env required (server-side):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional fallback envs (keep these for now while DB is empty):
//   COCKTAILS_JSON
//   SPIRITS_JSON
//
// Security: SERVICE ROLE KEY must only be used here (server). Never expose it to the browser.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ===== Parse request =====
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest'; // only two modes
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ===== Supabase (server-side only) =====
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabase = (supabaseUrl && supabaseKey)
      ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
      : null;

    // ===== Load JSON fallbacks from env =====
    let cocktails = {};
    let spiritsRaw = {};
    try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    try { spiritsRaw = JSON.parse(process.env.SPIRITS_JSON   || '{}'); } catch { spiritsRaw = {}; }

    // Flatten SPIRITS {(nested by category) -> flat name->object}
    function flattenSpirits(obj) {
      const out = {};
      function walk(node) {
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
      }
      walk(obj);
      return out;
    }
    const spirits = flattenSpirits(spiritsRaw);

    // ===== Session memory (very light) =====
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;

    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20; // 20m
      for (const [k, v] of state.entries()) {
        if (!v || (now - (v.at || 0)) > TTL) state.delete(k);
      }
    }
    const sess = state.get(sessionKey) || { at: now };
    sess.at = now;
    state.set(sessionKey, sess);

    // ===== Utils =====
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

    const priceLine = (price) => price ? ` (${escapeHTML(price)})` : '';
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
    const isWhatIsThis = (text) => /\b(what\s+is\s+(this|it)|who\s+are\s+you|help|how\s+does\s+this\s+work)\b/i.test(text || '');
    const isGreeting = (text) => /\b(hi|hello|hey|yo|sup)\b/i.test(text || '');

    // Keys for direct matches
    const keysCocktails = Object.keys(cocktails || {});
    const keysSpirits   = Object.keys(spirits   || {});
    const qNorm = normalize(q);

    function findBestKey(keys) {
      if (!keys.length || !qNorm) return null;
      // 1) contains either way
      let found = keys.find(k => qNorm.includes(normalize(k)));
      if (found) return found;
      found = keys.find(k => normalize(k).includes(qNorm));
      if (found) return found;
      // 2) token overlap for short queries (“espolon”, “fortaleza”)
      const qTokens = new Set(qNorm.split(' '));
      let best = null; let bestScore = 0;
      for (const k of keys) {
        const t = normalize(k).split(' ');
        const score = t.reduce((acc, tok) => acc + (qTokens.has(tok) ? 1 : 0), 0);
        if (score > bestScore) { best = k; bestScore = score; }
      }
      return bestScore > 0 ? best : null;
    }

    // ===== Formatters =====
    function headerTeal(name, price) {
      return `<span class="accent-teal">${escapeHTML(name)}</span>${priceLine(price)}`;
    }
    function bullets(lines) {
      return lines.filter(Boolean).map(l => `• ${escapeHTML(l)}`).join('<br>');
    }

    // Cocktails (staff)
    function bubbleCocktailStaffBatch(name, item) {
      const batch = getBatchBuild(item);
      const single = getSingleBuild(item);
      const lines = [];

      if (batch && batch.length) lines.push(...batch);
      else if (single && single.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass) lines.push(glass);
      if (garnish) lines.push(garnish);

      const b1 = joinLines([headerTeal(name, item.price), bullets(lines)]);
      const b2 = `Do you want to see the single cocktail build without batch?`;
      return [b1, b2];
    }

    function bubbleCocktailStaffSingle(name, item) {
      const single = getSingleBuild(item);
      const lines = [];

      if (single && single.length) lines.push(...single);
      else if (getIngredients(item)) lines.push(...getIngredients(item));

      const glass = getGlass(item);
      const garnish = getGarnish(item);
      if (glass) lines.push(glass);
      if (garnish) lines.push(garnish);

      const b1 = joinLines([headerTeal(name, item.price), bullets(lines)]);
      const b2 = `Want a quick quiz on ${escapeHTML(name)} (glass, garnish, or first ingredient)?`;
      return [b1, b2];
    }

    function charToOneLiner(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${String(last).toLowerCase()} finish.`;
    }

    function upsellFor(name) {
      const n = String(name || '').toLowerCase();
      if (n.includes('highland picnic')) return `This would go great with our chicken tinga tacos.<br>They're only $2.75 each on happy hour til 8pm!`;
      if (n.includes('margarita') || n.includes('paloma')) return `Great with our chips & queso — happy hour pricing til 8pm!`;
      if (n.includes('carajillo') || n.includes('espresso')) return `Try it with our churro bites — dessert-worthy combo.`;
      return `This would go great with our chicken tinga tacos.<br>They're only $2.75 each on happy hour til 8pm!`;
    }

    // Cocktails (guest)
    function bubbleCocktailGuest(name, item) {
      const ingredients = getIngredients(item);
      const top = headerTeal(name, item.price);
      const desc = charToOneLiner(item.character) ||
                   (ingredients?.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
      const ing = (ingredients && ingredients.length) ? `Ingredients: ${escapeHTML(ingredients.join(', '))}` : null;
      const b1 = joinLines([top, '', desc, '', ing || '']);
      const b2 = upsellFor(name);
      return [b1, b2];
    }

    // Spirits (no bullets, orange labels)
    function bubbleSpirit(name, item) {
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

      push('Distillery / Brand Identity',
        m['distillery_brand_identity'] ?? m['brandidentity'] ?? m['brandIdentity'] ?? m['distillery_brand']);

      push('Tasting Notes', m['tasting_notes'] ?? m['tastingnotes'] ?? m['tastingNotes']);
      push('Production Notes', m['production_notes'] ?? m['productionnotes'] ?? m['productionNotes']);
      push('Guest Talking Point / Fun Fact', m['guest_talking_point'] ?? m['guesttalkingpoint'] ?? m['funfact'] ?? m['fun_fact']);
      push('Reviews', m['reviews']);

      // extra fields not covered (except price)
      const used = new Set([
        'price',
        'type_category','typeandcategory','typeAndCategory','type','category',
        'agave_variety','agavevariety','agaveVariety','agave','base','base_ingredient',
        'region_distillery','regiondistillery','regionAndDistillery','region','distillery',
        'tasting_notes','tastingnotes','tastingNotes',
        'production_notes','productionnotes','productionNotes',
        'distillery_brand_identity','brandidentity','brandIdentity','distillery_brand',
        'guest_talking_point','guesttalkingpoint','funfact','fun_fact',
        'reviews'
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

      const header = headerTeal(name, item.price);
      return [joinLines([header, ...lines])];
    }

    // ===== Supabase knowledge search =====
    // Schema expectation:
    //   knowledge(id uuid PK, category text, name text, role text, price text,
    //             content jsonb, tags jsonb, source text, created_at timestamptz, updated_at timestamptz)
    //
    // We do a permissive search by (role ∈ [mode,both]) and:
    //   - name ilike q OR
    //   - tags contains [qToken] OR
    //   - (client-side) stringify(content) includes q
    //
    // This is intentionally simple and resilient to whatever data you have right now.
    async function supaSearchKnowledge(qText, roleMode) {
      if (!supabase) return [];

      const roleList = (roleMode === 'staff') ? ['staff','both'] : ['guest','both'];
      const qTok = qText.trim().toLowerCase();

      // First grab some candidates server-side (cheap filters)
      const { data, error } = await supabase
        .from('knowledge')
        .select('id,category,name,role,price,content,tags,source,created_at')
        .in('role', roleList)
        .or(`name.ilike.%${qTok}%,source.ilike.%${qTok}%`)
        .limit(50);

      if (error || !Array.isArray(data)) return [];

      // Client-side refine on tags + content text match
      const results = [];
      for (const row of data) {
        const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
        const tagHit = tags.some(t => String(t).toLowerCase().includes(qTok));

        const contentStr = (row.content ? JSON.stringify(row.content) : '').toLowerCase();
        const contentHit = contentStr.includes(qTok);

        const nameHit = String(row.name || '').toLowerCase().includes(qTok);
        if (nameHit || tagHit || contentHit) {
          results.push(row);
        }
      }
      return results;
    }

    // Turn a knowledge row into one or two bubbles depending on category
    function bubblesFromKnowledge(row) {
      const name = row.name || (row.content?.title) || (row.category || 'Info');
      const price = row.price || '';
      const header = headerTeal(name, price);

      // If content is an object with fields, render key/value lines with orange labels:
      if (row.content && typeof row.content === 'object' && !Array.isArray(row.content)) {
        const lines = [];
        for (const [k, v] of Object.entries(row.content)) {
          if (v == null || v === '') continue;
          const label = String(k)
            .replace(/([A-Z])/g, ' $1')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
          const val = Array.isArray(v) ? v.join('; ') : String(v);
          lines.push(`<span class="accent-medium">${escapeHTML(label)}:</span> ${escapeHTML(val)}`);
        }
        return [joinLines([header, ...lines])];
      }

      // Otherwise, show the header + a simple paragraph from content or source
      const body =
        (typeof row.content === 'string' && row.content) ? row.content :
        (row.source ? `Source: ${row.source}` : 'More details available with staff.');
      return [joinLines([header, escapeHTML(String(body || ''))])];
    }

    // ===== Conversational helpers =====
    if (isWhatIsThis(q)) {
      const intro = (mode === 'staff')
        ? `<span class="accent-teal">Spirit Guide</span><br>I can pull recipes, batch & single builds, glass/garnish, and spirit info. Ask me a cocktail or spirit name, say “quiz” to drill, or ask training questions.`
        : `<span class="accent-teal">Spirit Guide</span><br>I can help you explore cocktails, spirits, prices, and ingredients. Ask me for any drink, an ingredient, or “recommendation”.`;
      return res.status(200).json({ bubbles: [intro], answer: intro });
    }

    if (isGreeting(q)) {
      const greet = (mode === 'staff')
        ? `Hey! Ask me a cocktail or spirit. I’ll show specs (batch first), then you can say “yes” for single build or “quiz” to practice.`
        : `Hey! Ask me about any cocktail or spirit. I’ll keep it light and helpful — we can talk ingredients, flavors, or pairings.`;
      return res.status(200).json({ bubbles: [greet], answer: greet });
    }

    // ===== First try: direct cocktail or spirit match from JSON fallback
    let matchedCocktailKey = findBestKey(keysCocktails);
    let matchedSpiritKey = matchedCocktailKey ? null : findBestKey(keysSpirits);

    // Follow-up branches if no direct match
    if (!matchedCocktailKey && !matchedSpiritKey) {
      // “yes” to show single build
      if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = cocktails[sess.lastItemName];
        if (item) {
          const bubbles = bubbleCocktailStaffSingle(sess.lastItemName, item);
          sess.askedSingle = false;
          sess.lastItemType = 'cocktail';
          sess.lastMode = 'staff';
          state.set(sessionKey, sess);
          return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
        }
      }

      // “quiz” on last cocktail
      if (mode === 'staff' && isQuizRequest(query) && sess.lastItemType === 'cocktail' && sess.lastItemName) {
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
      }
    }

    // If we matched a SPIRIT from JSON
    if (matchedSpiritKey) {
      const item = spirits[matchedSpiritKey] || {};
      const bubbles = bubbleSpirit(matchedSpiritKey, item);

      // memory
      sess.lastItemName = matchedSpiritKey;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // If we matched a COCKTAIL from JSON
    if (matchedCocktailKey) {
      const item = cocktails[matchedCocktailKey] || {};
      let bubbles;

      if (mode === 'staff') {
        bubbles = bubbleCocktailStaffBatch(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'staff';
        sess.askedSingle = true;
        state.set(sessionKey, sess);
      } else {
        bubbles = bubbleCocktailGuest(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
        state.set(sessionKey, sess);
      }

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== No JSON hit – try Supabase knowledge =====
    let kbHits = [];
    try {
      kbHits = await supaSearchKnowledge(q, mode);
    } catch { /* ignore */ }

    if (Array.isArray(kbHits) && kbHits.length) {
      // Show up to 2 items as bubbles
      const top = kbHits.slice(0, 2).map(bubblesFromKnowledge).flat();
      if (top.length) {
        // lightweight memory update – if the name matches a cocktail/spirit key, remember it
        const hitName = String(kbHits[0]?.name || '');
        if (hitName) {
          if (keysCocktails.includes(hitName)) {
            sess.lastItemName = hitName;
            sess.lastItemType = 'cocktail';
            sess.lastMode = mode;
            sess.askedSingle = (mode === 'staff');
            state.set(sessionKey, sess);
          } else if (keysSpirits.includes(hitName)) {
            sess.lastItemName = hitName;
            sess.lastItemType = 'spirit';
            sess.lastMode = mode;
            sess.askedSingle = false;
            state.set(sessionKey, sess);
          }
        }
        return res.status(200).json({ bubbles: top, answer: top.join('\n\n') });
      }
    }

    // ===== Final fallback – keep it friendly =====
    const fallback = [`Sorry, I don't have this answer yet. I'm still learning...`];
    return res.status(200).json({ bubbles: fallback, answer: fallback.join('\n\n') });

  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
