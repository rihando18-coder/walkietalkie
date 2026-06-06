// ─── Config ───────────────────────────────────────────────────────────────────
const DEPT_CONFIG = {
  POLICE:   { name: 'Police Department',  freq: 'CH-1', color: '#1a6bb5' },
  FIRE:     { name: 'Fire Department',    freq: 'CH-2', color: '#c0392b' },
  DOT:      { name: 'D.O.T',             freq: 'CH-3', color: '#7d9b2a' },
  JMPD:     { name: 'JMPD',              freq: 'CH-4', color: '#1a8a6a' },
  DISPATCH: { name: 'Dispatch',           freq: 'CH-5', color: '#7a3ab5' },
};

const ERLC_TEAM_COLORS = {
  'Police':    '#1a6bb5',
  'Sheriff':   '#1a6bb5',
  'Fire':      '#c0392b',
  'DOT':       '#7d9b2a',
  'Civilian':  '#5a6a7a',
  'Criminal':  '#8b0000',
};

// ─── State ────────────────────────────────────────────────────────────────────
let socket = null;
let myCallsign = '';
let myDept = '';
let selectedDept = '';
let isTalking = false;
let erlcConfigured = false;

let audioContext = null;
let mediaStream = null;
let mediaRecorder = null;

const rxAudio = new Audio();
rxAudio.autoplay = true;
rxAudio.setAttribute('playsinline', '');

const BEEP_TX_START = { freq: 880,  dur: 60,  vol: 0.3 };
const BEEP_TX_END   = { freq: 660,  dur: 80,  vol: 0.25 };
const BEEP_RX_START = { freq: 1200, dur: 50,  vol: 0.2 };
const BEEP_BUSY     = { freq: 440,  dur: 200, vol: 0.2 };

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const loginScreen    = document.getElementById('login-screen');
const radioScreen    = document.getElementById('radio-screen');
const callsignInput  = document.getElementById('callsign-input');
const connectBtn     = document.getElementById('connect-btn');
const loginError     = document.getElementById('login-error');
const deptBtns       = document.querySelectorAll('.dept-btn');
const pttBtn         = document.getElementById('ptt-btn');
const logoutBtn      = document.getElementById('logout-btn');
const towBtn         = document.getElementById('tow-btn');
const erlcKeyInput   = document.getElementById('erlc-key-input');
const erlcSaveBtn    = document.getElementById('erlc-save-btn');
const erlcStatus     = document.getElementById('erlc-status');
const erlcPlayerList = document.getElementById('erlc-player-list');
const erlcCallList   = document.getElementById('erlc-call-list');
const notifContainer = document.getElementById('notif-container');
const towModal       = document.getElementById('tow-modal');
const towLocation    = document.getElementById('tow-location');
const towConfirmBtn  = document.getElementById('tow-confirm-btn');
const towCancelBtn   = document.getElementById('tow-cancel-btn');
const tabBtns        = document.querySelectorAll('.tab-btn');
const tabPanels      = document.querySelectorAll('.tab-panel');

const deptBadge       = document.getElementById('dept-badge');
const callsignDisplay = document.getElementById('callsign-display');
const freqDisplay     = document.getElementById('freq-display');
const deptNameDisplay = document.getElementById('dept-name-display');
const txText          = document.getElementById('tx-text');
const txArea          = document.querySelector('.tx-area');
const userList        = document.getElementById('user-list');
const userCount       = document.getElementById('user-count');
const logEntries      = document.getElementById('log-entries');

// ─── Tabs ─────────────────────────────────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────
deptBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    deptBtns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedDept = btn.dataset.dept;
    updateConnectBtn();
  });
});

callsignInput.addEventListener('input', updateConnectBtn);
function updateConnectBtn() {
  connectBtn.disabled = !(callsignInput.value.trim().length >= 2 && selectedDept);
}

connectBtn.addEventListener('click', connect);
callsignInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !connectBtn.disabled) connect();
});

