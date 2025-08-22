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

    // Load menu JSON from env (safe parse)
    let menu = {};
    try {
      menu = JSON.parse(process.env.MENU_JSON || '{}');
    } catch {
      menu = {};
    }

    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ===== Utilities =====
    const normalizeKey = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const priceLine = (price) => price ? `(${price})` : '';
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');

    // HTML escape (for safety)
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Name + Price header (HTML)
    const namePriceHTML = (name, price) =>
      `<div><strong class="accent-teal">${esc(name)}</strong> ${price ? `<span>${esc(priceLine(price))}</span>` : ''}</div>`;

    // Build UL list (HTML)
    const listHTML = (arr) => `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;

    // Character → single descriptive sentence
    function characterToLine(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd‑pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${last.toLowerCase()} finish.`;
    }

    // Simple upsell
    function upsellFor(name) {
      const n = name.toLowerCase();
      if (n.includes('highland picnic')) {
        return `Pairs nicely with our chicken tinga tacos — just $2.75 each during happy hour until 8pm!`;
      }
      if (n.includes('margarita') || n.includes('paloma')) {
        return `Great with chips & queso — and don’t miss happy hour pricing until 8pm!`;
      }
      if (n.includes('carajillo') || n.includes('espresso')) {
        return `Try it with our churro bites for a dessert‑worthy combo.`;
      }
      return `This would go great with our chicken tinga tacos — $2.75 each on happy hour until 8pm!`;
    }

    // ===== Quantity enrichment =====
    // Detect amount at the start: "0.5 oz", "1 oz", "30 ml", "6 dashes", "1 barspoon", etc.
    const AMOUNT_RE = /^\s*([\d.]+)\s*(oz|oz\.|ml|dash(?:es)?|dashes|barspoon(?:s)?|tsp|tbsp)\b/i;

    // Strip amount/unit from a line and normalize the ingredient phrase
    function normalizeIngName(line) {
      // remove amount prefix if present
      let s = String(line);
      s = s.replace(AMOUNT_RE, '').trim();
      // strip parentheticals and extra punctuation
      s = s.replace(/\(.*?\)/g, '').replace(/[–—\-•]/g, ' ').replace(/\s+/g, ' ').trim();
      return s.toLowerCase();
    }

    // Build a map from singleBuild lines (with amounts) -> normalized name
    function buildAmountMap(singleBuildArr) {
      const map = new Map();
      (singleBuildArr || []).forEach(line => {
        if (AMOUNT_RE.test(line)) {
          const nameNorm = normalizeIngName(line);
          if (nameNorm) map.set(nameNorm, String(line)); // store the full line with amount
        }
      });
      return map;
    }

    // Given a target list (batch/ingredients), ensure each entry has an amount if we can infer it
    function ensureAmounts(targetList, singleAmountMap) {
      if (!Array.isArray(targetList) || !targetList.length) return targetList || [];
      if (!singleAmountMap || singleAmountMap.size === 0) return targetList;

      return targetList.map(line => {
        if (AMOUNT_RE.test(line)) return line; // already has an amount
        const nameNorm = normalizeIngName(line);
        const mapped = singleAmountMap.get(nameNorm);
        return mapped || line;
      });
    }

    function staffFollowUp() {
      return `Do you want to see the single cocktail build without batch?`;
    }

    // ===== Format bubbles from structured item =====
    function bubblesForItem(name, item, mode) {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      const singleBuild =
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
        Array.isArray(item.recipe) ? item.recipe : null;

      const batchBuild =
        Array.isArray(item.build?.batchBuild) ? item.build.batchBuild : null;

      const glass = item.glass ? `Glass: ${item.glass}` : null;
      const garnish = item.garnish ? `Garnish: ${stringifyGarnish(item.garnish)}` : null;

      if (mode === 'staff') {
        // Build a map of amounts from singleBuild so we can enrich batch/ingredients if needed
        const singleAmountMap = buildAmountMap(singleBuild);

        // Prefer BATCH → else SINGLE → else INGREDIENTS
        let baseList = [];
        if (batchBuild && batchBuild.length) {
          baseList = ensureAmounts(batchBuild, singleAmountMap);
        } else if (singleBuild && singleBuild.length) {
          baseList = singleBuild.slice(); // already has amounts
        } else if (ingredients && ingredients.length) {
          baseList = ensureAmounts(ingredients, singleAmountMap);
        }

        const metaLines = [glass, garnish]
          .filter(Boolean)
          .map(line => `<div>${esc(line)}</div>`).join('');

        const bubble1 =
          `${namePriceHTML(name, item.price)}${listHTML(baseList)}${metaLines}`;
        const bubble2 = staffFollowUp();

        return [bubble1, bubble2];
      } else {
        // Guest: name+price, blank line, enticing description, blank line, Ingredients
        const top = namePriceHTML(name, item.price);
        const desc = characterToLine(item.character) ||
                     (ingredients && ingredients.length
                        ? `Bright, balanced, and easy to love.`
                        : `A house favorite with great balance.`);
        const ing = (ingredients && ingredients.length)
          ? `Ingredients: ${ingredients.join(', ')}`
          : null;

        const block =
          `${top}<br><br>${esc(desc)}${ing ? `<br><br>${esc(ing)}` : ''}`;

        const upsell = upsellFor(name);
        return [block, esc(upsell)];
      }
    }

    // ===== Try a direct cocktail match =====
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalizeKey(k))) ||
      keys.find((k) => normalizeKey(k).includes(q));

    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n') // back‑compat
      });
    }

    // ===== LLM fallback (kept: gpt-5-mini) =====
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).
Return ONLY JSON with "bubbles": [HTML_STRING, HTML_STRING].
Bubble 1 must:
- Start with: <div><strong class="accent-teal">NAME</strong> (\\$PRICE)</div>
- Then an HTML <ul> with <li> one line per build ingredient </li>.
- Always PREFER the BATCH BUILD if it exists.
- If the batch line is missing quantities, infer them from the single-cocktail recipe where possible so lines read like "0.5 oz Agave (Monin)" instead of "Agave".
- After the list, add <div>Glass: ...</div> and <div>Garnish: ...</div> (if present).
Bubble 2 must be exactly:
- "Do you want to see the single cocktail build without batch?"
Do not add any extra commentary.`;

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).
Return ONLY JSON with "bubbles": [HTML_STRING, HTML_STRING].
Bubble 1:
- <div><strong class="accent-teal">Name</strong> (\\$PRICE)</div>
- <br><br>
- One enticing sentence describing the drink based on character/tasting notes.
- <br><br>
- "Ingredients: ..." (comma-separated) if available.
Bubble 2:
- A friendly upsell/pairing recommendation (e.g., tacos + happy hour).
No detailed build/spec lines in guest mode.`;

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like:
- ingredients
- build.batchBuild
- build.singleBuild
- glass
- garnish
- character
- price

Follow the correct mode strictly. Return ONLY JSON with "bubbles": [string, string], each string is HTML (no markdown).
If batch build items lack quantities, infer them from the single-cocktail recipe when possible so each bullet shows a quantity.

${mode === 'staff' ? staffDirectives : guestDirectives}

Knowledge base (internal reference only):
${process.env.MENU_JSON || "{}"}
`.trim();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',  // confirmed model
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

    // Extract { bubbles: [...] } (expects valid JSON)
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
        // Fallback: split plain text into up to 2 pieces
        const plain = (data?.choices?.[0]?.message?.content || 'No answer.').trim();
        const split = plain.split(/\n\s*\n/).slice(0, 2);
        bubbles = split.length ? split : [plain];
      }
    } catch {
      const fallback = (data?.choices?.[0]?.message?.content || 'No answer.').trim();
      bubbles = [fallback];
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n')
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
