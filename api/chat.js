// /api/chat.js — Assistants v2 via REST (no SDK quirks)

const API = "https://api.openai.com/v1";
const HEADERS_JSON = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

export default async function handler(req, res) {
  try {
    // CORS (handy for local)
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
      if (!r.ok) {
        const t = await r.text().catch(()=> "");
        return res.status(502).json({ error: "Failed to create thread", detail: t });
      }
      const created = await r.json();
      threadId = created.id; // should look like "thread_..."
      if (!threadId) return res.status(502).json({ error: "No thread id returned" });
    }

    // 2) Add user message
    {
      const r = await fetch(`${API}/threads/${threadId}/messages`, {
        method: "POST",
        headers: HEADERS_JSON,
        body: JSON.stringify({ role: "user", content: message }),
      });
      if (!r.ok) {
        const t = await r.text().catch(()=> "");
        return res.status(502).json({ threadId, error: "Failed to add message", detail: t });
      }
    }

   // 3) Start run (force file_search tool; disallow general knowledge)
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
      // ↓ Require tools so the model can’t answer without retrieval
      tool_choice: { type: "file_search" }, // or: "required"
      // Optional: make it more deterministic
      temperature: 0.2
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    return res.status(502).json({ threadId, error: "Failed to start run", detail: t });
  }
  const run = await r.json();
  runId = run.id;
  if (!runId) return res.status(502).json({ threadId, error: "No run id returned" });
}


    // 4) Poll run until completed
    const TIMEOUT_MS = 30_000;
    const start = Date.now();
    while (true) {
      const r = await fetch(`${API}/threads/${threadId}/runs/${runId}`, {
        headers: { "Authorization": HEADERS_JSON.Authorization, "OpenAI-Beta": "assistants=v2" },
      });
      if (!r.ok) {
        const t = await r.text().catch(()=> "");
        return res.status(502).json({ threadId, error: "Failed to poll run", detail: t });
      }
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
      await new Promise((r) => setTimeout(r, 600));
    }

    // 5) Read last assistant message
    const msgsRes = await fetch(`${API}/threads/${threadId}/messages?order=asc`, {
      headers: { "Authorization": HEADERS_JSON.Authorization, "OpenAI-Beta": "assistants=v2" },
    });
    if (!msgsRes.ok) {
      const t = await msgsRes.text().catch(()=> "");
      return res.status(502).json({ threadId, error: "Failed to list messages", detail: t });
    }
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
    const bubbles = answer ? [answer] : ["I couldn't find that in my files yet."];

    return res.status(200).json({ threadId, bubbles, answer });
  } catch (e) {
    console.error("API error:", e);
    return res.status(500).json({ error: "Server error", detail: String(e).slice(0, 500) });
  }
}
