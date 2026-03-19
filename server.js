const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/**
 * Team buzz mode:
 * - "one_at_a_time": only one teammate can be queued/answering at once
 * - "one_per_question": once any teammate buzzes during a question, that team is blocked until reset_buzzers
 */
const TEAM_BUZZ_MODES = {
  ONE_AT_A_TIME: 'one_at_a_time',
  ONE_PER_QUESTION: 'one_per_question',
};

const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function getRoomByCode(code) {
  return Object.values(rooms).find(r => r.code === code);
}
function sanitize(str) {
  return String(str).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normalizeTeam(team) {
  return sanitize(team || '').trim().substring(0, 20);
}

function playerScore(room, playerId) {
  const p = room.players[playerId];
  if (!p) return 0;
  const team = normalizeTeam(p.team);
  if (team) return room.teamScores[team] ?? 0;
  return room.teamScores[playerId] ?? 0;
}
function setScoreForPlayer(room, playerId, score) {
  const p = room.players[playerId];
  if (!p) return;
  const team = normalizeTeam(p.team);
  const key = team || playerId;
  room.teamScores[key] = score;
}
function updateScoreForPlayer(room, playerId, delta) {
  const p = room.players[playerId];
  if (!p) return;
  const team = normalizeTeam(p.team);
  const key = team || playerId;
  room.teamScores[key] = (room.teamScores[key] ?? 0) + delta;
}

function rebuildBuzzedTeams(room) {
  room.buzzedTeams = new Set();
  for (const id of room.buzzOrder) {
    const p = room.players[id];
    if (!p) continue;
    const team = normalizeTeam(p.team);
    if (team) room.buzzedTeams.add(team);
  }
  if (room.answerTimer.currentPlayerId) {
    const p = room.players[room.answerTimer.currentPlayerId];
    const team = p ? normalizeTeam(p.team) : '';
    if (team) room.buzzedTeams.add(team);
  }
}

function broadcastRoomState(room) {
  const state = {
    code: room.code,
    locked: room.locked,
    buzzOrder: room.buzzOrder,
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      team: p.team,
      locked: p.locked,
      buzzedAt: p.buzzedAt,
      score: playerScore(room, id),
    })),
    answerSecondsDefault: room.answerSecondsDefault,
    answerTimer: {
      running: room.answerTimer.running,
      value: room.answerTimer.value,
      currentPlayerId: room.answerTimer.currentPlayerId
    },
    teamBuzzMode: room.teamBuzzMode
  };
  io.to(room.code).emit('room_state', state);
}

function clearAnswerTimer(room) {
  if (room.answerTimer.interval) {
    clearInterval(room.answerTimer.interval);
    room.answerTimer.interval = null;
  }
  room.answerTimer.running = false;
  room.answerTimer.value = 0;
  room.answerTimer.currentPlayerId = null;
}

function lockPlayerAfterBuzz(room, playerId) {
  if (room.players[playerId]) room.players[playerId].locked = true;
}

function removeFromQueue(room, playerId) {
  room.buzzOrder = room.buzzOrder.filter(id => id !== playerId);
  const p = room.players[playerId];
  if (p) p.buzzedAt = null;
  rebuildBuzzedTeams(room);
}

