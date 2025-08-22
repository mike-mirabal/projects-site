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

    // ---------- Utils ----------
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const keys = Object.keys(menu || {});
    const priceLine = (price) => price ? `(${price})` : '';

    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');

    // Escape for HTML safety
    const esc = (s) => String(s ?? '')
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Find a cocktail key mentioned in free text
    function findKeyInText(text) {
      const t = String(text || '').toLowerCase();
      return (
        keys.find(k => t.includes(normalize(k))) ||
        keys.find(k => normalize(k).includes(t))
      ) || null;
    }

    // Fuzzy match against keys
    let matchKey =
      keys.find(k => q.includes(normalize(k))) ||
      keys.find(k => normalize(k).includes(q));

    // Render STAFF build (HTML)
    function renderStaffHTML(name, price, lines, glass, garnish) {
      const title = `
        <div class="build-title">
          <span class="accent-teal"><strong>${esc(name)}</strong></span>
          ${price ? ` <span class="price">${esc(price)}</span>` : ''}
        </div>`;
      const list = Array.isArray(lines) && lines.length
        ? `<ul class="build-list">${lines.map(li => `<li>${esc(li)}</li>`).join('')}</ul>`
        : '';
      const glassLine   = glass   ? `<div>Glass: ${esc(glass)}</div>` : '';
      const garnishLine = garnish ? `<div>Garnish: ${esc(garnish)}</div>` : '';
      return `${title}${list}${glassLine}${garnishLine}`;
    }

    // Create STAFF/Guest bubbles from a structured item
    function bubblesForItem(name, item, mode, opts = {}) {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      // The JSON you pasted sometimes uses `build` (single recipe) and/or `batchBuild`.
      // Also support nested structures if you introduce them later.
      const singleBuild =
        Array.isArray(item.singleBuild) ? item.singleBuild :
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
        Array.isArray(item.build) ? item.build : // your current JSON uses this for single recipe
        Array.isArray(item.recipe) ? item.recipe : null;

      const batchBuild =
        Array.isArray(item.batchBuild) ? item.batchBuild :
        Array.isArray(item.build?.batchBuild) ? item.build.batchBuild : null;

      const glass = item.glass || null;
      const garnish = stringifyGarnish(item.garnish);

      if (mode === 'staff') {
        // Show batch by default; if explicitly asking for single, show single.
        const wantSingle = !!opts.singleOnly;

        let chosenLines = null;
        if (!wantSingle && batchBuild && batchBuild.length) {
          chosenLines = batchBuild;
        } else if (singleBuild && singleBuild.length) {
          chosenLines = singleBuild;
        } else if (ingredients && ingredients.length) {
          chosenLines = ingredients;
        } else {
          chosenLines = [];
        }

        const html = renderStaffHTML(name, item.price, chosenLines, glass, garnish);
        const follow =
          wantSingle
            ? `Need anything else about <span class="accent-teal"><strong>${esc(name)}</strong></span>?`
            : `Do you want to see the single cocktail build without batch?`;

        return [html, follow];
      } else {
        // GUEST bubble: name + price, blank line, enticing one-liner, blank line, Ingredients
        const top = `
          <div class="guest-title">
            <span class="accent-teal"><strong>${esc(name)}</strong></span> ${esc(priceLine(item.price))}
          </div>`.trim();

        const description = (() => {
          const charStr = String(item.character || '').trim();
          if (!charStr) return `Balanced and easy to love — a house favorite.`;
          const parts = charStr.split(/[,•]/).map(s => s.trim()).filter(Boolean);
          if (!parts.length) return `Balanced and easy to love — a house favorite.`;
          if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd‑pleaser.`;
          const last = parts.pop();
          return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${String(last).toLowerCase()} finish.`;
        })();

        const ing = (ingredients && ingredients.length)
          ? `<div>Ingredients: ${esc(ingredients.join(', '))}</div>` : '';

        const bubble1 = [top, `<div style="height:6px"></div>`, `<div>${esc(description)}</div>`, `<div style="height:6px"></div>`, ing]
          .filter(Boolean).join('\n');

        // Upsell
        const upsell = (() => {
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
        })();

        return [bubble1, upsell];
      }
    }

    // ---------- STAFF: explicit quiz mode ----------
    const wantsQuiz = (mode === 'staff') && /\b(quiz|test|flashcard|drill)\b/i.test(q);

    if (wantsQuiz) {
      // If a cocktail name is present, quiz on that; else pick a random one.
      const nameForQuiz = findKeyInText(query) || (keys.length ? keys[Math.floor(Math.random() * keys.length)] : null);
      if (!nameForQuiz) {
        return res.status(200).json({
          bubbles: [
            `Sorry, I don’t have items to quiz yet. Add cocktails to the menu JSON first.`,
          ],
          answer: `Sorry, I don’t have items to quiz yet. Add cocktails to the menu JSON first.`
        });
      }
      const item = menu[nameForQuiz] || {};
      // Build quiz prompts based on available fields
      const prompts = [];
      if (item.glass) prompts.push(`Quick quiz: What’s the <strong>glass</strong> for <span class="accent-teal"><strong>${esc(nameForQuiz)}</strong></span>?`);
      if (item.garnish) prompts.push(`Pop quiz: Name one <strong>garnish</strong> on <span class="accent-teal"><strong>${esc(nameForQuiz)}</strong></span>.`);
      const firstSingle =
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild[0] :
        Array.isArray(item.build) ? item.build[0] :
        Array.isArray(item.recipe) ? item.recipe[0] : null;
      if (firstSingle) prompts.push(`Recall: What’s the <strong>first ingredient</strong> in <span class="accent-teal"><strong>${esc(nameForQuiz)}</strong></span>?`);
      if (!prompts.length) prompts.push(`Ready for a flashcard on <span class="accent-teal"><strong>${esc(nameForQuiz)}</strong></span>? What’s one ingredient?`);

      const question = prompts[Math.floor(Math.random() * prompts.length)];
      const helper = `Say “another quiz” for a new one, or ask for a cocktail by name.`;

      return res.status(200).json({
        bubbles: [question, helper],
        answer: `${question}\n\n${helper}`
      });
    }

    // ---------- STAFF: "single build" intent (stateless) ----------
    const wantsSingleOnly = (mode === 'staff') && /\b(single\s*(cocktail)?\s*(build)?|no\s*batch|without\s*batch)\b/i.test(q);
    if (wantsSingleOnly) {
      const keyFromText = findKeyInText(query);
      if (!keyFromText) {
        const guidance = `Tell me which cocktail: e.g., <em>“single build Highland Picnic”</em>.`;
        return res.status(200).json({
          bubbles: [guidance],
          answer: guidance
        });
      }
      const item = menu[keyFromText] || {};
      const bubbles = bubblesForItem(keyFromText, item, 'staff', { singleOnly: true });
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ---------- Direct match from JSON ----------
    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode, { singleOnly: false });
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // ---------- Fallback to LLM for general questions ----------
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).
When a cocktail name is given, output ONLY two chat bubbles:

