const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB — enough for ~30s of audio
});

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

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('join', ({ callsign, department }) => {
    if (!DEPARTMENTS[department]) return;
    users[socket.id] = { callsign, department, socketId: socket.id };
    socket.join(department);
    channels[department].users.add(socket.id);
    io.to(department).emit('channel_update', getChannelInfo(department));
    socket.emit('joined', { departments: DEPARTMENTS, user: users[socket.id] });
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
    ch.chunks = []; // reset buffer for this transmission
    io.to(department).emit('transmission_start', {
      department,
      transmitter: user.callsign,
      socketId: socket.id
    });
  });

  // Collect chunks on the server — don't forward them yet
  socket.on('voice_chunk', ({ department, chunk }) => {
    const ch = channels[department];
    if (ch.transmitting === socket.id) {
      ch.chunks.push(Buffer.from(chunk));
    }
  });

  // PTT released — now send the COMPLETE audio to everyone
  socket.on('ptt_stop', ({ department }) => {
    const ch = channels[department];
    if (ch.transmitting !== socket.id) return;

    const callsign = users[socket.id]?.callsign;

    if (ch.chunks.length > 0) {
      // Concatenate all chunks into one complete audio buffer
      const fullAudio = Buffer.concat(ch.chunks);
      // Send the complete recording to everyone else on the channel
      socket.to(department).emit('voice_playback', {
        audio: fullAudio,
        transmitter: callsign
      });
      console.log(`[TX] ${callsign} sent ${fullAudio.length} bytes to ${department}`);
    }

    ch.transmitting = null;
    ch.chunks = [];
    io.to(department).emit('transmission_end', { department });
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

function getUserName(socketId) {
  return users[socketId]?.callsign || 'Unknown';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚔 Radio System running at http://localhost:${PORT}\n`);
});
