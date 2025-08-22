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

    // Try to find a direct cocktail match from the MENU_JSON
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalize(k))) ||
      keys.find((k) => normalize(k).includes(q));

    // Helper to format response bubbles for staff vs guest
    const bubblesForItem = (name, item, mode) => {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      // Support either `build` (array) or nested objects with arrays, or `recipe`
      const buildArr =
        Array.isArray(item.build) ? item.build :
        Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
        Array.isArray(item.recipe) ? item.recipe : null;

      const glass = item.glass ? `Glass: ${item.glass}` : null;
      const garnish = item.garnish
        ? `Garnish: ${Array.isArray(item.garnish) ? item.garnish.join(', ') : item.garnish}`
        : null;

      if (mode === 'staff') {
        const lines = [
          `**${name}**`,
          ...(buildArr ? buildArr.map(x => `• ${x}`) : (ingredients || []).map(x => `• ${x}`)),
          glass,
          garnish
        ].filter(Boolean);

        const follow = `Would you like to know more about this cocktail or its ingredients?`;
        return [lines.join('\n'), follow];
      } else {
        // guest mode: keep things high-level (no detailed build/spec)
        const lines = [
          `**${name}**`,
          ingredients && ingredients.length ? `Ingredients: ${ingredients.join(', ')}` : null,
          item.price ? `Price: ${item.price}` : null,
          glass,
          garnish,
          item.character ? `Character: ${item.character}` : null
        ].filter(Boolean);

        const follow = `Want to see similar drinks or check allergens?`;
        return [lines.join('\n'), follow];
      }
    };

    // If we found a menu match, return formatted bubbles immediately
    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      return res.status(200).json({
        bubbles,
        // Keep backwards compatibility with your current frontend:
        answer: bubbles.join('\n\n')
      });
    }

    // Otherwise, fall back to the LLM with the menu JSON as context
    const systemPrompt = `
You are Ghost Donkey Trainer.
Respond in ${mode === 'staff' ? 'STAFF mode (training)' : 'GUEST mode (menu/ordering)'} with 1–2 short chat bubbles, returned as JSON: { "bubbles": [ ... ] }.

Formatting rules:
- Bubble 1 (always):
  - **Cocktail Name**
  - If STAFF mode: bullet lines starting with "• " for build/spec or ingredients; include "Glass: ..." and "Garnish: ...".
  - If GUEST mode: do NOT disclose detailed build/spec; give ingredients summary, Price, Glass, Garnish, Character if helpful.
- Bubble 2 (always):
  - STAFF: "Would you like to know more about this cocktail or its ingredients?"
  - GUEST: "Want to see similar drinks or check allergens?"

Other rules:
- Keep responses brief and operational.
- NEVER print the full knowledge base JSON verbatim.
- If info is missing, say so briefly and suggest checking the spec sheet.

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
          bubbles = parsed.bubbles.slice(0, 2); // keep it tight
        }
      }
      if (!bubbles) {
        // As a fallback, just use the raw content
        const fallback = content.trim() || 'No answer.';
        bubbles = [fallback];
      }
    } catch {
      const fallback = (data?.choices?.[0]?.message?.content || 'No answer.').trim();
      bubbles = [fallback];
    }

    return res.status(200).json({
      bubbles,
      // Back-compat for current UI
      answer: bubbles.join('\n\n')
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
