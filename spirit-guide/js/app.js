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
  .typing .dot {
    width:6px; height:6px; border-radius:50%;
    background: var(--teal, #32e6b7);   /* <-- add this line */
    opacity:.5; animation:bounce 1.2s infinite ease-in-out;
  }
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

  /* --- About modal (opens from hint tap) --- */
  #aboutModal {
    position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.6); z-index: 9999; padding: 12px;
  }
  #aboutModal * { box-sizing: border-box; }
  #aboutModal .card {
    background: #f3d9d9; color: #09080a; width: min(92vw, 560px);
    border:var(--border) solid var(--accent);
    border-radius: 4px; padding: 18px 16px 16px;
    box-shadow: 0 16px 48px rgba(0,0,0,.55);
    position: relative;
  }
  #aboutModal h3 {git c
    font-size: 1.2rem;  
    font-weight: 900;
    color: var(--teal, #55c4bb); 
  }
  #aboutModal p {
    margin: 8px 0; line-height: 1.35; font-size: 14px;
  }
  #aboutModal .close {
    position: absolute; top: 10px; right: 10px;
    height: 28px; width: 28px; border-radius: 8px;
    display: inline-grid; place-items: center;
    border: none; outline: none; background: transparent; color: #ee4d36;
    cursor: pointer; font-size: 1.5rem; line-height: 1;
  }
  #aboutModal .close:hover,
#aboutModal .close:focus { 
  background: transparent;
  outline: none; 
}
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
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="staffModalTitle">
      <h3 id="staffModalTitle">SPIRIT GUIDE | Staff Mode</h3>
      <label for="staffPassInput">Enter Password:</label>
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

// ---------- About Modal (opens from hint tap/click) ----------
function createAboutModal() {
  const wrap = document.createElement('div');
  wrap.id = 'aboutModal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'aboutTitle');

  wrap.innerHTML = `
    <div class="card">
      <button class="close" id="aboutClose" aria-label="Close">×</button>
      <h3 id="aboutTitle">ABOUT SPIRIT GUIDE</h3>
      <p><span class="accent-medium">What is this?</span> <strong>Spirit Guide</strong> is a full-stack web application that streamlines bar operations by providing instant access to cocktail specs and menu information for staff training and customer service. This independent passion project explores AI-powered hospitality solutions.</p>

      <p><span class="accent-medium">Who built it?</span> Created by <strong>Mike Mirabal</strong> — designer and software developer who bartends at Ghost Donkey, combining hospitality expertise with technical skills to solve real industry challenges.</p>

      <p><span class="accent-medium">Why build it?</span> Initially created to help staff learn and retain detailed cocktail specs and spirit knowledge, the project evolved into exploring whether AI-powered tools could intelligently elevate hospitality service, making training faster and menu knowledge easier to access without flipping through binders or searching random links.</p>

      <p><span class="accent-medium">About AIgentask:</span> <strong>AIgentask</strong> is a small software company specializing in AI-powered solutions and automation workflows. Spirit Guide demonstrates end-to-end product development—from identifying operational pain points to deploying practical technical solutions.</p>
    </div>
  `;
  document.body.appendChild(wrap);

  const closeBtn = wrap.querySelector('#aboutClose');
  const onClose = () => hideAboutModal();
  closeBtn.addEventListener('click', onClose);

  // Click outside card closes
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) hideAboutModal();
  });

  // Esc closes
  document.addEventListener('keydown', function escHandler(e){
    if (wrap.style.display === 'flex' && e.key === 'Escape') hideAboutModal();
  });

  return wrap;
}

let aboutModal = null;
let aboutPrevFocus = null;

function showAboutModal() {
  if (!aboutModal) aboutModal = createAboutModal();
  aboutPrevFocus = document.activeElement;
  aboutModal.style.display = 'flex';
  const closeBtn = aboutModal.querySelector('#aboutClose');
  setTimeout(() => closeBtn && closeBtn.focus(), 50);
}

function hideAboutModal() {
  if (!aboutModal) return;
  aboutModal.style.display = 'none';
  if (aboutPrevFocus && typeof aboutPrevFocus.focus === 'function') {
    aboutPrevFocus.focus();
  }
}

// ---------- Typing indicator ----------
let typingEl = null;
function showTyping() {
  if (typingEl) return; // already showing
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.setAttribute('role', 'status');
  div.setAttribute('aria-live', 'polite');
  div.innerHTML = `
    <div class="typing" aria-label="Assistant is typing">
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

// ---------- Spacing compactor ----------
function compactHTML(html) {
  let s = String(html || '');
  // Normalize <br> variants
  s = s.replace(/<br\s*\/?>/gi, '<br>');
  // Collapse any runs of <br> to a single <br>
  s = s.replace(/(?:\s*<br>\s*){2,}/gi, '<br>');
  // Trim leading/trailing <br>
  s = s.replace(/^(?:\s*<br>)+/i, '');
  s = s.replace(/(?:\s*<br>)+\s*$/i, '');
  // Collapse 3+ raw newlines to one blank line
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
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
  div.innerHTML = compactHTML(nl2br(text));
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
    ? `<span class="accent-strong">GUEST MODE</span>: Ask me anything about the menu, drinks, restaurant info, reservations, location, or recommendations.`
    : `<span class="accent-strong">STAFF MODE</span>: Ask for builds, spirits info, pairings, or quiz yourself on cocktail knowledge.`;
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

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      removeTyping();
      appendAI(`A server error occurred (${res.status}).`);
      console.error('API error', res.status, t);
      return;
    }

    const data = await res.json();

    // store threadId for this session
    if (data.threadId) threadId = data.threadId;

    removeTyping(); // hide typing before rendering bubbles

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

// ---------- OPEN ABOUT MODAL WHEN HINT IS CLICKED ----------
(function wireAboutHint(){
  const hint = document.querySelector('.hint');
  if (!hint) return;
  hint.style.cursor = 'pointer';
  hint.addEventListener('click', showAboutModal);
})();
