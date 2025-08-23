// /api/chat.js
//
// Chat backend for Spirit Guide
// - Reads cocktails from process.env.COCKTAILS_JSON
// - Reads spirits   from process.env.SPIRITS_JSON
// - Staff mode defaults to showing BATCH build; follows up with a single-build prompt
// - Remembers last item per-session (very lightweight, in-memory) so replies like “yes” work
// - Spirits output: name (bold, accent) + (price) on first line, then one bullet per data point
//
// CHANGELOG (this drop-in):
// - More tolerant SPIRIT matching:
//   * token-based matching for brand-only queries (e.g., "espolon")
//   * handles variants like "espolon blanco", "don julio", "pasote", "fortaleza repo"
//   * alias support from optional item.aliases (array) in spirits JSON
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

    // ===== Load knowledge from env =====
    // COCKTAILS_JSON replaced MENU_JSON per user change
    let cocktails = {};
    let spirits = {};
    try { cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}'); } catch { cocktails = {}; }
    try { spirits   = JSON.parse(process.env.SPIRITS_JSON   || '{}'); } catch { spirits   = {}; }

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

    // ===== Build tolerant SPIRIT index =====
    // Allows queries like "espolon", "espolon blanco", "don julio", "fortaleza repo"
    const spiritIndex = makeSpiritIndex(spirits);

    function makeSpiritIndex(sp) {
      const idx = [];
      const spiritKeys = Object.keys(sp || {});
      for (const key of spiritKeys) {
        const item = sp[key] || {};
        const displayName = key; // key is the visible name in your JSON
        const nName = normalize(displayName);

        // Pull possible brand tokens from the name and item fields
        const altTokens = new Set();

        // tokens from the name without strength/variant words
        splitTokens(nName).forEach(t => altTokens.add(t));

        // include common fields that may contain brand words
        const brandy = [
          item.brand, item.distillery, item.distilleryBrand, item.brandIdentity,
          item.type, item.typeAndCategory, item.category
        ].filter(Boolean).join(' ');

        splitTokens(normalize(brandy)).forEach(t => altTokens.add(t));

        // include user-provided aliases (array of strings)
        asArray(item.aliases).forEach(a => splitTokens(normalize(a)).forEach(t => altTokens.add(t)));

        // remove generic stopwords
        const stops = new Set(['tequila','mezcal','raicilla','sotol','rum','vodka','gin','whiskey','whisky','blanco','reposado','repo','añejo','anejo','extra','cristalino','espadin','espadin','joven','silver','plata','gold']);
        const tokens = Array.from(altTokens).filter(t => t && !stops.has(t));

        idx.push({
          key,
          name: displayName,
          nName,
          tokens, // brand-ish tokens
          fullTokens: Array.from(altTokens), // includes type words too
        });
      }
      return idx;
    }

    function splitTokens(s) {
      return (s || '').split(' ').map(t => t.trim()).filter(Boolean);
    }

    function scoreSpiritMatch(qText) {
      const nQ = normalize(qText);
      const qTokens = splitTokens(nQ);
      const results = [];

      // Fast path: exact or contains in display name
      for (const entry of spiritIndex) {
        if (entry.nName === nQ || entry.nName.includes(nQ) || nQ.includes(entry.nName)) {
          results.push({ key: entry.key, score: 100 });
        }
      }
      if (results.length) {
        results.sort((a,b) => b.score - a.score);
        return results[0].key;
      }

      // Token overlap scoring:
      for (const entry of spiritIndex) {
        // overlap on brand-ish tokens
        const overlap = qTokens.filter(t => entry.tokens.includes(t)).length;

        // bonus for type/variant words matching in fullTokens
        const variantHits = qTokens.filter(t => entry.fullTokens.includes(t) && /^(blanco|reposado|repo|añejo|anejo|cristalino|joven|silver|plata)$/.test(t)).length;

        // small bonus if query is a substring of the display name words
        const substrBonus = entry.nName.includes(nQ) ? 1 : 0;

        const score = overlap * 10 + variantHits * 4 + substrBonus;
        if (score > 0) results.push({ key: entry.key, score });
      }

      if (!results.length) return null;
      results.sort((a,b) => b.score - a.score);
      // require a small threshold to avoid wild matches
      return results[0].score >= 8 ? results[0].key : null;
    }

    // ===== Basic cocktail matching (kept as before) =====
    const keysCocktails = Object.keys(cocktails || {});
    const qNorm = normalize(q);
    const findBestCocktailKey = () => {
      let found = keysCocktails.find(k => qNorm.includes(normalize(k)));
      if (found) return found;
      found = keysCocktails.find(k => normalize(k).includes(qNorm));
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

      // Offer quiz follow-up after the single build
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

    // Spirits formatting:
    // - First line: NAME (bold, accent) (price)
    // - Then each data point one bullet per line
    function formatSpirit(name, item) {
      const bubbleLines = [];

      // Preferred ordering when available
      const fieldsOrder = [
        ['type', 'Type & Category'],
        ['category', 'Category'],
        ['agave', 'Agave Variety / Base Ingredient'],
        ['base', 'Base Ingredient'],
        ['region', 'Region & Distillery'],
        ['distillery', 'Distillery'],
        ['tastingNotes', 'Tasting Notes'],
        ['productionNotes', 'Production Notes'],
        ['brandIdentity', 'Distillery / Brand Identity'],
        ['funFact', 'Guest Talking Point / Fun Fact'],
        ['reviews', 'Reviews'],
        // commons in your pasted data:
        ['typeAndCategory', 'Type & Category'],
        ['agaveVariety', 'Agave Variety / Base Ingredient'],
        ['regionAndDistillery', 'Region & Distillery'],
        ['guestTalkingPoint', 'Guest Talking Point / Fun Fact']
      ];

      const lowerMap = {};
      Object.keys(item || {}).forEach(k => { lowerMap[k.toLowerCase()] = item[k]; });

      for (const [key, label] of fieldsOrder) {
        const val =
          lowerMap[key] ??
          lowerMap[String(key).toLowerCase()] ??
          null;
        if (val) {
          const text = Array.isArray(val) ? val.join('; ') : String(val);
          bubbleLines.push(`${label}: ${text}`);
        }
      }

      // Include any additional fields that weren't listed, except price/aliases
      const covered = new Set(fieldsOrder.map(([k]) => String(k).toLowerCase()).concat(['price','aliases']));
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

    // ===== Direct match: cocktail or spirit =====
    let matchedCocktailKey = findBestCocktailKey();
    let matchedSpiritKey = matchedCocktailKey ? null : scoreSpiritMatch(q);

    // ===== Follow-ups / memory-driven branches =====
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

    // ===== If we matched a spirit =====
    if (matchedSpiritKey) {
      const item = spirits[matchedSpiritKey] || {};
      const bubbles = formatSpirit(matchedSpiritKey, item);

      // update memory
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

        sess.lastItemName = matchedCocktailKey;
        sess.lastItemType = 'cocktail';
        sess.lastMode = 'guest';
        sess.askedSingle = false;
        state.set(sessionKey, sess);
      }

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ===== Nothing matched: LLM fallback with both JSONs for context =====
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
  Then one bullet per line for each data point available. Prefer labels in this order when the data exists:
    Type & Category
    Agave Variety / Base Ingredient
    Region & Distillery
    Tasting Notes
    Production Notes
    Distillery / Brand Identity
    Guest Talking Point / Fun Fact
    Reviews
  If keys differ, map them sensibly and still output one bullet per line.

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
    An upsell/pairing recommendation. You may include a <br> for a happy-hour line.

- For spirits, use the same single-bubble format as staff:
  <span class="accent-teal">NAME</span> (PRICE)
  • one bullet per line for each data point as described.

Do NOT reveal detailed build/spec lines in guest mode.
No markdown. Use HTML only.`.trim();

    const systemPrompt = `
You have two structured JSON knowledge bases:

COCKTAILS:
${process.env.COCKTAILS_JSON || "{}"}

SPIRITS:
${process.env.SPIRITS_JSON || "{}"}

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
      // ignore; handled below
    }

    if (llmBubbles && llmBubbles.length) {
      // best-effort: update memory if the LLM clearly referenced a cocktail or spirit name
      const allSpiritKeys = Object.keys(spirits || {});
      const allCocktailKeys = Object.keys(cocktails || {});
      const allKeys = [...allCocktailKeys, ...allSpiritKeys];
      const hit = allKeys.find(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(llmBubbles.join(' ')));
      if (hit) {
        sess.lastItemName = hit;
        sess.lastItemType = allCocktailKeys.includes(hit) ? 'cocktail' : 'spirit';
        sess.lastMode = mode;
        if (mode === 'staff' && sess.lastItemType === 'cocktail') {
          sess.askedSingle = true;
        } else {
          sess.askedSingle = false;
        }
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
