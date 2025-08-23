// /api/stt.js
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb' // allow short clips comfortably
    }
  }
};

export default async function handler(req, res){
  try{
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { audio, mime = 'audio/webm' } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'Missing audio' });

    const buf = Buffer.from(audio, 'base64');

    // Build multipart/form-data using Web Streams/FormData (Node 18+)
    const form = new FormData();
    const file = new Blob([buf], { type: mime });
    form.append('file', file, 'audio.webm');
    form.append('model', 'whisper-1');          // STT model
    form.append('response_format', 'json');     // default; explicit for clarity

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!r.ok){
      const t = await r.text().catch(()=> '');
      return res.status(502).json({ error: 'OpenAI STT error', status: r.status, detail: t.slice(0,400) });
    }

    const data = await r.json();
    return res.status(200).json({ text: data.text || '' });

  }catch(e){
    return res.status(500).json({ error: 'Server error', detail: String(e).slice(0,400) });
  }
}
