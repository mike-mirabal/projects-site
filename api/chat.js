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
    const toBullets = (arr) => (arr || []).map(x => `• ${x}`);
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');
    const priceLine = (price) => price ? `(${price})` : '';

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
      if (item.glass) choices.push(`Quick check: what’s the glass for **${name}**?`);
      if (item.garnish) choices.push(`Pop quiz: name one garnish on **${name}**.`);
      if (Array.isArray(item.build?.singleBuild) && item.build.singleBuild.length) {
        choices.push(`Recall: what’s the first ingredient in **${name}**?`);
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        choices.push(`Recall: name two ingredients in **${name}**.`);
      }
      if (!choices.length) choices.push(`Want a quick flashcard on **${name}**?`);
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // Format bubbles for STAFF vs GUEST from a structured menu item
    function bubblesForItem(name, item, mode) {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      // Prefer batch or singleBuild arrays if present; else fall back to `ingredients`
      const singleBuild =
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
        Array.isArray(item.recipe) ? item.recipe : null;

      const batchBuild =
        Array.isArray(item.build?.batchBuild) ? item.build.batchBuild : null;

      const glass = item.glass ? `Glass: ${item.glass}` : null;
      const garnish = item.garnish ? `Garnish: ${stringifyGarnish(item.garnish)}` : null;

      if (mode === 'staff') {
        // STAFF: one thing per line, bullets for build; if batch exists, show only batch; else single; else ingredients
        let firstBlock = [`**${name}** ${priceLine(item.price)}`.trim()];
        if (batchBuild && batchBuild.length) {
          firstBlock = firstBlock.concat(toBullets(batchBuild));
        } else if (singleBuild && singleBuild.length) {
          firstBlock = firstBlock.concat(toBullets(singleBuild));
        } else if (ingredients && ingredients.length) {
          firstBlock = firstBlock.concat(toBullets(ingredients));
        }
        if (glass) firstBlock.push(glass);
        if (garnish) firstBlock.push(garnish);

        // Quiz bubble second
        const quiz = quizFor(name, item);
        return [firstBlock.join('\n'), quiz];
      } else {
        // GUEST: Name + Price, blank line, crafted description, blank line, Ingredients list, upsell
        const top = `**${name}** ${priceLine(item.price)}`.trim();
        const desc = characterToLine(item.character) ||
                     (ingredients && ingredients.length
                        ? `Bright, balanced, and easy to love.`
                        : `A house favorite with great balance.`);
        const ing = (ingredients && ingredients.length)
          ? `Ingredients: ${ingredients.join(', ')}`
          : null;
        const upsell = upsellFor(name);

        const block = [top, '', desc, '', ing].filter(Boolean).join('\n');
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
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // Otherwise, fall back to the LLM with the menu JSON as context
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).
- When a cocktail name is given, output ONLY two chat bubbles:
  Bubble 1:
    **NAME** (in bold ALL CAPS is NOT required, bold is enough)
    Then each line on its own line, starting with "• " for each ingredient/line of the build.
    Use ONLY the batch build if available; if not, use the single recipe.
    After the bullets, include:
    Glass: ...
    Garnish: ...
  Bubble 2:
    A single quiz prompt related to that cocktail (glass, garnish, first ingredient, etc.).

Formatting:
- One item per line. Use "• " bullets for build lines.
- Do not print the entire knowledge JSON.
- Keep it concise and scannable.

Example:
**HIGHLAND PICNIC** ($15)
• 3 oz Highland Batch
• 0.5 oz Lime Juice
• 0.5 oz Yuzu Juice
• 1 oz Egg White
Glass: Coupe
Garnish: Orange Chip, Hibiscus Salt
`;

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).
Return ONLY two chat bubbles:
  Bubble 1:
    **Name** (bold) with price in parentheses on the same line.
    Then a blank line.
    Then a SHORT enticing description crafted from tasting notes/character (one sentence).
    Then a blank line.
    Then "Ingredients: ..." with a concise comma-separated list.
  Bubble 2:
    An upsell/pairing recommendation (e.g., tacos + happy hour note).

Rules:
- Do NOT reveal detailed build/spec lines in guest mode.
- Keep it crisp and sales-forward.
`;

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like ingredients, build.batchBuild, build.singleBuild, glass, garnish, character, price.

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

NEVER include the entire JSON. Output JSON only if asked; otherwise return plain text. If you choose to return JSON, it must be: { "bubbles": ["...","..."] }.

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
        model: 'gpt-4o-mini',
        temperature: 0.2,
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
