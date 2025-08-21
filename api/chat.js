// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    // Load & parse your menu data
    let menu = {};
    try { menu = JSON.parse(process.env.MENU_JSON || '{}'); } catch { menu = {}; }

    // Find a matching item by name (ignores things in parentheses like "(frozen)")
    const q = String(query).toLowerCase();
    const normalize = s => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const keys = Object.keys(menu);
    let matchKey =
      keys.find(k => q.includes(normalize(k))) ||
      keys.find(k => normalize(k).includes(q));

    if (matchKey) {
      const item = menu[matchKey] || {};
      // Prefer "build" array; fall back to "recipe" array/string
      const buildArr = Array.isArray(item.build) ? item.build :
                       Array.isArray(item.recipe) ? item.recipe :
                       (typeof item.recipe === 'string' ? [item.recipe] : []);

      // Bubble 1: formatted spec
      const lines = [
        `**${matchKey}**`,
        ...buildArr.map(x => `• ${x}`),
        item.glass ? `Glass: ${item.glass}` : null,
        item.garnish ? `Garnish: ${item.garnish}` : null
      ].filter(Boolean);

      // Bubble 2: follow‑up
      const follow = `Would you like to know more about this cocktail or its ingredients?`;

      return res.status(200).json({ bubbles: [lines.join('\n'), follow] });
    }

    // Fallback to LLM when we don't detect a direct match
    const systemPrompt = `
You are Ghost Donkey Trainer. You answer staff questions about the bar's menu with precise, current specs.
Always format cocktail answers like this:

**Cocktail Name**
- 1oz Ingredient
- 1oz Ingredient
- 1oz Ingredient
Glass: [type of glass]
Garnish: [list garnishes]

Then follow with a second short chat bubble:
"Would you like to know more about this cocktail or its ingredients?"

Keep responses brief. If the answer is long, split into multiple chat bubbles. 
If the user asks for options, present them in a bulleted list.
Knowledge base (for your internal reference):
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
    // Try to read a bubbles array if the model followed instructions
    const content = data?.choices?.[0]?.message?.content || '';
    // Basic parse attempt: expect something like a JSON code block or raw JSON
    let bubbles;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.bubbles)) bubbles = parsed.bubbles;
      }
    } catch {}
    // Fallback: treat content as one bubble + our standard follow-up
    if (!bubbles) {
      bubbles = [content.trim(), 'Would you like to know more about this cocktail or its ingredients?'];
    }

    return res.status(200).json({ bubbles });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
