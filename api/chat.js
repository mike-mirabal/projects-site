// /api/chat.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" },
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { query, mode: rawMode, threadId: incomingThreadId } = req.body || {};
    const mode = rawMode === "staff" ? "staff" : "guest";
    const message = (query || "").toString().trim();
    if (!message) return res.status(400).json({ error: "Missing query" });

    const assistantId = process.env.GD_ASSISTANT_ID;
    const vsGuest = process.env.GD_GUEST_VS;
    const vsStaff = process.env.GD_STAFF_VS;
    if (!assistantId || !vsGuest || !vsStaff) {
      return res.status(500).json({
        error: "Missing env vars. Set GD_ASSISTANT_ID, GD_GUEST_VS, GD_STAFF_VS in Vercel.",
      });
    }

    const vectorStoreId = mode === "staff" ? vsStaff : vsGuest;

    // 1) Ensure we have a thread id
    let threadId = incomingThreadId;
    if (!threadId) {
      const created = await client.beta.threads.create();
      threadId = created?.id;
      if (!threadId) {
        return res.status(502).json({ error: "Failed to create thread" });
      }
    }

    // 2) Add the user message
    await client.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
    });

    // 3) Start the run
    const run = await client.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      instructions:
        mode === "guest"
          ? `MODE: GUEST. Answer conversationally using only guest-facing info from files. Do NOT reveal recipes, builds, batch specs, or staff notes. If asked for those, decline politely.`
          : `MODE: STAFF. You may include single/batch builds and presentation details when requested. Default to a guest-friendly description unless the user explicitly asks for staff details.`,
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    });

    // Some SDKs also return run.thread_id; keep a robust fallback
    const pollThreadId = threadId ?? run?.thread_id;
    const runId = run?.id;
    if (!pollThreadId || !runId) {
      return res.status(502).json({
        error: "Run did not return valid ids",
        detail: { threadId: pollThreadId, runId },
      });
    }

    // 4) Poll until completed (with timeout)
    const start = Date.now();
    const TIMEOUT_MS = 30000;
    while (true) {
      const r = await client.beta.threads.runs.retrieve(pollThreadId, runId);
      if (["completed", "failed", "cancelled", "expired"].includes(r.status)) {
        if (r.status !== "completed") {
          return res.status(502).json({
            threadId: pollThreadId,
            error: `Run ${r.status}`,
            detail: r.last_error?.message || "Assistant run did not complete successfully.",
          });
        }
        break;
      }
      if (Date.now() - start > TIMEOUT_MS) {
        return res.status(504).json({
          threadId: pollThreadId,
          error: "Timeout",
          detail: "Assistant run exceeded timeout.",
        });
      }
      await new Promise((r) => setTimeout(r, 550));
    }

    // 5) Read last assistant message
    const msgs = await client.beta.threads.messages.list(pollThreadId, { order: "asc" });
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

    return res.status(200).json({ threadId: pollThreadId, bubbles, answer });
  } catch (e) {
    console.error("API error:", e);
    return res.status(500).json({
      error: "Server error",
      detail: String(e && e.error?.message ? e.error.message : e).slice(0, 500),
    });
  }
}
