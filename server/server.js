const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../public')));

// Departments config
const DEPARTMENTS = {
  POLICE:   { id: 'POLICE',   name: 'Police',          color: '#1a3a6b', freq: 'CH-1' },
  FIRE:     { id: 'FIRE',     name: 'Fire Department', color: '#8b1a1a', freq: 'CH-2' },
  DOT:      { id: 'DOT',      name: 'D.O.T',           color: '#5a6b1a', freq: 'CH-3' },
  JMPD:     { id: 'JMPD',     name: 'JMPD',            color: '#2a5a4a', freq: 'CH-4' },
  DISPATCH: { id: 'DISPATCH', name: 'Dispatch',        color: '#4a2a6b', freq: 'CH-5' }
};

// Track who is in which channel and who is transmitting
const channels = {};
const users = {};

Object.keys(DEPARTMENTS).forEach(dep => {
  channels[dep] = { users: new Set(), transmitting: null };
});

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // User joins with callsign + department
  socket.on('join', ({ callsign, department }) => {
    if (!DEPARTMENTS[department]) return;

    users[socket.id] = { callsign, department, socketId: socket.id };
    socket.join(department);
    channels[department].users.add(socket.id);

    io.to(department).emit('channel_update', getChannelInfo(department));
    socket.emit('joined', { departments: DEPARTMENTS, user: users[socket.id] });
    console.log(`[JOIN] ${callsign} -> ${department}`);
  });

  // PTT (push to talk) start
  socket.on('ptt_start', ({ department }) => {
    const user = users[socket.id];
    if (!user) return;

    const ch = channels[department];
    // Only allow if channel is free
    if (ch.transmitting && ch.transmitting !== socket.id) {
      socket.emit('channel_busy', { department, transmitter: getUserName(ch.transmitting) });
      return;
    }

    ch.transmitting = socket.id;
    io.to(department).emit('transmission_start', {
      department,
      transmitter: user.callsign,
      socketId: socket.id
    });
  });

  // PTT stop
  socket.on('ptt_stop', ({ department }) => {
    const ch = channels[department];
    if (ch.transmitting === socket.id) {
      ch.transmitting = null;
      io.to(department).emit('transmission_end', { department });
    }
  });

  // WebRTC signaling
  socket.on('signal', ({ to, signal, department }) => {
    io.to(to).emit('signal', { from: socket.id, signal, department, callsign: users[socket.id]?.callsign });
  });

  // Relay voice chunk to channel (binary audio data)
  socket.on('voice_chunk', ({ department, chunk }) => {
    const ch = channels[department];
    if (ch.transmitting === socket.id) {
      socket.to(department).emit('voice_chunk', {
        chunk,  // ArrayBuffer — Socket.IO handles binary automatically
        transmitter: users[socket.id]?.callsign
      });
    }
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      const ch = channels[user.department];
      ch.users.delete(socket.id);
      if (ch.transmitting === socket.id) ch.transmitting = null;
      io.to(user.department).emit('channel_update', getChannelInfo(user.department));
      io.to(user.department).emit('transmission_end', { department: user.department });
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