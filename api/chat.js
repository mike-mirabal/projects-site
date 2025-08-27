// /api/chat.js — Assistants v2 via REST with bubble splitting & HTML cleanup

const API = "https://api.openai.com/v1";
const HEADERS_JSON = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

// --- helpers ---
function stripCitations(html) {
  // remove things like  or any 【...】
  return html.replace(/【[^】]*】/g, "");
}

function ensureHtmlLists(html) {
  // Convert plain-text dash bullets to <ul><li>…</li></ul>
  // Strategy: for each block of consecutive lines that start with "- ",
  // wrap them in <ul> and convert each to <li>...</li>.
  const lines = html.split(/\r?\n/);
  const out = [];
  let inList = false;
  let buffer = [];

  const flush = () => {
    if (buffer.length) {
      out.push("<ul>");
      for (const item of buffer) {
        // remove leading "- " and trim
        out.push(`<li>${item.replace(/^\s*-\s*/, "").trim()}</li>`);
      }
      out.push("</ul>");
      buffer = [];
    }
  };

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      buffer.push(line);
      inList = true;
    } else {
      if (inList) {
        flush();
        inList = false;
      }
      out.push(line);
    }
  }
  if (inList) flush();

  return out.join("\n");
}

function sanitize(html) {
  let s = html || "";
  // remove markdown headings/backticks if any slipped through
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/```[\s\S]*?```/g, "");
  // strip citations
  s = stripCitations(s);
  // normalize lists
  s = ensureHtmlLists(s);
  return s.trim();
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

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { query, mode: rawMode, threadId: incomingThreadId } = req.body || {};
    const mode = rawMode === "staff" ? "staff" : "guest";
    const message = (query || "").toString().trim();
    if (!message) return res.status(400).json({ error: "Missing query" });

    const assistantId = process.env.GD_ASSISTANT_ID;
    const vsGuest = process.env.GD_GUEST_VS;
    const vsStaff = process.env.GD_STAFF_VS;
    if (!process.env.OPENAI_API_KEY || !assistantId || !vsGuest || !vsStaff) {
      return res.status(500).json({ error: "Missing env vars (OPENAI_API_KEY, GD_ASSISTANT_ID, GD_GUEST_VS, GD_STAFF_VS)" });
    }

    const vectorStoreId = mode === "staff" ? vsStaff : vsGuest;

    // 1) Ensure thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const r = await fetch(`${API}/threads`, {
        method: "POST",
        headers: HEADERS_JSON,
        body: JSON.stringify({}),
      });
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

    // 3) Start run (force file_search; no freelancing)
    let runId = null;
    {
      const r = await fetch(`${API}/threads/${threadId}/runs`, {
        method: "POST",
        headers: HEADERS_JSON,
        body: JSON.stringify({
          assistant_id: assistantId,
          instructions:
            mode === "guest"
              ? "MODE: GUEST. Use file_search only. Do NOT answer from general knowledge. If nothing is found in files, say you can’t find it in your files and offer a different item."
              : "MODE: STAFF. Use file_search only. Do NOT answer from general knowledge. If nothing is found in files, say you can’t find it in your files and offer a different item. Format per staff rules.",
          tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
          tool_choice: { type: "file_search" }, // require tool use
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
        if (status.status !== "completed") {
          return res.status(502).json({ threadId, error: `Run ${status.status}`, detail: status.last_error?.message || "" });
        }
        break;
      }
      if (Date.now() - start > TIMEOUT_MS) {
        return res.status(504).json({ threadId, error: "Timeout", detail: "Run exceeded timeout" });
      }
      await new Promise((r2) => setTimeout(r2, 600));
    }

    // 5) Read last assistant message
    const msgsRes = await fetch(`${API}/threads/${threadId}/messages?order=asc`, {
      headers: { "Authorization": HEADERS_JSON.Authorization, "OpenAI-Beta": "assistants=v2" },
    });
    if (!msgsRes.ok) return res.status(502).json({ threadId, error: "Failed to list messages", detail: await msgsRes.text().catch(()=> "") });
    const msgs = await msgsRes.json();
    const last = msgs.data?.[msgs.data.length - 1];

    let answer = "";
    if (last?.content?.length) {
      const parts = [];
      for (const c of last.content) {
        if (c.type === "text" && c.text?.value) parts.push(c.text.value);
      }
      answer = parts.join("\n\n");
    }

    // Split into bubbles on HTML delimiter and sanitize each
    let bubbles = [];
    if (answer) {
      bubbles = answer
        .split(/<!--\s*BUBBLE\s*-->/i)
        .map(sanitize)
        .filter(Boolean);
    }
    if (!bubbles.length && answer) bubbles = [sanitize(answer)];
    if (!bubbles.length) bubbles = ["I couldn't find that in my files yet."];

    return res.status(200).json({ threadId, bubbles, answer: bubbles.join("\n\n") });
  } catch (e) {
    console.error("API error:", e);
    return res.status(500).json({ error: "Server error", detail: String(e).slice(0, 500) });
  }
}
