// /api/chat.js
//
// Chat backend for Spirit Guide
// - Prefers cocktails/spirits passed in req.body (from your front-end); falls back to env
// - Robust matching for spirits (supports object or array JSON, name/displayName/brand/aliases)
// - Staff: default to batch build; follow-up asks for single build
// - Remembers last item (session-lite) so “yes” works
// - Spirits output: NAME (accent + price) then one bullet per data point line (HTML only)

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

    // ===== Load knowledge (body first; env fallback) =====
    let cocktails = {};
    let spirits   = {};

    // Prefer client-provided payloads (from /public/app.js or similar)
    if (body.cocktails && (Array.isArray(body.cocktails) || typeof body.cocktails === 'object')) {
      cocktails = body.cocktails;
    } else {
      try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    }

    if (body.spirits && (Array.isArray(body.spirits) || typeof body.spirits === 'object')) {
      spirits = body.spirits;
    } else {
      try { spirits = JSON.parse(process.env.SPIRITS_JSON || '{}'); } catch { spirits = {}; }
    }

    // ===== Tiny per-session memory =====
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;

    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;

    // occasional cleanup (20 min TTL)
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20;
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
      .replace(/[\u2019']/g, '')              // apostrophes
      .replace(/[^\p{L}\p{N}]+/gu, ' ')       // non-alphanum -> space
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

    const qNorm = normalize(query);

    // ===== Normalize cocktails as a name->item map =====
    function toMap(data, opts = {}) {
      // supports object map { name: {...} } OR array [{name, ...}]
      const out = {};
      if (!data) return out;

      if (Array.isArray(data)) {
        data.forEach((item) => {
          if (!item) return;
          const name = item.name || item.displayName || item.title;
          if (name) out[String(name)] = item;
        });
      } else if (typeof data === 'object') {
        // already a map
        Object.keys(data).forEach((k) => {
          out[String(k)] = data[k];
        });
      }
      return out;
    }

    const cocktailsMap = toMap(cocktails);
    const spiritsMap   = toMap(spirits);

    // ===== Build a flexible search index (esp. for spirits) =====
    function buildIndex(map, kind) {
      // returns [{key, item, hay}], where hay is a single normalized string containing
      // name + displayName + brand + aliases + alt spellings, etc.
      const idx = [];
      for (const key of Object.keys(map)) {
        const item = map[key] || {};
        const bits = [
          key,
          item.name,
          item.displayName,
          item.brand,
          ...(asArray(item.aliases)),
        ]
          .filter(Boolean)
          .map(normalize);

        // Also include some helpful fields to catch queries like “Terralta Reposado”
        if (kind === 'spirit') {
          bits.push(normalize(item.type));
          bits.push(normalize(item.category));
          bits.push(normalize(item.agave));
          bits.push(normalize(item.region));
          bits.push(normalize(item.distillery));
        }

        const hay = normalize(bits.filter(Boolean).join(' '));
        idx.push({ key, item, hay });
      }
      return idx;
    }

    const cocktailsIdx = buildIndex(cocktailsMap, 'cocktail');
    const spiritsIdx   = buildIndex(spiritsMap, 'spirit');

    function findBest(idx) {
      if (!idx.length || !qNorm) return null;

      // exact-ish contains
      let hit = idx.find(({ key }) => qNorm.includes(normalize(key))) ||
                idx.find(({ key }) => normalize(key).includes(qNorm));
      if (hit) return hit;

      // haystack contains
      hit = idx.find(({ hay }) => hay && hay.includes(qNorm));
      if (hit) return hit;

      // word-wise overlap heuristic
      const words = qNorm.split(' ').filter(Boolean);
      let best = null;
      let bestScore = 0;
      for (const row of idx) {
        const score = words.reduce((acc, w) => acc + (row.hay?.includes(w) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; best = row; }
      }
      return bestScore > 0 ? best : null;
    }

    // ===== Cocktail helpers =====
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

    // ===== Formatters (HTML only) =====
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

      if (batch?.length) {
        lines.push(...batch);
      } else if (single?.length) {
        lines.push(...single);
      } else if (getIngredients(item)?.length) {
        lines.push(...getIngredients(item));
      }

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

      if (single?.length) {
        lines.push(...single);
      } else if (getIngredients(item)?.length) {
        lines.push(...getIngredients(item));
      }

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
      const ing = (ingredients?.length)
        ? `Ingredients: ${escapeHTML(ingredients.join(', '))}`
        : null;

      const block = joinLines([top, '', desc, '', ing || '']);
      return [block, upsellFor(name)];
    }

    // Spirits bullets: provide a friendly order, but include any extra fields too
    function formatSpirit(name, item) {
      const bubbleLines = [];

      const fieldsOrder = [
        ['type', 'Type & Category'],
        ['typeAndCategory', 'Type & Category'],
        ['category', 'Category'],
        ['agave', 'Agave Variety / Base Ingredient'],
        ['agaveVariety', 'Agave Variety / Base Ingredient'],
        ['base', 'Base Ingredient'],
        ['region', 'Region & Distillery'],
        ['regionAndDistillery', 'Region & Distillery'],
        ['distillery', 'Distillery'],
        ['tastingNotes', 'Tasting Notes'],
        ['productionNotes', 'Production Notes'],
        ['brandIdentity', 'Distillery / Brand Identity'],
        ['funFact', 'Guest Talking Point / Fun Fact'],
        ['guestTalkingPoint', 'Guest Talking Point / Fun Fact'],
        ['reviews', 'Reviews'],
      ];

      // normalize to case-insensitive map
      const lowerMap = {};
      Object.keys(item || {}).forEach(k => { lowerMap[k.toLowerCase()] = item[k]; });

      // preferred order
      for (const [key, label] of fieldsOrder) {
        const v = lowerMap[key.toLowerCase()];
        if (v != null && v !== '') {
          const text = Array.isArray(v) ? v.join('; ') : String(v);
          bubbleLines.push(`${label}: ${text}`);
        }
      }

      // include any other fields (skip price)
      const covered = new Set(fieldsOrder.map(([k]) => k.toLowerCase()));
      for (const rawKey of Object.keys(item || {})) {
        const lk = rawKey.toLowerCase();
        if (lk === 'price' || covered.has(lk)) continue;
        const v = item[rawKey];
        if (v == null || v === '') continue;
        const text = Array.isArray(v) ? v.join('; ') : String(v);
        const label = rawKey
          .replace(/([A-Z])/g, ' $1')
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
        bubbleLines.push(`${label}: ${text}`);
      }

      const header = formatHeaderHTML(name, item.price);
      const bullets = formatBulletsHTML(bubbleLines);
      return [joinLines([header, bullets])];
    }

    // ===== Intent helpers =====
    const isAffirmative = (text) => /\b(yes|yep|yup|yeah|sure|ok(ay)?|please|show\s*me|do\s*it)\b/i.test(text || '');
    const isQuizRequest = (text) => /\bquiz|test\s*(me|knowledge)?\b/i.test(text || '');

    // ===== Try to match a cocktail or a spirit =====
    const cocktailHit = findBest(cocktailsIdx);
    const spiritHit   = cocktailHit ? null : findBest(spiritsIdx);

    // ===== Follow-ups =====
    if (!cocktailHit && !spiritHit) {
      // “yes” to single build
      if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = cocktailsMap[sess.lastItemName];
        if (item) {
          const bubbles = formatCocktailStaffSingle(sess.lastItemName, item);
          sess.askedSingle = false;
          sess.lastMode = 'staff';
          state.set(sessionKey, sess);
          return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
        }
      }

      // quiz
      if (mode === 'staff' && isQuizRequest(query) && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = cocktailsMap[sess.lastItemName];
        if (item) {
          const qs = [];
          if (item.glass) qs.push(`What’s the correct glass for ${sess.lastItemName}?`);
          if (item.garnish) qs.push(`Name one garnish on ${sess.lastItemName}.`);
          const single = getSingleBuild(item);
          const batch = getBatchBuild(item);
          const firstFrom = (batch && batch[0]) || (single && single[0]) || null;
          if (firstFrom) qs.push(`What’s the first ingredient (with quantity) in ${sess.lastItemName}?`);
          const bubbles = qs.length ? [qs[Math.floor(Math.random() * qs.length)]] : [`Ready for a quick flashcard? Name one ingredient in ${sess.lastItemName}.`];
          sess.lastMode = 'staff';
          state.set(sessionKey, sess);
          return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
        }
      }
    }

    // ===== Spirit matched =====
    if (spiritHit) {
      const name = spiritHit.key;
      const item = spiritHit.item || {};
      const bubbles = formatSpirit(name, item);

      sess.lastItemName = name;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== Cocktail matched =====
    if (cocktailHit) {
      const name = cocktailHit.key;
      const item = cocktailHit.item || {};
      let bubbles;

      if (mode === 'staff') {
        bubbles = formatCocktailStaffBatch(name, item);
        sess.lastItemName = name;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'staff';
        sess.askedSingle = true;
        state.set(sessionKey, sess);
      } else {
        bubbles = formatCocktailGuest(name, item);
        sess.lastItemName = name;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
        state.set(sessionKey, sess);
      }

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== LLM fallback with both JSONs in context =====
    const staffDirectives = `
You are the Spirit Guide (STAFF mode). Respond in HTML only (no markdown).
Rules for cocktails:
- Prefer the BATCH BUILD by default (if present).
- Bubble 1:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line (batchBuild first; if absent use single build "build" or "recipe"; else ingredients)
  • Glass: ...
  • Garnish: ...
- Bubble 2 (exactly):
  Do you want to see the single cocktail build without batch?

If user confirms later, show the SINGLE BUILD similarly.
If user asks for a quiz on the last cocktail, ask one short question (glass, garnish, or first ingredient with quantity).

Rules for spirits:
- One bubble:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each data point.
  Preferred labels:
    Type & Category
    Agave Variety / Base Ingredient
    Region & Distillery
    Tasting Notes
    Production Notes
    Distillery / Brand Identity
    Guest Talking Point / Fun Fact
    Reviews
Map differing keys sensibly. Use <br> for newlines and "• " bullets. No markdown.`.trim();

    const guestDirectives = `
You are the Spirit Guide (GUEST mode). Respond in HTML only (no markdown).
Cocktails:
- Bubble 1:
  <span class="accent-teal">Name</span> (PRICE)
  <br>
  Short enticing one-sentence description from character/tasting notes.
  <br>
  Ingredients: concise, comma-separated list (no quantities).
- Bubble 2:
  Upsell/pairing (you may include a <br> for happy-hour line).

Spirits:
- Same single-bubble format as staff:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for data points.
Use HTML with <br> and "• ". No markdown.`.trim();

    const systemPrompt = `
You have two structured JSON knowledge bases.

COCKTAILS:
${typeof cocktails === 'string' ? cocktails : JSON.stringify(cocktails).slice(0, 50000)}

SPIRITS:
${typeof spirits === 'string' ? spirits : JSON.stringify(spirits).slice(0, 50000)}

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

Return either:
1) {"bubbles": ["<html...>","<html...>"]}  (up to 2 bubbles)
or
2) Plain HTML with two paragraphs separated by a blank line. Prefer JSON format.`.trim();

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
    } catch (_) {
      // ignore; handled below
    }

    if (llmBubbles?.length) {
      // heuristic memory update
      const allNames = [...Object.keys(cocktailsMap), ...Object.keys(spiritsMap)];
      const joined = llmBubbles.join(' ');
      const hit = allNames.find(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(joined));
      if (hit) {
        sess.lastItemName = hit;
        sess.lastItemType = Object.prototype.hasOwnProperty.call(cocktailsMap, hit) ? 'cocktail' : 'spirit';
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
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
