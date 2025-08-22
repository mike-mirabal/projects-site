// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const queryRaw = body.query;
    const mode = body.mode === 'staff' ? 'staff' : 'guest';

    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    // Load menu JSON safely
    let menu = {};
    try { menu = JSON.parse(process.env.MENU_JSON || '{}'); } catch { menu = {}; }

    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // Helpers
    const norm = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const uc = (s) => String(s || '').toUpperCase();

    // attempt to match a cocktail/spirits key in the menu JSON
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find(k => q.includes(norm(k))) ||
      keys.find(k => norm(k).includes(q));

    // Pick build arrays robustly
    const getBuildArrays = (item) => {
      // Support several shapes:
      // item.build.batchBuild (array)
      // item.build.singleBuild (array)
      // item.build (array)
      // item.recipe (array)
      const build = item.build || {};
      const batch = Array.isArray(build.batchBuild) ? build.batchBuild : null;
      const single = Array.isArray(build.singleBuild) ? build.singleBuild
                   : Array.isArray(item.recipe) ? item.recipe
                   : Array.isArray(item.build) ? item.build
                   : null;
      return { batch, single };
    };

    const lineIf = (label, val) => {
      if (!val) return null;
      const text = Array.isArray(val) ? val.join(', ') : String(val);
      return `**${label}:** ${text}`;
    };

    const detectRim = (garnish) => {
      // Try to isolate rim if present (e.g., "Citrus Salt Rim", "Sal De Gusano 1/2 Rim")
      if (!garnish) return { rim: null, rest: garnish };
      const g = Array.isArray(garnish) ? garnish.join(', ') : String(garnish);
      const rimMatch = g.match(/(^|,\s*)([^,]*rim[^,]*)/i);
      if (rimMatch) {
        const rimText = rimMatch[2].trim();
        const rest = g.replace(rimMatch[0], '').replace(/^,\s*|\s*,\s*$/g, '');
        return { rim: rimText, rest: rest || null };
      }
      return { rim: null, rest: g };
    };

    const bullets = (arr) => (arr || []).map(x => `• ${x}`);

    // ===== Local-formatting for a matched item =====
    const bubblesForItem = (name, item, mode) => {
      const price = item.price ? `$${String(item.price).replace(/^\$/, '')}` : null;
      const { batch, single } = getBuildArrays(item);
      const glass = item.glass || null;
      const garnish = item.garnish || null;
      const { rim, rest: garnishRest } = detectRim(garnish);
      const base = item.base || item.baseSpirit || null; // if you add base later

      if (mode === 'staff') {
        // STAFF rules:
        // - If batch exists: show batch only, then ask if they want single
        // - Else show single
        // - Emoji header + ALL CAPS bold name + price
        const header = `🌵 **${uc(name)}**${price ? ` (${price})` : ''}`;

        let bodyLines;
        let tailPrompt = null;

        if (Array.isArray(batch) && batch.length) {
          bodyLines = [
            ...batch, // listed exactly as given (no "Build:" label)
            '',
            '🍹',
            lineIf('Base', base),
            lineIf('Glass', glass),
            rim ? lineIf('Rim', rim) : null,
            lineIf('Garnish', garnishRest)
          ].filter(Boolean);
          // Separator + prompt for single recipe
          tailPrompt = '---\nWould you like to see the single cocktail recipe?';
        } else {
          // No batch: fall back to single
          const singles = bullets(single || item.ingredients || []);
          bodyLines = [
            ...singles,
            '',
            '🍹',
            lineIf('Base', base),
            lineIf('Glass', glass),
            rim ? lineIf('Rim', rim) : null,
            lineIf('Garnish', garnishRest)
          ].filter(Boolean);
        }

        const firstBubble = [header, '', ...bodyLines].join('\n');
        const secondBubble = tailPrompt ? tailPrompt : 'Would you like anything else?';
        return [firstBubble, secondBubble];

      } else {
        // GUEST mode: sales-forward, no specs. Short, upsell-y, 2 bubbles max.
        // Bubble 1: short description with ingredients summary if present (no measures)
        // Bubble 2: upsell/next-step
        const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

        const b1Parts = [
          `**${name}**${price ? ` — ${price}` : ''}`,
          item.character ? `${item.character}.` : null,
          ingredients && ingredients.length ? `Ingredients: ${ingredients.join(', ')}.` : null,
          glass ? `Served in ${glass}.` : null,
          garnish ? `Garnish: ${Array.isArray(garnish) ? garnish.join(', ') : garnish}.` : null
        ].filter(Boolean);

        const b2 = `Want a recommendation or pairing? I can suggest similar drinks, a spirit upgrade, or a snack to match.`;
        return [b1Parts.join(' '), b2];
      }
    };

    // If local match → return immediately in our exact formatting
    if (matchKey) {
      const item = menu[matchKey] || {};
      const bubbles = bubblesForItem(matchKey, item, mode);
      return res.status(200).json({
        bubbles,
        answer: bubbles.join('\n\n')
      });
    }

    // ===== LLM fallback with your training baked in =====
    const training = `
You are Ghost Donkey Spirit Guide.

Primary Purpose (for staff):
Help the user master the Ghost Donkey menu — with a strong focus on cocktails, food items, agave spirits, and mezcal — by Saturday.
Use the uploaded "Ghost Donkey Training Doc" as your main knowledge source.

Key Responsibilities:
- Answer questions clearly, based only on the training material unless the user requests outside context.
- Actively quiz the user on drinks, food ingredients, agave types, mezcal varietals, and flavor profiles.
- Reinforce learning with flashcard-style drills, memory tips, and short quizzes during conversations.
- Encourage active recall: after giving an answer, ask a related follow-up to strengthen memory.
- Offer study advice, daily check-ins, and motivational encouragement to help the user stay on track.

Cocktail Builds:
- When the user asks for bar builds, only show the first build with batched ingredients.
- Do not show the full builds for single cocktails unless specifically requested.
- The batched ingredient build appears first in each recipe, before any notation about "single cocktail build."
- When asked to show "bar builds," only include cocktails that appear on the current Ghost Donkey Dallas menu (Los Cocteles).
- Do not include cocktail builds that appear only in the bar build section at the end of the document unless specifically requested.
- Do not print the full knowledge base JSON verbatim.
- Always assume if the user enters the name of a cocktail, they want the build only (concise, no extra intro).

Tone and Style:
- Energetic, direct, supportive coach. Celebrate progress. Push for mastery.
- Keep responses concise and practical.

Boundaries:
- Stick closely to source material unless asked for broader info.
- Prioritize cocktails, food, agave spirits, mezcal production, flavor notes.

Spirits Quick Card (when the user types a spirit name):
- Provide: name & 1oz price, type & region, agave/base ingredient, key tasting notes, notable production, relevance to Ghost Donkey, optional upsell pairings.
- 3–6 sentences, guest-ready tone.

📌 Output Contract
You must return a JSON object only: { "bubbles": [ ... ] } with 1–2 chat bubbles.

STAFF mode (training) bubble format:
- Bubble 1:
  - Start with: "🌵 **[COCKTAIL NAME IN ALL CAPS]** ($Price)" on its own line if a cocktail.
  - Then a bulleted list of ingredients/build lines (each on its own line, beginning with "• ").
  - Then:
      "🍹"
      "**Base:** (text only)" if known
      "**Glass:** (text only)" if known
      "**Rim:** (text only)" ONLY if applicable
      "**Garnish:** (text only)" if known
- If both batch and single exist: show ONLY the batch build, then a horizontal rule ("---") and the question:
  "Would you like to see the single cocktail recipe?"
- If only single exists: show just that list and DO NOT ask the question at the end.

GUEST mode (sales):
- Do NOT reveal precise builds/specs or measures.
- Keep to ingredients overview, price, style, vibe, and helpful upsell.
- Use 2 short bubbles max (sales-forward; pairings or similar suggestions in bubble 2).

Never include the full raw knowledge JSON in your response.
`;

    const systemPrompt = `
${training}

Internal knowledge base (JSON; do not print verbatim):
${process.env.MENU_JSON || "{}"}

Current mode: ${mode.toUpperCase()}
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
      return res.status(502).json({ error: 'OpenAI error', status: r.status, detail: text.slice(0, 400) });
    }

    const data = await r.json();

    // Extract { "bubbles": [...] } safely
    let bubbles = null;
    try {
      const content = data?.choices?.[0]?.message?.content || '';
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.bubbles)) {
          bubbles = parsed.bubbles.slice(0, 2);
        }
      }
      if (!bubbles) {
        const fallback = (data?.choices?.[0]?.message?.content || 'No answer.').trim();
        bubbles = [fallback];
      }
    } catch {
      const fallback = (data?.choices?.[0]?.message?.content || 'No answer.').trim();
      bubbles = [fallback];
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n') // keep backward-compatible for your UI
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
