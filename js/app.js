/**
 * Main Application Logic – ties UI, storage, and matchmaker together
 */
const App = (() => {
  // ── State ────────────────────────────────────────────
  let currentTab = 'dashboard';

  // ── Initialization ───────────────────────────────────
  function init() {
    const db = DB.get();
    // Initialize courts if not set
    if (db.courts.length === 0) {
      DB.initCourts(db.settings.courtCount);
    }
    // Auto-seed demo data on first run
    if (db.players.length === 0 && typeof Seed !== 'undefined') {
      Seed.run();
    }
    bindEvents();
    switchTab('dashboard');
    render();
  }

  // ── Navigation ───────────────────────────────────────
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tab}`);
    });
    render();
  }

  // ── Rendering ────────────────────────────────────────
  function render() {
    const db = DB.get();
    renderDashboard(db);
    renderPlayers(db);
    renderQueue(db);
    renderHistory(db);
    renderSettings(db);
  }

  function renderDashboard(db) {
    // Stats cards
    document.getElementById('stat-players').textContent = db.players.length;
    document.getElementById('stat-queue').textContent = db.queue.length;
    document.getElementById('stat-active').textContent = db.activeMatches.length;
    document.getElementById('stat-completed').textContent = db.matches.length;

    // Courts overview
    const courtsEl = document.getElementById('courts-grid');
    courtsEl.innerHTML = db.courts.map(court => {
      const match = db.activeMatches.find(m => m.id === court.currentMatchId);
      const isActive = court.status === 'in-use' && match;

      let content = '';
      if (isActive) {
        const teamANames = match.teamA.map(id => playerName(id, db)).join(' & ');
        const teamBNames = match.teamB.map(id => playerName(id, db)).join(' & ');
        const elapsed = formatDuration(Date.now() - match.startedAt);
        content = `
          <div class="court-match">
            <div class="court-team">${esc(teamANames)}</div>
            <div class="court-vs">VS</div>
            <div class="court-team">${esc(teamBNames)}</div>
            <div class="court-time">${elapsed}</div>
            <button class="btn btn-sm btn-finish" onclick="App.openScoreDialog('${match.id}')">
              Enter Score
            </button>
          </div>`;
      } else {
        content = `<div class="court-empty">Available</div>`;
      }

      return `
        <div class="court-card ${isActive ? 'in-use' : 'available'}">
          <div class="court-header">${esc(court.name)}</div>
          ${content}
        </div>`;
    }).join('');

    // Auto-assign button state
    const canAssign = db.queue.length >= (db.settings.gameMode === 'doubles' ? 4 : 2)
      && db.courts.some(c => c.status === 'available');
    const btn = document.getElementById('btn-auto-assign');
    if (btn) btn.disabled = !canAssign;
  }

  function renderPlayers(db) {
    const tbody = document.getElementById('players-tbody');
    if (!tbody) return;

    const sorted = [...db.players].sort((a, b) => b.rating - a.rating);
    tbody.innerHTML = sorted.map((p, i) => {
      const inQueue = db.queue.includes(p.id);
      const inMatch = db.activeMatches.some(m =>
        [...m.teamA, ...m.teamB].includes(p.id));
      const statusBadge = inMatch ? '<span class="badge playing">Playing</span>'
        : inQueue ? '<span class="badge queued">In Queue</span>'
        : '<span class="badge idle">Idle</span>';
      const winRate = p.matchesPlayed > 0
        ? Math.round((p.wins / p.matchesPlayed) * 100) + '%'
        : '-';
      const streakStr = p.streak > 0 ? `🔥${p.streak}W` : p.streak < 0 ? `${Math.abs(p.streak)}L` : '-';

      return `<tr>
        <td>${i + 1}</td>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${p.rating}</td>
        <td>${capitalize(p.skillLevel)}</td>
        <td>${p.matchesPlayed}</td>
        <td>${winRate}</td>
        <td>${streakStr}</td>
        <td>${statusBadge}</td>
        <td>
          ${!inMatch && !inQueue ? `<button class="btn btn-xs btn-queue" onclick="App.enqueuePlayer('${p.id}')">+ Queue</button>` : ''}
          ${inQueue ? `<button class="btn btn-xs btn-dequeue" onclick="App.dequeuePlayer('${p.id}')">- Queue</button>` : ''}
          <button class="btn btn-xs btn-danger" onclick="App.confirmRemovePlayer('${p.id}', '${esc(p.name)}')">✕</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderQueue(db) {
    const listEl = document.getElementById('queue-list');
    if (!listEl) return;

    if (db.queue.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No players in queue. Add players from the Players tab.</div>';
      return;
    }

    listEl.innerHTML = db.queue.map((id, i) => {
      const p = db.players.find(pl => pl.id === id);
      if (!p) return '';
      return `
        <div class="queue-item" data-id="${id}">
          <span class="queue-pos">${i + 1}</span>
          <span class="queue-name">${esc(p.name)}</span>
          <span class="queue-rating">⭐ ${p.rating}</span>
          <div class="queue-actions">
            ${i > 0 ? `<button class="btn btn-xs" onclick="App.moveInQueue('${id}', -1)">▲</button>` : ''}
            ${i < db.queue.length - 1 ? `<button class="btn btn-xs" onclick="App.moveInQueue('${id}', 1)">▼</button>` : ''}
            <button class="btn btn-xs btn-danger" onclick="App.dequeuePlayer('${id}')">✕</button>
          </div>
        </div>`;
    }).join('');

    // Matchmaker preview
    const preview = document.getElementById('match-preview');
    if (preview) {
      const proposals = Matchmaker.findMatches();
      if (proposals.length > 0) {
        preview.innerHTML = '<h4>Next Matches Preview</h4>' + proposals.map(p => {
          const teamANames = p.teamA.map(id => playerName(id, db)).join(' & ');
          const teamBNames = p.teamB.map(id => playerName(id, db)).join(' & ');
          const court = db.courts.find(c => c.id === p.courtId);
          return `<div class="preview-match">
            <span class="preview-court">${esc(court?.name || '?')}</span>
            <span>${esc(teamANames)}</span>
            <span class="preview-vs">vs</span>
            <span>${esc(teamBNames)}</span>
          </div>`;
        }).join('');
      } else {
        preview.innerHTML = '<div class="empty-state">Not enough players or courts for a match.</div>';
      }
    }
  }

  function renderHistory(db) {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;

    if (db.matches.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No matches played yet.</div>';
      return;
    }

    listEl.innerHTML = db.matches.slice(0, 50).map(m => {
      const teamANames = m.teamA.map(id => playerName(id, db)).join(' & ');
      const teamBNames = m.teamB.map(id => playerName(id, db)).join(' & ');
      const court = db.courts.find(c => c.id === m.courtId);
      const date = new Date(m.endedAt || m.startedAt).toLocaleString();
      const duration = m.endedAt ? formatDuration(m.endedAt - m.startedAt) : '-';
      const winnerClass = (side) => m.winner === side ? 'winner' : 'loser';

      return `
        <div class="history-item">
          <div class="history-header">
            <span class="history-court">${esc(court?.name || '?')}</span>
            <span class="history-date">${date}</span>
            <span class="history-duration">${duration}</span>
          </div>
          <div class="history-teams">
            <span class="history-team ${winnerClass('A')}">${esc(teamANames)}</span>
            <span class="history-score">${m.scoreA} - ${m.scoreB}</span>
            <span class="history-team ${winnerClass('B')}">${esc(teamBNames)}</span>
          </div>
        </div>`;
    }).join('');
  }

  function renderSettings(db) {
    const el = document.getElementById('settings-form');
    if (!el) return;
    const s = db.settings;
    document.getElementById('set-courts').value = s.courtCount;
    document.getElementById('set-mode').value = s.gameMode;
    document.getElementById('set-challenge').value = s.challengeFactor;
    document.getElementById('challenge-val').textContent = Math.round(s.challengeFactor * 100) + '%';
  }

  // ── Actions ──────────────────────────────────────────
  function addPlayer() {
    const nameInput = document.getElementById('player-name');
    const levelInput = document.getElementById('player-level');
    const name = nameInput.value.trim();
    if (!name) return toast('Enter a player name', 'warning');
    DB.addPlayer(name, levelInput.value);
    nameInput.value = '';
    toast(`${name} added!`, 'success');
    render();
  }

  function confirmRemovePlayer(id, name) {
    if (confirm(`Remove ${name} from the app?`)) {
      DB.removePlayer(id);
      toast(`${name} removed`, 'info');
      render();
    }
  }

  function enqueuePlayer(id) {
    DB.enqueue(id);
    toast('Added to queue', 'success');
    render();
  }

  function dequeuePlayer(id) {
    DB.dequeue(id);
    toast('Removed from queue', 'info');
    render();
  }

  function enqueueAll() {
    const db = DB.get();
    const inMatch = new Set();
    db.activeMatches.forEach(m => [...m.teamA, ...m.teamB].forEach(id => inMatch.add(id)));
    db.players.forEach(p => {
      if (!db.queue.includes(p.id) && !inMatch.has(p.id)) {
        DB.enqueue(p.id);
      }
    });
    toast('All available players queued', 'success');
    render();
  }

  function clearQueue() {
    DB.clearQueue();
    toast('Queue cleared', 'info');
    render();
  }

  function moveInQueue(id, direction) {
    const db = DB.get();
    const idx = db.queue.indexOf(id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= db.queue.length) return;
    [db.queue[idx], db.queue[newIdx]] = [db.queue[newIdx], db.queue[idx]];
    DB.reorderQueue(db.queue);
    render();
  }

  function autoAssign() {
    const count = Matchmaker.autoAssign();
    if (count > 0) {
      toast(`${count} match${count > 1 ? 'es' : ''} started!`, 'success');
    } else {
      toast('No matches available', 'warning');
    }
    render();
  }

  function openScoreDialog(matchId) {
    const db = DB.get();
    const match = db.activeMatches.find(m => m.id === matchId);
    if (!match) return;

    const teamANames = match.teamA.map(id => playerName(id, db)).join(' & ');
    const teamBNames = match.teamB.map(id => playerName(id, db)).join(' & ');

    const dialog = document.getElementById('score-dialog');
    document.getElementById('score-team-a').textContent = teamANames;
    document.getElementById('score-team-b').textContent = teamBNames;
    document.getElementById('score-a').value = '';
    document.getElementById('score-b').value = '';
    dialog.dataset.matchId = matchId;
    dialog.classList.add('open');
  }

  function submitScore() {
    const dialog = document.getElementById('score-dialog');
    const matchId = dialog.dataset.matchId;
    const scoreA = parseInt(document.getElementById('score-a').value, 10);
    const scoreB = parseInt(document.getElementById('score-b').value, 10);

    if (isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0) {
      return toast('Enter valid scores', 'warning');
    }
    if (scoreA === scoreB) {
      return toast('Scores cannot be tied', 'warning');
    }

    DB.finishMatch(matchId, scoreA, scoreB);
    dialog.classList.remove('open');
    toast('Match completed!', 'success');
    render();

    // Auto-assign next matches if queue has players
    setTimeout(() => {
      const db = DB.get();
      if (db.queue.length >= (db.settings.gameMode === 'doubles' ? 4 : 2)
          && db.courts.some(c => c.status === 'available')) {
        autoAssign();
      }
    }, 500);
  }

  function closeScoreDialog() {
    document.getElementById('score-dialog').classList.remove('open');
  }

  function saveSettings() {
    const courtCount = parseInt(document.getElementById('set-courts').value, 10);
    const gameMode = document.getElementById('set-mode').value;
    const challengeFactor = parseFloat(document.getElementById('set-challenge').value);

    const db = DB.get();
    const oldCourtCount = db.settings.courtCount;
    DB.updateSettings({ courtCount, gameMode, challengeFactor });

    if (courtCount !== oldCourtCount) {
      DB.initCourts(courtCount);
    }
    toast('Settings saved', 'success');
    render();
  }

  function exportData() {
    const json = DB.exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `badminton-queue-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Data exported', 'success');
  }

  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (DB.importData(reader.result)) {
          toast('Data imported successfully', 'success');
          render();
        } else {
          toast('Invalid backup file', 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function resetData() {
    if (confirm('Reset ALL data? This cannot be undone.')) {
      DB.resetAll();
      DB.initCourts(DB.get().settings.courtCount);
      toast('All data reset', 'info');
      render();
    }
  }

  // Re-add finished players to queue automatically
  function requeueFinished(matchId) {
    const db = DB.get();
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return;
    [...match.teamA, ...match.teamB].forEach(id => DB.enqueue(id));
    toast('Players re-queued', 'success');
    render();
  }

  // ── Event Binding ────────────────────────────────────
  function bindEvents() {
    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Add player on Enter
    document.getElementById('player-name')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addPlayer();
    });

    // Challenge slider live update
    document.getElementById('set-challenge')?.addEventListener('input', e => {
      document.getElementById('challenge-val').textContent = Math.round(e.target.value * 100) + '%';
    });
  }

  // ── Helpers ──────────────────────────────────────────
  function playerName(id, db) {
    const p = db.players.find(pl => pl.id === id);
    return p ? p.name : 'Unknown';
  }

  function formatDuration(ms) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2500);
  }

  // Refresh dashboard timer every 30s
  setInterval(() => {
    if (currentTab === 'dashboard') renderDashboard(DB.get());
  }, 30000);

  return {
    init, render, switchTab,
    addPlayer, confirmRemovePlayer,
    enqueuePlayer, dequeuePlayer, enqueueAll, clearQueue, moveInQueue,
    autoAssign, openScoreDialog, submitScore, closeScoreDialog,
    saveSettings, exportData, importData, resetData, requeueFinished,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
