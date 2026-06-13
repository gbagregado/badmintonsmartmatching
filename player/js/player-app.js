/**
 * Player App — main logic for the Player PWA
 */
const PlayerApp = (() => {

  // ── State ─────────────────────────────────────────────────
  let deviceId    = null;
  let profile     = null;  // { displayName, contact, gender, weightKg, skillLevel }
  let linkedId    = null;  // Supabase players.id
  let playerData  = null;  // full row from players table
  let currentTab  = 'queue';
  let queueSub    = null;
  let matchSub    = null;
  let reqSub      = null;
  let allPlayers  = [];
  let queueRows   = [];
  let activeMatches = [];
  let myMatches   = [];
  let ratingHistory = [];
  let pendingReqId = null; // join_request.id while waiting for approval
  let _pollTimer   = null; // polling interval for approval check

  // ── Helpers ───────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
    if (d >= today) return 'Today';
    if (d >= yesterday) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function calories(durationMs) {
    const mins = durationMs / 60000;
    const MET  = (profile?.gameMode === 'singles') ? 8.0 : 6.5;
    const kg   = parseFloat(profile?.weightKg) || null;
    if (kg) return Math.round(mins * MET * kg / 200);
    // estimate by gender default
    const defaultKg = profile?.gender === 'Female' ? 60 : 65;
    return Math.round(mins * MET * defaultKg / 200);
  }

  function playerName(id) {
    const p = allPlayers.find(x => x.id === id);
    return p ? p.name : '?';
  }

  function annotateMatch(m) {
    if (!linkedId) return m;
    const inA = (m.team_a || []).includes(linkedId);
    const inB = (m.team_b || []).includes(linkedId);
    const won  = (inA && m.winner === 'A') || (inB && m.winner === 'B');
    const lost = (inA && m.winner === 'B') || (inB && m.winner === 'A');
    const dur  = m.ended_at && m.started_at ? new Date(m.ended_at) - new Date(m.started_at) : 0;
    return { ...m, _won: won, _lost: lost, _duration: dur, _cal: calories(dur) };
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/player/sw.js').catch(() => {});
    }

    // Load device identity
    deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('deviceId', deviceId);
    }

    profile  = JSON.parse(localStorage.getItem('playerProfile') || 'null');
    linkedId = localStorage.getItem('linkedPlayerId') || null;

    // Init Supabase
    PlayerCloud.init();

    // Show loading screen briefly
    document.getElementById('screen-loading').style.display = 'flex';

    if (!profile) {
      showScreen('screen-setup');
      return;
    }

    // Try to resolve link from cloud
    if (!linkedId && PlayerCloud.ready()) {
      linkedId = await PlayerCloud.getLinkedPlayerId(deviceId);
      if (linkedId) localStorage.setItem('linkedPlayerId', linkedId);
    }

    // Check if still pending approval
    if (!linkedId && PlayerCloud.ready()) {
      const req = await PlayerCloud.getMyRequest(deviceId);
      if (req && req.status === 'pending') {
        pendingReqId = req.id;
        showScreen('screen-pending');
        subscribeForApproval();
        return;
      }
      if (req && req.status === 'approved' && req.player_id) {
        linkedId = req.player_id;
        localStorage.setItem('linkedPlayerId', linkedId);
      }
    }

    await loadAllData();
    bindNav();
    showScreen('screen-main');
    switchTab('queue');
  }

  async function loadAllData() {
    const jobs = [
      PlayerCloud.getAllPlayers().then(d => { allPlayers = d; }),
      PlayerCloud.getQueue().then(d => { queueRows = d; }),
      PlayerCloud.getActiveMatches().then(d => { activeMatches = d; }),
    ];
    if (linkedId) {
      jobs.push(PlayerCloud.getPlayer(linkedId).then(d => { playerData = d; }));
      jobs.push(PlayerCloud.getPlayerMatches(linkedId).then(d => {
        myMatches = d.map(annotateMatch);
      }));
      jobs.push(PlayerCloud.getRatingHistory(linkedId).then(d => { ratingHistory = d; }));
    }
    await Promise.allSettled(jobs);
    subscribeRealtime();
  }

  function subscribeRealtime() {
    queueSub?.unsubscribe?.();
    matchSub?.unsubscribe?.();
    queueSub = PlayerCloud.subscribeQueue(() => {
      PlayerCloud.getQueue().then(d => { queueRows = d; renderQueueTab(); });
    });
    matchSub = PlayerCloud.subscribeMatches(() => {
      PlayerCloud.getActiveMatches().then(d => { activeMatches = d; renderQueueTab(); });
    });
  }

  function subscribeForApproval() {
    reqSub = PlayerCloud.subscribeJoinRequest(deviceId, async (payload) => {
      const row = payload.new;
      if (row.status === 'approved' && row.player_id) {
        linkedId = row.player_id;
        localStorage.setItem('linkedPlayerId', linkedId);
        reqSub?.unsubscribe?.();
        clearInterval(_pollTimer);
        await loadAllData();
        bindNav();
        showScreen('screen-main');
        switchTab('queue');
      } else if (row.status === 'rejected') {
        reqSub?.unsubscribe?.();
        clearInterval(_pollTimer);
        document.getElementById('pending-msg').textContent = '\u274c Your request was declined. Please ask the queue master.';
      }
    });
    // Polling fallback every 5s in case Realtime filter doesn\'t fire
    _pollTimer = setInterval(async () => {
      const req = await PlayerCloud.getMyRequest(deviceId);
      if (req?.status === 'approved' && req.player_id) {
        linkedId = req.player_id;
        localStorage.setItem('linkedPlayerId', linkedId);
        reqSub?.unsubscribe?.();
        clearInterval(_pollTimer);
        await loadAllData();
        bindNav();
        showScreen('screen-main');
        switchTab('queue');
      } else if (req?.status === 'rejected') {
        reqSub?.unsubscribe?.();
        clearInterval(_pollTimer);
        document.getElementById('pending-msg').textContent = '\u274c Your request was declined. Please ask the queue master.';
      }
    }, 5000);
  }

  // ── Screen management ─────────────────────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  function bindNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(c => c.style.display = c.id === `tab-${tab}` ? 'block' : 'none');
    renderTab(tab);
  }

  function renderTab(tab) {
    if (tab === 'queue')    renderQueueTab();
    if (tab === 'stats')    renderStatsTab();
    if (tab === 'history')  renderHistoryTab();
    if (tab === 'insights') renderInsightsTab();
    if (tab === 'profile')  renderProfileTab();
  }

  // ── Profile Setup ─────────────────────────────────────────
  function bindSetupForm() {
    const genderOther = document.getElementById('setup-gender');
    if (genderOther) {
      genderOther.addEventListener('change', () => {
        const wrap = document.getElementById('gender-other-wrap');
        if (wrap) wrap.style.display = genderOther.value === 'Other' ? 'block' : 'none';
      });
    }

    const weightToggle = document.getElementById('weight-toggle');
    const weightRow = document.getElementById('weight-row');
    if (weightToggle && weightRow) {
      weightToggle.addEventListener('change', () => {
        weightRow.style.display = weightToggle.checked ? 'block' : 'none';
      });
    }

    document.getElementById('setup-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const genderVal = document.getElementById('setup-gender').value;
      const genderFinal = genderVal === 'Other'
        ? (document.getElementById('setup-gender-other').value.trim() || 'Other')
        : genderVal;
      const weightInput = document.getElementById('setup-weight');
      const weightKg = weightInput?.value ? parseFloat(weightInput.value) : null;

      profile = {
        displayName: document.getElementById('setup-name').value.trim(),
        contact:     document.getElementById('setup-contact').value.trim(),
        gender:      genderFinal,
        weightKg,
        skillLevel:  document.getElementById('setup-level').value,
      };

      if (!profile.displayName) return alert('Please enter your name.');

      localStorage.setItem('playerProfile', JSON.stringify(profile));

      if (PlayerCloud.ready()) {
        const { error } = await PlayerCloud.submitJoinRequest(deviceId, profile);
        if (error) {
          console.warn('Submit failed:', error);
          // Still continue offline — QM can add manually
        } else {
          pendingReqId = true;
          showScreen('screen-pending');
          subscribeForApproval();
          return;
        }
      }

      // Offline fallback: go straight to main (unlinked)
      await loadAllData();
      bindNav();
      showScreen('screen-main');
      switchTab('queue');
    });
  }

  // ── Queue Tab ─────────────────────────────────────────────
  function renderQueueTab() {
    const el = document.getElementById('tab-queue');
    if (!el || currentTab !== 'queue') return;

    const myPos = linkedId ? queueRows.findIndex(r => r.player_id === linkedId) : -1;
    const inQueue = myPos !== -1;
    const inMatch = linkedId ? activeMatches.some(m =>
      (m.team_a||[]).includes(linkedId) || (m.team_b||[]).includes(linkedId)) : false;

    // Estimate wait time
    const avgMatchMs = estimateAvgMatchMs();
    let waitMs = 0;
    if (inQueue && myPos > 0) {
      // How many courts available soon
      const courtsInUse = activeMatches.length;
      const matchesAhead = Math.ceil(myPos / 2); // doubles
      waitMs = matchesAhead * avgMatchMs;
    }
    const waitStr = waitMs > 0 ? fmtDuration(waitMs) : '—';

    // Upcoming match preview (who I might play with)
    let upcomingHtml = '';
    if (inQueue) {
      upcomingHtml = buildUpcomingPreview(myPos);
    }

    // Active courts
    const courtsHtml = activeMatches.map(m => {
      const teamA = (m.team_a||[]).map(playerName).join(' & ');
      const teamB = (m.team_b||[]).map(playerName).join(' & ');
      const elapsed = fmtDuration(Date.now() - new Date(m.started_at));
      const hasMe = linkedId && ((m.team_a||[]).includes(linkedId) || (m.team_b||[]).includes(linkedId));
      return `<div class="court-card ${hasMe ? 'my-court' : ''}">
        <div class="court-header">
          <span class="court-label">🟢 Court</span>
          <span class="court-time">${elapsed}</span>
        </div>
        <div class="court-teams">
          <span>${esc(teamA)}</span>
          <span class="vs-sep">vs</span>
          <span>${esc(teamB)}</span>
        </div>
        ${hasMe ? '<div class="my-court-badge">You are playing!</div>' : ''}
      </div>`;
    }).join('') || '<div class="empty-note">No active matches right now.</div>';

    // Queue list (top 10)
    const queueHtml = queueRows.slice(0, 12).map((r, i) => {
      const isMe = r.player_id === linkedId;
      const p = allPlayers.find(x => x.id === r.player_id);
      const wait = fmtDuration(Date.now() - new Date(r.queued_at));
      return `<div class="queue-row ${isMe ? 'queue-row-me' : ''}">
        <span class="q-pos">${i+1}</span>
        <span class="q-name">${esc(p?.name || '?')} ${isMe ? '<span class="you-badge">YOU</span>' : ''}</span>
        <span class="q-level">${esc(p?.skill_level || '?')}</span>
        <span class="q-wait">${wait}</span>
      </div>`;
    }).join('') || '<div class="empty-note">Queue is empty.</div>';

    el.innerHTML = `
      <div class="tab-scroll">
        ${inMatch ? `
          <div class="status-banner playing">
            🎾 You are currently playing!
          </div>` : inQueue ? `
          <div class="status-banner in-queue">
            <div class="queue-position-big">#${myPos + 1}</div>
            <div class="queue-status-label">Your position in queue</div>
            <div class="queue-wait-est">⏱ Est. wait: <strong>~${waitStr}</strong></div>
          </div>` : `
          <div class="status-banner idle">
            Not in queue
          </div>`}

        ${upcomingHtml}

        <div class="section-block">
          <h4>Active Courts</h4>
          ${courtsHtml}
        </div>

        <div class="section-block">
          <h4>Queue (${queueRows.length} players)</h4>
          ${queueHtml}
          ${queueRows.length > 12 ? `<div class="empty-note">+${queueRows.length - 12} more…</div>` : ''}
        </div>

        <div class="action-row">
          ${!inQueue && !inMatch
            ? `<button class="btn-action btn-join" onclick="PlayerApp.requestJoinQueue()">✋ Request to Join Queue</button>`
            : inQueue
              ? `<button class="btn-action btn-leave" onclick="PlayerApp.requestLeaveQueue()">🚪 Request to Leave Queue</button>`
              : ''}
        </div>
      </div>`;
  }

  function estimateAvgMatchMs() {
    if (myMatches.length >= 3) {
      const durations = myMatches.filter(m => m._duration > 0).map(m => m._duration);
      if (durations.length) return durations.reduce((a,b) => a+b,0) / durations.length;
    }
    return 25 * 60 * 1000; // default 25 min
  }

  function buildUpcomingPreview(myPos) {
    // Simple: look at who is just ahead in queue + guess partners
    if (myPos < 0 || queueRows.length < 4) return '';
    const upcoming = queueRows.slice(0, Math.min(myPos + 4, queueRows.length))
      .map(r => allPlayers.find(x => x.id === r.player_id)?.name || '?');
    return `<div class="upcoming-preview">
      <div class="upcoming-label">🔮 Upcoming match</div>
      <div class="upcoming-players">Based on queue position, you may play with: <strong>${esc(upcoming.join(', '))}</strong></div>
      <div class="upcoming-note">Actual match decided by queue master</div>
    </div>`;
  }

  function requestJoinQueue() {
    if (!PlayerCloud.ready()) {
      alert('You need an internet connection. Ask the queue master to add you manually.');
      return;
    }
    if (!linkedId) {
      alert('Your account is not linked yet. Wait for the queue master to approve your request, or ask them to add you.');
      return;
    }
    alert('Request sent! The queue master will add you to the queue.');
    // In a full implementation this would insert a queue_request row
    // For now the QM adds them manually via the approval flow
  }

  function requestLeaveQueue() {
    alert('Please ask the queue master to remove you from the queue.');
  }

  // ── Stats Tab ─────────────────────────────────────────────
  function renderStatsTab() {
    const el = document.getElementById('tab-stats');
    if (!el || currentTab !== 'stats') return;

    if (!playerData && !profile) { el.innerHTML = '<div class="empty-note">Profile not set up yet.</div>'; return; }

    const p = playerData;
    const totalMatches  = p?.matches_played || 0;
    const totalWins     = p?.wins || 0;
    const totalLosses   = p?.losses || 0;
    const winRate       = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
    const rating        = p?.rating || 1200;
    const streak        = p?.streak || 0;
    const streakStr     = streak > 0 ? `🔥 ${streak}W streak` : streak < 0 ? `❄️ ${Math.abs(streak)}L streak` : '—';

    // Today's stats
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMatches = myMatches.filter(m => new Date(m.ended_at||m.started_at) >= todayStart);
    const todayWins = todayMatches.filter(m => m._won).length;
    const todayMins = Math.round(todayMatches.reduce((s,m) => s + (m._duration||0), 0) / 60000);
    const todayCal  = todayMatches.reduce((s,m) => s + (m._cal||0), 0);

    // All time totals
    const totalMins = Math.round(myMatches.reduce((s,m) => s + (m._duration||0), 0) / 60000);
    const totalHours = (totalMins / 60).toFixed(1);
    const totalCal  = myMatches.reduce((s,m) => s + (m._cal||0), 0);

    // ELO trend spark
    const sparkHtml = buildEloSpark();

    // Best partner / toughest opp
    const bestPartner = PlayerTips.getBestPartner(linkedId, myMatches, allPlayers);
    const toughOpp    = PlayerTips.getToughestOpponent(linkedId, myMatches, allPlayers);
    const peakHour    = PlayerTips.getPeakHour(linkedId, myMatches);

    const calNote = profile?.weightKg ? '' : '<span class="cal-note">*estimated (no weight entered)</span>';

    el.innerHTML = `
      <div class="tab-scroll">
        <div class="stats-hero">
          <div class="stats-hero-rating">${rating}</div>
          <div class="stats-hero-level">${esc(p?.skill_level || profile?.skillLevel || '?')}</div>
          <div class="stats-hero-streak">${streakStr}</div>
          ${sparkHtml}
        </div>

        <div class="stats-grid-2">
          <div class="stats-block">
            <div class="stats-block-title">Today</div>
            <div class="stat-row"><span>Games</span><strong>${todayMatches.length}</strong></div>
            <div class="stat-row"><span>W / L</span><strong>${todayWins} / ${todayMatches.length - todayWins}</strong></div>
            <div class="stat-row"><span>Time</span><strong>${todayMins} min</strong></div>
            <div class="stat-row"><span>Calories</span><strong>~${todayCal} kcal</strong>${calNote}</div>
          </div>
          <div class="stats-block">
            <div class="stats-block-title">All Time</div>
            <div class="stat-row"><span>Games</span><strong>${totalMatches}</strong></div>
            <div class="stat-row"><span>Win rate</span><strong>${winRate}%</strong></div>
            <div class="stat-row"><span>Time</span><strong>${totalHours}h</strong></div>
            <div class="stat-row"><span>Calories</span><strong>~${Math.round(totalCal/1000)}k kcal*</strong></div>
          </div>
        </div>

        <div class="section-block">
          <h4>Insights</h4>
          ${bestPartner ? `<div class="insight-row">🤝 Best partner: <strong>${esc(bestPartner.name)}</strong> (${bestPartner.wins}W/${bestPartner.games - bestPartner.wins}L together)</div>` : ''}
          ${toughOpp    ? `<div class="insight-row">⚔️ Toughest opp: <strong>${esc(toughOpp.name)}</strong> (${toughOpp.wins}W/${toughOpp.losses}L vs them)</div>` : ''}
          ${peakHour    ? `<div class="insight-row">⏰ Peak hours: <strong>${peakHour}</strong></div>` : ''}
          ${!bestPartner && !toughOpp && !peakHour ? '<div class="empty-note">Play more games to unlock insights!</div>' : ''}
        </div>
      </div>`;
  }

  function buildEloSpark() {
    if (ratingHistory.length < 2) return '';
    const ratings = ratingHistory.map(r => r.rating);
    const min = Math.min(...ratings) - 50;
    const max = Math.max(...ratings) + 50;
    const w = 200, h = 40;
    const pts = ratings.map((r, i) => {
      const x = (i / (ratings.length - 1)) * w;
      const y = h - ((r - min) / (max - min)) * h;
      return `${x},${y}`;
    }).join(' ');
    const latest = ratings[ratings.length - 1];
    const prev = ratings[ratings.length - 2];
    const arrow = latest > prev ? '↑' : latest < prev ? '↓' : '→';
    const color = latest > prev ? '#00b894' : latest < prev ? '#e17055' : '#74b9ff';
    return `<div class="elo-spark-wrap">
      <svg viewBox="0 0 ${w} ${h}" class="elo-spark">
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
      </svg>
      <div class="elo-delta" style="color:${color}">${arrow}${Math.abs(latest - prev)} pts</div>
    </div>`;
  }

  // ── History Tab ───────────────────────────────────────────
  function renderHistoryTab() {
    const el = document.getElementById('tab-history');
    if (!el || currentTab !== 'history') return;

    if (!linkedId) {
      el.innerHTML = '<div class="empty-note">Link your account to see match history.</div>';
      return;
    }
    if (!myMatches.length) {
      el.innerHTML = '<div class="empty-note">No matches recorded yet.</div>';
      return;
    }

    const rows = myMatches.slice(0, 50).map(m => {
      const teamA = (m.team_a||[]).map(playerName).join(' & ');
      const teamB = (m.team_b||[]).map(playerName).join(' & ');
      const result = m._won ? '<span class="result-w">W</span>' : m._lost ? '<span class="result-l">L</span>' : '<span class="result-d">—</span>';
      const score = (m.score_a != null && m.score_b != null) ? `${m.score_a}–${m.score_b}` : '?–?';
      const dur   = m._duration > 0 ? fmtDuration(m._duration) : '';
      const cal   = m._cal > 0 ? `~${m._cal} kcal` : '';
      const dateStr = fmtDate(m.ended_at || m.started_at);
      const timeStr = fmtTime(m.ended_at || m.started_at);
      const inA = (m.team_a||[]).includes(linkedId);
      const myTeam  = inA ? teamA : teamB;
      const oppTeam = inA ? teamB : teamA;
      return `<div class="history-card ${m._won ? 'won' : m._lost ? 'lost' : ''}">
        <div class="hist-header">
          ${result}
          <span class="hist-score">${score}</span>
          <span class="hist-meta">${esc(dateStr)} ${esc(timeStr)}</span>
          ${dur ? `<span class="hist-meta">${esc(dur)}</span>` : ''}
          ${cal ? `<span class="hist-meta">🔥${esc(cal)}</span>` : ''}
        </div>
        <div class="hist-teams">
          <span class="hist-my-team">${esc(myTeam)}</span>
          <span class="hist-vs">vs</span>
          <span class="hist-opp-team">${esc(oppTeam)}</span>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `<div class="tab-scroll">${rows}</div>`;
  }

  // ── Insights Tab ──────────────────────────────────────────
  function renderInsightsTab() {
    const el = document.getElementById('tab-insights');
    if (!el || currentTab !== 'insights') return;

    const tips = PlayerTips.generateTips(playerData, myMatches, myMatches);
    const badges = PlayerTips.getBadges(playerData || {}, myMatches);

    const tipsHtml = tips.length
      ? tips.map(t => `<div class="tip-card ${t.type}">
          <div class="tip-icon">${t.icon}</div>
          <div><div class="tip-title">${esc(t.title)}</div><div class="tip-text">${esc(t.text)}</div></div>
        </div>`).join('')
      : '<div class="empty-note">Play some matches to get personalized tips!</div>';

    const badgesHtml = badges.map(b => `
      <div class="badge-card ${b.earned ? 'earned' : 'locked'}">
        <div class="badge-icon">${b.earned ? b.icon : '🔒'}</div>
        <div class="badge-label">${esc(b.label)}</div>
        <div class="badge-desc">${esc(b.desc)}</div>
      </div>`).join('');

    el.innerHTML = `
      <div class="tab-scroll">
        <div class="section-block">
          <h4>💡 Tips for You</h4>
          ${tipsHtml}
        </div>
        <div class="section-block">
          <h4>🏅 Badges</h4>
          <div class="badges-grid">${badgesHtml}</div>
        </div>
      </div>`;
  }

  // ── Profile Tab ───────────────────────────────────────────
  function renderProfileTab() {
    const el = document.getElementById('tab-profile');
    if (!el || currentTab !== 'profile') return;

    if (!profile) { el.innerHTML = '<div class="empty-note">No profile yet.</div>'; return; }

    const p = playerData;
    const weightNote = profile.weightKg
      ? `${profile.weightKg} kg`
      : 'Not entered (using average estimate for calories)';

    el.innerHTML = `
      <div class="tab-scroll">
        <div class="profile-hero">
          <div class="profile-avatar">${esc(profile.displayName.charAt(0).toUpperCase())}</div>
          <div class="profile-name">${esc(profile.displayName)}</div>
          <div class="profile-level-badge level-badge-lg">${esc(p?.skill_level || profile.skillLevel)}</div>
          ${linkedId ? '<div class="linked-badge">✅ Account linked</div>' : '<div class="linked-badge unlinked">⏳ Pending approval</div>'}
        </div>

        <div class="section-block">
          <h4>My Details</h4>
          <div class="profile-row"><span>Name</span><span>${esc(profile.displayName)}</span></div>
          <div class="profile-row"><span>Contact</span><span>${esc(profile.contact || '—')}</span></div>
          <div class="profile-row"><span>Gender</span><span>${esc(profile.gender || '—')}</span></div>
          <div class="profile-row"><span>Weight</span><span>${esc(weightNote)}</span></div>
          <div class="profile-row"><span>Level</span><span>${esc(p?.skill_level || profile.skillLevel)}</span></div>
          <div class="profile-row"><span>ELO Rating</span><span>${p?.rating || '—'}</span></div>
          <div class="profile-row"><span>Device ID</span><span class="device-id">${deviceId.substring(0,8)}…</span></div>
        </div>

        <div class="section-block">
          <button class="btn-outline-sm" onclick="PlayerApp.editProfile()">✏️ Edit Profile</button>
          <button class="btn-outline-sm danger" onclick="PlayerApp.resetProfile()">🗑 Reset App</button>
        </div>
      </div>`;
  }

  function editProfile() {
    showScreen('screen-setup');
    // Pre-fill form
    setTimeout(() => {
      const f = document.getElementById('setup-form');
      if (!f || !profile) return;
      document.getElementById('setup-name').value    = profile.displayName || '';
      document.getElementById('setup-contact').value = profile.contact || '';
      document.getElementById('setup-level').value   = profile.skillLevel || 'C';
      const g = document.getElementById('setup-gender');
      const knownGenders = ['Male','Female','Non-binary','Genderqueer','Agender','Transgender','Prefer not to say','Other'];
      if (knownGenders.includes(profile.gender)) {
        g.value = profile.gender;
      } else {
        g.value = 'Other';
        document.getElementById('setup-gender-other').value = profile.gender || '';
        document.getElementById('gender-other-wrap').style.display = 'block';
      }
      if (profile.weightKg) {
        document.getElementById('weight-toggle').checked = true;
        document.getElementById('weight-row').style.display = 'block';
        document.getElementById('setup-weight').value = profile.weightKg;
      }
    }, 50);
  }

  function resetProfile() {
    if (!confirm('This will remove all local profile data. Continue?')) return;
    localStorage.removeItem('playerProfile');
    localStorage.removeItem('linkedPlayerId');
    localStorage.removeItem('deviceId');
    location.reload();
  }

  return {
    init, bindSetupForm,
    switchTab,
    requestJoinQueue, requestLeaveQueue,
    editProfile, resetProfile,
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  PlayerApp.bindSetupForm();
  PlayerApp.init();
});
