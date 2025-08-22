// /api/chat.js
// Simple in-memory context for the current process. (Good enough for MVP.)
// If you're on serverless, instances may recycle; for persistence across users,
// switch to a per-user session mechanism (cookie/sessionID + store).
let lastCocktail = null;          // last matched cocktail name
let pendingSingleFor = null;      // cocktail awaiting "yes" to show single build

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

    // ===== Load menu JSON from env (safe parse) =====
    let menu = {};
    try {
      menu = JSON.parse(process.env.MENU_JSON || '{}');
    } catch {
      menu = {};
    }

    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ===== Utils =====
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const toBullets = (arr) => (arr || []).map(x => `• ${x}`);
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');
    const priceSpan = (price) => price ? `<span>${price}</span>` : '';

    // Pulls single & batch builds while supporting either top-level arrays
    //   item.build, item.batchBuild
    // or nested: item.build.singleBuild, item.build.batchBuild
    function getSingleBuild(item) {
      if (Array.isArray(item.build?.singleBuild)) return item.build.singleBuild;
      if (Array.isArray(item.recipe)) return item.recipe;
      if (Array.isArray(item.build)) return item.build;
      return null;
    }
    function getBatchBuild(item) {
      if (Array.isArray(item.build?.batchBuild)) return item.build.batchBuild;
      if (Array.isArray(item.batchBuild)) return item.batchBuild;
      return null;
    }

    // Guest-facing description synthesized from "character"
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
        return `This would go great with our chicken tinga tacos.\nThey’re only $2.75 each on happy hour ‘til 8pm!`;
      }
      if (n.includes('margarita') || n.includes('paloma')) {
        return `Chips & queso is the move — and happy hour deals run ‘til 8pm!`;
      }
      if (n.includes('carajillo') || n.includes('espresso')) {
        return `Pair it with our churro bites for a dessert-worthy combo.`;
      }
      return `This would go great with our chicken tinga tacos.\nThey’re only $2.75 each on happy hour ‘til 8pm!`;
    }

    // Build a quiz bubble for staff
    function quizFor(name, item) {
      const choices = [];
      const single = getSingleBuild(item);
      const batch  = getBatchBuild(item);
      if (item.glass) choices.push(`Quick check: what’s the glass for <strong>${name}</strong>?`);
      if (item.garnish) choices.push(`Pop quiz: name one garnish on <strong>${name}</strong>.`);
      if (batch && batch.length) {
        choices.push(`Recall: what’s the <em>first</em> ingredient in the batch build for <strong>${name}</strong>?`);
      } else if (single && single.length) {
        choices.push(`Recall: what’s the <em>first</em> ingredient in the single build for <strong>${name}</strong>?`);
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        choices.push(`Recall: name two ingredients in <strong>${name}</strong>.`);
      }
      if (!choices.length) choices.push(`Want a quick flashcard on <strong>${name}</strong>?`);
      return choices[Math.floor(Math.random() * choices.length)];
    }

    // HTML rendering for STAFF vs GUEST
    function bubblesForItem(name, item, mode) {
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;
      const singleBuild = getSingleBuild(item);
      const batchBuild  = getBatchBuild(item);

      const glass   = item.glass ? `Glass: ${item.glass}` : null;
      const garnish = item.garnish ? `Garnish: ${stringifyGarnish(item.garnish)}` : null;

      if (mode === 'staff') {
        // STAFF: show BATCH first if present; otherwise single; otherwise ingredients
        const header = `<span class="accent-teal"><strong>${name}</strong></span> ${priceSpan(item.price)}`.trim();
        let firstBlock = [header];

        if (batchBuild && batchBuild.length) {
          firstBlock = firstBlock.concat(toBullets(batchBuild));
        } else if (singleBuild && singleBuild.length) {
          firstBlock = firstBlock.concat(toBullets(singleBuild));
        } else if (ingredients && ingredients.length) {
          firstBlock = firstBlock.concat(toBullets(ingredients));
        }

        if (glass) firstBlock.push(glass);
        if (garnish) firstBlock.push(garnish);

        // Follow-up: specifically ask about single cocktail build (without batch)
        let secondBubble = `Do you want to see the single cocktail build without batch?`;

        // If there is NO batch but there IS single, then we already showed single.
        // Use a different follow up (offer a quiz or ask for another drink).
        if (!batchBuild && singleBuild && singleBuild.length) {
          secondBubble = `Need the batch build again, or want a quick quiz?`;
        }

        return [firstBlock.join('<br>'), secondBubble];
      } else {
        // GUEST: Name + Price, blank line, enticing desc, blank line, Ingredients
        const top = `<span class="accent-teal"><strong>${name}</strong></span> ${priceSpan(item.price)}`.trim();
        const desc = characterToLine(item.character)
          || (ingredients && ingredients.length
              ? `Bright, balanced, and easy to love.`
              : `A house favorite with great balance.`);
        const ing = (ingredients && ingredients.length)
          ? `Ingredients: ${ingredients.join(', ')}`
          : null;
        const upsell = upsellFor(name);

        const block = [top, '', desc, '', ing].filter(Boolean).join('<br>');
        return [block, upsell];
      }
    }

    // ===== Try to find a direct cocktail match from the MENU_JSON =====
    const keys = Object.keys(menu || {});
    let matchKey =
      keys.find((k) => q.includes(normalize(k))) ||
      keys.find((k) => normalize(k).includes(q));

    // ===== If the previous step asked for single, accept a "yes" reply =====
    const affirmative = /^(y|yes|yeah|yep|sure|ok|okay|show me|please|show|let me see)\b/i.test(query);
    if (affirmative && pendingSingleFor && menu[pendingSingleFor]) {
      const item = menu[pendingSingleFor];
      const singleBuild = getSingleBuild(item);
      const header = `<span class="accent-teal"><strong>${pendingSingleFor}</strong></span> ${priceSpan(item.price)}`.trim();
      let firstBlock = [header];
      if (singleBuild && singleBuild.length) {
        firstBlock = firstBlock.concat(toBullets(singleBuild));
      } else if (Array.isArray(item.ingredients) && item.ingredients.length) {
        firstBlock = firstBlock.concat(toBullets(item.ingredients));
      }
      if (item.glass)   firstBlock.push(`Glass: ${item.glass}`);
      if (item.garnish) firstBlock.push(`Garnish: ${stringifyGarnish(item.garnish)}`);

      // Clear pending since we just served it
      lastCocktail = pendingSingleFor;
      pendingSingleFor = null;

      const follow = `Need the batch build again, or want a quick quiz?`;
      return res.status(200).json({
        bubbles: [firstBlock.join('<br>'), follow],
        answer: [firstBlock.join('\n'), follow].join('\n\n')
      });
    }

    // ===== "quiz" command: quiz on last cocktail =====
    if (/\bquiz\b/i.test(query)) {
      if (lastCocktail && menu[lastCocktail]) {
        const qz = quizFor(lastCocktail, menu[lastCocktail]);
        return res.status(200).json({
          bubbles: [qz],
          answer: qz
        });
      } else {
        return res.status(200).json({
          bubbles: ["Pick a cocktail first, then I’ll quiz you!"],
          answer: "Pick a cocktail first, then I’ll quiz you!"
        });
      }
    }

    // ===== If we have a match, render locally (no LLM) =====
    if (matchKey) {
      const item = menu[matchKey] || {};
      lastCocktail = matchKey;

      const bubbles = bubblesForItem(matchKey, item, mode);

      // If STAFF and both batch & single exist, set pending flag to allow "yes" next
      if (mode === 'staff') {
        const hasBatch  = !!getBatchBuild(item)?.length;
        const hasSingle = !!getSingleBuild(item)?.length;
        pendingSingleFor = (hasBatch && hasSingle) ? matchKey : null;
      } else {
        pendingSingleFor = null;
      }

      return res.status(200).json({
        bubbles,
        answer: bubbles.map(b => b.replaceAll('<br>', '\n')).join('\n\n')
      });
    }

    // ===== Otherwise, fall back to the LLM with the menu JSON as context =====
    const staffDirectives = `
You are the Spirit Guide in STAFF mode.
Return EXACTLY { "bubbles": ["...","..."] } with HTML ONLY (no markdown).
When a cocktail is mentioned by name:
- Bubble 1 (HTML):
  - Title line: <span class="accent-teal"><strong>NAME</strong></span> (price in parentheses on the same line if available)
  - Then each build line on its own line using the "• " bullet prefix (these are literal text lines; keep the original text with quantities like "1 oz ...").
  - Show ONLY the batch build if available; if no batch, show the single recipe.
  - After the bullets, include:
    - Glass: ...
    - Garnish: ...
  - Separate lines with <br>, not new paragraphs.
- Bubble 2 (HTML):
  - If both batch and single exist: "Do you want to see the single cocktail build without batch?"
  - If only single exists: "Need the batch build again, or want a quick quiz?"

Rules:
- Use valid HTML only (no markdown).
- Do not reveal the entire knowledge JSON.
- Keep responses concise and scannable.
`;

    const guestDirectives = `
You are the Spirit Guide in GUEST mode.
Return EXACTLY { "bubbles": ["...","..."] } with HTML ONLY (no markdown).
- Bubble 1 (HTML):
  - Title line: <span class="accent-teal"><strong>Name</strong></span> (price)
  - Blank line (<br>) then a SHORT enticing description crafted from tasting notes/character (one sentence).
  - Blank line (<br>) then "Ingredients: ..." as a concise comma-separated list (no detailed build/spec).
- Bubble 2 (HTML):
  - A specific upsell/pairing recommendation (e.g., tacos + happy hour note).

Rules:
- No detailed build/spec lines in guest mode.
- Use valid HTML only (no markdown).
- Be crisp and sales-forward.
`;

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like ingredients, build/batchBuild, glass, garnish, character, price.
Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

