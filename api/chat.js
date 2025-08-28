// /api/chat.js — Assistants v2 via REST with strict formatting, staff pass gate,
// HTML sanitization, and Google Sheet logging (one row per turn + Session ID)

const API = "https://api.openai.com/v1";
const HEADERS_JSON = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || "";

// ---- helpers ----
function stripCitations(html) {
  return (html || "").replace(/【[^】]*】/g, "");
}
function collapseWhitespace(html) {
  let s = html || "";
  s = s.replace(/\r/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>");
  return s.trim();
}
function ensureHtmlDashLists(html) {
  // dash -> ul/li
  const lines = (html || "").split("\n");
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    out.push("<ul>");
    for (const item of buf) out.push(`<li>${item.replace(/^\s*-\s*/, "").trim()}</li>`);
    out.push("</ul>");
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) buf.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out.join("\n");
}
function ensureHtmlQuantityLists(html) {
  // Convert runs of ingredient-ish lines into <ul><li>…</li></ul>
  const isQty = (s) => /^\s*(?:\d+(\.\d+)?\s*oz\b|top with\b|add\b|splash\b|dash\b|barspoon\b|rinse\b|fill\b)/i.test(s);
  const lines = (html || "").split("\n");
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    out.push("<ul>");
    for (const item of buf) out.push(`<li>${item.trim()}</li>`);
    out.push("</ul>");
    buf = [];
  };
  for (const line of lines) {
    if (isQty(line)) buf.push(line);
    else {
      if (buf.length) flush();
      out.push(line);
    }
  }
  if (buf.length) flush();
  return out.join("\n");
}
function sanitize(html) {
  let s = html || "";
  // remove stray markdown fences/headings
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/```[\s\S]*?```/g, "");
  s = stripCitations(s);
  s = ensureHtmlDashLists(s);
  s = ensureHtmlQuantityLists(s);
  s = collapseWhitespace(s);
  return s;
}

// Build a short Session ID from the thread (for the Sheet & human readability)
function toSessionId(threadId) {
  if (!threadId) return "";
  return (threadId.slice(-8) || threadId).toUpperCase();
}

// Extract plain text from a message's content (for logging to CSV)
function textOfMessage(msg) {
  if (!msg?.content?.length) return "";
  const chunks = [];
  for (const c of msg.content) {
    if (c.type === "text" && c.text?.value) chunks.push(c.text.value);
  }
  return chunks.join("\n\n")
    .replace(/<!--\s*BUBBLE\s*-->/gi, "\n\n") // bubbles to blank line
    .replace(/<\/?[^>]+>/g, '')               // strip HTML tags
    .replace(/\s+\n/g, '\n')
    .trim();
}

