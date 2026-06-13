/**
 * Main Application Logic – ties UI, storage, and matchmaker together
 */
const App = (() => {
  // ── State ────────────────────────────────────────────
  let currentTab = 'dashboard';

  // ── Initialization ───────────────────────────────────
  async function init() {
    // Initialize Cloud (Supabase) if available
    if (typeof Cloud !== 'undefined') {
      Cloud.init();
      // Wait a moment for connection test
      await new Promise(r => setTimeout(r, 300));

      if (Cloud.isConnected()) {
        // Try pulling from cloud first
        const pulled = await DB.syncFromCloud();
        if (pulled) {
          console.log('[App] Loaded data from Supabase');
        }
        // Subscribe to real-time changes
        Cloud.onChange(async (table) => {
          console.log(`[App] Real-time update on: ${table}`);
          await DB.syncFromCloud();
          render();
          updateSyncBadge(true);
        });
        Cloud.subscribe();
      }
      updateSyncBadge(Cloud.isConnected());
    }

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

  function updateSyncBadge(isOnline) {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    if (isOnline) {
      badge.className = 'sync-badge online';
      badge.textContent = '☁️ Synced';
    } else {
      badge.className = 'sync-badge offline';
      badge.textContent = '💾 Local Only';
    }
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
    renderPayments(db);
    renderSettings(db);
  }

  function renderDashboard(db) {
    // Count players currently playing (in active matches)
    const playingIds = new Set();
    db.activeMatches.forEach(m => {
      [...m.teamA, ...m.teamB].forEach(id => playingIds.add(id));
    });
    const queueCount = db.queue.length;
    const playingCount = playingIds.size;
    const idleCount = db.players.length - queueCount - playingCount;

    // Stats cards
    document.getElementById('stat-players').textContent = db.players.length;
    document.getElementById('stat-queue').textContent = queueCount;
    document.getElementById('stat-playing').textContent = playingCount;
    document.getElementById('stat-idle').textContent = idleCount;
    document.getElementById('stat-active').textContent = db.activeMatches.length;
    document.getElementById('stat-completed').textContent = db.matches.length;

    // Courts overview
    const courtsEl = document.getElementById('courts-grid');
    courtsEl.innerHTML = db.courts.map(court => {
      const match = db.activeMatches.find(m => m.id === court.currentMatchId);
      const isActive = court.status === 'in-use' && match;

      let content = '';
      if (isActive) {
        const teamANames = match.teamA.map(id => {
          const p = db.players.find(pl => pl.id === id);
          return p ? `${p.name} (${p.skillLevel})` : 'Unknown';
        }).join(' & ');
        const teamBNames = match.teamB.map(id => {
          const p = db.players.find(pl => pl.id === id);
          return p ? `${p.name} (${p.skillLevel})` : 'Unknown';
        }).join(' & ');
        content = `
          <div class="court-match">
            <div class="court-team">${esc(teamANames)}</div>
            <div class="court-vs">VS</div>
            <div class="court-team">${esc(teamBNames)}</div>
            <div class="court-timer" data-started="${match.startedAt}">⏱ ${formatDuration(Date.now() - match.startedAt)}</div>
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
    const queuePlayerIds = db.queue.map(q => q.id);
    const canAssign = db.queue.length >= (db.settings.gameMode === 'doubles' ? 4 : 2)
      && db.courts.some(c => c.status === 'available');
    const btn = document.getElementById('btn-auto-assign');
    if (btn) btn.disabled = !canAssign;
  }

  function renderPlayers(db) {
    const tbody = document.getElementById('players-tbody');
    if (!tbody) return;

    const queueIds = new Set(db.queue.map(q => q.id));
    const sorted = [...db.players].sort((a, b) => b.rating - a.rating);
    tbody.innerHTML = sorted.map((p, i) => {
      const inQueue = queueIds.has(p.id);
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
        <td><span class="level-badge level-${p.skillLevel.replace('+','p')}">${esc(p.skillLevel)}</span></td>
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

    const now = Date.now();
    listEl.innerHTML = db.queue.map((qEntry, i) => {
      const p = db.players.find(pl => pl.id === qEntry.id);
      if (!p) return '';
      const waitMins = Math.floor((now - qEntry.joinedAt) / 60000);
      const waitStr = waitMins >= 60 ? `${Math.floor(waitMins/60)}h ${waitMins%60}m` : `${waitMins}m`;
      const gamesStr = qEntry.gamesPlayedToday || 0;
      return `
        <div class="queue-item" data-id="${qEntry.id}">
          <span class="queue-pos">${i + 1}</span>
          <span class="queue-name">${esc(p.name)}</span>
          <span class="level-badge level-${p.skillLevel.replace('+','p')}">${esc(p.skillLevel)}</span>
          <span class="queue-rating">⭐ ${p.rating}</span>
          <span class="queue-wait" title="Wait time">⏱ ${waitStr}</span>
          <span class="queue-games" title="Games played today">🎮 ${gamesStr}</span>
          <div class="queue-actions">
            ${i > 0 ? `<button class="btn btn-xs" onclick="App.moveInQueue('${qEntry.id}', -1)">▲</button>` : ''}
            ${i < db.queue.length - 1 ? `<button class="btn btn-xs" onclick="App.moveInQueue('${qEntry.id}', 1)">▼</button>` : ''}
            <button class="btn btn-xs btn-danger" onclick="App.dequeuePlayer('${qEntry.id}')">✕</button>
          </div>
        </div>`;
    }).join('');

    // Matchmaker preview
    const preview = document.getElementById('match-preview');
    if (preview) {
      const proposals = Matchmaker.findMatches();
      if (proposals.length > 0) {
        preview.innerHTML = '<h4>Next Matches Preview</h4>' + proposals.map(p => {
          const teamANames = p.teamA.map(id => {
            const pl = db.players.find(x => x.id === id);
            return pl ? `${pl.name} (${pl.skillLevel})` : '?';
          }).join(' & ');
          const teamBNames = p.teamB.map(id => {
            const pl = db.players.find(x => x.id === id);
            return pl ? `${pl.name} (${pl.skillLevel})` : '?';
          }).join(' & ');
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

  function renderPayments(db) {
    // Shuttle cost info
    const costInfo = document.getElementById('shuttle-cost-info');
    if (costInfo) {
      costInfo.textContent = `Shuttle cost: $${Number(db.settings.shuttleCost).toFixed(2)} per player per game`;
    }

    // Player dropdown for recording payments
    const paySelect = document.getElementById('pay-player');
    if (paySelect) {
      const currentVal = paySelect.value;
      paySelect.innerHTML = db.players
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
        .join('');
      if (currentVal && db.players.find(p => p.id === currentVal)) {
        paySelect.value = currentVal;
      }
    }

    // Balance table
    const tbody = document.getElementById('payments-tbody');
    if (tbody) {
      let totalOwed = 0;
      const rows = db.players
        .map(p => {
          const charges = db.payments.filter(pm => pm.playerId === p.id && pm.type === 'charge');
          const payments = db.payments.filter(pm => pm.playerId === p.id && pm.type === 'payment');
          const totalCharged = charges.reduce((sum, pm) => sum + pm.amount, 0);
          const totalPaid = payments.reduce((sum, pm) => sum + pm.amount, 0);
          const balance = totalCharged - totalPaid;
          const gamesCharged = charges.length;
          if (balance > 0) totalOwed += balance;
          return { p, gamesCharged, totalCharged, totalPaid, balance };
        })
        .sort((a, b) => b.balance - a.balance);

      tbody.innerHTML = rows.map(({ p, gamesCharged, totalCharged, totalPaid, balance }) => {
        const balanceClass = balance > 0 ? 'payment-owes' : balance < 0 ? 'payment-credit' : 'payment-clear';
        const balanceStr = balance > 0 ? `$${balance.toFixed(2)}` : balance < 0 ? `-$${Math.abs(balance).toFixed(2)}` : '$0.00';
        return `<tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td>${gamesCharged}</td>
          <td>$${totalCharged.toFixed(2)}</td>
          <td>$${totalPaid.toFixed(2)}</td>
          <td><span class="badge ${balanceClass}">${balanceStr}</span></td>
          <td>
            ${balance > 0 ? `<button class="btn btn-xs btn-success" onclick="App.settlePlayer('${p.id}')">Settle</button>` : ''}
          </td>
        </tr>`;
      }).join('');

      // Total summary
      const totalEl = document.getElementById('payment-total-owed');
      if (totalEl) {
        totalEl.textContent = `Total outstanding: $${totalOwed.toFixed(2)}`;
      }
    }

    // Transaction log
    const logEl = document.getElementById('payment-log');
    if (logEl) {
      if (db.payments.length === 0) {
        logEl.innerHTML = '<div class="empty-state">No transactions yet. Fees are charged when matches finish.</div>';
      } else {
        logEl.innerHTML = [...db.payments]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 50)
          .map(pm => {
            const player = db.players.find(p => p.id === pm.playerId);
            const name = player ? esc(player.name) : 'Unknown';
            const icon = pm.type === 'charge' ? '🔴' : '🟢';
            const sign = pm.type === 'charge' ? '+' : '-';
            const date = new Date(pm.createdAt).toLocaleString();
            return `<div class="payment-log-item">
              <span class="payment-log-icon">${icon}</span>
              <span class="payment-log-name">${name}</span>
              <span class="payment-log-amount ${pm.type}">${sign}$${pm.amount.toFixed(2)}</span>
              <span class="payment-log-note">${esc(pm.note || '')}</span>
              <span class="payment-log-date">${date}</span>
            </div>`;
          }).join('');
      }
    }
  }

  function renderSettings(db) {
    const el = document.getElementById('settings-form');
    if (!el) return;
    const s = db.settings;
    document.getElementById('set-courts').value = s.courtCount;
    document.getElementById('set-mode').value = s.gameMode;
    document.getElementById('set-shuttle-cost').value = s.shuttleCost;
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
    const queueIds = new Set(db.queue.map(q => q.id));
    db.players.forEach(p => {
      if (!queueIds.has(p.id) && !inMatch.has(p.id)) {
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
    const idx = db.queue.findIndex(q => q.id === id);
    const newIdx = idx + direction;
    if (idx === -1 || newIdx < 0 || newIdx >= db.queue.length) return;
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

    // Get match players before finishing (so we can re-queue them)
    const db = DB.get();
    const match = db.activeMatches.find(m => m.id === matchId);
    const matchPlayerIds = match ? [...match.teamA, ...match.teamB] : [];

    DB.finishMatch(matchId, scoreA, scoreB);
    DB.chargeMatch(matchId);

    // Auto re-queue finished players at the back of the line
    // Increment their gamesPlayedToday counter
    for (const pid of matchPlayerIds) {
      DB.enqueue(pid);
      // Update games played today for the new queue entry
      DB.update(data => {
        const qEntry = data.queue.find(q => q.id === pid);
        if (qEntry) {
          qEntry.gamesPlayedToday = (qEntry.gamesPlayedToday || 0) + 1;
        }
      });
    }

    dialog.classList.remove('open');
    toast('Match completed! Players re-queued.', 'success');
    render();

    // Auto-assign next matches if queue has players
    setTimeout(() => {
      const freshDb = DB.get();
      if (freshDb.queue.length >= (freshDb.settings.gameMode === 'doubles' ? 4 : 2)
          && freshDb.courts.some(c => c.status === 'available')) {
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
    const shuttleCost = parseFloat(document.getElementById('set-shuttle-cost').value) || 0;

    const db = DB.get();
    const oldCourtCount = db.settings.courtCount;
    DB.updateSettings({ courtCount, gameMode, challengeFactor, shuttleCost });

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

  function recordPayment() {
    const playerId = document.getElementById('pay-player').value;
    const amount = parseFloat(document.getElementById('pay-amount').value);
    const note = document.getElementById('pay-note').value.trim();
    if (!playerId) return toast('Select a player', 'warning');
    if (isNaN(amount) || amount <= 0) return toast('Enter a valid amount', 'warning');
    DB.recordPayment(playerId, amount, note);
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-note').value = '';
    const name = playerName(playerId, DB.get());
    toast(`$${amount.toFixed(2)} payment recorded for ${name}`, 'success');
    render();
  }

  function settlePlayer(playerId) {
    const db = DB.get();
    const balance = DB.getPlayerBalance(playerId, db);
    if (balance <= 0) return toast('Nothing to settle', 'info');
    const name = playerName(playerId, db);
    if (confirm(`Settle ${name}'s full balance of $${balance.toFixed(2)}?`)) {
      DB.clearPlayerBalance(playerId);
      toast(`${name}'s balance settled!`, 'success');
      render();
    }
  }

  async function pushToCloud() {
    if (typeof Cloud === 'undefined' || !Cloud.isConnected()) {
      return toast('Not connected to Supabase', 'warning');
    }
    toast('Pushing to cloud...', 'info');
    const ok = await Cloud.pushAll(DB.get());
    if (ok) {
      toast('All data pushed to cloud!', 'success');
      updateSyncBadge(true);
    } else {
      toast('Push failed — check console', 'error');
    }
  }

  async function pullFromCloud() {
    if (typeof Cloud === 'undefined' || !Cloud.isConnected()) {
      return toast('Not connected to Supabase', 'warning');
    }
    toast('Pulling from cloud...', 'info');
    const ok = await DB.syncFromCloud();
    if (ok) {
      toast('Data loaded from cloud!', 'success');
      render();
    } else {
      toast('Pull failed — check console', 'error');
    }
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

  // Live court timers – update every second
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.court-timer[data-started]').forEach(el => {
      const started = parseInt(el.dataset.started, 10);
      if (!isNaN(started)) {
        el.textContent = '⏱ ' + formatDuration(now - started);
      }
    });
  }, 1000);

  // Refresh dashboard data every 30s
  setInterval(() => {
    if (currentTab === 'dashboard') renderDashboard(DB.get());
  }, 30000);

  return {
    init, render, switchTab,
    addPlayer, confirmRemovePlayer,
    enqueuePlayer, dequeuePlayer, enqueueAll, clearQueue, moveInQueue,
    autoAssign, openScoreDialog, submitScore, closeScoreDialog,
    saveSettings, exportData, importData, resetData,
    pushToCloud, pullFromCloud,
    recordPayment, settlePlayer,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