function connect() {
  const callsign = callsignInput.value.trim().toUpperCase();
  if (!callsign || !selectedDept) return;
  loginError.textContent = '';
  myCallsign = callsign;
  myDept = selectedDept;
  unlockAudio();
  socket = io();
  socket.on('connect', () => socket.emit('join', { callsign: myCallsign, department: myDept }));
  socket.on('joined', () => switchToRadio());
  socket.on('connect_error', () => { loginError.textContent = 'Cannot connect to server.'; });
  setupSocketHandlers();
}

function unlockAudio() {
  rxAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  rxAudio.play().catch(() => {});
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
}

function switchToRadio() {
  loginScreen.classList.remove('active');
  radioScreen.classList.add('active');
  const cfg = DEPT_CONFIG[myDept];
  deptBadge.textContent = myDept;
  deptBadge.className = `dept-badge ${myDept}`;
  callsignDisplay.textContent = myCallsign;
  freqDisplay.textContent = cfg.freq;
  deptNameDisplay.textContent = cfg.name;
  addLog('sys', `Connected to ${cfg.name} (${cfg.freq})`);
}

// ─── ERLC Key Setup ───────────────────────────────────────────────────────────
erlcSaveBtn.addEventListener('click', async () => {
  const key = erlcKeyInput.value.trim();
  if (!key) return;
  erlcSaveBtn.textContent = 'SAVING...';
  try {
    const res = await fetch('/api/erlc-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.ok) {
      erlcStatus.textContent = '● CONNECTED';
      erlcStatus.className = 'erlc-status connected';
      erlcKeyInput.value = '';
      erlcConfigured = true;
      addLog('sys', 'ERLC API connected');
    } else {
      erlcStatus.textContent = '● ERROR';
      erlcStatus.className = 'erlc-status error';
    }
  } catch(e) {
    erlcStatus.textContent = '● FAILED';
    erlcStatus.className = 'erlc-status error';
  }
  erlcSaveBtn.textContent = 'SAVE';
});

// ─── Tow Request ──────────────────────────────────────────────────────────────
towBtn.addEventListener('click', () => {
  towModal.classList.add('active');
  towLocation.focus();
});
towCancelBtn.addEventListener('click', () => {
  towModal.classList.remove('active');
  towLocation.value = '';
});
towConfirmBtn.addEventListener('click', sendTowRequest);
towLocation.addEventListener('keydown', e => { if (e.key === 'Enter') sendTowRequest(); });

