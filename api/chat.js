// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { query } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const systemPrompt = `
You are Ghost Donkey Trainer. You answer staff questions about the bar's menu with precise, current specs.
- Be concise and operationally useful (steps, measures, glassware, garnish).
- Include allergen flags and ingredient substitutions if relevant.
- If info is missing, say so and suggest checking the spec sheet.
Knowledge Base (JSON):
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
          { role: 'user', content: query },
        ],
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(500).json({ error: 'OpenAI error', status: r.status, detail: text.slice(0, 400) });
    }

    const data = await r.json();
    const answer = data?.choices?.[0]?.message?.content || 'No answer.';
    return res.status(200).json({ answer });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
