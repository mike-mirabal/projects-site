// /api/chat.js
//
// Chat backend for Spirit Guide
// - Reads cocktails/spirits from request body if provided (front-end JSON files), else from env
// - Flattens spirits when nested like { SPIRITS: { Category: { Brand: {...} } } }
// - Staff mode defaults to BATCH build; follows up with single-build prompt
// - Remembers last item per-session (very lightweight, in-memory)
// - Spirits output: name (accent) + (price) on first line, then one bullet per data point
//
// NOTE: This server keeps a tiny in-memory state keyed by a best-effort session key
//       (x-session-id header if provided, otherwise IP+UA). It resets automatically.

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

    // ===== Load knowledge =====
    // Prefer JSON sent from the client (front-end fetched files).
    // Fallback to environment variables if body doesn't include them.
    let cocktails = {};
    let spirits = {};
    try {
      cocktails = body.cocktails && typeof body.cocktails === 'object'
        ? body.cocktails
        : JSON.parse(process.env.COCKTAILS_JSON || '{}');
    } catch { cocktails = {}; }

    try {
      spirits = body.spirits && typeof body.spirits === 'object'
        ? body.spirits
        : JSON.parse(process.env.SPIRITS_JSON || '{}');
    } catch { spirits = {}; }

    // ===== Normalize / Flatten SPIRITS if nested =====
    spirits = flattenSpirits(spirits);

    // ===== Lightweight session memory (per user) =====
    const now = Date.now();
    const sessionKey =
      (req.headers['x-session-id'] && String(req.headers['x-session-id'])) ||
      `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'na'} :: ${req.headers['user-agent'] || 'ua'}`;

    if (!global.__SG_STATE__) global.__SG_STATE__ = new Map();
    const state = global.__SG_STATE__;
    // cleanup occasionally
    if (Math.random() < 0.02) {
      const TTL = 1000 * 60 * 20; // 20 minutes
      for (const [k, v] of state.entries()) {
        if (!v || (now - (v.at || 0)) > TTL) state.delete(k);
      }
    }
    const sess = state.get(sessionKey) || { at: now };
    sess.at = now;
    state.set(sessionKey, sess);

    // ===== Utilities =====
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

    const getBatchBuild = (item) =>
      Array.isArray(item?.batchBuild) ? item.batchBuild :
      Array.isArray(item?.build?.batchBuild) ? item.build.batchBuild :
      Array.isArray(item?.batch_build) ? item.batch_build :
      null;

    const getSingleBuild = (item) =>
      Array.isArray(item?.build) ? item.build :
      Array.isArray(item?.recipe) ? item.recipe :
      Array.isArray(item?.build?.singleBuild) ? item.build.singleBuild :
      Array.isArray(item?.single_build) ? item.single_build :
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

    // ===== Matching helpers =====
    const keysCocktails = Object.keys(cocktails || {});
    const keysSpirits   = Object.keys(spirits   || {});
    const qNorm = normalize(q);

    const containsOrIn = (needle, hay) =>
      normalize(hay).includes(normalize(needle)) || normalize(needle).includes(normalize(hay));

    const findBestCocktailKey = () => {
      // direct contains either way
      let found = keysCocktails.find(k => containsOrIn(qNorm, k));
      if (found) return found;
      // token prefix match
      found = keysCocktails.find(k => normalize(k).split(' ').some(t => t.startsWith(qNorm)));
      return found || null;
    };

    const findBestSpiritKey = () => {
      // direct contains either way
      let found = keysSpirits.find(k => containsOrIn(qNorm, k));
      if (found) return found;

      // token prefix match
      found = keysSpirits.find(k => normalize(k).split(/[()]/)[0].split(' ').some(t => t.startsWith(qNorm)));
      if (found) return found;

      // brand keyword (e.g., "espolon" matches "Espolon Blanco")
      found = keysSpirits.find(k => normalize(k).includes(qNorm));
      return found || null;
    };

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

      // Always prefer batch build for initial staff response
      if (batch && batch.length) {
        lines.push(...batch);
      } else if (single && single.length) {
        lines.push(...single);
      } else if (getIngredients(item)) {
        lines.push(...getIngredients(item));
      }

      // Append glass/garnish
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

      if (single && single.length) {
        lines.push(...single);
      } else if (getIngredients(item)) {
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
      const ing = (ingredients && ingredients.length)
        ? `Ingredients: ${escapeHTML(ingredients.join(', '))}`
        : null;

      const block = joinLines([top, '', desc, '', ing || '']);
      return [block, upsellFor(name)];
    }

    // Spirits formatting with flexible keys (snake_case, camelCase, etc.)
    function formatSpirit(name, item) {
      const header = formatHeaderHTML(name, item.price);

      // Map all keys to a lower, no-space, no-underscore variant for matching
      const kv = {};
      Object.keys(item || {}).forEach(k => {
        const norm = String(k).toLowerCase().replace(/[\s_]/g, '');
        kv[norm] = item[k];
      });

      // Preferred order of labels -> list of possible key aliases
      const fields = [
        { label: 'Type & Category', keys: ['type', 'category', 'typecategory', 'typeandcategory'] },
        { label: 'Agave Variety / Base Ingredient', keys: ['agave', 'agavevariety', 'base', 'baseingredient', 'agavevarietybaseingredient'] },
        { label: 'Region & Distillery', keys: ['region', 'distillery', 'regiondistillery', 'regionanddistillery'] },
        { label: 'Tasting Notes', keys: ['tastingnotes', 'notes_tasting'] },
        { label: 'Production Notes', keys: ['productionnotes', 'process', 'production'] },
        { label: 'Distillery / Brand Identity', keys: ['brandidentity', 'distillerybrandidentity', 'brand'] },
        { label: 'Guest Talking Point / Fun Fact', keys: ['funfact', 'guesttalkingpoint', 'talkingpoint'] },
        { label: 'Reviews', keys: ['reviews'] }
      ];

      const bullets = [];

      // Pull values in the preferred order
      for (const f of fields) {
        const keyHit = f.keys.find(k => kv[k] != null);
        if (keyHit) {
          const v = kv[keyHit];
          bullets.push(`${f.label}: ${Array.isArray(v) ? v.join('; ') : String(v)}`);
        }
      }

      // Add any remaining fields (except price) that weren’t covered
      const used = new Set(fields.flatMap(f => f.keys));
      for (const rawKey of Object.keys(item || {})) {
        const norm = rawKey.toLowerCase().replace(/[\s_]/g, '');
        if (norm === 'price' || used.has(norm)) continue;
        const v = item[rawKey];
        if (v == null || v === '') continue;
        const human =
          rawKey
            .replace(/_/g, ' ')
            .replace(/([A-Z])/g, ' $1')
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
        bullets.push(`${human}: ${Array.isArray(v) ? v.join('; ') : String(v)}`);
      }

      const bubble = joinLines([header, formatBulletsHTML(bullets)]);
      return [bubble];
    }

    // ===== Try direct matches =====
    const matchedSpiritKey   = findBestSpiritKey();
    const matchedCocktailKey = matchedSpiritKey ? null : findBestCocktailKey();

    // ===== Follow-ups / memory-driven branches =====
    if (!matchedCocktailKey && !matchedSpiritKey) {
      // Staff "yes" -> single build
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

      // Staff quiz on last cocktail
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

    // ===== If we matched a spirit =====
    if (matchedSpiritKey) {
      const item = spirits[matchedSpiritKey] || {};
      const bubbles = formatSpirit(matchedSpiritKey, item);

      // memory
      sess.lastItemName = matchedSpiritKey;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== If we matched a cocktail =====
    if (matchedCocktailKey) {
      const item = cocktails[matchedCocktailKey] || {};
      let bubbles;

      if (mode === 'staff') {
        bubbles = formatCocktailStaffBatch(matchedCocktailKey, item);

        // set memory for follow-up "yes"
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'staff';
        sess.askedSingle = true;  // we just asked if they want the single build
        state.set(sessionKey, sess);

      } else {
        // guest mode
        bubbles = formatCocktailGuest(matchedCocktailKey, item);

        // memory
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
        state.set(sessionKey, sess);
      }

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== Nothing matched: LLM fallback (kept minimal) =====
    const staffDirectives = `
You are the Spirit Guide (STAFF mode). Respond in HTML only (no markdown).
Rules for cocktails:
- If a cocktail is referenced, prefer the BATCH BUILD by default (if present).
- Format bubble 1 as:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each build line (use batchBuild first; if not found, use single build "build" or "recipe"; if not found, use ingredients)
  • Glass: ...
  • Garnish: ...
- Format bubble 2 exactly as:
  Do you want to see the single cocktail build without batch?

If user later confirms (e.g., "yes"), show the SINGLE BUILD ("build" or "recipe") similarly.
If the user asks for a quiz on the last cocktail, ask one short question (glass, garnish, or first ingredient with quantity).

Rules for spirits:
- If a spirit is referenced by name, create ONE bubble:
  <span class="accent-teal">NAME</span> (PRICE)
  Then one bullet per line for each data point available. Prefer labels in this order:
    Type & Category
    Agave Variety / Base Ingredient
    Region & Distillery
    Tasting Notes
    Production Notes
    Distillery / Brand Identity
    Guest Talking Point / Fun Fact
    Reviews
Map keys sensibly even if the JSON uses snake_case or different labels.
Use <br> for new lines and "• " bullets.`.trim();

    const guestDirectives = `
You are the Spirit Guide (GUEST mode). Respond in HTML only (no markdown).
- For cocktails, return ONLY two bubbles:
  Bubble 1:
    <span class="accent-teal">Name</span> (PRICE)
    <br>
    Short enticing one-sentence description from character/tasting notes.
    <br>
    Ingredients: a concise, comma-separated list (no quantities).
  Bubble 2:
    An upsell/pairing recommendation. You may include a <br> for a happy-hour line.

- For spirits, use the same single-bubble format as staff:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each data point as described.

No markdown. HTML only.`.trim();

    const systemPrompt = `
You have two structured JSON knowledge bases:

COCKTAILS:
${safeJSONString(cocktails)}

SPIRITS:
${safeJSONString(spirits)}

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

Return either:
1) {"bubbles": ["<html...>","<html...>"]}  (JSON with up to 2 bubbles)
or
2) Plain HTML with two paragraphs separated by a blank line. Prefer the JSON format above.`.trim();

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

        // Try to extract JSON with bubbles
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.bubbles)) {
              llmBubbles = parsed.bubbles.slice(0, 2).map(String);
            }
          } catch {}
        }
        // Fallback: split plain HTML by blank line
        if (!llmBubbles) {
          const split = content.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 2);
          if (split.length) llmBubbles = split;
        }
      }
    } catch (e) {
      // ignore; handled by fallback
    }

    if (llmBubbles && llmBubbles.length) {
      // best-effort memory update
      const allKeys = [...Object.keys(cocktails||{}), ...Object.keys(spirits||{})];
      const hit = allKeys.find(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(llmBubbles.join(' ')));
      if (hit) {
        const isCocktail = cocktails && cocktails[hit];
        sess.lastItemName = hit;
        sess.lastItemType = isCocktail ? 'cocktail' : 'spirit';
        sess.lastMode = mode;
        sess.askedSingle = !!(mode === 'staff' && isCocktail);
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

/* ================= Helpers ================= */

// Flattens shapes like:
// { SPIRITS: { Mezcal: { "Amaras Verde": {...}, "Bozal Ensamble": {...} }, Tequila: {...} } }
// or { Mezcal: {...}, Tequila: {...} }
// into a flat { "Amaras Verde": {...}, "Bozal Ensamble": {...} }
function flattenSpirits(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let root = raw.SPIRITS && typeof raw.SPIRITS === 'object' ? raw.SPIRITS : raw;

  const out = {};
  const isLeaf = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    // Heuristic: a leaf has one or more known spirit fields, e.g. price OR tasting/type/etc.
    return (
      'price' in obj ||
      'type' in obj || 'type_category' in obj || 'typeCategory' in obj ||
      'tasting_notes' in obj || 'tastingNotes' in obj
    );
  };

  (function walk(node) {
    Object.keys(node || {}).forEach(key => {
      const val = node[key];
      if (val && typeof val === 'object') {
        if (isLeaf(val)) {
          out[key] = val;
        } else {
          walk(val); // category/group
        }
      }
    });
  })(root);

  return out;
}

// Safe JSON stringify for prompt
function safeJSONString(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch { return '{}'; }
}
