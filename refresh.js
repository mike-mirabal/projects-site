// refresh.js
// One-command updater: split master doc -> upload files -> attach to vector stores.
// Usage:
//   node refresh.js            (keeps existing files in the vector stores)
//   node refresh.js --clean    (removes existing files from vector stores before attaching)
//
// Requires Node 18+ (global fetch/FormData/Blob available).
// Env vars needed: OPENAI_API_KEY, GD_GUEST_VS (optional), GD_STAFF_VS (optional)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const API = 'https://api.openai.com/v1';
const KEY = process.env.OPENAI_API_KEY;

if (!KEY) {
  console.error('✖ Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const headersBase = {
  Authorization: `Bearer ${KEY}`,
  'OpenAI-Beta': 'assistants=v2',
};

const MASTER_PATH = './ghost_donkey_knowledge.md';
const GUEST_PATH  = './ghost_guest.md';
const STAFF_PATH  = './ghost_staff.md';

const CLEAN = process.argv.includes('--clean');

// ---------- 1) Split master doc ----------
function splitMaster() {
  if (!fs.existsSync(MASTER_PATH)) {
    console.error(`✖ Missing ${MASTER_PATH}`);
    process.exit(1);
  }

  const src = fs.readFileSync(MASTER_PATH, 'utf8');

  // Split by ### (your existing convention)
  const sections = src.split(/\n(?=###[^\n]+)/g);

  // Guest = remove any [STAFF...] blocks; strip [GUEST] labels
  const guest = sections.map(s =>
    s
      .replace(/\[STAFF[^\]]*\][\s\S]*?(?=(\n\[|$))/g, '') // drop staff-only blocks
      .replace(/\[GUEST\]\s*/g, '')                        // remove guest labels
  ).join('\n').trim();

  // Staff = keep all, just remove [GUEST] labels
  const staff = sections.map(s =>
    s.replace(/\[GUEST\]\s*/g, '')
  ).join('\n').trim();

  fs.writeFileSync(GUEST_PATH, guest);
  fs.writeFileSync(STAFF_PATH, staff);

  console.log('✓ Split complete → ghost_guest.md, ghost_staff.md updated');
}

// ---------- 2) OpenAI helpers ----------
async function createVectorStore(name) {
  const r = await fetch(`${API}/vector_stores`, {
    method: 'POST',
    headers: { ...headersBase, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`createVectorStore(${name}) failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function listVectorStoreFiles(vectorStoreId) {
  const r = await fetch(`${API}/vector_stores/${vectorStoreId}/files`, { headers: headersBase });
  if (!r.ok) throw new Error(`listVectorStoreFiles failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function deleteVectorStoreFile(vectorStoreId, fileId) {
  const r = await fetch(`${API}/vector_stores/${vectorStoreId}/files/${fileId}`, {
    method: 'DELETE',
    headers: headersBase
  });
  if (!r.ok) throw new Error(`deleteVectorStoreFile failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function uploadFile(filePath) {
  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'text/markdown' }), path.basename(abs));
  form.append('purpose', 'assistants');

  const r = await fetch(`${API}/files`, {
    method: 'POST',
    headers: { Authorization: headersBase.Authorization },
    body: form
  });
  if (!r.ok) throw new Error(`uploadFile(${filePath}) failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function attachAndPoll(vectorStoreId, fileIds = []) {
  const r = await fetch(`${API}/vector_stores/${vectorStoreId}/file_batches`, {
    method: 'POST',
    headers: { ...headersBase, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_ids: fileIds }),
  });
  if (!r.ok) throw new Error(`fileBatches create failed: ${r.status} ${await r.text()}`);
  const batch = await r.json();

  // poll
  while (true) {
    const pr = await fetch(`${API}/vector_stores/${vectorStoreId}/file_batches/${batch.id}`, { headers: headersBase });
    if (!pr.ok) throw new Error(`batch poll failed: ${pr.status} ${await pr.text()}`);
    const status = await pr.json();

    process.stdout.write(`  … indexing: ${status.status}\r`);

    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
      process.stdout.write('\n');
      return status;
    }
    await new Promise(res => setTimeout(res, 1000));
  }
}

// ---------- 3) Orchestrate ----------
async function ensureVectorStore(idFromEnv, nameLabel) {
  if (idFromEnv) {
    console.log(`↪ Using existing vector store for ${nameLabel}: ${idFromEnv}`);
    return { id: idFromEnv, justCreated: false };
  }
  console.log(`→ Creating vector store for ${nameLabel}…`);
  const vs = await createVectorStore(`GD ${nameLabel}`);
  console.log(`✓ Created vector store for ${nameLabel}: ${vs.id}`);
  return { id: vs.id, justCreated: true };
}

async function maybeCleanVectorStore(vsId, label) {
  if (!CLEAN) return;
  console.log(`→ Cleaning existing files from ${label} vector store (${vsId})…`);
  const listing = await listVectorStoreFiles(vsId);
  const files = listing.data || [];
  if (!files.length) {
    console.log(`  (no existing files)`);
    return;
  }
  for (const f of files) {
    await deleteVectorStoreFile(vsId, f.id);
    console.log(`  deleted file: ${f.id}`);
  }
  console.log('✓ Cleaned.');
}

async function main() {
  try {
    // 1) Split
    splitMaster();

    // 2) Ensure VSs
    const guestVS = await ensureVectorStore(process.env.GD_GUEST_VS || '', 'Guest');
    const staffVS = await ensureVectorStore(process.env.GD_STAFF_VS || '', 'Staff');

    // 3) Optional clean
    await maybeCleanVectorStore(guestVS.id, 'Guest');
    await maybeCleanVectorStore(staffVS.id, 'Staff');

    // 4) Upload both files
    console.log('→ Uploading files…');
    const guestFile = await uploadFile(GUEST_PATH);
    console.log('  guest file uploaded:', guestFile.id);
    const staffFile = await uploadFile(STAFF_PATH);
    console.log('  staff file uploaded:', staffFile.id);

    // 5) Attach & poll
    console.log(`→ Attaching to Guest VS (${guestVS.id}) and indexing…`);
    const gBatch = await attachAndPoll(guestVS.id, [guestFile.id]);
    console.log('  Guest indexing:', gBatch.status, gBatch.file_counts || '');

    console.log(`→ Attaching to Staff VS (${staffVS.id}) and indexing…`);
    const sBatch = await attachAndPoll(staffVS.id, [staffFile.id]);
    console.log('  Staff indexing:', sBatch.status, sBatch.file_counts || '');

    // 6) Remind envs if just created
    if (guestVS.justCreated || staffVS.justCreated) {
      console.log('\n⚙️  Add/confirm these in your Vercel env vars:');
      console.log('  GD_GUEST_VS =', guestVS.id);
      console.log('  GD_STAFF_VS =', staffVS.id);
    }

    console.log('\n✓ Refresh complete.');
  } catch (e) {
    console.error('\n✖ refresh error:', e?.message || e);
    process.exit(1);
  }
}

main();
