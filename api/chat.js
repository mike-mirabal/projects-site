// /api/chat.js
// Path A: OpenAI File Search
// ENV: OPENAI_API_KEY, GD_ASSISTANT_ID, GD_GUEST_VS, GD_STAFF_VS

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" },
});

export default async function handler(req, res) {
  try {
    // --- CORS / preflight (handy for local testing) ---
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

    // ---------- Parse request ----------
    const { query, mode: rawMode, threadId } = req.body || {};
    const mode = rawMode === "staff" ? "staff" : "guest";
    const message = (query || "").toString().trim();
    if (!message) return res.status(400).json({ error: "Missing query" });

    // ---------- Env checks ----------
    const assistantId = process.env.GD_ASSISTANT_ID;
    const vsGuest = process.env.GD_GUEST_VS;
    const vsStaff = process.env.GD_STAFF_VS;
    if (!assistantId || !vsGuest || !vsStaff) {
      return res.status(500).json({
        error:
          "Missing env vars. Set GD_ASSISTANT_ID, GD_GUEST_VS, GD_STAFF_VS in Vercel.",
      });
    }

    const vector_store_id = mode === "staff" ? vsStaff : vsGuest;

    // ---------- Thread ----------
    const thread = threadId ? { id: threadId } : await client.beta.threads.create();

    // Add the user message
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
    });

    // ---------- Run with selected vector store ----------
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
      // tighten behavior per mode
      instructions:
        mode === "guest"
          ? `MODE: GUEST. Answer conversationally using only guest-facing info from files. Do NOT reveal recipes, builds, batch specs, or staff notes. If asked for those, decline politely.`
          : `MODE: STAFF. You may include single/batch builds and presentation details when requested. Default to a guest-friendly description unless the user explicitly asks for staff details.`,
      tool_resources: { file_search: { vector_store_ids: [vector_store_id] } },
    });

    // ---------- Poll until completed (with timeout) ----------
    const started = Date.now();
    const TIMEOUT_MS = 30_000; // 30s
    while (true) {
      const r = await client.beta.threads.runs.retrieve(thread.id, run.id);
      if (["completed", "failed", "cancelled", "expired"].includes(r.status)) {
        if (r.status !== "completed") {
          return res.status(502).json({
            threadId: thread.id,
            error: `Run ${r.status}`,
            detail: r.last_error?.message || "Assistant run did not complete successfully.",
          });
        }
        break;
      }
      if (Date.now() - started > TIMEOUT_MS) {
        return res.status(504).json({
          threadId: thread.id,
          error: "Timeout",
          detail: "Assistant run exceeded timeout.",
        });
      }
      await new Promise((r) => setTimeout(r, 550));
    }

    // ---------- Collect last assistant message ----------
    const msgs = await client.beta.threads.messages.list(thread.id, { order: "asc" });
    const last = msgs.data.at(-1);

    let answer = "";
    if (last?.content?.length) {
      const parts = [];
      for (const c of last.content) {
        if (c.type === "text" && c.text?.value) parts.push(c.text.value);
      }
      answer = parts.join("\n\n");
    }

    const bubbles = answer ? [answer] : ["I couldn't find that in my files yet."];

    return res.status(200).json({ threadId: thread.id, bubbles, answer });
  } catch (e) {
    console.error("API error:", e);
    return res
      .status(500)
      .json({ error: "Server error", detail: String(e).slice(0, 500) });
  }
}
