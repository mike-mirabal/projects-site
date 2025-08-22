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

    // Utils
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');
    const priceLine = (price) => price ? `(${price})` : '';

    // Make guest-facing one-liner from "character"
    function characterToLine(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${last.toLowerCase()} finish.`;
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
        return `Try it with our churro bites for a dessert-worthy combo.`;
      }
      // default
      return `This would go great with our chicken tinga tacos — $2.75 each on happy hour until 8pm!`;
    }

    // Build a quiz bubble for staff
    function quizFor(name, item) {
      const choices = [];
      if (item.glass) choices.push(`Quick check: what’s the glass for <strong>${name}</strong>?`);
      if (item.garnish) choices.push(`Pop quiz: name one garnish on <strong>${name}</strong>.`);
      if (Array.isArray(item.build?.singleBuild) && item.build.singleBuild.length) {
        choices.push(`Recall: what’s the first ingredient in <strong>${name}</strong>?`);
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        choices.push(`Recall: name two ingredients in <strong>${name}</strong>.`);
      }
      if (!choices.length) choices.push(`Want a quick flashcard on <strong>${name}</strong>?`);
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // Format bubbles for STAFF vs GUEST from a structured menu item (HTML-only)
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
        // STAFF: teal bold name, bullets each on its own line with <br>, then Glass/Garnish on their own lines.
        let html = `<span class="accent-teal"><strong>${name}</strong></span> ${priceLine(item.price)}<br>`;
        const lines = [];

        if (batchBuild && batchBuild.length) {
          batchBuild.forEach(x => lines.push(`• ${x}<br>`));
        } else if (singleBuild && singleBuild.length) {
          singleBuild.forEach(x => lines.push(`• ${x}<br>`));
        } else if (ingredients && ingredients.length) {
          ingredients.forEach(x => lines.push(`• ${x}<br>`));
        }

        html += lines.join('');
        if (glass)   html += `${glass}<br>`;
        if (garnish) html += `${garnish}`;

        const quiz = quizFor(name, item);
        return [html, quiz];
      } else {
        // GUEST: Name + Price, blank line, enticing description, blank line, Ingredients, upsell
        const top = `<strong>${name}</strong> ${priceLine(item.price)}`.trim();
        const desc = characterToLine(item.character) ||
                     (ingredients && ingredients.length
                        ? `Bright, balanced, and easy to love.`
                        : `A house favorite with great balance.`);
        const ing = (ingredients && ingredients.length)
          ? `Ingredients: ${ingredients.join(', ')}`
          : null;
        const upsell = upsellFor(name);

        const block = [top, '<br>', desc, '<br>', ing].filter(Boolean).join('<br>');
        return [block, upsell];
      }
    }

    // Try to find a direct cocktail match from the MENU_JSON
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalize(k))) ||
      keys.find((k) => normalize(k).includes(q));

    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      // Return HTML bubbles; keep answer for backward-compat if needed
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // ========================
    // LLM fallback (HTML only)
    // ========================

    const staffDirectives = `
You are Ghost Donkey Spirit Guide in STAFF mode.

OUTPUT FORMAT (HTML ONLY — never Markdown):
Return EXACTLY two chat bubbles as strings (we'll wrap them client-side).

Bubble 1 (recipe):
<span class="accent-teal"><strong>ITEM NAME</strong></span> (PRICE)<br>
• INGREDIENT/LINE 1<br>
• INGREDIENT/LINE 2<br>
• INGREDIENT/LINE 3<br>
Glass: GLASS TYPE<br>
Garnish: GARNISH DETAILS

Rules:
- Use HTML with <br> for line breaks; use <strong>…</strong> and the CSS class "accent-teal" for the item name.
- If a batch build exists, show ONLY the batch lines; otherwise show the single recipe lines. Do not print both unless the user explicitly asks.
- Every recipe line starts with "• " and ends with a <br>.
- After the bullets, always include "Glass: …" and "Garnish: …" each on its own line.
- No introductory or closing sentences in Bubble 1.

Bubble 2 (next step OR quiz):
- A short follow-up such as: "Learn more about this cocktail? Ingredients? Or something else?"
- If the user asked for a quiz or study/test, provide a short quiz question (glass, garnish, first ingredient, etc.) instead.

Keep things concise and scannable. Do NOT output the entire JSON.
`.trim();

    const guestDirectives = `
You are Ghost Donkey Spirit Guide in GUEST mode (sales/menus).

OUTPUT FORMAT (HTML ONLY — never Markdown):
Return EXACTLY two chat bubbles as strings.

Bubble 1 (menu/sales):
<strong>ITEM NAME</strong> (PRICE)<br>
<br>
ONE-SENTENCE ENTICING DESCRIPTION crafted from tasting notes/character (guest-facing, inviting).<br>
<br>
Ingredients: comma-separated concise list

Bubble 2 (upsell):
Concrete pairing recommendation and/or happy-hour nudge, e.g.:
"Pairs nicely with our chicken tinga tacos — just $2.75 each during happy hour until 8pm!"

Rules:
- Use HTML with <br> for line breaks; <strong>…</strong> for the name.
- Do NOT reveal detailed build/spec lines in guest mode.
- Keep both bubbles crisp, warm, and sales-forward.
`.trim();

    const systemPrompt = `
You have a structured JSON knowledge base with fields like:
- ingredients
- build.batchBuild
- build.singleBuild
- glass
- garnish
- character
- price

Follow the correct mode strictly and the formatting rules above.

CRITICAL:
- Output HTML only (no Markdown). Use <br> for line breaks.
- If you decide to return a JSON wrapper, it must be exactly: { "bubbles": ["...","..."] }
  where each string is the final HTML for that bubble.
- Otherwise, plain text output must still be HTML (with <br>), and we will split into bubbles client-side.

NEVER include the entire knowledge JSON or any debugging text.

Use the knowledge base only as internal reference:
${process.env.MENU_JSON || "{}"}
`.trim();

    // You are using GPT‑5 Mini here:
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
          { role: 'system', content: (mode === 'staff' ? staffDirectives : guestDirectives) + '\n\n' + systemPrompt },
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
          // Keep it tight to two bubbles
          bubbles = parsed.bubbles.slice(0, 2);
        }
      }
      if (!bubbles) {
        // If plain HTML came back, split into up to 2 by double newlines or a blank-line marker
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
