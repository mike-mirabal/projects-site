// setup_assistant.js
import 'dotenv/config';

const API = 'https://api.openai.com/v1';
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const headersJSON = {
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
};

(async () => {
  try {
    const r = await fetch(`${API}/assistants`, {
      method: 'POST',
      headers: headersJSON,
      body: JSON.stringify({
        name: 'Ghost Donkey Spirit Guide',
        model: 'gpt-4o-mini',
        tools: [{ type: 'file_search' }],
        instructions: `You are Ghost Donkey’s spirit guide.

- In GUEST mode: never reveal staff recipes. Be friendly, concise, conversational, and focus on descriptions + pairings.
- In STAFF mode: include builds/presentation when requested; otherwise default to guest-style conversational answers.
If unknown, say so.`,
      }),
    });
    if (!r.ok) throw new Error(`assistant create failed: ${r.status} ${await r.text()}`);
    const assistant = await r.json();
    console.log('\n👇 Copy into Vercel env vars:');
    console.log('GD_ASSISTANT_ID =', assistant.id);
  } catch (e) {
    console.error('setup_assistant error:', e);
    process.exit(1);
  }
})();