Bubble 1 (HTML only — no markdown):
- Title line: "<span class='accent-teal'><strong>NAME</strong></span> (PRICE)" on a single line.
- Then a bulleted list (<ul><li>...</li></ul>) of the build with one ingredient per <li>.
- By default show ONLY the batch build (if available); if no batch exists, show the single recipe instead.
- After the list, show:
  - "Glass: ..."
  - "Garnish: ..."
Everything must be valid HTML. Do not use asterisks or markdown.

Bubble 2 (plain sentence):
- Ask: "Do you want to see the single cocktail build without batch?"

If the request is "single build [name]" or "without batch [name]" show Bubble 1 using only the single (non-batch) build, then Bubble 2: "Need anything else about NAME?"
Keep responses concise and scannable. Never dump the entire knowledge JSON.
`.trim();

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).
Return ONLY two chat bubbles, as HTML (no markdown):

Bubble 1:
- A title line: "<span class='accent-teal'><strong>Name</strong></span> (PRICE)"
- Blank spacer (e.g., <div style="height:6px"></div>)
- A SHORT enticing one-sentence description crafted from tasting notes/character.
- Blank spacer
- "Ingredients: ..." as a single line (no detailed build steps).

Bubble 2:
- A sales-forward upsell/pairing recommendation (e.g., tacos + happy hour).

Never reveal detailed build/spec in guest mode. Keep it crisp and sales-forward.
`.trim();

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like ingredients, batchBuild, build (single recipe), glass, garnish, character, price.

Follow the correct mode strictly:
${mode === 'staff' ? staffDirectives : guestDirectives}

NEVER include the entire JSON. If you output JSON, it must be: { "bubbles": ["...","..."] }.
HTML is preferred; do not output markdown.

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
      // Prefer an embedded JSON object if present
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.bubbles)) {
          bubbles = parsed.bubbles.slice(0, 2);
        }
      }
      if (!bubbles) {
        // If the model returned plain text/HTML, split into up to 2 bubbles by double newlines
        const plain = (data?.choices?.[0]?.message?.content || '').trim();
        const split = plain ? plain.split(/\n\s*\n/).slice(0, 2) : null;
        bubbles = (split && split.length) ? split : null;
      }
    } catch {
      bubbles = null;
    }

    if (!bubbles) {
      const fallback = `Sorry, I don't have this answer yet. I'm still learning...`;
      return res.status(200).json({ bubbles: [fallback], answer: fallback });
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n')
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