function sendTowRequest() {
  const location = towLocation.value.trim();
  if (!location || !socket) return;
  socket.emit('tow_request', { location, callsign: myCallsign, department: myDept });
  towModal.classList.remove('active');
  towLocation.value = '';
  addLog('sys', `TOW REQUEST sent — ${location}`);
  showNotif({
    type: 'tow',
    title: '🚗 TOW REQUEST SENT',
    body: `Location: ${location}`,
    color: '#ffcc00'
  });
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
function setupSocketHandlers() {

  socket.on('channel_update', ({ count, users }) => {
    userCount.textContent = count;
    userList.innerHTML = users && users.length > 0
      ? users.map(u => `<span class="user-tag">${u}</span>`).join('')
      : '<span class="no-users">No units connected</span>';
  });

  socket.on('transmission_start', ({ transmitter, socketId }) => {
    if (socketId === socket.id) return;
    setRxMode(true, transmitter);
    playBeep(BEEP_RX_START);
    addLog('rx', `${transmitter} — TRANSMITTING`);
  });

  socket.on('transmission_end', () => {});

  socket.on('channel_busy', ({ transmitter }) => {
    playBeep(BEEP_BUSY);
    pttBtn.classList.add('busy');
    setTimeout(() => pttBtn.classList.remove('busy'), 900);
    addLog('sys', `CHANNEL BUSY — ${transmitter} is transmitting`);
  });

  socket.on('voice_playback', ({ audio, transmitter }) => {
    addLog('rx', `${transmitter} — playing`);
    playAudioBlob(audio).then(() => setRxMode(false));
  });

  // ERLC events
  socket.on('erlc_players', (players) => renderPlayers(players));
  socket.on('erlc_calls',   (calls)   => renderCalls(calls));
  socket.on('erlc_new_call', (call)   => {
    showNotif({
      type: 'call',
      title: `📞 ${call.Type || call.type || 'NEW CALL'}`,
      body: call.Description || call.description || call.Location || '',
      color: '#00aaff'
    });
    addLog('sys', `ERLC CALL: ${call.Type || call.type || ''} — ${call.Description || call.description || ''}`);
  });

  socket.on('tow_alert', ({ callsign, department, location }) => {
    showNotif({
      type: 'tow',
      title: '🚗 TOW TRUCK REQUESTED',
      body: `${callsign} (${department}) — ${location}`,
      color: '#ffcc00'
    });
    addLog('sys', `TOW REQUEST from ${callsign} at ${location}`);
  });

  socket.on('disconnect', () => {
    addLog('sys', 'DISCONNECTED FROM SERVER');
    setRxMode(false);
    setTxMode(false);
  });
}

// ─── ERLC Rendering ───────────────────────────────────────────────────────────
function renderPlayers(players) {
  if (!players || players.length === 0) {
    erlcPlayerList.innerHTML = '<div class="erlc-empty">No players online</div>';
    return;
  }
  // Group by team
  const teams = {};
  players.forEach(p => {
    const team = p.Team || p.team || 'Unknown';
    if (!teams[team]) teams[team] = [];
    teams[team].push(p);
  });

  erlcPlayerList.innerHTML = Object.entries(teams).map(([team, members]) => `
    <div class="erlc-team">
      <div class="erlc-team-header" style="border-color:${ERLC_TEAM_COLORS[team] || '#5a6a7a'}">
        <span style="color:${ERLC_TEAM_COLORS[team] || '#5a6a7a'}">${team}</span>
        <span class="erlc-team-count">${members.length}</span>
      </div>
      ${members.map(p => `
        <div class="erlc-player">
          <span class="erlc-player-name">${p.Player || p.Username || p.name || 'Unknown'}</span>
          ${p.Permission ? `<span class="erlc-player-rank">${p.Permission}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderCalls(calls) {
  if (!calls || calls.length === 0) {
    erlcCallList.innerHTML = '<div class="erlc-empty">No active calls</div>';
    return;
  }
  erlcCallList.innerHTML = calls.map(c => {
    const type = c.Type || c.type || 'Call';
    const desc = c.Description || c.description || '';
    const loc  = c.Location || c.location || '';
    const caller = c.Caller || c.caller || '';
    return `
      <div class="erlc-call-card">
        <div class="erlc-call-type">${type}</div>
        ${desc ? `<div class="erlc-call-desc">${desc}</div>` : ''}
        ${loc  ? `<div class="erlc-call-loc">📍 ${loc}</div>` : ''}
        ${caller ? `<div class="erlc-call-caller">👤 ${caller}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ─── Notifications ────────────────────────────────────────────────────────────
function showNotif({ title, body, color }) {
  const notif = document.createElement('div');
  notif.className = 'notif';
  notif.style.borderLeftColor = color || '#00aaff';
  notif.innerHTML = `
    <div class="notif-title" style="color:${color || '#00aaff'}">${title}</div>
    ${body ? `<div class="notif-body">${body}</div>` : ''}
    <button class="notif-close">✕</button>
  `;
  notif.querySelector('.notif-close').addEventListener('click', () => dismissNotif(notif));
  notifContainer.appendChild(notif);
  // Auto dismiss after 8s
  setTimeout(() => dismissNotif(notif), 8000);
}

function dismissNotif(notif) {
  notif.classList.add('dismissing');
  setTimeout(() => notif.remove(), 350);
}

// ─── PTT ──────────────────────────────────────────────────────────────────────
pttBtn.addEventListener('mousedown',  startPTT);
pttBtn.addEventListener('mouseup',    stopPTT);
pttBtn.addEventListener('mouseleave', stopPTT);
pttBtn.addEventListener('touchstart', e => { e.preventDefault(); startPTT(); }, { passive: false });
pttBtn.addEventListener('touchend',   e => { e.preventDefault(); stopPTT(); });

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && document.activeElement !== callsignInput) {
    e.preventDefault(); startPTT();
  }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') stopPTT(); });

async function startPTT() {
  if (isTalking || !socket) return;
  socket.emit('ptt_start', { department: myDept });
  try {
    if (!mediaStream) mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    isTalking = true;
    pttBtn.classList.add('active');
    setTxMode(true);
    playBeep(BEEP_TX_START);
    addLog('tx', `${myCallsign} — TRANSMITTING`);
    const mimeType = getBestMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) e.data.arrayBuffer().then(buf => {
        if (socket) socket.emit('voice_chunk', { department: myDept, chunk: buf });
      });
    };
    mediaRecorder.start(200);
  } catch (err) {
    console.error('Mic error:', err);
    addLog('sys', 'MIC ACCESS DENIED — Check browser permissions');
    isTalking = false;
    pttBtn.classList.remove('active');
    setTxMode(false);
  }
}

function stopPTT() {
  if (!isTalking) return;
  isTalking = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => { if (socket) socket.emit('ptt_stop', { department: myDept }); };
    mediaRecorder.stop();
  } else {
    if (socket) socket.emit('ptt_stop', { department: myDept });
  }
  pttBtn.classList.remove('active');
  setTxMode(false);
  playBeep(BEEP_TX_END);
}

// ─── UI States ────────────────────────────────────────────────────────────────
function setTxMode(on) {
  if (on) { txArea.classList.add('transmitting'); txArea.classList.remove('receiving'); txText.textContent = 'TRANSMITTING'; }
  else if (!txArea.classList.contains('receiving')) { txArea.classList.remove('transmitting'); txText.textContent = 'STANDBY'; }
}
function setRxMode(on, who = '') {
  if (on) { txArea.classList.add('receiving'); txArea.classList.remove('transmitting'); txText.textContent = `RX: ${who}`; }
  else { txArea.classList.remove('receiving', 'transmitting'); txText.textContent = 'STANDBY'; }
}

// ─── Audio ────────────────────────────────────────────────────────────────────
function getBestMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

function playAudioBlob(data) {
  return new Promise((resolve) => {
    try {
      let uint8;
      if (data instanceof ArrayBuffer) uint8 = new Uint8Array(data);
      else if (data && data.buffer) uint8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data && typeof data === 'object') uint8 = new Uint8Array(Object.values(data));
      else { resolve(); return; }
      const mimeType = (uint8[0] === 0x1A && uint8[1] === 0x45) ? 'audio/webm' : 'audio/ogg';
      const blob = new Blob([uint8], { type: mimeType });
      const url = URL.createObjectURL(blob);
      if (rxAudio.src && rxAudio.src.startsWith('blob:')) URL.revokeObjectURL(rxAudio.src);
      rxAudio.src = url;
      rxAudio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      rxAudio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      const p = rxAudio.play();
      if (p) p.catch(() => resolve());
    } catch(e) { resolve(); }
  });
}

function playBeep({ freq, dur, vol }) {
  try {
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.frequency.value = freq; osc.type = 'square';
    gain.gain.setValueAtTime(vol, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + dur / 1000);
    osc.start(); osc.stop(audioContext.currentTime + dur / 1000);
  } catch(e) {}
}

// ─── Log ──────────────────────────────────────────────────────────────────────
function addLog(type, message) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span>${message}</span>`;
  logEntries.appendChild(entry);
  logEntries.scrollTop = logEntries.scrollHeight;
  while (logEntries.children.length > 50) logEntries.removeChild(logEntries.firstChild);
}

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn.addEventListener('click', () => {
  if (socket) { socket.disconnect(); socket = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  isTalking = false;
  radioScreen.classList.remove('active');
  loginScreen.classList.add('active');
  userList.innerHTML = '<span class="no-users">No units connected</span>';
  logEntries.innerHTML = '';
  setRxMode(false); setTxMode(false);
});