ALWAYS return JSON in this exact shape:
{ "bubbles": ["<HTML bubble 1>", "<HTML bubble 2>"] }

NEVER include or print the entire knowledge JSON.
Knowledge base (internal reference only):
${process.env.MENU_JSON || "{}"}
`.trim();

    // Call the model for non-matching queries (general Q&A)
    let data;
    try {
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
        // Model failed — return friendly fallback
        return res.status(200).json({
          bubbles: ["Sorry, I don't have this answer yet. I'm still learning..."],
          answer: "Sorry, I don't have this answer yet. I'm still learning..."
        });
      }

      data = await r.json();
    } catch {
      // Network/other error — friendly fallback
      return res.status(200).json({
        bubbles: ["Sorry, I don't have this answer yet. I'm still learning..."],
        answer: "Sorry, I don't have this answer yet. I'm still learning..."
      });
    }

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
        const plain = (data?.choices?.[0]?.message?.content || '').trim();
        if (plain) {
          const split = plain.split(/\n\s*\n/).slice(0, 2);
          bubbles = split.length ? split : [plain];
        }
      }
    } catch {
      // Parsing issue — fallback
    }

    if (!bubbles || !bubbles.length) {
      return res.status(200).json({
        bubbles: ["Sorry, I don't have this answer yet. I'm still learning..."],
        answer: "Sorry, I don't have this answer yet. I'm still learning..."
      });
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n')
    });

  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0, 400) });
  }
}
