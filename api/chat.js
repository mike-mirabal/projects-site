// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // -------- Input --------
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = (body.mode === 'staff') ? 'staff' : 'guest';

    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    // -------- Load MENU JSON from env (safe parse) --------
    let menu = {};
    try {
      menu = JSON.parse(process.env.MENU_JSON || '{}');
    } catch {
      menu = {};
    }

    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // -------- Utils --------
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const toBullets = (arr) => (arr || []).map(x => `• ${x}`);
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');
    const priceLine = (price) => price ? `(${price})` : '';

    // Turn "Character" into one-sentence, guest-facing description
    function characterToLine(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${last.toLowerCase()} finish.`;
    }

    // Simple upsell line
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
      return `This would go great with our chicken tinga tacos — $2.75 each on happy hour until 8pm!`;
    }

    // Staff follow-up (used when we show batch first)
    const singleFollowUp = `Do you want to see the single cocktail build without batch?`;

    // Quiz fallback if we didn’t show batch
    function quizFor(name, item) {
      const choices = [];
      if (item.glass) choices.push(`Quick check: what’s the glass for **${name}**?`);
      if (item.garnish) choices.push(`Pop quiz: name one garnish on **${name}**.`);
      if (Array.isArray(item.build) && item.build.length) {
        choices.push(`Recall: what’s the first ingredient in **${name}**?`);
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        choices.push(`Recall: name two ingredients in **${name}**.`);
      }
      if (!choices.length) choices.push(`Want a quick flashcard on **${name}**?`);
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // -------- Format bubbles for STAFF vs GUEST --------
    function bubblesForItem(name, item, mode) {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      // Support both shapes: top-level arrays or nested under build.*
      const batchBuild =
        Array.isArray(item.batchBuild) ? item.batchBuild :
        Array.isArray(item.build?.batchBuild) ? item.build.batchBuild : null;

      const singleBuild =
        Array.isArray(item.build) ? item.build :
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
        Array.isArray(item.recipe) ? item.recipe : null;

      const glass = item.glass ? `Glass: ${item.glass}` : null;
      const garnish = item.garnish ? `Garnish: ${stringifyGarnish(item.garnish)}` : null;

      if (mode === 'staff') {
        // STAFF: show BATCH by default (preserves quantities), else single, else ingredients.
        const header = `**${name}** ${priceLine(item.price)}`.trim();
        const lines = [header, ''];

        let showedBatch = false;

        if (batchBuild && batchBuild.length) {
          // Quantities are already present in your JSON lines—just bullet them.
          lines.push(...toBullets(batchBuild));
          showedBatch = true;
        } else if (singleBuild && singleBuild.length) {
          lines.push(...toBullets(singleBuild));
        } else if (ingredients && ingredients.length) {
          // Last-resort (no measures here, but this only happens if no build data exists)
          lines.push(...toBullets(ingredients));
        }

        if (glass) lines.push(glass);
        if (garnish) lines.push(garnish);

        const bubble1 = lines.join('\n').replace(/\n{3,}/g, '\n\n'); // tidy blank lines
        const bubble2 = showedBatch ? singleFollowUp : quizFor(name, item);
        return [bubble1, bubble2];
      }

      // GUEST: name + price, blank line, crafted description, blank line, Ingredients list, upsell
      const top = `**${name}** ${priceLine(item.price)}`.trim();
      const desc = characterToLine(item.character) ||
        (ingredients && ingredients.length ? `Bright, balanced, and easy to love.` : `A house favorite with great balance.`);
      const ing = (ingredients && ingredients.length) ? `Ingredients: ${ingredients.join(', ')}` : null;
      const upsell = upsellFor(name);

      const block = [top, '', desc, '', ing].filter(Boolean).join('\n');
      return [block, upsell];
    }

    // -------- Try direct cocktail match from MENU_JSON --------
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalize(k))) ||
      keys.find((k) => normalize(k).includes(q));

    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      return res.status(200).json({
        bubbles,
        // Back-compat for your UI path that still reads {answer}
        answer: bubbles.join('\n\n'),
      });
    }

    // -------- LLM fallback (mode-aware) --------
    // If no direct JSON match, ask the model to follow the same rules.
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).
When a cocktail name is given, produce TWO chat bubbles:

Bubble 1 (exact format):
- **NAME** (bold) with price in parentheses on the same line.
- Then a blank line.
- Then each build line on its own line, starting with "• ".
- Prefer the batch build (if it exists in the knowledge). If no batch exists, use the single recipe.
- After bullets, include:
  Glass: ...
  Garnish: ...

Bubble 2 (exact text when a batch exists):
"Do you want to see the single cocktail build without batch?"

If there is NO batch (only single recipe), still produce a second bubble with a short quiz prompt about that cocktail.

Formatting notes:
- One item per line. Use "• " bullets for build lines. Do NOT merge items into a single line.
- Do not print the entire knowledge JSON.
- Keep it concise and scannable.

Example:
**HIGHLAND PICNIC** ($15)

• 3 oz Highland Batch
• 0.5 oz Lime Juice
• 0.5 oz Yuzu Juice
• 1 oz Egg White
Glass: Coupe
Garnish: Half Orange Chip, Hibiscus Salt
`.trim();

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).
Return ONLY two chat bubbles:

Bubble 1:
- **Name** (bold) with price in parentheses on the same line.
- Then a blank line.
- Then ONE short, enticing description crafted from tasting notes/character.
- Then a blank line.
- Then "Ingredients: ..." with a concise comma-separated list (no measurements).

Bubble 2:
- A specific upsell/pairing recommendation (e.g., tacos + happy hour note).

Rules:
- Do NOT reveal detailed build/spec lines in guest mode.
- Keep it crisp and sales-forward.
`.trim();

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like:
- ingredients (array of names)
- build (array of single-cocktail build lines with quantities)
- batchBuild (array of batch build lines with quantities)
- glass, garnish, character, price

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

NEVER include the entire knowledge JSON in the output.
If you decide to return JSON, it must be exactly: { "bubbles": ["...","..."] }.

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
        temperature: 0.3,
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

    // -------- Parse model output into bubbles --------
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
      answer: bubbles.join('\n\n'),
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
