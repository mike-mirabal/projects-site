// ===== Spirit Guide (Path A: Assistants + Vector Stores) =====

// UI elements
const chatEl   = document.getElementById('chat');
const inputEl  = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const guestBtn = document.getElementById('guestBtn');
const staffBtn = document.getElementById('staffBtn');
const composer = document.getElementById('composer');
const micBtn   = document.getElementById('mic');

// State
let mode = 'staff';       // 'guest' | 'staff'
let threadId = null;      // persist conversation (server returns this)

// Render helpers
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

staffBtn.onclick = () => setMode('staff');
guestBtn.onclick = () => setMode('guest');

// Visual viewport handling (mobile safe)
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

// First load
setMode('staff');
syncHeights();
setTimeout(syncHeights, 150);
setTimeout(syncHeights, 600);

// ----- Send handler (Path A payload: { query, mode, threadId }) -----
async function send(){
  const text = (inputEl.value || '').trim();
  if(!text) return;

  appendUser(text);
  inputEl.value = '';
  inputEl.blur();               // hide mobile keyboard
  sendBtn.disabled = true;

  try{
    const res = await fetch('/api/chat', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        query: text,
        mode,
        threadId,               // reuse if present
      })
    });

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      appendAI(`A server error occurred (${res.status}).`);
      console.error('API error', res.status, t);
      return;
    }

    const data = await res.json();

    // Save returned threadId for multi-turn context
    if (data.threadId) threadId = data.threadId;

    if (Array.isArray(data.bubbles) && data.bubbles.length){
      data.bubbles.forEach(b => appendAI(String(b)));
    } else {
      appendAI(data.answer || 'No answer.');
    }
  }catch(err){
    console.error(err);
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

// ----- Voice Input (Web Speech API) -----
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
