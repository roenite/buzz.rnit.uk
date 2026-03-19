const socket = io();

let state = {
  role: null,
  roomCode: null,
  myName: null,
  roomState: null,
  buzzed: false,
  locked: false,
  answerTimer: { running: false, value: 0, currentPlayerId: null }
};

// Host-only buzz sound support
let hostBuzzAudio = null;
let hostBuzzAudioUrl = null;

function setHostBuzzSoundFromFile(file) {
  if (hostBuzzAudioUrl) URL.revokeObjectURL(hostBuzzAudioUrl);
  hostBuzzAudioUrl = URL.createObjectURL(file);
  hostBuzzAudio = new Audio(hostBuzzAudioUrl);
  hostBuzzAudio.preload = 'auto';
}
function clearHostBuzzSound() {
  if (hostBuzzAudioUrl) URL.revokeObjectURL(hostBuzzAudioUrl);
  hostBuzzAudioUrl = null;
  hostBuzzAudio = null;
}
function playDefaultHostBuzzBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.start(); osc.stop(ctx.currentTime + 0.22);
  } catch (e) {}
}
function playHostBuzzSound() {
  if (state.role !== 'host') return;
  if (hostBuzzAudio) {
    try { hostBuzzAudio.currentTime = 0; hostBuzzAudio.play().catch(() => {}); } catch (e) {}
  } else {
    playDefaultHostBuzzBeep();
  }
}
function playTimerEnd() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [440, 330, 220].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.3);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.3);
    });
  } catch (e) {}
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(msg, duration = 2500) {
  let cont = document.getElementById('toast-container');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'toast-container';
    cont.style.position = 'fixed';
    cont.style.bottom = '1.5rem';
    cont.style.right = '1.5rem';
    cont.style.display = 'flex';
    cont.style.flexDirection = 'column';
    cont.style.gap = '.5rem';
    cont.style.zIndex = 9999;
    document.body.appendChild(cont);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.background = 'var(--surface)';
  t.style.borderRadius = '8px';
  t.style.padding = '.7rem 1.2rem';
  t.style.boxShadow = 'var(--shadow)';
  t.style.fontSize = '.9rem';
  t.style.borderLeft = '4px solid var(--accent)';
  t.textContent = msg;
  cont.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function esc(str) {
  return String(str || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Host create room
document.getElementById('btn-create-room').addEventListener('click', () => {
  const hostName = document.getElementById('host-name').value.trim() || 'Host';
  socket.emit('create_room', { hostName }, (res) => {
    if (res.error) { toast('❌ ' + res.error); return; }
    state.role = 'host';
    state.roomCode = res.code;
    document.getElementById('host-room-code').textContent = res.code;
    showPage('page-host-room');
    toast('✅ Room created! Code: ' + res.code);

    // Host sound controls
    const fileInput = document.getElementById('buzz-sound-file');
    const btnTest = document.getElementById('btn-test-buzz-sound');
    const btnClear = document.getElementById('btn-clear-buzz-sound');

    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      setHostBuzzSoundFromFile(f);
      toast(`🔊 Loaded sound: ${f.name}`);
    });
    btnTest.addEventListener('click', () => playHostBuzzSound());
    btnClear.addEventListener('click', () => {
      clearHostBuzzSound();
      fileInput.value = '';
      toast('🔔 Using default beep');
    });

    // Team buzz mode controls
    document.getElementById('btn-set-team-buzz-mode').addEventListener('click', () => {
      const mode = document.getElementById('team-buzz-mode').value;
      socket.emit('set_team_buzz_mode', { mode });
      toast('✅ Team buzz mode set');
    });
  });
});

// Join room
document.getElementById('btn-join').addEventListener('click', joinRoom);
document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
document.getElementById('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim();
  const errEl = document.getElementById('join-error');
  errEl.classList.add('hidden');
  if (!code) { errEl.textContent = 'Please enter a room code.'; errEl.classList.remove('hidden'); return; }
  if (!name) { errEl.textContent = 'Please enter a nickname.'; errEl.classList.remove('hidden'); return; }
  socket.emit('join_room', { code, name }, (res) => {
    if (res.error) { errEl.textContent = res.error; errEl.classList.remove('hidden'); return; }
    state.role = 'player';
    state.roomCode = res.code;
    state.myName = res.name;
    document.getElementById('player-room-code').textContent = res.code;
    document.getElementById('player-display-name').textContent = res.name;
    showPage('page-player-room');
    wirePlayerHotkeys();
  });
}

// Player buzz + hotkeys
function sendBuzz() {
  if (state.role !== 'player') return;
  if (state.buzzed || state.locked) return;
  socket.emit('buzz');
}
document.getElementById('btn-buzz').addEventListener('click', sendBuzz);

function wirePlayerHotkeys() {
  window.addEventListener('keydown', (e) => {
    if (state.role !== 'player') return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      sendBuzz();
    }
  }, { passive: false });
}

