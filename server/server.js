const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 10 * 1024 * 1024
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DEPARTMENTS = {
  POLICE:   { id: 'POLICE',   name: 'Police',          freq: 'CH-1' },
  FIRE:     { id: 'FIRE',     name: 'Fire Department', freq: 'CH-2' },
  DOT:      { id: 'DOT',      name: 'D.O.T',           freq: 'CH-3' },
  JMPD:     { id: 'JMPD',     name: 'JMPD',            freq: 'CH-4' },
  DISPATCH: { id: 'DISPATCH', name: 'Dispatch',        freq: 'CH-5' }
};

const channels = {};
const users = {};

Object.keys(DEPARTMENTS).forEach(dep => {
  channels[dep] = { users: new Set(), transmitting: null, chunks: [] };
});

// ─── ERLC API ─────────────────────────────────────────────────────────────────
let ERLC_API_KEY = process.env.ERLC_API_KEY || '';
const ERLC_BASE  = 'https://api.policeroleplay.community/v1/server';
let lastCallIds  = new Set();
let erlcPlayers  = [];
let erlcCalls    = [];
let erlcInterval = null;

async function fetchErlc(endpoint) {
  if (!ERLC_API_KEY) return null;
  try {
    const res = await fetch(`${ERLC_BASE}${endpoint}`, {
      headers: { 'Server-Key': ERLC_API_KEY }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[ERLC] fetch error:', e.message);
    return null;
  }
}

async function pollErlc() {
  const [players, calls] = await Promise.all([
    fetchErlc('/players'),
    fetchErlc('/calls')
  ]);

  if (players) {
    erlcPlayers = Array.isArray(players) ? players : (players.Players || []);
    io.emit('erlc_players', erlcPlayers);
  }

  if (calls) {
    const callList = Array.isArray(calls) ? calls : (calls.Calls || []);

    // Find new calls since last poll
    const newCalls = callList.filter(c => !lastCallIds.has(String(c.ID || c.id)));
    newCalls.forEach(c => {
      io.emit('erlc_new_call', c);
    });

    lastCallIds = new Set(callList.map(c => String(c.ID || c.id)));
    erlcCalls = callList;
    io.emit('erlc_calls', erlcCalls);
  }
}

function startErlcPolling() {
  if (!ERLC_API_KEY) return;
  pollErlc();
  erlcInterval = setInterval(pollErlc, 10000);
  console.log('[ERLC] Polling started');
}

// Endpoint to set API key at runtime
app.post('/api/erlc-key', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'No key provided' });
  ERLC_API_KEY = key;
  if (erlcInterval) clearInterval(erlcInterval);
  startErlcPolling();
  res.json({ ok: true });
});

app.get('/api/erlc-status', (req, res) => {
  res.json({ connected: !!ERLC_API_KEY, players: erlcPlayers.length, calls: erlcCalls.length });
});

// ─── Radio socket ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // Send current ERLC state to newly joined user
  socket.on('join', ({ callsign, department }) => {
    if (!DEPARTMENTS[department]) return;
    users[socket.id] = { callsign, department, socketId: socket.id };
    socket.join(department);
    channels[department].users.add(socket.id);
    io.to(department).emit('channel_update', getChannelInfo(department));
    socket.emit('joined', { departments: DEPARTMENTS, user: users[socket.id] });
    // Send current ERLC snapshot to this user
    if (erlcPlayers.length) socket.emit('erlc_players', erlcPlayers);
    if (erlcCalls.length)   socket.emit('erlc_calls',   erlcCalls);
    console.log(`[JOIN] ${callsign} -> ${department}`);
  });

  socket.on('ptt_start', ({ department }) => {
    const user = users[socket.id];
    if (!user) return;
    const ch = channels[department];
    if (ch.transmitting && ch.transmitting !== socket.id) {
      socket.emit('channel_busy', { department, transmitter: getUserName(ch.transmitting) });
      return;
    }
    ch.transmitting = socket.id;
    ch.chunks = [];
    io.to(department).emit('transmission_start', {
      department, transmitter: user.callsign, socketId: socket.id
    });
  });

  socket.on('voice_chunk', ({ department, chunk }) => {
    const ch = channels[department];
    if (ch.transmitting === socket.id) {
      ch.chunks.push(Buffer.from(chunk));
    }
  });

  socket.on('ptt_stop', ({ department }) => {
    const ch = channels[department];
    if (ch.transmitting !== socket.id) return;
    const callsign = users[socket.id]?.callsign;
    if (ch.chunks.length > 0) {
      const fullAudio = Buffer.concat(ch.chunks);
      socket.to(department).emit('voice_playback', { audio: fullAudio, transmitter: callsign });
    }
    ch.transmitting = null;
    ch.chunks = [];
    io.to(department).emit('transmission_end', { department });
  });

  // Tow request — broadcast to ALL departments
  socket.on('tow_request', ({ location, callsign, department }) => {
    console.log(`[TOW] ${callsign} from ${department} at ${location}`);
    io.emit('tow_alert', { callsign, department, location, time: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      const ch = channels[user.department];
      ch.users.delete(socket.id);
      if (ch.transmitting === socket.id) {
        ch.transmitting = null;
        ch.chunks = [];
        io.to(user.department).emit('transmission_end', { department: user.department });
      }
      io.to(user.department).emit('channel_update', getChannelInfo(user.department));
      delete users[socket.id];
      console.log(`[LEAVE] ${user.callsign} from ${user.department}`);
    }
  });
});

function getChannelInfo(department) {
  const ch = channels[department];
  return {
    department,
    count: ch.users.size,
    transmitting: ch.transmitting ? getUserName(ch.transmitting) : null,
    users: [...ch.users].map(id => users[id]?.callsign).filter(Boolean)
  };
}
function getUserName(socketId) { return users[socketId]?.callsign || 'Unknown'; }

startErlcPolling();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🚔 Radio System running at http://localhost:${PORT}\n`));
