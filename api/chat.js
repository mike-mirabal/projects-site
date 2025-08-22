// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { query, mode = 'guest' } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    // Load & parse menu JSON
    let menu = {};
    try { menu = JSON.parse(process.env.MENU_JSON || '{}'); } catch { menu = {}; }

    const q = String(query).toLowerCase();
    const normalize = s => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const keys = Object.keys(menu);

    let matchKey =
      keys.find(k => q.includes(normalize(k))) ||
      keys.find(k => normalize(k).includes(q));

    // Helper: format bubbles for staff vs guest
    const bubblesForItem = (name, item, mode) => {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;
      const buildArr = Array.isArray(item.build) ? item.build :
                       Array.isArray(item.build?.singleBuild) ? item.build.singleBuild :
                       Array.isArray(item.recipe) ? item.recipe : null;

      if (mode === 'staff') {
        const lines = [
          `**${name}**`,
          ...(buildArr ? buildArr.map(x => `• ${x}`) : (ingredients || []).map(x => `• ${x}`)),
          item.glass ? `Glass: ${item.glass}` : null,
          item.garnish ? `Garnish: ${Array.isArray(item.garnish) ? item.garnish.join(', ') : item.garnish}` : null
        ].filter(Boolean);

        const follow = `Would you like to know more about this cocktail or its ingredients?`;
        return [lines.join('\n'), follow];
      } else {
        // guest: no detailed specs; keep to menu/ordering info
        const lines = [
          `**${name}**`,
          ingredients && ingredients.length ? `Ingredients: ${ingredients.join(', ')}` : null,
          item.price ? `Price: ${item.price}` : null,
          item.glass ? `Glass: ${item.glass}` : null,
          item.garnish ? `Garnish: ${Array.isArray(item.garnish) ? item.garnish.join(', ') : item.garnish}` : null,
          item.character ? `Character: ${item.character}` : null,
        ].filter(Boolean);

        const follow = `Want to see similar drinks or check allergens?`;
        return [lines.join('\n'), follow];
      }
    };

    if (matchKey) {
      const item = menu[matchKey] || {};
      return res.status(200).json({ bubbles: bubblesForItem(matchKey, item, mode) });
    }

    // LLM fallback (mode-aware)
    const systemPrompt = `
You are Ghost Donkey Trainer.
Respond as ${mode === 'staff' ? 'STAFF mode (training)' : 'GUEST mode (menu/ordering)'} with 1–2 short chat bubbles, returned as JSON: { "bubbles": [ ... ] }.

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
      return res.status(500).json({ error: 'OpenAI error', status: r.status, detail: text.slice(0, 400) });
    }

    const data = await r.json();
    let bubbles;
    try {
      const content = data?.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.bubbles)) bubbles = parsed.bubbles;
      }
    } catch {}
    if (!bubbles) {
      // Safe fallback: a single message
      bubbles = [ (data?.choices?.[0]?.message?.content || 'No answer.').trim() ];
    }

    return res.status(200).json({ bubbles });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