// Host controls
document.getElementById('btn-reset').addEventListener('click', () => socket.emit('reset_buzzers'));

const btnLock = document.getElementById('btn-lock-toggle');
let allLocked = false;
btnLock.addEventListener('click', () => {
  allLocked = !allLocked;
  socket.emit('set_lock', { locked: allLocked });
  btnLock.textContent = allLocked ? '🔓 Unlock All' : '🔒 Lock All';
  btnLock.className = allLocked ? 'btn btn-danger' : 'btn btn-warning';
});

document.getElementById('btn-set-answer-seconds').addEventListener('click', () => {
  const sec = parseInt(document.getElementById('answer-seconds').value) || 8;
  socket.emit('set_answer_seconds', { seconds: sec });
  toast(`⏱ Answer seconds set to ${sec}`);
});
document.getElementById('btn-clear-answer').addEventListener('click', () => socket.emit('clear_answer_timer'));

// Host helper functions
window.adjustScore = function (playerId, delta) { socket.emit('update_score', { playerId, delta }); };
window.togglePlayerLock = function (playerId, locked) { socket.emit('set_player_lock', { playerId, locked }); };
window.setTeam = function (playerId, team) { socket.emit('set_team', { playerId, team }); };
window.kickPlayer = function (playerId) { if (confirm('Kick this player?')) socket.emit('kick_player', { playerId }); };

// Real-time score typing (debounced)
const scoreDebouncers = new Map();
window.onScoreInput = function (playerId, value) {
  if (scoreDebouncers.has(playerId)) clearTimeout(scoreDebouncers.get(playerId));
  const t = setTimeout(() => {
    socket.emit('set_score', { playerId, score: value });
  }, 200);
  scoreDebouncers.set(playerId, t);
};

// Timer renderer
function renderAnswerTimerUI(roomState, answerTimerOverride = null) {
  const at = answerTimerOverride || (roomState && roomState.answerTimer) || { running: false, value: 0, currentPlayerId: null };
  const players = (roomState && roomState.players) || (state.roomState && state.roomState.players) || [];
  const curPlayer = players.find(p => p.id === at.currentPlayerId);

  if (state.role === 'host') {
    const who = document.getElementById('answer-timer-who');
    const disp = document.getElementById('answer-timer-display');
    const val = document.getElementById('answer-timer-value');
    who.textContent = curPlayer ? `Currently answering: ${curPlayer.name}` : 'No one answering';
    if (at.running && at.value > 0) {
      disp.classList.remove('hidden');
      val.textContent = at.value;
      disp.classList.toggle('urgent', at.value <= 3);
    } else disp.classList.add('hidden');
  }

  if (state.role === 'player') {
    const who = document.getElementById('player-answer-who');
    const disp = document.getElementById('player-answer-timer-display');
    const val = document.getElementById('player-answer-timer-value');
    who.textContent = curPlayer ? `Currently answering: ${curPlayer.name}` : 'Waiting…';
    if (at.running && at.value > 0) {
      disp.classList.remove('hidden');
      val.textContent = at.value;
      disp.classList.toggle('urgent', at.value <= 3);
    } else disp.classList.add('hidden');
  }
}

