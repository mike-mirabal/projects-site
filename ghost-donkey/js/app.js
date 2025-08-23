// ===== Data bootstrapping (front-end loads JSON and sends to API) =====
let cocktailsData = {};
let spiritsData = {};

async function loadJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`Failed to load ${url}:`, e);
    return {};
  }
}

(async () => {
  // Load cocktails & spirits from local files in /data
  cocktailsData = await loadJSON("../ghost-donkey/data/cocktails.json").then(j => j || {});
  spiritsData   = await loadJSON("../ghost-donkey/data/spirits.json").then(j => j || {});

  // If index.html is at ghost-donkey/ root, prefer relative (uncomment next two lines)
  if (!Object.keys(cocktailsData).length) cocktailsData = await loadJSON("data/cocktails.json");
  if (!Object.keys(spiritsData).length)   spiritsData   = await loadJSON("data/spirits.json");
})();

// ===== UI elements =====
const chatEl   = document.getElementById('chat');
const inputEl  = document.getElementById('input');
const sendBtn  = document.getElementById('send');
const guestBtn = document.getElementById('guestBtn');
const staffBtn = document.getElementById('staffBtn');
const composer = document.getElementById('composer');
const micBtn   = document.getElementById('mic');

let mode = 'staff'; // 'guest' | 'staff'

// Render helpers
function nl2br(htmlish){
  // Replace **bold** with styled span; convert newlines to <br>
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

  // Reset chat and show mode banner message
  chatEl.innerHTML = '';
  const banner = isGuest
    ? `<span class="accent-strong">GUEST MODE</span>: Get more information about the menu, ingredients, and prices.`
    : `<span class="accent-strong">STAFF MODE</span>: Ask for Recipes, Get Info, or Test your knowledge.`;
  appendAI(banner);
}

staffBtn.onclick = () => setMode('staff');
guestBtn.onclick = () => setMode('guest');

// ===== Visual Viewport handling =====
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
function syncHeights(){
  setAppHeight();
  setComposerHeight();
}
window.addEventListener('resize', syncHeights);
window.addEventListener('orientationchange', syncHeights);
if (window.visualViewport){
  window.visualViewport.addEventListener('resize', syncHeights);
  window.visualViewport.addEventListener('scroll', syncHeights);
}

// First load -> Staff by default (only call once)
setMode('staff');
syncHeights();
setTimeout(syncHeights, 150);
setTimeout(syncHeights, 600);

// ===== Send handler =====
async function send(){
  const text = (inputEl.value || '').trim();
  if(!text) return;

  appendUser(text);
  inputEl.value = '';
  // Hide keyboard on mobile after send
  inputEl.blur();
  sendBtn.disabled = true;

  try{
    const res = await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        query: text,
        mode,
        // Pass local JSON to the API so backend can use these instead of env vars
        cocktails: cocktailsData,
        spirits: spiritsData
      })
    });

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      appendAI(`A server error occurred (${res.status}).`);
      console.error('API error', res.status, t);
      return;
    }

    const data = await res.json();
    if (Array.isArray(data.bubbles)) {
      data.bubbles.forEach(b => appendAI(String(b)));
    } else {
      appendAI(data.answer || 'No answer.');
    }
  }catch(err){
    console.error(err);
    appendAI('Network error. Try again.');
  }finally{
    sendBtn.disabled = false;
    // Don’t auto-focus to avoid popping keyboard; user taps to bring it back
  }
}

// Enter to send
inputEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){ e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

// ===== Voice Input (Web Speech API first; fallback could be added later) =====
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
    send(); // auto-send after recognition
  };

  micBtn.onclick = () => {
    try { recognition.start(); } catch {}
  };
})();
