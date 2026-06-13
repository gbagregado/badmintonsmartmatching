/**
 * Main Application Logic – ties UI, storage, and matchmaker together
 */
const App = (() => {
  // ── State ────────────────────────────────────────────
  let currentTab = 'dashboard';
  let currentHistoryView = 'results';

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
      // Load join requests on startup
      if (Cloud.isConnected()) refreshJoinRequests();
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

    renderManualMatch(db);
  }

  function renderManualMatch(db) {
    const mode = db.settings.gameMode;
    const teamSize = mode === 'doubles' ? 2 : 1;

    // Build list of available players (not currently in a match)
    const playingIds = new Set();
    db.activeMatches.forEach(m => [...m.teamA, ...m.teamB].forEach(id => playingIds.add(id)));
    const available = db.players.filter(p => !playingIds.has(p.id));

    const playerOptions = available.map(p =>
      `<option value="${p.id}">${esc(p.name)} (${esc(p.skillLevel)})</option>`
    ).join('');
    const emptyOption = `<option value="">— pick player —</option>`;

    // Render team slot selects
    ['a', 'b'].forEach(team => {
      const el = document.getElementById(`manual-team-${team}-slots`);
      if (!el) return;
      // Preserve current selections
      const existing = [...el.querySelectorAll('select')].map(s => s.value);
      el.innerHTML = Array.from({ length: teamSize }, (_, i) => `
        <div class="manual-slot">
          <select id="manual-${team}-${i}" onchange="App.renderDashboardManual()">
            ${emptyOption}${playerOptions}
          </select>
        </div>`).join('');
      // Restore selections
      existing.forEach((val, i) => {
        const sel = document.getElementById(`manual-${team}-${i}`);
        if (sel && val) sel.value = val;
      });
    });

    // Court dropdown — only available courts
    const courtSel = document.getElementById('manual-court');
    if (courtSel) {
      const prev = courtSel.value;
      const availCourts = db.courts.filter(c => c.status === 'available');
      courtSel.innerHTML = availCourts.length
        ? availCourts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
        : `<option value="">No courts available</option>`;
      if (prev && availCourts.find(c => c.id === prev)) courtSel.value = prev;
    }
  }

  // Called by select onchange to avoid full re-render resetting selections
  function renderDashboardManual() {
    renderManualMatch(DB.get());
  }

  // Holds validated picks while analysis dialog is open
  let _pendingManualMatch = null;

  function startManualMatch() {
    const db = DB.get();
    const mode = db.settings.gameMode;
    const teamSize = mode === 'doubles' ? 2 : 1;

    const teamA = Array.from({ length: teamSize }, (_, i) =>
      document.getElementById(`manual-a-${i}`)?.value).filter(Boolean);
    const teamB = Array.from({ length: teamSize }, (_, i) =>
      document.getElementById(`manual-b-${i}`)?.value).filter(Boolean);
    const courtId = document.getElementById('manual-court')?.value;

    if (teamA.length < teamSize || teamB.length < teamSize)
      return toast(`Select ${teamSize} player(s) for each team`, 'warning');

    const allPicked = [...teamA, ...teamB];
    if (new Set(allPicked).size < allPicked.length)
      return toast('A player cannot be on both teams', 'warning');

    if (!courtId) return toast('Select a court', 'warning');

    // Build and show analysis
    const analysis = buildMatchAnalysis(teamA, teamB, courtId, db);
    document.getElementById('analysis-content').innerHTML = analysis.html;
    document.getElementById('analysis-dialog').classList.add('open');
    _pendingManualMatch = { teamA, teamB, courtId, analysisData: analysis.data };
  }

  // ── Core analysis data extractor (used by dialog + auto-save) ──────────
  function getAnalysisData(teamA, teamB, courtId, db) {
    const getP = id => db.players.find(p => p.id === id);
    const playingIds = new Set();
    db.activeMatches.forEach(m => [...m.teamA, ...m.teamB].forEach(id => playingIds.add(id)));
    const court = db.courts.find(c => c.id === courtId);
    const avgRating = ids => {
      const r = ids.map(id => getP(id)?.rating || 1200);
      return Math.round(r.reduce((a, b) => a + b, 0) / r.length);
    };
    const avgA = avgRating(teamA);
    const avgB = avgRating(teamB);
    const ratingGap = Math.abs(avgA - avgB);
    const playingPicked = [...teamA, ...teamB].filter(id => playingIds.has(id));
    const flags = [];

    if (ratingGap > 400) {
      flags.push({ level: 'danger', icon: '⚠️', text: `Teams are heavily unbalanced — ${ratingGap} rating gap (ideal < 200). Expect a one-sided match.` });
    } else if (ratingGap > 200) {
      flags.push({ level: 'warning', icon: '⚡', text: `Teams are slightly unbalanced — ${ratingGap} rating gap. One team has a clear advantage.` });
    } else {
      flags.push({ level: 'ok', icon: '✅', text: `Teams are well balanced — only ${ratingGap} rating gap.` });
    }
    if (playingPicked.length > 0) {
      const names = playingPicked.map(id => getP(id)?.name).filter(Boolean).join(', ');
      flags.push({ level: 'danger', icon: '🔴', text: `${names} ${playingPicked.length > 1 ? 'are' : 'is'} already in an active match. Starting this will double-book them.` });
    }
    if (teamA.length > 1) {
      const gapA = Math.abs((getP(teamA[0])?.rating||1200)-(getP(teamA[1])?.rating||1200));
      const gapB = Math.abs((getP(teamB[0])?.rating||1200)-(getP(teamB[1])?.rating||1200));
      if (gapA > 500) flags.push({ level: 'warning', icon: '👥', text: `Team A partners have a large skill gap (${gapA} pts). Coordination may suffer.` });
      if (gapB > 500) flags.push({ level: 'warning', icon: '👥', text: `Team B partners have a large skill gap (${gapB} pts). Coordination may suffer.` });
    }
    [...teamA, ...teamB].forEach(id => {
      const p = getP(id); if (!p) return;
      if (p.streak >= 5) flags.push({ level: 'info', icon: '🔥', text: `${p.name} is on a ${p.streak}-game win streak — may be heavily favoured.` });
      if (p.streak <= -4) flags.push({ level: 'info', icon: '❄️', text: `${p.name} has lost ${Math.abs(p.streak)} in a row — consider a fairer match.` });
    });
    [...teamA, ...teamB].forEach(id => {
      const qEntry = db.queue.find(q => q.id === id);
      const games = qEntry?.gamesPlayedToday || 0;
      if (games >= 4) { const p = getP(id); flags.push({ level: 'warning', icon: '😣', text: `${p?.name} has already played ${games} games today — may be fatigued.` }); }
    });
    [...teamA, ...teamB].forEach(id => {
      const p = getP(id); if (!p) return;
      if (p.matchesPlayed === 0) flags.push({ level: 'info', icon: '🆕', text: `${p.name} has never played — rating (${p.rating}) is unproven.` });
      else if (p.matchesPlayed < 5) flags.push({ level: 'info', icon: '🆕', text: `${p.name} has only ${p.matchesPlayed} match${p.matchesPlayed > 1 ? 'es' : ''} — rating may not reflect true skill yet.` });
    });
    const allGamesToday = db.players.map(p => db.queue.find(e => e.id === p.id)?.gamesPlayedToday || 0);
    const maxGamesToday = Math.max(...allGamesToday, 0);
    const avgGamesToday = allGamesToday.reduce((a, b) => a + b, 0) / (allGamesToday.length || 1);
    [...teamA, ...teamB].forEach(id => {
      const p = getP(id); if (!p) return;
      const games = db.queue.find(q => q.id === id)?.gamesPlayedToday || 0;
      if (maxGamesToday >= 3 && games === maxGamesToday && games > Math.ceil(avgGamesToday))
        flags.push({ level: 'warning', icon: '🔄', text: `${p.name} is one of today's most frequent players (${games} games) while others have had fewer.` });
    });
    const pickedIds = new Set([...teamA, ...teamB]);
    const sideline = db.players.filter(p => {
      const games = db.queue.find(e => e.id === p.id)?.gamesPlayedToday || 0;
      return games === 0 && maxGamesToday >= 2 && !pickedIds.has(p.id) && !playingIds.has(p.id);
    });
    if (sideline.length > 0) {
      const names = sideline.slice(0, 3).map(p => p.name).join(', ');
      const more = sideline.length > 3 ? ` +${sideline.length - 3} more` : '';
      flags.push({ level: 'info', icon: '⏳', text: `${names}${more} ${sideline.length === 1 ? 'has' : 'have'} not played today — consider giving them priority.` });
    }
    let quality;
    if (ratingGap <= 200 && playingPicked.length === 0) quality = 'good';
    else if (ratingGap <= 400 && playingPicked.length === 0) quality = 'fair';
    else quality = 'poor';

    return {
      teamAAvg: avgA, teamBAvg: avgB, ratingGap, quality, flags,
      teamAPlayers: teamA.map(id => ({ id, name: getP(id)?.name||'Unknown', level: getP(id)?.skillLevel||'?' })),
      teamBPlayers: teamB.map(id => ({ id, name: getP(id)?.name||'Unknown', level: getP(id)?.skillLevel||'?' })),
      courtName: court?.name || courtId,
    };
  }

  function buildMatchAnalysis(teamA, teamB, courtId, db) {
    const data = getAnalysisData(teamA, teamB, courtId, db);
    const { teamAAvg, teamBAvg, ratingGap, quality, flags, courtName } = data;
    const getP = id => db.players.find(p => p.id === id);
    const playingIds = new Set();
    db.activeMatches.forEach(m => [...m.teamA, ...m.teamB].forEach(id => playingIds.add(id)));
    const queueIds = new Set(db.queue.map(q => q.id));
    const avgRating = ids => {
      const r = ids.map(id => getP(id)?.rating || 1200);
      return Math.round(r.reduce((a, b) => a + b, 0) / r.length);
    };
    const teamCard = (ids, label) => {
      const players = ids.map(id => {
        const p = getP(id); if (!p) return '';
        const status = playingIds.has(id) ? '🔴 Playing' : queueIds.has(id) ? '🟡 In Queue' : '🟢 Idle';
        const streak = p.streak > 0 ? ` 🔥${p.streak}W` : p.streak < 0 ? ` ❄️${Math.abs(p.streak)}L` : '';
        const games = db.queue.find(q => q.id === id)?.gamesPlayedToday || 0;
        const newTag = p.matchesPlayed < 5 ? ` 🆕 New (${p.matchesPlayed} total)` : ` · ${p.matchesPlayed} matches`;
        return `<div class="analysis-player">
          <span class="level-badge level-${p.skillLevel.replace('+','p')}">${esc(p.skillLevel)}</span>
          <span><strong>${esc(p.name)}</strong>${streak}</span>
          <span class="analysis-player-rating">${p.rating} · ${status}${games > 0 ? ` · ${games} today` : ''}${newTag}</span>
        </div>`;
      }).join('');
      return `<div class="analysis-team">
        <div class="analysis-team-name">${label}</div>
        ${players}
        <div class="analysis-team-avg">Avg rating: <strong>${avgRating(ids)}</strong></div>
      </div>`;
    };
    const qualityLabel = quality === 'good' ? '✅ Good match — well balanced, no issues.'
      : quality === 'fair' ? '⚡ Fair match — slight imbalance but playable.'
      : '⚠️ Poor match — significant issues found. Review before proceeding.';
    const flagsHtml = flags.map(f => `<div class="analysis-flag ${f.level}">${f.icon} ${f.text}</div>`).join('');
    const html = `
      <div class="analysis-section">
        <h4>Teams</h4>
        <div class="analysis-teams">
          ${teamCard(teamA, 'Team A')}
          ${teamCard(teamB, 'Team B')}
        </div>
      </div>
      <div class="analysis-section">
        <h4>Overall Quality</h4>
        <div class="analysis-quality ${quality}">${qualityLabel}</div>
      </div>
      <div class="analysis-section">
        <h4>Flags (${flags.length})</h4>
        <div class="analysis-flags">${flagsHtml}</div>
      </div>
      <div class="analysis-section" style="color:var(--text-muted);font-size:.82rem">
        Court: <strong style="color:var(--text)">${esc(courtName)}</strong>
      </div>`;
    return { html, quality, data };
  }

  function confirmManualMatch() {
    if (!_pendingManualMatch) return;
    const { teamA, teamB, courtId, analysisData } = _pendingManualMatch;
    _pendingManualMatch = null;
    document.getElementById('analysis-dialog').classList.remove('open');
    const match = DB.createMatch(courtId, teamA, teamB);
    if (match) {
      DB.saveMatchAnalysis({
        id: crypto.randomUUID(),
        matchId: match.id,
        source: 'manual',
        createdAt: Date.now(),
        courtId, teamA, teamB,
        ...analysisData,
      });
    }
    toast('Match started!', 'success');
    render();
  }

  function closeAnalysisDialog() {
    document.getElementById('analysis-dialog').classList.remove('open');
    _pendingManualMatch = null;
  }

  function clearManualMatch() {
    const db = DB.get();
    const teamSize = db.settings.gameMode === 'doubles' ? 2 : 1;
    ['a', 'b'].forEach(team => {
      Array.from({ length: teamSize }, (_, i) => {
        const sel = document.getElementById(`manual-${team}-${i}`);
        if (sel) sel.value = '';
      });
    });
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
    const logEl = document.getElementById('analysis-log');
    if (!listEl) return;
    listEl.style.display = currentHistoryView === 'results' ? '' : 'none';
    if (logEl) logEl.style.display = currentHistoryView === 'analysis' ? '' : 'none';
    if (currentHistoryView === 'analysis') { renderAnalysisLog(db); return; }

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

  function switchHistoryView(view) {
    currentHistoryView = view;
    document.querySelectorAll('.hist-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    renderHistory(DB.get());
  }

  function renderAnalysisLog(db) {
    const el = document.getElementById('analysis-log');
    if (!el) return;
    const analyses = db.matchAnalyses || [];
    if (analyses.length === 0) {
      el.innerHTML = '<div class="empty-state">No match analyses recorded yet. Start matches to begin logging.</div>';
      return;
    }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = analyses.filter(a => a.createdAt >= todayStart.getTime());
    const todayManual = today.filter(a => a.source === 'manual');
    const todayAuto = today.filter(a => a.source === 'auto');

    let summaryHtml = '';
    if (today.length > 0) {
      const qDist = { good: 0, fair: 0, poor: 0 };
      todayManual.forEach(a => { if (qDist[a.quality] !== undefined) qDist[a.quality]++; });
      const freq = {};
      todayManual.forEach(a => {
        [...(a.teamA||[]), ...(a.teamB||[])].forEach(id => { freq[id] = (freq[id]||0)+1; });
      });
      const sortedFreq = Object.entries(freq).sort((a, b) => b[1]-a[1]);
      const topPicked = sortedFreq.slice(0, 3).map(([id, n]) => {
        const p = db.players.find(pl => pl.id === id);
        return p ? `${esc(p.name)} (${n}×)` : '';
      }).filter(Boolean).join(', ');
      const pickedInManual = new Set(Object.keys(freq));
      const notPicked = db.players.filter(p => !pickedInManual.has(p.id)).map(p => esc(p.name));

      // Fairness concerns
      const issues = [];
      if (todayManual.length >= 3 && qDist.poor >= Math.ceil(todayManual.length * 0.4))
        issues.push(`${qDist.poor}/${todayManual.length} manual matches were poor quality`);
      if (todayManual.length >= 4 && notPicked.length >= db.players.length * 0.4)
        issues.push(`${notPicked.length} players were never picked in manual matches`);
      if (sortedFreq.length > 0 && sortedFreq[0][1] >= 3 && sortedFreq[0][1] >= todayManual.length * 0.5) {
        const p = db.players.find(pl => pl.id === sortedFreq[0][0]);
        if (p) issues.push(`${esc(p.name)} appeared in ${sortedFreq[0][1]}/${todayManual.length} manual matches (possible favouritism)`);
      }
      const fairnessHtml = issues.length > 0
        ? `<div class="fairness-alert">⚠️ Fairness concerns detected:<ul>${issues.map(i => `<li>${i}</li>`).join('')}</ul></div>`
        : todayManual.length >= 2
          ? `<div class="fairness-ok">✅ No fairness concerns detected in today’s manual matches.</div>` : '';

      summaryHtml = `
        <div class="analysis-summary-card">
          <h4>Today’s Session — ${today.length} match${today.length !== 1 ? 'es' : ''}</h4>
          <div class="summary-stats-row">
            <span class="summary-pill auto">⚡ ${todayAuto.length} Auto</span>
            <span class="summary-pill manual">✋ ${todayManual.length} Manual</span>
            ${todayManual.length > 0 ? `
              <span class="summary-pill good">✅ ${qDist.good} Good</span>
              <span class="summary-pill fair">⚡ ${qDist.fair} Fair</span>
              <span class="summary-pill poor">⚠️ ${qDist.poor} Poor</span>` : ''}
          </div>
          ${topPicked ? `<div class="summary-note">Most picked manually: <strong>${topPicked}</strong></div>` : ''}
          ${notPicked.length > 0 && todayManual.length >= 2 ? `<div class="summary-note muted">Not manually picked today: ${notPicked.slice(0, 5).join(', ')}${notPicked.length > 5 ? ` +${notPicked.length-5} more` : ''}</div>` : ''}
          ${fairnessHtml}
        </div>`;
    }

    const entriesHtml = analyses.slice(0, 100).map(a => {
      const date = new Date(a.createdAt);
      const isToday = date >= todayStart;
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = isToday ? 'Today' : date.toLocaleDateString();
      const sourceBadge = a.source === 'manual'
        ? '<span class="source-badge manual">✋ Manual</span>'
        : '<span class="source-badge auto">⚡ Auto</span>';
      const qLabel = a.quality === 'good' ? '✅ Good' : a.quality === 'fair' ? '⚡ Fair' : '⚠️ Poor';
      const teamAStr = (a.teamAPlayers||[]).map(p => `${esc(p.name)} (${esc(p.level)})`).join(' & ')
        || (a.teamA||[]).map(id => { const p = db.players.find(pl => pl.id === id); return p ? esc(p.name) : 'Unknown'; }).join(' & ');
      const teamBStr = (a.teamBPlayers||[]).map(p => `${esc(p.name)} (${esc(p.level)})`).join(' & ')
        || (a.teamB||[]).map(id => { const p = db.players.find(pl => pl.id === id); return p ? esc(p.name) : 'Unknown'; }).join(' & ');
      const critFlags = (a.flags||[]).filter(f => f.level === 'danger' || f.level === 'warning').slice(0, 2);
      const flagsHtml = critFlags.map(f => `<div class="log-flag-mini ${f.level}">${f.icon} ${f.text}</div>`).join('');
      return `
        <div class="analysis-log-entry ${a.quality}">
          <div class="log-entry-header">
            <div class="log-entry-left">
              ${sourceBadge}
              <span class="log-court-name">${esc(a.courtName||a.courtId||'')}</span>
              <span class="log-time-info">${timeStr} · ${dateStr}</span>
            </div>
            <span class="quality-pill ${a.quality}">${qLabel}</span>
          </div>
          <div class="log-teams-row">
            <span class="log-team-name">${teamAStr}</span>
            <span class="log-vs-badge">VS</span>
            <span class="log-team-name">${teamBStr}</span>
            <span class="log-gap">Δ${a.ratingGap||0}</span>
          </div>
          ${flagsHtml ? `<div class="log-flags-list">${flagsHtml}</div>` : ''}
        </div>`;
    }).join('');

    el.innerHTML = summaryHtml + entriesHtml;
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
    const db = DB.get();
    const proposals = Matchmaker.findMatches();
    if (proposals.length === 0) {
      toast('No matches available', 'warning');
      render();
      return;
    }
    for (const { courtId, teamA, teamB } of proposals) {
      const match = DB.createMatch(courtId, teamA, teamB);
      if (match) {
        const analysisData = getAnalysisData(teamA, teamB, courtId, db);
        DB.saveMatchAnalysis({
          id: crypto.randomUUID(),
          matchId: match.id,
          source: 'auto',
          createdAt: Date.now(),
          courtId, teamA, teamB,
          ...analysisData,
        });
      }
    }
    toast(`${proposals.length} match${proposals.length > 1 ? 'es' : ''} started!`, 'success');
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

    // Save ELO snapshots for all players involved
    if (Cloud.isConnected() && match) {
      const freshDb = DB.get();
      const finishedMatch = freshDb.matches.find(m => m.id === matchId);
      [...match.teamA, ...match.teamB].forEach(pid => {
        const player = freshDb.players.find(p => p.id === pid);
        if (player) Cloud.saveRatingSnapshot(pid, player.rating, matchId);
      });
    }

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

  // ── QR Code ───────────────────────────────────────────────
  function showQRCode() {
    const url = window.location.origin + '/player/';
    const el = document.getElementById('qr-container');
    const urlEl = document.getElementById('qr-url-text');
    if (urlEl) urlEl.textContent = url;
    if (el) {
      el.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        try {
          new QRCode(el, {
            text: url,
            width: 220,
            height: 220,
            colorDark: '#e8eaf6',
            colorLight: '#1a1a2e',
            correctLevel: QRCode.CorrectLevel.M,
          });
        } catch (e) {
          el.innerHTML = `<div class="qr-fallback"><a href="${esc(url)}" target="_blank">${esc(url)}</a></div>`;
        }
      } else {
        // Fallback: use Google Charts API to generate QR
        const encoded = encodeURIComponent(url);
        el.innerHTML = `<img src="https://chart.googleapis.com/chart?chs=220x220&cht=qr&chl=${encoded}&choe=UTF-8" width="220" height="220" alt="QR Code">`;
      }
    }
    document.getElementById('qr-modal').classList.add('open');
  }

  function closeQRCode() {
    document.getElementById('qr-modal').classList.remove('open');
  }

  // ── Join Requests ─────────────────────────────────────────
  async function refreshJoinRequests() {
    if (!Cloud.isConnected()) {
      toast('No cloud connection', 'warning');
      return;
    }
    const requests = await Cloud.getJoinRequests('pending');
    const badge = document.getElementById('requests-badge');
    const countBadge = document.getElementById('requests-count-badge');
    const panel = document.getElementById('join-requests-panel');
    const list = document.getElementById('join-requests-list');

    if (badge) { badge.textContent = requests.length; badge.style.display = requests.length > 0 ? 'flex' : 'none'; }
    if (countBadge) countBadge.textContent = requests.length;
    if (panel) panel.style.display = 'block';

    if (!list) return;
    if (requests.length === 0) {
      list.innerHTML = '<div class="empty-state">No pending requests.</div>';
      return;
    }

    const db = DB.get();
    list.innerHTML = requests.map(req => {
      const time = new Date(req.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="join-request-card" id="req-${req.id}">
        <div class="join-req-info">
          <div class="join-req-name">${esc(req.display_name)}</div>
          <div class="join-req-meta">
            Level: <strong>${esc(req.skill_level)}</strong>
            ${req.gender ? ` · ${esc(req.gender)}` : ''}
            ${req.contact ? ` · ${esc(req.contact)}` : ''}
            · ${time}
          </div>
        </div>
        <div class="join-req-actions">
          <select id="link-player-${req.id}" class="join-req-player-select">
            <option value="">— New player —</option>
            ${db.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
          <button class="btn btn-xs btn-success" onclick="App.approveJoinRequest('${req.id}', '${esc(req.display_name)}', '${esc(req.skill_level)}')">✓ Approve</button>
          <button class="btn btn-xs btn-danger"  onclick="App.rejectJoinRequest('${req.id}')">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  async function approveJoinRequest(requestId, displayName, skillLevel) {
    const selectEl = document.getElementById(`link-player-${requestId}`);
    let playerId = selectEl?.value;

    if (!playerId) {
      // Create new player in localStorage DB
      DB.addPlayer(displayName, skillLevel);
      const db = DB.get();
      // Find by name — addPlayer may create duplicates if called twice, so dedup
      const matches = db.players.filter(p => p.name === displayName);
      if (!matches.length) return toast('Failed to create player', 'danger');
      // Use the most recently created one
      const newPlayer = matches[matches.length - 1];
      // Remove any accidental duplicates (same name, keep newest)
      if (matches.length > 1) {
        DB.update(data => {
          const keep = newPlayer.id;
          data.players = data.players.filter(p => p.name !== displayName || p.id === keep);
        });
      }
      playerId = newPlayer.id;
      // Upsert to Supabase (upsert prevents duplicate if called twice)
      if (Cloud.isConnected()) {
        await Cloud.addPlayer(newPlayer);
      }
      toast(`${displayName} added as new player`, 'success');
    }

    const ok = await Cloud.approveJoinRequest(requestId, playerId);
    if (ok) {
      document.getElementById(`req-${requestId}`)?.remove();
      toast(`${displayName} approved!`, 'success');
      render();
    } else {
      toast('Approval failed — check connection', 'danger');
    }
  }

  async function rejectJoinRequest(requestId) {
    const ok = await Cloud.rejectJoinRequest(requestId);
    if (ok) {
      document.getElementById(`req-${requestId}`)?.remove();
      toast('Request rejected', 'info');
    }
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
    startManualMatch, clearManualMatch, renderDashboardManual,
    confirmManualMatch, closeAnalysisDialog,
    switchHistoryView,
    showQRCode, closeQRCode,
    refreshJoinRequests, approveJoinRequest, rejectJoinRequest,
    saveSettings, exportData, importData, resetData,
    pushToCloud, pullFromCloud,
    recordPayment, settlePlayer,
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  // Poll for join requests every 30s when cloud is available
  setInterval(() => {
    if (Cloud.isConnected()) App.refreshJoinRequests();
  }, 30000);
});