function startAnswerTimerForNext(room) {
  if (room.answerTimer.running) return;

  while (room.buzzOrder.length > 0 && !room.players[room.buzzOrder[0]]) {
    room.buzzOrder.shift();
  }
  const nextId = room.buzzOrder[0];
  if (!nextId) {
    clearAnswerTimer(room);
    io.to(room.code).emit('answer_timer_update', { running: false, value: 0, currentPlayerId: null });
    broadcastRoomState(room);
    return;
  }

  const seconds = parseInt(room.answerSecondsDefault) || 8;
  room.answerTimer.running = true;
  room.answerTimer.value = seconds;
  room.answerTimer.currentPlayerId = nextId;

  io.to(room.code).emit('answer_timer_update', {
    running: true,
    value: room.answerTimer.value,
    currentPlayerId: room.answerTimer.currentPlayerId
  });

  if (room.answerTimer.interval) clearInterval(room.answerTimer.interval);
  room.answerTimer.interval = setInterval(() => {
    room.answerTimer.value--;
    if (room.answerTimer.value <= 0) {
      room.answerTimer.value = 0;

      io.to(room.code).emit('answer_timer_update', {
        running: false,
        value: 0,
        currentPlayerId: room.answerTimer.currentPlayerId
      });
      io.to(room.code).emit('answer_timer_expired', { playerId: room.answerTimer.currentPlayerId });

      const expiredId = room.answerTimer.currentPlayerId;
      clearAnswerTimer(room);
      removeFromQueue(room, expiredId);

      broadcastRoomState(room);
      startAnswerTimerForNext(room);
    } else {
      io.to(room.code).emit('answer_timer_update', {
        running: true,
        value: room.answerTimer.value,
        currentPlayerId: room.answerTimer.currentPlayerId
      });
    }
  }, 1000);

  rebuildBuzzedTeams(room);
  broadcastRoomState(room);
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ hostName }, cb) => {
    const code = generateCode();
    const room = {
      code,
      hostSocketId: socket.id,
      locked: false,
      players: {},
      buzzOrder: [],
      buzzedTeams: new Set(),
      teamBuzzedThisQuestion: new Set(),
      teamScores: {},
      answerSecondsDefault: 8,
      answerTimer: { running: false, value: 0, interval: null, currentPlayerId: null },
      teamBuzzMode: TEAM_BUZZ_MODES.ONE_AT_A_TIME
    };
    rooms[socket.id] = room;
    socket.join(code);
    cb({ code });
    broadcastRoomState(room);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    const room = getRoomByCode(String(code || '').toUpperCase());
    if (!room) return cb({ error: 'Room not found.' });

    const safeName = sanitize(name).trim().substring(0, 24);
    if (!safeName) return cb({ error: 'Name cannot be empty.' });
    const duplicate = Object.values(room.players).find(p => p.name.toLowerCase() === safeName.toLowerCase());
    if (duplicate) return cb({ error: 'Name already taken.' });

    room.players[socket.id] = { name: safeName, team: '', locked: false, buzzedAt: null };
    room.teamScores[socket.id] = room.teamScores[socket.id] ?? 0;

    socket.join(room.code);
    cb({ success: true, name: safeName, code: room.code });
    broadcastRoomState(room);
  });

  socket.on('buzz', () => {
    const room = Object.values(rooms).find(r => r.players[socket.id]);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    if (room.locked) return;    // host lock-all
    if (player.locked) return;  // player already buzzed this question
    if (room.buzzOrder.includes(socket.id)) return;

    const team = normalizeTeam(player.team);

    if (team) {
      if (room.teamBuzzMode === TEAM_BUZZ_MODES.ONE_AT_A_TIME) {
        rebuildBuzzedTeams(room);
        if (room.buzzedTeams.has(team)) return;
      } else if (room.teamBuzzMode === TEAM_BUZZ_MODES.ONE_PER_QUESTION) {
        if (room.teamBuzzedThisQuestion.has(team)) return;
      }
    }

    player.buzzedAt = Date.now();
    room.buzzOrder.push(socket.id);

    // Lock THIS player immediately (until reset)
    lockPlayerAfterBuzz(room, socket.id);

    if (team && room.teamBuzzMode === TEAM_BUZZ_MODES.ONE_PER_QUESTION) {
      room.teamBuzzedThisQuestion.add(team);
    }

    rebuildBuzzedTeams(room);

    // host-only sound
    io.to(room.hostSocketId).emit('host_buzz_sound');

    io.to(room.code).emit('player_buzzed', {
      id: socket.id,
      name: player.name,
      team: player.team,
      position: room.buzzOrder.length,
    });

    broadcastRoomState(room);
    startAnswerTimerForNext(room);
  });

  socket.on('reset_buzzers', () => {
    const room = rooms[socket.id];
    if (!room) return;

    room.buzzOrder = [];
    Object.values(room.players).forEach(p => {
      p.buzzedAt = null;
      p.locked = false; // unlock everyone
    });

    clearAnswerTimer(room);
    rebuildBuzzedTeams(room);
    room.teamBuzzedThisQuestion = new Set();

    io.to(room.code).emit('buzzers_reset');
    io.to(room.code).emit('answer_timer_update', { running: false, value: 0, currentPlayerId: null });

    broadcastRoomState(room);
  });

  socket.on('set_lock', ({ locked }) => {
    const room = rooms[socket.id];
    if (!room) return;
    room.locked = !!locked;
    broadcastRoomState(room);
  });

  socket.on('set_player_lock', ({ playerId, locked }) => {
    const room = rooms[socket.id];
    if (!room) return;
    if (room.players[playerId]) room.players[playerId].locked = !!locked;
    broadcastRoomState(room);
  });

  socket.on('set_team', ({ playerId, team }) => {
    const room = rooms[socket.id];
    if (!room) return;
    if (!room.players[playerId]) return;

    const newTeam = normalizeTeam(team);
    room.players[playerId].team = newTeam;
    if (newTeam) room.teamScores[newTeam] = room.teamScores[newTeam] ?? 0;

    // Clean queue: keep first queued per team
    let seen = new Set();
    const newOrder = [];
    for (const id of room.buzzOrder) {
      const p = room.players[id];
      if (!p) continue;
      const t = normalizeTeam(p.team);
      if (!t) { newOrder.push(id); continue; }
      if (!seen.has(t)) {
        seen.add(t);
        newOrder.push(id);
      } else {
        p.buzzedAt = null;
      }
    }
    room.buzzOrder = newOrder;

    rebuildBuzzedTeams(room);
    broadcastRoomState(room);
  });

  socket.on('update_score', ({ playerId, delta }) => {
    const room = rooms[socket.id];
    if (!room) return;
    if (!room.players[playerId]) return;

    const d = Number(delta);
    if (!Number.isFinite(d)) return;
    updateScoreForPlayer(room, playerId, d);
    broadcastRoomState(room);
  });

  socket.on('set_score', ({ playerId, score }) => {
    const room = rooms[socket.id];
    if (!room) return;
    if (!room.players[playerId]) return;

    let s = Number(score);
    if (!Number.isFinite(s)) s = 0;
    s = Math.trunc(s);
    setScoreForPlayer(room, playerId, s);
    broadcastRoomState(room);
  });

  socket.on('set_answer_seconds', ({ seconds }) => {
    const room = rooms[socket.id];
    if (!room) return;
    const n = Math.max(1, Math.min(300, parseInt(seconds) || 8));
    room.answerSecondsDefault = n;
    broadcastRoomState(room);
  });

  socket.on('clear_answer_timer', () => {
    const room = rooms[socket.id];
    if (!room) return;

    const cur = room.answerTimer.currentPlayerId;
    clearAnswerTimer(room);
    if (cur) removeFromQueue(room, cur);

    io.to(room.code).emit('answer_timer_update', { running: false, value: 0, currentPlayerId: null });
    broadcastRoomState(room);
    startAnswerTimerForNext(room);
  });

  socket.on('set_team_buzz_mode', ({ mode }) => {
    const room = rooms[socket.id];
    if (!room) return;

    const m = String(mode || '');
    if (m !== TEAM_BUZZ_MODES.ONE_AT_A_TIME && m !== TEAM_BUZZ_MODES.ONE_PER_QUESTION) return;

    room.teamBuzzMode = m;

    // If switching to strict mid-question, mark teams already queued/answering as "buzzed"
    if (room.teamBuzzMode === TEAM_BUZZ_MODES.ONE_PER_QUESTION) {
      const s = new Set(room.teamBuzzedThisQuestion);
      for (const id of room.buzzOrder) {
        const p = room.players[id];
        if (!p) continue;
        const t = normalizeTeam(p.team);
        if (t) s.add(t);
      }
      if (room.answerTimer.currentPlayerId) {
        const p = room.players[room.answerTimer.currentPlayerId];
        const t = p ? normalizeTeam(p.team) : '';
        if (t) s.add(t);
      }
      room.teamBuzzedThisQuestion = s;
    }

    broadcastRoomState(room);
  });

  socket.on('kick_player', ({ playerId }) => {
    const room = rooms[socket.id];
    if (!room) return;

    if (room.answerTimer.currentPlayerId === playerId) {
      clearAnswerTimer(room);
      io.to(room.code).emit('answer_timer_update', { running: false, value: 0, currentPlayerId: null });
    }

    io.to(playerId).emit('kicked');
    const ps = io.sockets.sockets.get(playerId);
    if (ps) ps.leave(room.code);

    delete room.players[playerId];
    delete room.teamScores[playerId];

    removeFromQueue(room, playerId);

    broadcastRoomState(room);
    startAnswerTimerForNext(room);
  });

  socket.on('disconnect', () => {
    if (rooms[socket.id]) {
      const room = rooms[socket.id];
      if (room.answerTimer.interval) clearInterval(room.answerTimer.interval);
      io.to(room.code).emit('room_closed');
      delete rooms[socket.id];
      return;
    }

    for (const room of Object.values(rooms)) {
      if (room.players[socket.id]) {
        if (room.answerTimer.currentPlayerId === socket.id) {
          clearAnswerTimer(room);
          io.to(room.code).emit('answer_timer_update', { running: false, value: 0, currentPlayerId: null });
        }

        delete room.players[socket.id];
        delete room.teamScores[socket.id];

        removeFromQueue(room, socket.id);
        broadcastRoomState(room);
        startAnswerTimerForNext(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BuzzIn clone running on http://localhost:${PORT}`));