function renderHostRoom(roomState) {
  const badge = document.getElementById('host-status-badge');
  badge.textContent = roomState.locked ? '🔒 Buzzers Locked' : '✅ Buzzers Open';
  badge.style.color = roomState.locked ? 'var(--warning)' : 'var(--success)';

  allLocked = !!roomState.locked;
  btnLock.textContent = allLocked ? '🔓 Unlock All' : '🔒 Lock All';
  btnLock.className = allLocked ? 'btn btn-danger' : 'btn btn-warning';

  const ansInput = document.getElementById('answer-seconds');
  if (ansInput && document.activeElement !== ansInput) ansInput.value = roomState.answerSecondsDefault ?? 8;

  const teamModeSel = document.getElementById('team-buzz-mode');
  if (teamModeSel && document.activeElement !== teamModeSel) {
    teamModeSel.value = roomState.teamBuzzMode || 'one_at_a_time';
  }

  renderAnswerTimerUI(roomState);

  const buzzList = document.getElementById('buzz-order-list');
  const at = roomState.answerTimer || { currentPlayerId: null };
  if (roomState.buzzOrder.length === 0) {
    buzzList.innerHTML = '<p class="muted">No one has buzzed yet.</p>';
  } else {
    buzzList.innerHTML = roomState.buzzOrder.map((id, idx) => {
      const p = roomState.players.find(pl => pl.id === id);
      if (!p) return '';
      const teamBadge = p.team ? `<span class="buzz-team">${esc(p.team)}</span>` : '';
      const isCurrent = id === at.currentPlayerId;
      return `<div class="buzz-item ${idx === 0 ? 'first' : ''}" style="${isCurrent ? 'border:1.5px solid var(--info)' : ''}">
        <span class="buzz-pos">${idx === 0 ? '🥇' : idx + 1}</span>
        <span class="buzz-name">${esc(p.name)}${isCurrent ? ' (answering)' : ''}</span>
        ${teamBadge}
      </div>`;
    }).join('');
  }

  document.getElementById('player-count').textContent = roomState.players.length;
  const tbody = document.getElementById('players-tbody');

  tbody.innerHTML = roomState.players.map(p => {
    const buzzedPos = roomState.buzzOrder.indexOf(p.id);
    const isAnswering = roomState.answerTimer && roomState.answerTimer.currentPlayerId === p.id;

    const statusStr = p.locked ? '<span style="color:var(--warning);font-weight:700">🔒 Player Locked</span>'
      : isAnswering ? '<span style="color:var(--info);font-weight:700">⏱ Answering</span>'
        : buzzedPos >= 0 ? `<span style="color:var(--accent);font-weight:700">⚡ Queued #${buzzedPos + 1}</span>`
          : '<span style="color:var(--success)">✔ Ready</span>';

    return `<tr style="${p.locked ? 'opacity:.75' : ''}">
      <td><strong>${esc(p.name)}</strong></td>
      <td><input class="team-input" value="${esc(p.team)}" placeholder="Team" maxlength="20"
           onchange="setTeam('${p.id}', this.value)" /></td>

      <td>
        <div class="score-cell">
          <button class="btn btn-sm btn-ghost" onclick="adjustScore('${p.id}', -1)">−</button>
          <span class="score-val">${p.score}</span>
          <button class="btn btn-sm btn-success" onclick="adjustScore('${p.id}', 1)">+</button>
        </div>
      </td>

      <td>
        <input id="setscore-${p.id}" class="setscore-input" type="number" value="${p.score}"
               oninput="onScoreInput('${p.id}', this.value)" />
      </td>

      <td>${statusStr}</td>

      <td style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="btn btn-sm ${p.locked ? 'btn-success' : 'btn-warning'}"
                onclick="togglePlayerLock('${p.id}', ${!p.locked})">
          ${p.locked ? '🔓' : '🔒'}
        </button>
        <button class="btn btn-sm btn-danger" onclick="kickPlayer('${p.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPlayerRoom(roomState) {
  const buzzBtn = document.getElementById('btn-buzz');
  const buzzStatus = document.getElementById('buzz-status');

  const myPos = roomState.buzzOrder.indexOf(socket.id);
  const myPlayer = roomState.players.find(p => p.id === socket.id);
  const isLocked = roomState.locked || (myPlayer && myPlayer.locked);

  state.buzzed = myPos >= 0;
  state.locked = isLocked;

  if (state.buzzed) {
    buzzBtn.disabled = true;
    buzzBtn.className = 'buzz-button buzzed';
    buzzStatus.textContent = myPos === 0 ? '🥇 You are first in the queue!' : `⚡ You are queued #${myPos + 1}`;
    buzzStatus.style.color = myPos === 0 ? 'gold' : 'var(--accent)';
  } else if (isLocked) {
    buzzBtn.disabled = true;
    buzzBtn.className = 'buzz-button locked';
    buzzStatus.textContent = '🔒 Your buzzer is locked (wait for reset)';
    buzzStatus.style.color = 'var(--warning)';
  } else {
    buzzBtn.disabled = false;
    buzzBtn.className = 'buzz-button';
    buzzStatus.textContent = 'Press Space to buzz';
    buzzStatus.style.color = 'var(--muted)';
  }

  renderAnswerTimerUI(roomState);

  const buzzList = document.getElementById('player-buzz-order-list');
  const at = roomState.answerTimer || { currentPlayerId: null };
  if (roomState.buzzOrder.length === 0) {
    buzzList.innerHTML = '<p class="muted">No one has buzzed yet.</p>';
  } else {
    buzzList.innerHTML = roomState.buzzOrder.map((id, idx) => {
      const p = roomState.players.find(pl => pl.id === id);
      if (!p) return '';
      const isMe = id === socket.id;
      const isCurrent = id === at.currentPlayerId;
      const teamBadge = p.team ? `<span class="buzz-team">${esc(p.team)}</span>` : '';
      return `<div class="buzz-item ${idx === 0 ? 'first' : ''}" style="${isMe ? 'border:1.5px solid var(--accent)' : ''};${isCurrent ? 'outline:1.5px solid var(--info)' : ''}">
        <span class="buzz-pos">${idx === 0 ? '🥇' : idx + 1}</span>
        <span class="buzz-name">${esc(p.name)}${isMe ? ' (you)' : ''}${isCurrent ? ' (answering)' : ''}</span>
        ${teamBadge}
      </div>`;
    }).join('');
  }

  const scoresList = document.getElementById('player-scores-list');
  const sorted = [...roomState.players].sort((a, b) => b.score - a.score);
  scoresList.innerHTML = sorted.map(p => {
    const isMe = p.id === socket.id;
    return `<div class="score-row ${isMe ? 'me' : ''}">
      <span class="sname">${esc(p.name)}${p.team ? ` <span style="font-size:.75rem;color:var(--muted)">[${esc(p.team)}]</span>` : ''}${isMe ? ' <span style="font-size:.75rem;color:var(--muted)">(you)</span>' : ''}</span>
      <span class="sval">${p.score}</span>
    </div>`;
  }).join('');
}

// Socket events
socket.on('room_state', (roomState) => {
  state.roomState = roomState;
  if (state.role === 'host') renderHostRoom(roomState);
  if (state.role === 'player') renderPlayerRoom(roomState);
});

socket.on('host_buzz_sound', () => playHostBuzzSound());

socket.on('player_buzzed', ({ name, position, team }) => {
  const teamTxt = team ? ` [${team}]` : '';
  toast(`⚡ ${name}${teamTxt} buzzed! (#${position})`);
});

socket.on('buzzers_reset', () => toast('🔄 Buzzers reset!'));

socket.on('answer_timer_update', ({ running, value, currentPlayerId }) => {
  state.answerTimer = { running, value, currentPlayerId };
  renderAnswerTimerUI(state.roomState, state.answerTimer);
});

socket.on('answer_timer_expired', () => {
  playTimerEnd();
  toast('⏰ Answer time expired');
});

socket.on('kicked', () => {
  toast('⛔ You were removed from the room.');
  showPage('page-landing');
  state = {
    role: null, roomCode: null, myName: null, roomState: null,
    buzzed: false, locked: false, answerTimer: { running: false, value: 0, currentPlayerId: null }
  };
});

socket.on('room_closed', () => {
  toast('🚫 The host closed the room.');
  showPage('page-landing');
  state = {
    role: null, roomCode: null, myName: null, roomState: null,
    buzzed: false, locked: false, answerTimer: { running: false, value: 0, currentPlayerId: null }
  };
});