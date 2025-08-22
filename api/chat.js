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
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');
    const priceLine = (price) => price ? ` (${price})` : '';

    const esc = (str) =>
      String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Turns "Sweet, Smoky, Creamy, Tart" -> sentence for guest mode
    function characterToSentence(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd‑pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${String(last).toLowerCase()} finish.`;
    }

    // Simple upsell line (customize per cocktail if you like)
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

    // Build a quiz bubble for staff (plain text)
    function quizFor(name, item) {
      const choices = [];
      if (item.glass) choices.push(`Quick check: what’s the glass for ${name}?`);
      if (item.garnish) choices.push(`Pop quiz: name one garnish on ${name}.`);
      const single = Array.isArray(item.build?.singleBuild) ? item.build.singleBuild
                    : Array.isArray(item.recipe) ? item.recipe
                    : Array.isArray(item.build) ? item.build
                    : null;
      if (Array.isArray(single) && single.length) {
        choices.push(`Recall: what’s the first ingredient in ${name}?`);
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        choices.push(`Recall: name two ingredients in ${name}.`);
      }
      if (!choices.length) choices.push(`Want a quick flashcard on ${name}?`);
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // ---------- HTML formatters ----------
    function formatStaffHTML(name, item) {
      // Prefer batch build; support top-level batchBuild or build.batchBuild
      const batch = Array.isArray(item.batchBuild) ? item.batchBuild
                   : Array.isArray(item.build?.batchBuild) ? item.build.batchBuild
                   : null;
      // Fallback to single (support build.singleBuild, recipe, or build array)
      const single = Array.isArray(item.build?.singleBuild) ? item.build.singleBuild
                    : Array.isArray(item.recipe) ? item.recipe
                    : Array.isArray(item.build) ? item.build
                    : null;
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      const lines = (batch && batch.length) ? batch
                  : (single && single.length) ? single
                  : (ingredients || []);

      const glass = item.glass ? `<div><strong>Glass:</strong> ${esc(item.glass)}</div>` : '';
      const garnish = item.garnish ? `<div><strong>Garnish:</strong> ${esc(stringifyGarnish(item.garnish))}</div>` : '';

      return `
<div class="gd-item">
  <div class="gd-title"><span class="accent-teal"><strong>${esc(name)}</strong></span>${priceLine(item.price)}</div>
  ${lines && lines.length ? `<ul class="gd-bullets">${lines.map(li => `<li>${esc(li)}</li>`).join('')}</ul>` : ''}
  ${glass}${garnish}
</div>`.trim();
    }

    function formatGuestHTML(name, item) {
      const price = priceLine(item.price);
      const desc = characterToSentence(item.character) ||
                   (Array.isArray(item.ingredients) && item.ingredients.length
                      ? `Bright, balanced, and easy to love.`
                      : `A house favorite with great balance.`);
      const ing = (Array.isArray(item.ingredients) && item.ingredients.length)
        ? `Ingredients: ${esc(item.ingredients.join(', '))}` : '';

      return `
<div class="gd-item">
  <div class="gd-title"><span class="accent-teal"><strong>${esc(name)}</strong></span>${price}</div>
  <div class="gd-desc" style="margin-top:.25rem;">${esc(desc)}</div>
  ${ing ? `<div class="gd-ings" style="margin-top:.4rem;">${ing}</div>` : ``}
</div>`.trim();
    }

    // ---------- Build bubbles for menu item ----------
    function bubblesForItem(name, item, mode) {
      if (mode === 'staff') {
        const html = formatStaffHTML(name, item);
        const follow = `Do you want to see the single cocktail build without batch?`;
        return [html, esc(follow)];
      } else {
        const html = formatGuestHTML(name, item);
        const upsell = upsellFor(name);
        return [html, esc(upsell)];
      }
    }

    // ---------- Exact match from MENU_JSON ----------
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalize(k))) ||
      keys.find((k) => normalize(k).includes(q));

    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      // Return HTML bubbles
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // ---------- LLM fallback (ask model to return HTML bubbles) ----------
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).
When a cocktail name is given, return ONLY two chat bubbles as HTML (not markdown):
Bubble 1 (HTML):
  - Title line: <div class="gd-title"><span class="accent-teal"><strong>NAME</strong></span> (PRICE)</div>
  - Then an unordered list <ul class="gd-bullets"> with one <li> per line of the build.
    • Use ONLY the BATCH build if available; if not, use the SINGLE recipe.
  - After the list, add:
    <div><strong>Glass:</strong> ...</div>
    <div><strong>Garnish:</strong> ...</div>
Bubble 2 (plain text):
  "Do you want to see the single cocktail build without batch?"

Formatting rules:
- Return HTML (no markdown). Use <ul><li> for bullets.
- Keep it concise and scannable.
`.trim();

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).
Return ONLY two chat bubbles:
Bubble 1 (HTML):
  - Title line: <div class="gd-title"><span class="accent-teal"><strong>Name</strong></span> (PRICE)</div>
  - Blank line (or spacing via separate <div>).
  - One short enticing description crafted from tasting notes/character (one sentence) inside a <div>.
  - Blank line.
  - Then "Ingredients: ..." inside a <div>, concise comma-separated list.
Bubble 2 (plain text):
  - An upsell/pairing recommendation (e.g., tacos + happy hour note).

Rules:
- Do NOT reveal detailed build/spec lines in guest mode.
- Return HTML (no markdown) for bubble 1.
`.trim();

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like ingredients, build.batchBuild, build.singleBuild, glass, garnish, character, price.

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

IMPORTANT OUTPUT CONTRACT:
- Return a JSON object: { "bubbles": [ "<html for bubble 1>", "plain text for bubble 2" ] }
- Bubble 1 must be HTML (no markdown). Bubble 2 is short plain text.
- NEVER include the entire knowledge JSON.

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
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.bubbles)) {
          bubbles = parsed.bubbles.slice(0, 2);
        }
      }
      if (!bubbles) {
        // If the model returned plain text, split into up to 2 bubbles by double newlines
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
