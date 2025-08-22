// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest';

    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    // ===== Load JSON from env (now split across two env vars) =====
    let cocktails = {};
    let spirits = {};
    try {
      cocktails = JSON.parse(process.env.COCKTAILS_JSON || process.env.MENU_JSON || '{}'); // backward-compat
    } catch { cocktails = {}; }
    try {
      spirits = JSON.parse(process.env.SPIRITS_JSON || '{}');
    } catch { spirits = {}; }

    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ===== Utils =====
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const htmlEscape = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const joinIfArray = (val, sep = ', ') =>
      Array.isArray(val) ? val.join(sep) : (val || '');

    // Parse a build line like "0.5 oz Lime Juice" or "Top with Mineragua"
    const parseBuildLine = (line) => {
      const s = String(line || '').trim();
      // Extract qty + unit at the start if present
      const m = s.match(/^(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)\s*(oz|dash(?:es)?|barspoon|barspoons|tsp|tbsp|ml)\b\s*(.*)$/i);
      if (m) {
        return {
          qty: m[1],
          unit: m[2],
          ingredient: (m[3] || '').trim(),
          raw: s
        };
      }
      return {
        qty: '',
        unit: '',
        ingredient: s,
        raw: s
      };
    };

    const formatBuildBlockHTML = (lines = []) => {
      // Render as bullet-like lines with quantities preserved
      const rows = (lines || []).map((line) => {
        const { qty, unit, ingredient } = parseBuildLine(line);
        const left = qty && unit ? `${htmlEscape(qty)} ${htmlEscape(unit)}` : '';
        const right = htmlEscape(ingredient);
        // Use a leading bullet dot and a non-breaking space for neat alignment
        return `•&nbsp;${left ? `${left} ` : ''}${right}`;
      });
      return rows.join('<br>');
    };

    const priceText = (price) => price ? ` ${htmlEscape(price)}` : '';

    const spiritSummaryHTML = (name, sObj) => {
      // Guest-facing 3–6 sentence summary (concise)
      const price = sObj.price || sObj.cost || '';
      const type = sObj.type || sObj.category || sObj['Type & Category'] || '';
      const region = sObj.region || sObj['Region & Distillery'] || '';
      const base = sObj.base || sObj['Agave Variety / Base Ingredient'] || '';
      const notes = sObj.tasting || sObj['Tasting Notes'] || sObj.notes || '';
      const prod = sObj.production || sObj['Production Notes'] || '';
      const relevance = sObj.relevance || sObj['Relevance'] || '';
      const upsell = sObj.upsell || sObj['Upsell'] || '';

      const pieces = [];

      // Line 1: Name + price
      pieces.push(`<strong>${htmlEscape(name)}</strong>${price ? ` (${htmlEscape(price)})` : ''}`);

      // Then 3–6 tight sentences:
      const sentences = [];
      if (type || region) {
        sentences.push(`A ${htmlEscape(type || 'spirit')} from ${htmlEscape(region || 'Mexico')}.`);
      }
      if (base) {
        sentences.push(`Base: ${htmlEscape(base)}.`);
      }
      if (notes) {
        sentences.push(`Tasting: ${htmlEscape(notes)}.`);
      }
      if (prod) {
        sentences.push(`Production: ${htmlEscape(prod)}.`);
      }
      if (relevance) {
        sentences.push(`${htmlEscape(relevance)}`);
      }
      const summary = sentences.slice(0, 6).join(' ');

      pieces.push(summary);

      if (upsell) {
        pieces.push(htmlEscape(upsell));
      }

      return pieces.join('<br><br>');
    };

    // Turn "Character" into a one-sentence, guest-facing description
    function characterToLine(charStr) {
      if (!charStr) return null;
      // e.g., "Sweet, Smoky, Creamy, Tart" -> "Sweet and smoky with a creamy, tart finish."
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${last.toLowerCase()} finish.`;
    }

    // Salesy upsell line
    function upsellFor(name) {
      const n = name.toLowerCase();
      if (n.includes('highland picnic')) {
        return `This would go great with our chicken tinga tacos.<br>They’re only $2.75 each on happy hour till 8pm!`;
      }
      if (n.includes('margarita') || n.includes('paloma')) {
        return `Perfect with chips & queso.<br>Happy hour pricing till 8pm!`;
      }
      if (n.includes('carajillo') || n.includes('espresso')) {
        return `Try it with our churro bites — dessert-worthy combo.`;
      }
      return `This would go great with our chicken tinga tacos.<br>They’re only $2.75 each on happy hour till 8pm!`;
    }

    // Build a quiz bubble (generic, stateless)
    function genericQuizBubble() {
      const allCocktails = Object.keys(cocktails || {});
      const pick = allCocktails.length ? allCocktails[Math.floor(Math.random() * allCocktails.length)] : null;
      if (!pick) {
        return `Want a quick flashcard on a cocktail? Ask for any drink on the menu.`;
      }
      const item = cocktails[pick] || {};
      const prompts = [];
      if (item.glass) prompts.push(`Quick check: what’s the glass for <strong>${htmlEscape(pick)}</strong>?`);
      if (item.garnish) prompts.push(`Pop quiz: name one garnish on <strong>${htmlEscape(pick)}</strong>.`);
      if (Array.isArray(item.build) && item.build.length) {
        prompts.push(`Recall: what’s the first ingredient (with quantity) in <strong>${htmlEscape(pick)}</strong>?`);
      }
      if (!prompts.length) prompts.push(`Name two ingredients in <strong>${htmlEscape(pick)}</strong>.`);
      return prompts[Math.floor(Math.random() * prompts.length)];
    }

    // ===== Format Cocktail Bubbles (STAFF / GUEST) =====
    function bubblesForCocktail(name, item, mode) {
      const price = item.price || '';
      const build = Array.isArray(item.build) ? item.build : null;
      const batchBuild = Array.isArray(item.batchBuild) ? item.batchBuild : (
        Array.isArray(item.build?.batchBuild) ? item.build.batchBuild : null
      );
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      const glass = item.glass ? `Glass: ${htmlEscape(item.glass)}` : null;
      const garnishLine = item.garnish ? `Garnish: ${htmlEscape(joinIfArray(item.garnish))}` : null;

      if (mode === 'staff') {
        // STAFF default: show BATCH BUILD if available; otherwise single build; otherwise ingredients
        const title = `<strong>${htmlEscape(name)}</strong>${price ? ` ${htmlEscape(price)}` : ''}`;
        let specHTML = '';

        if (batchBuild && batchBuild.length) {
          specHTML = formatBuildBlockHTML(batchBuild);
        } else if (build && build.length) {
          specHTML = formatBuildBlockHTML(build);
        } else if (ingredients && ingredients.length) {
          // If no build arrays exist, at least list ingredients (not ideal for staff but a fallback)
          specHTML = ingredients.map(i => `•&nbsp;${htmlEscape(i)}`).join('<br>');
        } else {
          specHTML = '•&nbsp;Spec not found. Check the training sheet.';
        }

        const lines = [
          title,
          '', // blank line after headline
          specHTML,
          glass,
          garnishLine
        ].filter(Boolean);

        const follow = `Do you want to see the single cocktail build without batch?`;

        return [lines.join('<br>'), follow];
      }

      // GUEST mode
      const title = `<strong>${htmlEscape(name)}</strong>${price ? ` ${htmlEscape(price)}` : ''}`;
      const desc = characterToLine(item.character) ||
                   (ingredients && ingredients.length
                      ? `Bright, balanced, and easy to love.`
                      : `A house favorite with great balance.`);
      const ing = (ingredients && ingredients.length)
        ? `Ingredients: ${htmlEscape(ingredients.join(', '))}`
        : null;
      const upsell = upsellFor(name);

      const block = [title, '', htmlEscape(desc), '', ing].filter(Boolean).join('<br>');
      return [block, upsell];
    }

    // ===== Format Spirit Bubbles (guest-facing summary) =====
    function bubblesForSpirit(name, sObj, _mode) {
      // Spirits should always be guest-facing, concise sales-forward summary
      const summary = spiritSummaryHTML(name, sObj);
      // Optional quick pairing nudge if not already present
      const upsell = sObj.upsell
        ? htmlEscape(sObj.upsell)
        : `Want a pairing? Try it with our chicken tinga tacos — just $2.75 each on happy hour till 8pm!`;
      return [summary, upsell];
    }

    // ===== Lookups =====
    const cocktailKeys = Object.keys(cocktails || {});
    const spiritKeys = Object.keys(spirits || {});

    const findByName = (keys, data, needle) => {
      const direct =
        keys.find((k) => normalize(k) === normalize(needle)) ||
        keys.find((k) => normalize(needle).includes(normalize(k))) ||
        keys.find((k) => normalize(k).includes(normalize(needle)));
      return direct ? { key: direct, item: data[direct] } : null;
    };

    // Check for "single" intent inline (e.g., "Highland Picnic single", "single build for Mushroom Margarita")
    const wantsSingle = /\b(single|single build|without\s+batch)\b/i.test(query);

    // 1) Try cocktails
    let found = findByName(cocktailKeys, cocktails, q);
    if (!found) {
      // Try raw query (not lowercased) as well to catch exact-case keys
      found = findByName(cocktailKeys, cocktails, query);
    }
    if (found) {
      const { key, item } = found;

      if (mode === 'staff' && wantsSingle) {
        // Force SINGLE BUILD
        const price = item.price || '';
        const title = `<strong>${htmlEscape(key)}</strong>${price ? ` ${htmlEscape(price)}` : ''}`;
        const build = Array.isArray(item.build) ? item.build : [];
        const glass = item.glass ? `Glass: ${htmlEscape(item.glass)}` : null;
        const garnishLine = item.garnish ? `Garnish: ${htmlEscape(joinIfArray(item.garnish))}` : null;

        const specHTML = build.length
          ? formatBuildBlockHTML(build)
          : '•&nbsp;Single build not found.';

        const lines = [title, '', specHTML, glass, garnishLine].filter(Boolean);
        const follow = `Want a quick quiz for this cocktail?`;

        return res.status(200).json({
          bubbles: [lines.join('<br>'), follow],
          answer: [lines.join('<br>'), follow].join('\n\n')
        });
      }

      // Default formatting
      const bubbles = bubblesForCocktail(key, item, mode);

      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // 2) Try spirits
    let foundSpirit = findByName(spiritKeys, spirits, q) || findByName(spiritKeys, spirits, query);
    if (foundSpirit) {
      const { key, item } = foundSpirit;
      const bubbles = bubblesForSpirit(key, item, mode);
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // 3) Special keywords (stateless quiz)
    if (/\bquiz(es)?\b/i.test(q)) {
      const quiz = genericQuizBubble();
      return res.status(200).json({
        bubbles: [quiz],
        answer: quiz
      });
    }

    // ===== Otherwise, fall back to the LLM with both JSONs as context =====
    const staffDirectives = `
You are the Spirit Guide in STAFF mode.

When a cocktail name is given, output ONLY two chat bubbles as HTML (no markdown):
  Bubble 1 (HTML):
    <strong>NAME</strong> (price)
    (blank line)
    • qty unit Ingredient
    • qty unit Ingredient
    ...
    Glass: ...
    Garnish: ...
    - Always show the BATCH BUILD if available; if not, show the single build array. Preserve quantities/units exactly as in data.
    - Each bullet starts with "• " and each line is separated by <br>.
  Bubble 2 (HTML):
    "Do you want to see the single cocktail build without batch?"

If user asks for "single" or "without batch", show the single build (with quantities) in Bubble 1 and then in Bubble 2: "Want a quick quiz for this cocktail?"

General formatting rules:
- Return raw HTML in the "bubbles" array. Do not use markdown.
- Keep it concise and scannable.
- Never dump the entire JSON.
`.trim();

    const guestDirectives = `
You are the Spirit Guide in GUEST mode.

Return ONLY two chat bubbles as HTML (no markdown):
  Bubble 1 (HTML for cocktails):
    <strong>Name</strong> (price)
    (blank line)
    One enticing, guest-facing description based on "character" or tasting notes (one sentence).
    (blank line)
    Ingredients: ... (comma-separated)
  Bubble 2 (HTML for cocktails):
    A direct upsell/pairing recommendation (e.g., tacos + happy hour note), separated by <br> for two-line callout.

For spirits, provide a concise, guest-facing 3–6 sentence blurb with:
- Name and price (1 oz pour) on the first line (bold name)
- Type & region
- Base ingredient
- Key tasting notes
- Notable production details
- Optional upsell or pairing
- Use <br> between short paragraphs/sentences; keep HTML only, no markdown.

Rules:
- Do NOT reveal detailed build/spec lines in guest mode.
- Keep copy crisp and sales-forward.
- Return raw HTML strings in "bubbles".
`.trim();

    const systemPrompt = `
You have TWO structured JSON knowledge bases:

[COCKTAILS_JSON] — cocktails with fields like:
- ingredients (array)
- build (array of single-cocktail lines)
- batchBuild (array of batched lines) or build.batchBuild
- glass, garnish, character, price

[SPIRITS_JSON] — spirits with fields like:
- price, type/category, region/distillery, base ingredient, tasting notes, production notes, brand identity, fun fact, upsell

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

NEVER include the entire JSON. Return either:
- Plain HTML text, or
- { "bubbles": ["<div>...html...</div>", "<div>...html...</div>"] }

Knowledge bases (internal reference only, do not print verbatim):
COCKTAILS_JSON:
${process.env.COCKTAILS_JSON || process.env.MENU_JSON || "{}"}

SPIRITS_JSON:
${process.env.SPIRITS_JSON || "{}"}
`.trim();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ]
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        error: 'OpenAI error',
        status: r.status,
        detail: text.slice(0, 400)
      });
    }

    const data = await r.json();

    // Try to extract a JSON object with { bubbles: [...] } from the model output
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
        // If the model returned plain text, split into up to 2 bubbles by double newlines
        const plain = (data?.choices?.[0]?.message?.content || '').trim();
        if (plain) {
          const split = plain.split(/\n\s*\n/).slice(0, 2);
          bubbles = split.length ? split : [plain];
        }
      }
    } catch {
      // fall through
    }

    // Final fallback
    if (!bubbles || !bubbles.length) {
      bubbles = [`Sorry, I don't have this answer yet. I'm still learning...`];
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n')
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
