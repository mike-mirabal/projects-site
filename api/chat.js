// /api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------- Helpers ----------
    const readCookies = (header = '') =>
      Object.fromEntries(
        String(header)
          .split(';')
          .map(v => v.trim())
          .filter(Boolean)
          .map(v => {
            const i = v.indexOf('=');
            return i === -1 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
          })
      );

    const setLastCocktailCookie = (name) => {
      if (!name) return;
      // Short-lived, path=/, lax
      res.setHeader(
        'Set-Cookie',
        `gd_last_cocktail=${encodeURIComponent(name)}; Max-Age=900; Path=/; SameSite=Lax`
      );
    };

    const isAffirmative = (s = '') => {
      const t = String(s).trim().toLowerCase();
      return (
        t === 'yes' ||
        t === 'y' ||
        t === 'yeah' ||
        t === 'yep' ||
        t === 'sure' ||
        t === 'ok' ||
        t === 'okay' ||
        /^yes[.!]?$/i.test(s) ||
        /^show (me )?(it|the single|single)/i.test(s) ||
        /^let'?s see/i.test(s)
      );
    };

    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // HTML renderers (no markdown)
    const renderStaffBlock = (name, price, lines, glass, garnish) => {
      return `
<div class="gd-card">
  <div class="gd-title"><strong class="accent-teal">${esc(name)}</strong>${price ? ` <span class="price">(${esc(price)})</span>` : ''}</div>
  <ul class="gd-build">
    ${lines.map(li => `<li>${esc(li)}</li>`).join('')}
  </ul>
  ${glass ? `<div><strong>Glass:</strong> ${esc(glass)}</div>` : ''}
  ${garnish ? `<div><strong>Garnish:</strong> ${esc(garnish)}</div>` : ''}
</div>`.trim();
    };

    const renderGuestBlock = (name, price, desc, ing) => {
      return `
<div class="gd-card">
  <div class="gd-title"><strong class="accent-teal">${esc(name)}</strong>${price ? ` <span class="price">(${esc(price)})</span>` : ''}</div>
  ${desc ? `<p>${esc(desc)}</p>` : ''}
  ${ing ? `<div><strong>Ingredients:</strong> ${esc(ing)}</div>` : ''}
</div>`.trim();
    };

    // ---------- Parse request ----------
    const body = req.body || {};
    const queryRaw = body.query;
    const mode = body.mode === 'guest' ? 'guest' : 'staff'; // default staff
    if (!queryRaw || !String(queryRaw).trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const query = String(queryRaw).trim();
    const q = query.toLowerCase();

    // ---------- Load menu JSON ----------
    let menu = {};
    try {
      menu = JSON.parse(process.env.MENU_JSON || '{}');
    } catch {
      menu = {};
    }

    // ---------- Utilities for menu ----------
    const normalize = (s) => String(s).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const stringifyGarnish = (g) => Array.isArray(g) ? g.join(', ') : (g || '');

    const toLines = (arr) => {
      if (!Array.isArray(arr)) return [];
      // Keep exact order/quantities as provided
      return arr.map(x => String(x));
    };

    // Character -> short description
    function characterToLine(charStr) {
      if (!charStr) return null;
      const parts = String(charStr).split(/[,•]/).map(s => s.trim()).filter(Boolean);
      if (!parts.length) return null;
      if (parts.length === 1) return `A ${parts[0].toLowerCase()} crowd-pleaser.`;
      const last = parts.pop();
      return `${parts.map(p => p.toLowerCase()).join(', ')} with a ${last.toLowerCase()} finish.`;
    }

    function upsellFor(name) {
      const n = String(name).toLowerCase();
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

    // ---------- Cookie context ----------
    const cookies = readCookies(req.headers.cookie || '');
    const lastCocktailCookie = cookies['gd_last_cocktail'];

    // ---------- Direct match finder ----------
    const keys = Object.keys(menu || {});
    const findCocktailKey = (needleLower) =>
      keys.find(k => needleLower.includes(normalize(k))) ||
      keys.find(k => normalize(k).includes(needleLower));

    let matchKey = findCocktailKey(q);

    // If staff mode and user said "yes", try cookie
    if (mode === 'staff' && !matchKey && isAffirmative(q) && lastCocktailCookie) {
      matchKey = lastCocktailCookie;
    }

    // If they wrote "single build for <name>" try to extract name
    if (!matchKey && /^single\b|^show single/i.test(query)) {
      const nameGuess = query.replace(/^(single|show single|show the single|single build (for|of))\s*/i, '').trim();
      if (nameGuess) matchKey = findCocktailKey(nameGuess.toLowerCase());
    }

    // ---------- If we have a match in JSON ----------
    if (matchKey && menu[matchKey]) {
      const item = menu[matchKey] || {};
      const price = item.price || '';
      const glass = item.glass || '';
      const garnish = stringifyGarnish(item.garnish);

      // Resolve batch vs single arrays (your JSON uses top-level build/batchBuild)
      const batchBuild = Array.isArray(item.batchBuild) ? item.batchBuild : null;
      const singleBuild = Array.isArray(item.build) ? item.build : null;
      const ingredients = Array.isArray(item.ingredients) ? item.ingredients : null;

      let firstBlockHTML = '';
      let secondBubbleHTML = '';

      if (mode === 'staff') {
        // Decide whether showing single build (affirmative) or batch build by default
        const showSingle =
          isAffirmative(q) && (!!singleBuild && singleBuild.length) && lastCocktailCookie === matchKey;

        if (showSingle && singleBuild && singleBuild.length) {
          // Single build
          firstBlockHTML = renderStaffBlock(matchKey, price, toLines(singleBuild), glass, garnish);
          secondBubbleHTML = `<div>Need the batch build again, or want a quick quiz?</div>`;
        } else {
          // Default: Batch first if available; else single; else ingredients
          if (batchBuild && batchBuild.length) {
            firstBlockHTML = renderStaffBlock(matchKey, price, toLines(batchBuild), glass, garnish);
            secondBubbleHTML = `<div>Do you want to see the single cocktail build without batch?</div>`;
          } else if (singleBuild && singleBuild.length) {
            firstBlockHTML = renderStaffBlock(matchKey, price, toLines(singleBuild), glass, garnish);
            secondBubbleHTML = `<div>Want a quick quiz on this build, or see similar cocktails?</div>`;
          } else if (ingredients && ingredients.length) {
            firstBlockHTML = renderStaffBlock(matchKey, price, toLines(ingredients), glass, garnish);
            secondBubbleHTML = `<div>Want the full measured build?</div>`;
          } else {
            firstBlockHTML = `<div>Sorry, I don't have this answer yet. I'm still learning...</div>`;
          }
        }
      } else {
        // Guest mode: description + ingredients + upsell
        const desc =
          characterToLine(item.character) ||
          (ingredients && ingredients.length
            ? `Bright, balanced, and easy to love.`
            : `A house favorite with great balance.`);
        const ing = ingredients && ingredients.length ? ingredients.join(', ') : '';
        firstBlockHTML = renderGuestBlock(matchKey, price, desc, ing);
        secondBubbleHTML = `<div>${esc(upsellFor(matchKey))}</div>`;
      }

      // remember last cocktail so "yes" works next turn
      setLastCocktailCookie(matchKey);

      const bubbles = [firstBlockHTML];
      if (secondBubbleHTML) bubbles.push(secondBubbleHTML);
      return res.status(200).json({ bubbles, answer: bubbles.join('\n\n') });
    }

    // ---------- No direct match: try model as a fallback ----------
    // Build concise directives that still ask the model to return HTML bubbles.
    const staffDirectives = `
You are Ghost Donkey Spirit Guide (STAFF mode).

If the user provides a cocktail name, return EXACTLY two HTML "bubbles" (strings):
  Bubble 1 (HTML):
    <div class="gd-card">
      <div class="gd-title"><strong class="accent-teal">Name</strong> (Price)</div>
      <ul class="gd-build">
        <li>…measured build line…</li>
        <li>…</li>
      </ul>
      <div><strong>Glass:</strong> …</div>
      <div><strong>Garnish:</strong> …</div>
    </div>
  • Default to the batch build if it exists; otherwise show the single cocktail build. Use exact quantities if present.
  Bubble 2 (HTML):
    <div>Do you want to see the single cocktail build without batch?</div>

Never use markdown; return HTML only. Keep it concise and scannable.
`;

    const guestDirectives = `
You are Ghost Donkey Spirit Guide (GUEST mode).

Return EXACTLY two HTML "bubbles":
  Bubble 1 (HTML):
    <div class="gd-card">
      <div class="gd-title"><strong class="accent-teal">Name</strong> (Price)</div>
      <p>Short enticing description derived from tasting notes.</p>
      <div><strong>Ingredients:</strong> item1, item2, …</div>
    </div>
  Bubble 2 (HTML):
    <div>Concrete upsell/pairing (e.g., tacos/happy hour) in one sentence.</div>

Never use markdown; return HTML only.
`;

    const systemPrompt = `
You have a structured JSON knowledge base with cocktails and fields like ingredients, build (single), batchBuild (batch), glass, garnish, character, price.

Follow the correct mode strictly.

${mode === 'staff' ? staffDirectives : guestDirectives}

NEVER include the entire JSON. Output MUST be JSON ONLY if explicitly asked; otherwise return plain text containing ONLY the two HTML strings separated in JSON-like structure:
{ "bubbles": ["<div>...</div>", "<div>...</div>"] }

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
      // Graceful generic fallback
      return res.status(200).json({
        bubbles: [`<div>Sorry, I don't have this answer yet. I'm still learning...</div>`],
        answer: `Sorry, I don't have this answer yet. I'm still learning...`
      });
    }

    const data = await r.json();

    // Extract bubbles (prefer JSON, fall back to splitting)
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
        // If we only got plain text, try to split into 2 HTML blocks by double newlines
        const plain = (data?.choices?.[0]?.message?.content || '').trim();
        const split = plain.split(/\n\s*\n/).slice(0, 2);
        bubbles = split.length ? split : [`<div>Sorry, I don't have this answer yet. I'm still learning...</div>`];
      }
    } catch {
      bubbles = [`<div>Sorry, I don't have this answer yet. I'm still learning...</div>`];
    }

    return res.status(200).json({
      bubbles,
      answer: bubbles.join('\n\n')
    });
  } catch (e) {
    return res.status(500).json({
      error: 'Server error',
      detail: String(e).slice(0, 400)
    });
  }
}
