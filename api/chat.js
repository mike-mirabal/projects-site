// /api/chat.js
//
// Chat backend for Spirit Guide
// - Reads cocktails/spirits from req.body first (front-end JSON), then env fallback
// - Flattens nested category JSON (e.g., { Tequila: { "Espolon Blanco": {...} } })
// - Staff mode: batch build first; follow-up asks for single build
// - Remembers last item per-session so "yes" shows single build
// - Spirits output: Name (accent) + (price) then one bullet per line of datapoints
// - More robust matching: diacritics-stripped + token fuzzy match
//
// NOTE: In-memory session store resets on cold start (OK for demo/prototype)

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

    // ===== Load knowledge from client first, env as fallback =====
    let cocktails = {};
    let spirits = {};

    // Front-end may post JSON directly
    if (body.cocktails && typeof body.cocktails === 'object') cocktails = body.cocktails;
    if (body.spirits && typeof body.spirits === 'object') spirits = body.spirits;

    // Env fallback
    if (!Object.keys(cocktails).length) {
      try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    }
    if (!Object.keys(spirits).length) {
      try { spirits = JSON.parse(process.env.SPIRITS_JSON || '{}'); } catch { spirits = {}; }
    }

    // ===== Lightweight session memory (per user) =====
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

    // ===== Utilities =====
    const stripDiacritics = (s) =>
      String(s || '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '');

    const normalize = (s) => stripDiacritics(s)
      .toLowerCase()
      .replace(/[\u2019']/g, '')            // apostrophes
      .replace(/[^a-z0-9]+/g, ' ')          // non-alphanum -> space
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

    // ===== Flatten nested catalogs (categories → items) =====
    // Accepts shapes like:
    //   { "Espolon Blanco": {...} }
    //   { "Tequila": { "Espolon Blanco": {...} } }
    //   { "Tequila": [ { name: "Espolon Blanco", ... }, ... ] }
    function flattenCatalog(obj) {
      const out = {}; // { Name: item }
      function walk(node, parentKey) {
        if (!node) return;

        if (Array.isArray(node)) {
          for (const el of node) {
            if (el && typeof el === 'object') {
              const name = el.name || el.title || parentKey; // try to find a name
              if (name && (el.price || el.type || el.tastingNotes || el.ingredients || el.build || el.batchBuild)) {
                out[String(name)] = el;
              } else {
                walk(el, parentKey);
              }
            }
          }
          return;
        }

        if (typeof node === 'object') {
          // If this object looks like an item (has item-ish fields) and has a key name
          const keys = Object.keys(node);
          const looksLikeItem =
            ('ingredients' in node) || ('build' in node) || ('batchBuild' in node) ||
            ('glass' in node) || ('garnish' in node) ||
            ('tastingNotes' in node) || ('productionNotes' in node) || ('type' in node);

          if (looksLikeItem && parentKey && !keys.some(k => typeof node[k] === 'object')) {
            // probably an item object that was passed with a parent name; add it
            out[String(parentKey)] = node;
          }

          // otherwise iterate children
          for (const k of keys) {
            const v = node[k];
            // If child is a terminal item object, record it under its key
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              const childLooksItem =
                ('ingredients' in v) || ('build' in v) || ('batchBuild' in v) ||
                ('glass' in v) || ('garnish' in v) ||
                ('tastingNotes' in v) || ('productionNotes' in v) || ('type' in v);
              if (childLooksItem) {
                out[String(k)] = v;
              } else {
                walk(v, k);
              }
            } else if (Array.isArray(v)) {
              // arrays of items
              walk(v, k);
            }
          }
        }
      }
      walk(obj, null);
      return out;
    }

    const flatCocktails = flattenCatalog(cocktails);
    const flatSpirits   = flattenCatalog(spirits);

    // Build a normalized index for fuzzy lookup
    function buildIndex(mapObj) {
      const entries = [];
      for (const name of Object.keys(mapObj || {})) {
        const item = mapObj[name];
        const normName = normalize(name);
        const aliases = new Set([normName]);

        // Optional alias fields
        for (const key of ['aka', 'aliases', 'alsoKnownAs']) {
          const val = item[key];
          if (Array.isArray(val)) val.forEach(a => aliases.add(normalize(a)));
          else if (val) aliases.add(normalize(val));
        }

        // Also derive brand-only + variety-only tokens for spirits (e.g., "espolon", "pasote blanco")
        // split the name into tokens; store useful prefixes
        const tokens = normName.split(' ');
        if (tokens.length > 1) {
          aliases.add(tokens[0]); // brand
          aliases.add(tokens.slice(0, 2).join(' ')); // brand + variant
        }

        entries.push({ name, normName, aliases, item });
      }
      return entries;
    }

    const cocktailIdx = buildIndex(flatCocktails);
    const spiritIdx   = buildIndex(flatSpirits);

    // Token-based fuzzy find:
    // - exact alias match first
    // - then "query is contained in candidate" or "candidate contains query"
    // - then token overlap score
    function findBest(query, index) {
      const qn = normalize(query);
      if (!qn) return null;

      // exact/alias
      for (const e of index) {
        if (e.aliases.has(qn)) return e.name;
      }

      // contains either way
      for (const e of index) {
        if (e.normName.includes(qn) || qn.includes(e.normName)) return e.name;
      }

      // token overlap
      const qTokens = new Set(qn.split(' '));
      let best = null;
      let bestScore = 0;
      for (const e of index) {
        const t = new Set(e.normName.split(' '));
        let score = 0;
        for (const tok of qTokens) {
          if (t.has(tok)) score += 1;
        }
        // slight bonus if first token matches (brand)
        const qFirst = qn.split(' ')[0];
        const eFirst = e.normName.split(' ')[0];
        if (qFirst && eFirst && qFirst === eFirst) score += 0.25;
        if (score > bestScore) { bestScore = score; best = e.name; }
      }
      // require at least 1 token overlap to avoid wild guesses
      return bestScore >= 1 ? best : null;
    }

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

      if (batch && batch.length) {
        lines.push(...batch);
      } else if (single && single.length) {
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

    // Spirits (one bubble: header + bullets)
    function formatSpirit(name, item) {
      const bubbleLines = [];

      const fieldsOrder = [
        ['type', 'Type & Category'],
        ['typeAndCategory', 'Type & Category'],
        ['category', 'Category'],
        ['agave', 'Agave Variety / Base Ingredient'],
        ['base', 'Base Ingredient'],
        ['agaveVariety', 'Agave Variety / Base Ingredient'],
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

      const lowerMap = {};
      Object.keys(item || {}).forEach(k => { lowerMap[k.toLowerCase()] = item[k]; });

      for (const [key, label] of fieldsOrder) {
        const val = lowerMap[key.toLowerCase()];
        if (val != null && val !== '') {
          const text = Array.isArray(val) ? val.join('; ') : String(val);
          bubbleLines.push(`${label}: ${text}`);
        }
      }

      // add any extra fields not already covered (except price)
      const covered = new Set(fieldsOrder.map(([k]) => k.toLowerCase()).concat(['price']));
      for (const rawKey of Object.keys(item || {})) {
        const lk = rawKey.toLowerCase();
        if (covered.has(lk)) continue;
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

    // ===== Matching & memory-driven branches =====
    const matchedCocktailKey = findBest(query, cocktailIdx);
    const matchedSpiritKey   = !matchedCocktailKey ? findBest(query, spiritIdx) : null;

    // Follow-up: user said "yes" to single build for last cocktail
    if (!matchedCocktailKey && !matchedSpiritKey) {
      if (mode === 'staff' && isAffirmative(query) && sess.askedSingle && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = flatCocktails[sess.lastItemName];
        if (item) {
          const bubbles = formatCocktailStaffSingle(sess.lastItemName, item);
          sess.askedSingle = false;
          sess.lastMode = 'staff';
          state.set(sessionKey, sess);
          return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
        }
      }

      // Quiz request
      if (mode === 'staff' && isQuizRequest(query) && sess.lastItemType === 'cocktail' && sess.lastItemName) {
        const item = flatCocktails[sess.lastItemName];
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

    // Spirit matched
    if (matchedSpiritKey) {
      const item = flatSpirits[matchedSpiritKey] || {};
      const bubbles = formatSpirit(matchedSpiritKey, item);
      sess.lastItemName = matchedSpiritKey;
      sess.lastItemType = 'spirit';
      sess.lastMode = mode;
      sess.askedSingle = false;
      state.set(sessionKey, sess);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // Cocktail matched
    if (matchedCocktailKey) {
      const item = flatCocktails[matchedCocktailKey] || {};
      let bubbles;
      if (mode === 'staff') {
        bubbles = formatCocktailStaffBatch(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'staff';
        sess.askedSingle = true;
        state.set(sessionKey, sess);
      } else {
        bubbles = formatCocktailGuest(matchedCocktailKey, item);
        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
        state.set(sessionKey, sess);
      }
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== LLM fallback with both JSONs (HTML only) =====
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
  Then one bullet per line for each data point available in sensible order:
    Type & Category
    Agave Variety / Base Ingredient
    Region & Distillery
    Tasting Notes
    Production Notes
    Distillery / Brand Identity
    Guest Talking Point / Fun Fact
    Reviews

Do NOT output markdown. Use <br> for new lines. Use "• " at the start of bullet lines.`.trim();

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
    An upsell/pairing recommendation (you may include a <br>).

- For spirits (same single-bubble format as staff):
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each data point as described.

No markdown. HTML only.`.trim();

    const systemPrompt = `
You have two structured JSON knowledge bases.

COCKTAILS:
${JSON.stringify(flatCocktails).slice(0, 25000)}

SPIRITS:
${JSON.stringify(flatSpirits).slice(0, 25000)}

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
    } catch {}

    if (llmBubbles && llmBubbles.length) {
      // best-effort memory update
      const allNames = new Set([...Object.keys(flatCocktails), ...Object.keys(flatSpirits)]);
      const joined = llmBubbles.join(' ');
      for (const name of allNames) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(joined)) {
          sess.lastItemName = name;
          sess.lastItemType = flatCocktails[name] ? 'cocktail' : 'spirit';
          sess.lastMode = mode;
          sess.askedSingle = (mode === 'staff' && sess.lastItemType === 'cocktail');
          state.set(sessionKey, sess);
          break;
        }
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
