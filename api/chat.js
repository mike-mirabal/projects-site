// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ======= Incoming payload =======
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest'; // 'staff' | 'guest'

    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ======= Load knowledge from ENV (renamed) =======
    // Primary cocktails JSON (renamed from MENU_JSON -> COCKTAILS_JSON)
    let cocktails = {};
    try {
      cocktails = JSON.parse(process.env.COCKTAILS_JSON || '{}');
    } catch {
      cocktails = {};
    }

    // Optional spirits JSON (kept separate, if present)
    let spirits = {};
    try {
      spirits = JSON.parse(process.env.SPIRITS_JSON || '{}');
    } catch {
      spirits = {};
    }

    // ======= Utils =======
    const normalize = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, '')  // remove parenthetical variants
        .replace(/[^\p{L}\p{N}]+/gu, ' ') // strip punctuation to spaces
        .replace(/\s+/g, ' ')
        .trim();

    // HTML-safe encode (basic)
    const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

    // Build lines to HTML (no markdown)
    const toLines = (arr) => (arr || []).map(x => `<div>${esc(x)}</div>`).join('');

    // Price formatter (on same line as name for guest; separate line for staff per style)
    const priceText = (price) => price ? esc(price) : '';

    // Character / tasting notes → enticing one-liner
    function characterToSentence(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd‑pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${String(last).toLowerCase()} finish.`;
    }

    // Pairing / upsell
    function upsellFor(name) {
      const n = String(name || '').toLowerCase();
      if (n.includes('highland picnic')) {
        return `This would go great with our chicken tinga tacos.<br/>They’re only $2.75 each on happy hour til 8pm!`;
      }
      if (n.includes('margarita') || n.includes('paloma')) {
        return `Perfect with chips &amp; queso.<br/>Happy hour pricing til 8pm!`;
      }
      if (n.includes('carajillo') || n.includes('espresso')) {
        return `Pair it with our churro bites for a dessert‑worthy combo.`;
      }
      return `This would go great with our chicken tinga tacos.<br/>They’re only $2.75 each on happy hour til 8pm!`;
    }

    // Quiz builder (can use a provided item or pick random)
    function quizFor(name, item) {
      const prompts = [];
      if (item?.glass) prompts.push(`Quick check: what’s the glass for <strong>${esc(name)}</strong>?`);
      if (item?.garnish) prompts.push(`Pop quiz: name one garnish on <strong>${esc(name)}</strong>.`);
      const singleBuild = Array.isArray(item?.build) ? item.build : Array.isArray(item?.build?.singleBuild) ? item.build.singleBuild : null;
      const ingredients = Array.isArray(item?.ingredients) ? item.ingredients : null;
      if (singleBuild?.length) {
        prompts.push(`Recall: what’s the first ingredient in <strong>${esc(name)}</strong>?`);
      } else if (ingredients?.length) {
        prompts.push(`Recall: name two ingredients in <strong>${esc(name)}</strong>.`);
      }
      if (!prompts.length) prompts.push(`Want a quick flashcard on <strong>${esc(name)}</strong>?`);
      return prompts[Math.floor(Math.random() * prompts.length)];
    }

    // Find cocktail by fuzzy name
    function findCocktailByQuery(qstr) {
      const keys = Object.keys(cocktails || {});
      const qn = normalize(qstr);
      // exact include
      let matchKey =
        keys.find((k) => qn.includes(normalize(k))) ||
        keys.find((k) => normalize(k).includes(qn));
      if (matchKey) return matchKey;

      // token-based fuzzy (any token match of length >=3)
      const tokens = qn.split(' ').filter(t => t.length >= 3);
      const scored = keys
        .map(k => {
          const kn = normalize(k);
          const score = tokens.reduce((acc, t) => acc + (kn.includes(t) ? 1 : 0), 0);
          return { k, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored[0]?.k || null;
    }

    // ---------- STAFF HTML (batch first, then optional single) ----------
    function staffHTML(name, item, showBatch = true) {
      const price = priceText(item.price);
      const head = `<div class="line"><span class="name accent-teal"><strong>${esc(name)}</strong></span>${price ? ` <span class="price">${price}</span>` : ''}</div>`;

      // Prefer explicit batchBuild, then item.build (string array), else item.build.singleBuild if nested, else ingredients
      const batchBuild = Array.isArray(item.batchBuild) ? item.batchBuild
                        : Array.isArray(item.build?.batchBuild) ? item.build.batchBuild
                        : null;
      const singleBuild = Array.isArray(item.build) ? item.build
                        : Array.isArray(item.build?.singleBuild) ? item.build.singleBuild
                        : null;
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      let body = '';
      if (showBatch && batchBuild?.length) {
        body += toLines(batchBuild);
      } else if (!showBatch && singleBuild?.length) {
        body += toLines(singleBuild);
      } else if (singleBuild?.length) {
        // fallback to single if no batch exists
        body += toLines(singleBuild);
      } else if (ingredients?.length) {
        body += toLines(ingredients);
      }

      const glass = item.glass ? `<div>Glass: ${esc(item.glass)}</div>` : '';
      const garnish = item.garnish
        ? `<div>Garnish: ${esc(Array.isArray(item.garnish) ? item.garnish.join(', ') : item.garnish)}</div>`
        : '';

      return [head, body, glass, garnish].filter(Boolean).join('');
    }

    // ---------- GUEST HTML ----------
    function guestHTML(name, item) {
      const price = priceText(item.price);
      const title = `<div class="line"><span class="name accent-teal"><strong>${esc(name)}</strong></span>${price ? ` <span class="price">${price}</span>` : ''}</div>`;

      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;
      const desc = characterToSentence(item.character) ||
                   (ingredients?.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
      const descHTML = `<div>${esc(desc)}</div>`;
      const ingHTML = ingredients?.length ? `<div>Ingredients: ${esc(ingredients.join(', '))}</div>` : '';

      return [title, '<br/>', descHTML, '<br/>', ingHTML].filter(Boolean).join('');
    }

    // ---------- Response builders ----------
    function bubblesForCocktail(name, item, mode, intent = null) {
      if (mode === 'staff') {
        // default: batch build first
        const first = staffHTML(name, item, /*showBatch*/ intent === 'single' ? false : true);
        // Follow-up question as requested
        const follow = (intent === 'single')
          ? quizFor(name, item) // if they asked for single already, next is quiz
          : `Do you want to see the single cocktail build without batch?`;
        return [first, follow];
      } else {
        const first = guestHTML(name, item);
        const upsell = upsellFor(name);
        return [first, upsell];
      }
    }

    // Spirits lookup (simple)
    function spiritLookup(qstr) {
      // structure can be { "Tequila": ["Brand A", "Brand B"], "Mezcal": [...] } or object map of objects
      const qn = normalize(qstr);
      const out = [];

      for (const [group, data] of Object.entries(spirits || {})) {
        const groupNorm = normalize(group);
        if (qn.includes(groupNorm)) {
          // list names if array, or keys if object
          if (Array.isArray(data)) {
            out.push(`<div><strong>${esc(group)}</strong>: ${esc(data.join(', '))}</div>`);
          } else if (data && typeof data === 'object') {
            out.push(`<div><strong>${esc(group)}</strong>: ${esc(Object.keys(data).join(', '))}</div>`);
          }
        } else {
          // check inside children for a name match
          if (Array.isArray(data)) {
            for (const item of data) {
              if (normalize(item) && qn.includes(normalize(item))) {
                out.push(`<div><strong>${esc(item)}</strong> — in ${esc(group)}</div>`);
              }
            }
          } else if (data && typeof data === 'object') {
            for (const [spName] of Object.entries(data)) {
              if (qn.includes(normalize(spName))) {
                out.push(`<div><strong>${esc(spName)}</strong> — ${esc(group)}</div>`);
              }
            }
          }
        }
      }
      return out;
    }

    // ======= ROUTING LOGIC =======
    // 1) Direct cocktail match (by name in user query)
    const cocktailKey = findCocktailByQuery(q);
    if (cocktailKey) {
      const item = cocktails[cocktailKey] || {};
      // detect "single" intent in same query
      const wantsSingle = /\b(single|no\s*batch|without\s*batch)\b/i.test(query);
      const bubbles = bubblesForCocktail(cocktailKey, item, mode, wantsSingle ? 'single' : null);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // 2) If staff says "yes" (follow-up) but we don't know which drink, ask to specify
    if (mode === 'staff' && /\b(yes|yep|sure|ok|okay|show me|single)\b/i.test(query) && !cocktailKey) {
      const msg = `Which cocktail would you like the single build for? (e.g., "Highland Picnic")`;
      return res.status(200).json({ bubbles: [msg], answer: msg });
    }

    // 3) Ask for a quiz explicitly
    if (/\bquiz\b/i.test(q)) {
      // Try to base quiz on a mentioned cocktail name (if any)
      const keyForQuiz = findCocktailByQuery(q) || Object.keys(cocktails)[Math.floor(Math.random() * Math.max(1, Object.keys(cocktails).length))];
      const item = cocktails[keyForQuiz] || {};
      const prompt = keyForQuiz ? quizFor(keyForQuiz, item) : `Pop quiz: name two ingredients from any house cocktail.`;
      return res.status(200).json({ bubbles: [prompt], answer: prompt });
    }

    // 4) Spirits lookup
    const spiritHits = spiritLookup(q);
    if (spiritHits.length) {
      const txt = spiritHits.join('');
      return res.status(200).json({ bubbles: [txt], answer: txt });
    }

    // ======= LLM FALLBACK (last resort) =======
    // Provide the model with both datasets (cocktails + spirits) & strict formatting instructions.
    const staffDirectives = `
You are Spirit Guide (STAFF mode).
Return ONLY two HTML chat bubbles:
Bubble 1 (the recipe):
  <div class="line"><span class="name accent-teal"><strong>NAME</strong></span> <span class="price">(PRICE)</span></div>
  Then put EACH build line on its own line inside <div>...</div>, using the BATCH BUILD by default.
  If no batch exists, use the single recipe.
  After the build lines, include:
  <div>Glass: ...</div>
  <div>Garnish: ...</div>

Bubble 2 (follow-up):
  Exactly this question:
  Do you want to see the single cocktail build without batch?

FORMAT RULES:
- Output only HTML (no markdown).
- Never show bullets like "•"; each build step must be its own <div> row.
- Never dump the entire JSON knowledge base.
`.trim();

    const guestDirectives = `
You are Spirit Guide (GUEST mode).
Return ONLY two HTML chat bubbles:
Bubble 1:
  <div class="line"><span class="name accent-teal"><strong>Name</strong></span> <span class="price">(Price)</span></div>
  <br/>
  <div>Short enticing description (crafted from "character").</div>
  <br/>
  <div>Ingredients: A, B, C</div>

Bubble 2:
  An upsell/pairing recommendation (include happy hour mention if relevant).

FORMAT RULES:
- Output only HTML (no markdown).
- Do NOT reveal detailed build/spec lines in guest mode.
- Keep it concise and sales-forward.
`.trim();

    // System prompt with JSON snippets
    const systemPrompt = `
You have two structured JSON knowledge bases: cocktails and spirits.
Fields include: ingredients, batchBuild, build (aka single), glass, garnish, character, price.

Follow the correct mode strictly (STAFF vs GUEST).
Return only HTML bubbles (two strings).

${mode === 'staff' ? staffDirectives : guestDirectives}

COCKTAILS (internal reference only):
${process.env.COCKTAILS_JSON || "{}"}

SPIRITS (internal reference only):
${process.env.SPIRITS_JSON || "{}"}
`.trim();

    // Call OpenAI only if we truly have no deterministic match
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

      if (!r.ok) {
        // Graceful generic fallback (as requested)
        const msg = `Sorry, I don't have this answer yet. I'm still learning...`;
        return res.status(200).json({ bubbles: [msg], answer: msg });
      }

      const data = await r.json();
      // Try to capture a JSON object { "bubbles": ["...", "..."] } if the model returns one
      let bubbles = null;
      try {
        const content = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.bubbles)) {
            bubbles = parsed.bubbles.slice(0, 2);
          }
        }
        if (!bubbles) {
          // If plain text HTML, split by double newlines into up to 2 bubbles
          const plain = (data?.choices?.[0]?.message?.content || '').trim();
          const split = plain.split(/\n\s*\n/).slice(0, 2);
          bubbles = split.length ? split : [plain || `Sorry, I don't have this answer yet. I'm still learning...`];
        }
      } catch {
        bubbles = [`Sorry, I don't have this answer yet. I'm still learning...`];
      }

      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    } catch (err) {
      console.error('OpenAI error:', err);
      const msg = `Sorry, I don't have this answer yet. I'm still learning...`;
      return res.status(200).json({ bubbles: [msg], answer: msg });
    }
  } catch (e) {
    console.error('Server error:', e);
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