export default async function handler(req, res) {
  try {
    // CORS (optional)
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).end();
    }
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { query, mode: rawMode, threadId: incomingThreadId, staffToken } = req.body || {};
    let mode = rawMode === "staff" ? "staff" : "guest";
    const message = (query || "").toString().trim();
    if (!message) return res.status(400).json({ error: "Missing query" });

    const assistantId = process.env.GD_ASSISTANT_ID;
    const vsGuest = process.env.GD_GUEST_VS;
    const vsStaff = process.env.GD_STAFF_VS;
    const STAFF_PASS = process.env.GD_STAFF_PASS || "";

    if (!process.env.OPENAI_API_KEY || !assistantId || !vsGuest || !vsStaff) {
      return res.status(500).json({ error: "Missing env vars (OPENAI_API_KEY, GD_ASSISTANT_ID, GD_GUEST_VS, GD_STAFF_VS)" });
    }

    // Hard gate staff mode by passcode (force guest if invalid)
    if (mode === "staff" && (!staffToken || staffToken !== STAFF_PASS)) {
      mode = "guest";
    }

    const vectorStoreId = mode === "staff" ? vsStaff : vsGuest;

    // 1) Ensure thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const r = await fetch(`${API}/threads`, { method: "POST", headers: HEADERS_JSON, body: JSON.stringify({}) });
      if (!r.ok) return res.status(502).json({ error: "Failed to create thread", detail: await r.text().catch(()=> "") });
      const created = await r.json();
      threadId = created.id;
      if (!threadId) return res.status(502).json({ error: "No thread id returned" });
    }

    // 2) Add user message
    {
      const r = await fetch(`${API}/threads/${threadId}/messages`, {
        method: "POST",
        headers: HEADERS_JSON,
        body: JSON.stringify({ role: "user", content: message }),
      });
      if (!r.ok) return res.status(502).json({ threadId, error: "Failed to add message", detail: await r.text().catch(()=> "") });
    }

    // 3) Start run (force file_search; strict per-mode instructions)
    let runId = null;
    {
      const r = await fetch(`${API}/threads/${threadId}/runs`, {
        method: "POST",
        headers: HEADERS_JSON,
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions:
            mode === "guest"
              ? "MODE: GUEST. Use file_search only. Do not reveal staff specs. Output in HTML only. Two bubbles max: (1) description/price/pairing, (2) short follow-up. No citations. Lists must be <ul><li>…</li></ul> only. Never mention locations unless asked; assume Ghost Donkey Dallas. Format names with <span class=\"accent-teal\">Name</span> only for item in focus."
              : "MODE: STAFF. Use file_search only. Do NOT include any guest sections. EXACTLY three bubbles: (1) <span class=\"accent-teal\">Name</span> + <strong>Batch Build:</strong> with <ul><li> lines; (2) <strong>Glass:</strong> …, <strong>Rim:</strong> …, <strong>Garnish:</strong> …; (3) follow-up asking about <strong>Single Cocktail Build</strong>. No narrative outside bubbles. No citations. HTML only; lists must be <ul><li>…</li></ul>. Never mention locations unless asked; assume Ghost Donkey Dallas.",
          tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
          tool_choice: { type: "file_search" }, // require retrieval
          temperature: 0.2,
        }),
      });
      if (!r.ok) return res.status(502).json({ threadId, error: "Failed to start run", detail: await r.text().catch(()=> "") });
      const run = await r.json();
      runId = run.id;
      if (!runId) return res.status(502).json({ threadId, error: "No run id returned" });
    }

    // 4) Poll run
    const TIMEOUT_MS = 30_000;
    const start = Date.now();
    while (true) {
      const r = await fetch(`${API}/threads/${threadId}/runs/${runId}`, {
        headers: { "Authorization": HEADERS_JSON.Authorization, "OpenAI-Beta": "assistants=v2" },
      });
      if (!r.ok) return res.status(502).json({ threadId, error: "Failed to poll run", detail: await r.text().catch(()=> "") });
      const status = await r.json();
      if (["completed", "failed", "cancelled", "expired"].includes(status.status)) {
        if (status.status !== "completed")
          return res.status(502).json({ threadId, error: `Run ${status.status}`, detail: status.last_error?.message || "" });
        break;
      }
      if (Date.now() - start > TIMEOUT_MS)
        return res.status(504).json({ threadId, error: "Timeout", detail: "Run exceeded timeout" });
      await new Promise((r2) => setTimeout(r2, 600));
    }

    // 5) Read messages (for both response + logging)
    const msgsRes = await fetch(`${API}/threads/${threadId}/messages?order=asc`, {
      headers: { "Authorization": HEADERS_JSON.Authorization, "OpenAI-Beta": "assistants=v2" },
    });
    if (!msgsRes.ok) return res.status(502).json({ threadId, error: "Failed to list messages", detail: await msgsRes.text().catch(()=> "") });
    const msgs = await msgsRes.json();

    // Build answer from last assistant message
    const last = msgs.data?.[msgs.data.length - 1];
    let answer = "";
    if (last?.content?.length) {
      const parts = [];
      for (const c of last.content) if (c.type === "text" && c.text?.value) parts.push(c.text.value);
      answer = parts.join("\n\n");
    }

    // Split into bubbles & sanitize each
    let bubbles = [];
    if (answer) {
      bubbles = answer
        .split(/<!--\s*BUBBLE\s*-->/i)
        .map(sanitize)
        .filter(Boolean);
    }
    if (!bubbles.length && answer) bubbles = [sanitize(answer)];
    if (!bubbles.length) bubbles = ["I couldn't find that in my files yet."];

    // 6) Log only the latest turn (best-effort, one row per user→bot pair)
    if (SHEET_WEBHOOK_URL) {
      try {
        // Find last assistant message
        let lastAssistantIndex = -1;
        for (let i = msgs.data.length - 1; i >= 0; i--) {
          if (msgs.data[i].role === "assistant") { lastAssistantIndex = i; break; }
        }
        let lastAssistant = lastAssistantIndex >= 0 ? msgs.data[lastAssistantIndex] : null;

        // Find nearest previous user message
        let pairedUser = null;
        if (lastAssistant) {
          for (let i = lastAssistantIndex - 1; i >= 0; i--) {
            if (msgs.data[i].role === "user") { pairedUser = msgs.data[i]; break; }
          }
        }

        // Extract plain text for CSV
        const userText = textOfMessage(pairedUser);
        const botText  = textOfMessage(lastAssistant);

        // Turn number = count of user messages so far
        let turn = 0;
        for (const m of msgs.data) if (m.role === "user") turn++;

        // Session ID from threadId
        const sessionId = toSessionId(threadId);

        if (userText || botText) {
          await fetch(SHEET_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode,
              threadId,
              turn,
              sessionId,  // <-- include Session ID for your new column
              user: userText,
              bot: botText,
            }),
          });
        }
      } catch (logErr) {
        console.warn("Logging to Google Sheet failed:", logErr);
      }
    }

    return res.status(200).json({ threadId, bubbles, answer: bubbles.join("\n\n") });
  } catch (e) {
    console.error("API error:", e);
    return res.status(500).json({ error: "Server error", detail: String(e).slice(0, 500) });
  }
}
