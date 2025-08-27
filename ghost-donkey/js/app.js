// ===== Spirit Guide (Path A: Assistants + Vector Stores) =====

// UI elements
const chatEl   = document.getElementById('chat');
const inputEl  = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const guestBtn = document.getElementById('guestBtn');
const staffBtn = document.getElementById('staffBtn');
const composer = document.getElementById('composer');
const micBtn   = document.getElementById('mic');

// ---------- Inject minimal CSS (typing & modal) so this file is self-contained ----------
(function injectCSS(){
  const css = `
  .typing { display:inline-flex; gap:6px; align-items:center; height:1em; }
  .typing .dot { width:6px; height:6px; border-radius:50%; opacity:.5; animation:bounce 1.2s infinite ease-in-out; }
  .typing .dot:nth-child(1){ animation-delay:0s; } 
  .typing .dot:nth-child(2){ animation-delay:.15s; } 
  .typing .dot:nth-child(3){ animation-delay:.3s; }
  @keyframes bounce { 0%,80%,100%{ transform:translateY(0); opacity:.5 } 40%{ transform:translateY(-6px); opacity:1 } }

  /* Staff pass modal */
  #staffModal {
    position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.35); z-index: 9999;
  }
  #staffModal .card {
    background: #111; color: #fff; width: min(92vw, 420px); border-radius: 16px; padding: 18px 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,.5);
  }
  #staffModal h3 { margin: 0 0 8px 0; font-size: 16px; letter-spacing: .02em; }
  #staffModal label { font-size: 13px; opacity: .9; display: block; margin-bottom: 8px; }
  #staffModal input {
    width: 100%; padding: 12px 12px; border-radius: 10px; border: 1px solid #333; background: #0c0c0c; color: #fff;
  }
  #staffModal .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  #staffModal button {
    padding: 10px 14px; border-radius: 10px; border: 0; background: #1f1f1f; color: #fff; cursor: pointer;
  }
  #staffModal button.primary { background: #0ea5a3; color: #061617; font-weight: 600; }
  `;
  const tag = document.createElement('style');
  tag.type = 'text/css';
  tag.appendChild(document.createTextNode(css));
  document.head.appendChild(tag);
})();

// ---------- State ----------
let mode = 'guest';       // default to guest
let threadId = null;      // persist conversation (server returns this)
let staffToken = null;    // no persistence -> re-prompt each refresh

// ---------- Staff Password Modal ----------
function createStaffModal() {
  const wrap = document.createElement('div');
  wrap.id = 'staffModal';
  wrap.innerHTML = `
    <div class="card">
      <h3>SPIRIT GUIDE | Staff Mode</h3>
      <label>Enter Password:</label>
      <input id="staffPassInput" type="password" autocomplete="current-password" />
      <div class="row">
        <button id="cancelStaffPass">Cancel</button>
        <button id="okStaffPass" class="primary">Enter</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  return wrap;
}

let staffModal = null;
function askStaffPassword() {
  if (!staffModal) staffModal = createStaffModal();
  const input = staffModal.querySelector('#staffPassInput');
  const okBtn = staffModal.querySelector('#okStaffPass');
  const cancelBtn = staffModal.querySelector('#cancelStaffPass');

  return new Promise((resolve) => {
    staffModal.style.display = 'flex';
    input.value = '';
    setTimeout(()=> input.focus(), 50);

    const done = (val) => {
      staffModal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

async function requireStaff() {
  const t = await askStaffPassword();
  if (!t) return false;
  staffToken = t; // in-memory only
  return true;
}

// ---------- Typing indicator ----------
let typingEl = null;
function showTyping() {
  removeTyping();
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="typing">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  typingEl = div;
}
function removeTyping() {
  if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
  typingEl = null;
}

// ---------- Render helpers ----------
function nl2br(htmlish){
  return (htmlish || '')
    .replace(/\*\*(.+?)\*\*/g, '<span class="accent-teal">$1</span>')
    .replace(/\n/g, '<br>');
}
function appendAI(text){
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = nl2br(text);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function appendUser(text){
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setMode(next){
  mode = next;
  const isGuest = mode === 'guest';

  // Toggle UI state
  staffBtn.className = isGuest ? 'off' : 'on';
  guestBtn.className = isGuest ? 'on' : 'off';
  staffBtn.setAttribute('aria-selected', String(!isGuest));
  guestBtn.setAttribute('aria-selected', String(isGuest));

  // Reset conversation thread on mode switch
  threadId = null;
  chatEl.innerHTML = '';
  const banner = isGuest
    ? `<span class="accent-strong">GUEST MODE</span>: Ask about menu items, ingredients, prices, and pairings.`
    : `<span class="accent-strong">STAFF MODE</span>: Ask for builds, presentation, or quiz yourself.`;
  appendAI(banner);
}

// ---------- Wire mode buttons ----------
staffBtn.onclick = async () => {
  const ok = await requireStaff();
  if (!ok) return;          // stay in guest if canceled
  setMode('staff');
};
guestBtn.onclick = () => setMode('guest');

// ---------- Visual viewport handling (mobile safe) ----------
function setAppHeight(){
  const h = (window.visualViewport && window.visualViewport.height)
    ? window.visualViewport.height
    : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
}
function setComposerHeight(){
  const h = composer ? composer.getBoundingClientRect().height : 88;
  document.documentElement.style.setProperty('--composer-h', `${Math.ceil(h)}px`);
}
function syncHeights(){ setAppHeight(); setComposerHeight(); }
window.addEventListener('resize', syncHeights);
window.addEventListener('orientationchange', syncHeights);
if (window.visualViewport){
  window.visualViewport.addEventListener('resize', syncHeights);
  window.visualViewport.addEventListener('scroll', syncHeights);
}

// ---------- First load ----------
setMode('guest');
syncHeights();
setTimeout(syncHeights, 150);
setTimeout(syncHeights, 600);

// ---------- Send handler (Path A payload: { query, mode, threadId, staffToken }) ----------
async function send(){
  const text = (inputEl.value || '').trim();
  if(!text) return;

  appendUser(text);
  inputEl.value = '';
  inputEl.blur();               // hide mobile keyboard
  sendBtn.disabled = true;
  showTyping();

  try{
    const res = await fetch('/api/chat', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        query: text,
        mode,
        threadId,               // reuse if present
        staffToken,             // gate staff on backend
      })
    });

    removeTyping();

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      appendAI(`A server error occurred (${res.status}).`);
      console.error('API error', res.status, t);
      return;
    }

    const data = await res.json();

    // Backend may force mode back to guest if pass invalid (we keep UI state)
    if (data.threadId) threadId = data.threadId;

    if (Array.isArray(data.bubbles) && data.bubbles.length){
      data.bubbles.forEach(b => appendAI(String(b)));
    } else {
      appendAI(data.answer || 'No answer.');
    }
  }catch(err){
    console.error(err);
    removeTyping();
    appendAI('Network error. Try again.');
  }finally{
    sendBtn.disabled = false;
  }
}

// Enter to send
inputEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){ e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

// ---------- Voice Input (Web Speech API) ----------
(function setupVoice(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !micBtn) return;

  const recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onstart = () => micBtn.classList.add('listening');
  recognition.onend   = () => micBtn.classList.remove('listening');

  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    inputEl.value = text;
    send(); // auto-send
  };

  micBtn.onclick = () => { try { recognition.start(); } catch {} };
})();
