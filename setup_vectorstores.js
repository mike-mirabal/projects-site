// setup_vectorstores.js
import 'dotenv/config';
import fs from 'fs';

const API = 'https://api.openai.com/v1';
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('Missing OPENAI_API_KEY in .env'); process.exit(1); }

const baseHeaders = {
  Authorization: `Bearer ${KEY}`,
  'OpenAI-Beta': 'assistants=v2',
};

// 1) Upload a file to /files (multipart). Returns file.id
async function uploadFile(path) {
  const buf = fs.readFileSync(path);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'text/markdown' }), path.split('/').pop());
  form.append('purpose', 'assistants');

  const r = await fetch(`${API}/files`, { method: 'POST', headers: { Authorization: baseHeaders.Authorization }, body: form });
  if (!r.ok) throw new Error(`file upload failed: ${r.status} ${await r.text()}`);
  const file = await r.json();
  return file.id;
}

// 2) Create a vector store (or reuse existing if id provided)
async function createVectorStore(name, existingId) {
  if (existingId) {
    console.log(`Reusing vector store ${existingId} (${name})`);
    return { id: existingId };
  }
  const r = await fetch(`${API}/vector_stores`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`createVectorStore failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

// 3) Attach files to vector store as a batch (JSON body with file_ids) and poll
async function attachAndPoll(vectorStoreId, fileIds) {
  const r = await fetch(`${API}/vector_stores/${vectorStoreId}/file_batches`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_ids: fileIds }),
  });
  if (!r.ok) throw new Error(`fileBatches create failed: ${r.status} ${await r.text()}`);
  const batch = await r.json();

  // poll
  while (true) {
    const pr = await fetch(`${API}/vector_stores/${vectorStoreId}/file_batches/${batch.id}`, { headers: baseHeaders });
    if (!pr.ok) throw new Error(`batch poll failed: ${pr.status} ${await pr.text()}`);
    const status = await pr.json();
    if (['completed', 'failed', 'cancelled'].includes(status.status)) return status;
    await new Promise(r => setTimeout(r, 1000));
  }
}

(async () => {
  try {
    // If you already have IDs (like your Guest VS), put them in .env to reuse:
    // GD_GUEST_VS=vs_...
    // GD_STAFF_VS=vs_...
    const existingGuest = process.env.GD_GUEST_VS || 'vs_68af4725fb388191a36334f60c8857c7'; // reuse the one you just created
    const existingStaff = process.env.GD_STAFF_VS || '';

    // Create or reuse stores
    const guestVS = await createVectorStore('GD Guest', existingGuest);
    console.log('Guest VS:', guestVS.id);

    const staffVS = await createVectorStore('GD Staff', existingStaff);
    console.log('Staff VS:', staffVS.id);

    // Upload files -> get file_ids
    const guestFileId = await uploadFile('./ghost_guest.md');
    console.log('Uploaded guest file ->', guestFileId);

    const staffFileId = await uploadFile('./ghost_staff.md');
    console.log('Uploaded staff file ->', staffFileId);

    // Attach to stores & poll
    const guestBatch = await attachAndPoll(guestVS.id, [guestFileId]);
    console.log('Guest batch status:', guestBatch.status, guestBatch.file_counts || '');

    const staffBatch = await attachAndPoll(staffVS.id, [staffFileId]);
    console.log('Staff batch status:', staffBatch.status, staffBatch.file_counts || '');

    console.log('\n👇 Add/confirm these in Vercel env vars:');
    console.log('GD_GUEST_VS =', guestVS.id);
    console.log('GD_STAFF_VS =', staffVS.id);
  } catch (e) {
    console.error('setup_vectorstores error:', e);
    process.exit(1);
  }
})();
