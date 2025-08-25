// /api/chat.js
//
// Spirit Guide backend wired to Supabase (plus your existing JSON paths)
// - Tries local JSON matches (COCKTAILS_JSON, SPIRITS_JSON) first (zero changes to your current content).
// - Also queries Supabase `knowledge` table by name & role (guest/staff/both).
// - Spirits are rendered with orange bold labels on separate lines (no bullets).
// - Cocktails keep your existing staff/guest formatting & memory for follow-ups.
//
// Env required (Vercel → Project → Settings → Environment Variables):
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY  (server-side only)
// - OPENAI_API_KEY             (optional fallback, used exactly as before)
// - COCKTAILS_JSON             (optional legacy)
// - SPIRITS_JSON               (optional legacy)

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ===== Parse request =====
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest';
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ===== Supabase client =====
    const supabaseUrl  = process.env.SUPABASE_URL;
    const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabase = (supabaseUrl && supabaseKey)
      ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
      : null;

    // ===== Load legacy JSON (optional, keeps your current flow working) =====
    let cocktails = {};
    let spiritsRaw = {};
    try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    try { spiritsRaw = JSON.parse(process.env.SPIRITS_JSON   || '{}'); } catch { spiritsRaw = {}; }

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

    // ===== Memory (per-session) =====
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;

    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20;
      for (const [k, v] of state.entries()) {
        if (!v || (now - (v.at || 0)) > TTL) state.delete(k);
      }
    }
    const sess = state.get(sessionKey) || { at: now };
    sess.at = now;
    state.set(sessionKey, sess);

    // ===== Utils / Formatters =====
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

    function findBestKey(keys, qNorm) {
      if (!keys.length || !qNorm) return null;
      let found = keys.find(k => qNorm.includes(normalize(k)));
      if (found) return found;
      found = keys.find(k => normalize(k).includes(qNorm));
      if (found) return found;
      const qTokens = new Set(qNorm.split(' '));
      let best = null; let bestScore = 0;
      for (const k of keys) {
        const t = normalize(k).split(' ');
        const score = t.reduce((acc, tok) => acc + (qTokens.has(tok) ? 1 : 0), 0);
        if (score > bestScore) { best = k; bestScore = score; }
      }
      return bestScore > 0 ? best : null;
    }

    function formatHeaderHTML(name, price) {
      return `<span class="accent-teal">${escapeHTML(name)}</span>${priceLine(price)}`;
    }

    function formatBulletsHTML(lines) {
      return lines.filter(Boolean).map(l => `• ${escapeHTML(l)}`).join('<br>');
    }

    function formatCocktailStaffBatch(name, item) {
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
      if (single && single.length) lines.push(...single);
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
      if (n.includes('highland picnic')) return `This would go great with our chicken tinga tacos.<br>They're only $2.75 each on happy hour til 8pm!`;
      if (n.includes('margarita') || n.includes('paloma')) return `Great with our chips & queso — happy hour pricing til 8pm!`;
      if (n.includes('carajillo') || n.includes('espresso')) return `Try it with our churro bites — dessert-worthy combo.`;
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

    // Spirits: NO bullets. Orange bold label per line.
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

      push('Type & Category', m['type_category'] ?? m['typeandcategory'] ?? m['typeAndCategory'] ?? m['type'] ?? m['category']);
      push('Agave Variety / Base Ingredient', m['agave_variety'] ?? m['agavevariety'] ?? m['agaveVariety'] ?? m['agave'] ?? m['base'] ?? m['base_ingredient']);
      push('Region & Distillery', m['region_distillery'] ?? m['regiondistillery'] ?? m['regionAndDistillery'] ?? m['region'] ?? m['distillery']);
      push('Tasting Notes', m['tasting_notes'] ?? m['tastingnotes'] ?? m['tastingNotes']);
      push('Production Notes', m['production_notes'] ?? m['productionnotes'] ?? m['productionNotes']);
      push('Distillery / Brand Identity', m['brand_identity'] ?? m['distillery_brand_identity'] ?? m['brandIdentity'] ?? m['distillery_brand']);
      push('Guest Talking Point / Fun Fact', m['fun_fact'] ?? m['guest_talking_point'] ?? m['guesttalkingpoint'] ?? m['funfact']);
      push('Reviews', m['reviews']);

      // Include any extra keys (except price)
      const used = new Set([
        'price','type','category','type_category','typeandcategory','typeAndCategory',
        'agave','base','base_ingredient','agave_variety','agavevariety','agaveVariety',
        'region','distillery','region_distillery','regiondistillery','regionAndDistillery',
        'tasting_notes','tastingnotes','tastingNotes',
        'production_notes','productionnotes','productionNotes',
        'brand_identity','distillery_brand_identity','brandIdentity','distillery_brand',
        'fun_fact','guest_talking_point','guesttalkingpoint','funfact',
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

      const header = formatHeaderHTML(name, item.price);
      return [joinLines([header, ...lines])];
    }

    // ===== First try legacy JSON (still supported) =====
    const keysCocktails = Object.keys(cocktails || {});
    const keysSpirits   = Object.keys(spirits   || {});
    const qNorm = normalize(q);

    let matchedCocktailKey = findBestKey(keysCocktails, qNorm);
    let matchedSpiritKey   = matchedCocktailKey ? null : findBestKey(keysSpirits, qNorm);

    // ===== Follow-ups (yes/quiz) if nothing new matched =====
    if (!matchedCocktailKey && !matchedSpiritKey) {
      if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = cocktails[sess.lastItemName];
        if (item) {
          const bubbles = formatCocktailStaffSingle(sess.lastItemName, item);
          sess.askedSingle = false;
          sess.lastItemType = 'cocktail';
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

    // ===== If legacy JSON matched, answer immediately =====
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

    // ===== Supabase search (name match first), filtered by role =====
    async function fetchByNameFromSupabase(term, role) {
      if (!supabase) return null;
      // role visibility: 'both' or exact role
      const { data, error } = await supabase
        .from('knowledge')
        .select('*')
        .ilike('name', `%${term}%`)
        .in('role', ['both', role])
        .limit(5);

      if (error) {
        console.error('Supabase name search error:', error);
        return null;
      }
      return data || [];
    }

    async function fetchByContentFromSupabase(term, role) {
      if (!supabase) return null;
      // basic fallback: search key text columns
      const { data, error } = await supabase
        .from('knowledge')
        .select('*')
        .or([
          `name.ilike.%${term}%`,
          `tasting_notes.ilike.%${term}%`,
          `production_notes.ilike.%${term}%`,
          `brand_identity.ilike.%${term}%`,
          `fun_fact.ilike.%${term}%`,
          `character.ilike.%${term}%`,
          `ingredients::text.ilike.%${term}%`,
          `build::text.ilike.%${term}%`,
          `batch_build::text.ilike.%${term}%`
        ].join(','))
        .in('role', ['both', role])
        .limit(5);

      if (error) {
        console.error('Supabase content search error:', error);
        return null;
      }
      return data || [];
    }

    // Try Supabase “name contains” first
    let sb = await fetchByNameFromSupabase(q, mode);
    if (!sb || sb.length === 0) {
      // then try content columns
      sb = await fetchByContentFromSupabase(q, mode);
    }

    if (sb && sb.length) {
      // Choose the strongest looking hit (prefer exact-ish name match)
      const exact = sb.find(r => normalize(r.name) === qNorm) || sb[0];
      const item = exact;

      if (item.type === 'spirit') {
        const mapped = {
          price: item.price || null,
          type_category: item.type_category || null,
          agave_variety: item.agave_variety || null,
          region_distillery: item.region_distillery || null,
          tasting_notes: item.tasting_notes || null,
          production_notes: item.production_notes || null,
          brand_identity: item.brand_identity || null,
          fun_fact: item.fun_fact || null,
          reviews: item.reviews || null
        };
        const bubbles = formatSpirit(item.name, mapped);
        sess.lastItemName = item.name;
        sess.lastItemType = 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = false;
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }

      if (item.type === 'cocktail') {
        const mapped = {
          price: item.price || null,
          character: item.character || null,
          ingredients: asArray(item.ingredients),
          build: asArray(item.build),
          batchBuild: asArray(item.batch_build),
          glass: item.glass || null,
          garnish: asArray(item.garnish)
        };
        let bubbles;
        if (mode === 'staff') {
          bubbles = formatCocktailStaffBatch(item.name, mapped);
          sess.lastItemName = item.name;
          sess.lastItemType = 'cocktail';
          sess.lastMode = 'staff';
          sess.askedSingle = true;
        } else {
          bubbles = formatCocktailGuest(item.name, mapped);
          sess.lastItemName = item.name;
          sess.lastItemType = 'cocktail';
          sess.lastMode = 'guest';
          sess.askedSingle = false;
        }
        state.set(sessionKey, sess);
        return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
      }

      // Generic knowledge row (non-cocktail/spirit): show name + content-ish fields
      const lines = [];
      const push = (label, value) => {
        if (!value) return;
        lines.push(`<span class="accent-medium">${escapeHTML(label)}:</span> ${escapeHTML(String(value))}`);
      };
      push('Category', item.category);
      push('Notes', item.notes);
      const bubbles = [joinLines([formatHeaderHTML(item.name || 'Info', item.price), ...lines])];
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== Optional: LLM fallback (unchanged from your prior flow) =====
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

SPIRITS (NO BULLETS):
Bubble 1:
  <span class="accent-teal">NAME</span> (PRICE)
  <span class="accent-medium">Type & Category:</span> ...
  <span class="accent-medium">Agave Variety / Base Ingredient:</span> ...
  <span class="accent-medium">Region & Distillery:</span> ...
  <span class="accent-medium">Distillery / Brand Identity:</span> ...
  <span class="accent-medium">Tasting Notes:</span> ...
  <span class="accent-medium">Production Notes:</span> ...
(One field per line using <br>, no bullets.)
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

SPIRITS (NO BULLETS):
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
      if (process.env.OPENAI_API_KEY) {
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
      }
    } catch (e) {
      console.error('LLM fallback error:', e);
    }

    if (llmBubbles && llmBubbles.length) {
      const allKeys = [...Object.keys(cocktails || {}), ...Object.keys(spirits || {})];
      const hit = allKeys.find(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(llmBubbles.join(' ')));
      if (hit) {
        sess.lastItemName = hit;
        sess.lastItemType = Object.prototype.hasOwnProperty.call(cocktails, hit) ? 'cocktail' : 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = (mode === 'staff' && sess.lastItemType === 'cocktail');
        state.set(sessionKey, sess);
      }
      return res.status(200).json({ bubbles: llmBubbles, answer: llmBubbles.join('\n\n') });
    }

    // Final fallback
    const fallback = [`Sorry, I don't have this answer yet. I'm still learning...`];
    return res.status(200).json({ bubbles: fallback, answer: fallback.join('\n\n') });

  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
