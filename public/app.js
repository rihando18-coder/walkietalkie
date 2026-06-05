// ─── Config ───────────────────────────────────────────────────────────────────
const DEPT_CONFIG = {
  POLICE:   { name: 'Police Department',  freq: 'CH-1', color: '#1a6bb5' },
  FIRE:     { name: 'Fire Department',    freq: 'CH-2', color: '#c0392b' },
  DOT:      { name: 'D.O.T',             freq: 'CH-3', color: '#7d9b2a' },
  JMPD:     { name: 'JMPD',              freq: 'CH-4', color: '#1a8a6a' },
  DISPATCH: { name: 'Dispatch',           freq: 'CH-5', color: '#7a3ab5' },
};

// ─── State ────────────────────────────────────────────────────────────────────
let socket = null;
let myCallsign = '';
let myDept = '';
let selectedDept = '';
let isTalking = false;

// Audio TX
let audioContext = null;
let mediaStream = null;
let mediaRecorder = null;

// Beep tones
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

const deptBadge       = document.getElementById('dept-badge');
const callsignDisplay = document.getElementById('callsign-display');
const freqDisplay     = document.getElementById('freq-display');
const deptNameDisplay = document.getElementById('dept-name-display');
const txText          = document.getElementById('tx-text');
const txArea          = document.querySelector('.tx-area');
const userList        = document.getElementById('user-list');
const userCount       = document.getElementById('user-count');
const logEntries      = document.getElementById('log-entries');

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
  socket = io();
  socket.on('connect', () => socket.emit('join', { callsign: myCallsign, department: myDept }));
  socket.on('joined', () => switchToRadio());
  socket.on('connect_error', () => { loginError.textContent = 'Cannot connect to server.'; });
  setupSocketHandlers();
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

  socket.on('transmission_end', ({ department }) => {
    // RX mode will be cleared after playback finishes (inside voice_playback handler)
    // Only clear immediately if we never got audio
  });

  socket.on('channel_busy', ({ transmitter }) => {
    playBeep(BEEP_BUSY);
    pttBtn.classList.add('busy');
    setTimeout(() => pttBtn.classList.remove('busy'), 900);
    addLog('sys', `CHANNEL BUSY — ${transmitter} is transmitting`);
  });

  // Full complete audio arrives after sender releases PTT
  socket.on('voice_playback', ({ audio, transmitter }) => {
    addLog('rx', `${transmitter} — PLAYING BACK`);
    playCompleteAudio(audio).then(() => {
      setRxMode(false);
    });
  });

  socket.on('disconnect', () => {
    addLog('sys', 'DISCONNECTED FROM SERVER');
    setRxMode(false);
    setTxMode(false);
  });
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
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
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
      if (e.data.size > 0) {
        e.data.arrayBuffer().then(buf => {
          if (socket) socket.emit('voice_chunk', { department: myDept, chunk: buf });
        });
      }
    };

    // Collect in 200ms chunks while talking
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
    // onstop fires after the final ondataavailable — server gets every chunk
    mediaRecorder.onstop = () => {
      if (socket) socket.emit('ptt_stop', { department: myDept });
    };
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
  if (on) {
    txArea.classList.add('transmitting');
    txArea.classList.remove('receiving');
    txText.textContent = 'TRANSMITTING';
  } else if (!txArea.classList.contains('receiving')) {
    txArea.classList.remove('transmitting');
    txText.textContent = 'STANDBY';
  }
}

function setRxMode(on, who = '') {
  if (on) {
    txArea.classList.add('receiving');
    txArea.classList.remove('transmitting');
    txText.textContent = `RX: ${who}`;
  } else {
    txArea.classList.remove('receiving', 'transmitting');
    txText.textContent = 'STANDBY';
  }
}

// ─── Audio ────────────────────────────────────────────────────────────────────
function getBestMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

// Play a complete audio buffer (ArrayBuffer) from start to finish, returns a Promise
async function playCompleteAudio(arrayBuf) {
  return new Promise(async (resolve) => {
    try {
      if (!audioContext) audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();

      // arrayBuf arrives as a Node Buffer over socket — convert to ArrayBuffer
      const buf = arrayBuf instanceof ArrayBuffer
        ? arrayBuf
        : arrayBuf.buffer
          ? arrayBuf.buffer.slice(arrayBuf.byteOffset, arrayBuf.byteOffset + arrayBuf.byteLength)
          : new Uint8Array(Object.values(arrayBuf)).buffer;

      const decoded = await audioContext.decodeAudioData(buf);
      const src = audioContext.createBufferSource();
      src.buffer = decoded;
      src.connect(audioContext.destination);
      src.onended = resolve;
      src.start();
    } catch (e) {
      console.warn('Audio decode error:', e);
      resolve(); // don't hang even if decode fails
    }
  });
}

function playBeep({ freq, dur, vol }) {
  try {
    if (!audioContext) audioContext = new AudioContext();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.frequency.value = freq;
    osc.type = 'square';
    gain.gain.setValueAtTime(vol, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + dur / 1000);
    osc.start();
    osc.stop(audioContext.currentTime + dur / 1000);
  } catch (e) {}
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
  setRxMode(false);
  setTxMode(false);
});
