/**
 * Storage Layer - localStorage wrapper with structured data management
 * Acts as a lightweight database for the badminton queue app
 */
const DB = (() => {
  const STORAGE_KEY = 'badminton_queue_db';

  const DEFAULT_DATA = {
    settings: {
      courtCount: 4,
      gameMode: 'doubles', // 'singles' or 'doubles'
      defaultRating: 1200,
      challengeFactor: 0.15, // 0 = perfect balance, 1 = max challenge
      maxPointsPerSet: 21,
      setsToWin: 1,
      shuttleCost: 5.00, // cost per shuttle (split among players in the match)
    },
    players: [],
    courts: [],
    queue: [],       // player IDs in queue order
    matches: [],     // match history
    activeMatches: [],
    payments: [],    // { id, playerId, matchId, amount, type: 'charge'|'payment', createdAt, note }
    matchAnalyses: [], // { id, matchId, source, createdAt, courtId, teamA, teamB, teamAAvg, teamBAvg, ratingGap, quality, flags, teamAPlayers, teamBPlayers, courtName }
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_DATA);
      const data = JSON.parse(raw);
      // Merge with defaults for forward-compatibility
      return { ...structuredClone(DEFAULT_DATA), ...data };
    } catch {
      return structuredClone(DEFAULT_DATA);
    }
  }

  function save(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    // Schedule cloud sync (debounced)
    scheduleSync();
  }

  let _syncTimer = null;
  function scheduleSync() {
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => {
      if (typeof Cloud !== 'undefined' && Cloud.isConnected()) {
        Cloud.pushAll(load()).then(ok => {
          if (ok) console.log('[DB] Synced to cloud');
        });
      }
    }, 500);
  }

  // Pull from cloud and merge into local (cloud wins)
  async function syncFromCloud() {
    if (typeof Cloud === 'undefined' || !Cloud.isConnected()) return false;
    const remote = await Cloud.pullAll();
    if (!remote) return false;
    const local = load(); // preserve local-only data not stored in cloud
    const merged = {
      ...structuredClone(DEFAULT_DATA),
      settings: { ...structuredClone(DEFAULT_DATA).settings, ...remote.settings },
      players: remote.players,
      courts: remote.courts,
      queue: remote.queue,
      activeMatches: remote.activeMatches,
      matches: remote.matches,
      payments: local.payments,       // payments have no cloud table — must not be wiped on sync
      matchAnalyses: local.matchAnalyses || [], // analyses are local-only
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return true;
  }

  function get() {
    return load();
  }

  function update(fn) {
    const data = load();
    fn(data);
    save(data);
    return data;
  }

  // ── Players ──────────────────────────────────────────
  // Official badminton levels: A+ (highest) down to G (lowest)
  const LEVELS = ['A+','A','B+','B','C+','C','D+','D','E+','E','F+','F','G'];
  const LEVEL_RATINGS = {
    'A+': 2000, 'A': 1850, 'B+': 1700, 'B': 1550,
    'C+': 1400, 'C': 1250, 'D+': 1100, 'D': 950,
    'E+': 800,  'E': 700,  'F+': 600,  'F': 500, 'G': 400,
  };

  function addPlayer(name, skillLevel) {
    return update(db => {
      const rating = LEVEL_RATINGS[skillLevel] ?? db.settings.defaultRating;

      db.players.push({
        id: crypto.randomUUID(),
        name: name.trim(),
        rating,
        initialRating: rating,
        skillLevel,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        totalPointsScored: 0,
        totalPointsLost: 0,
        streak: 0, // positive = win streak, negative = loss streak
        createdAt: Date.now(),
        lastMatchAt: null,
      });
    });
  }

  function removePlayer(playerId) {
    return update(db => {
      db.players = db.players.filter(p => p.id !== playerId);
      db.queue = db.queue.filter(q => q.id !== playerId);
    });
  }

  function getPlayer(playerId) {
    return load().players.find(p => p.id === playerId);
  }

  function updatePlayer(playerId, changes) {
    return update(db => {
      const idx = db.players.findIndex(p => p.id === playerId);
      if (idx !== -1) Object.assign(db.players[idx], changes);
    });
  }

  // ── Queue ────────────────────────────────────────────
  function enqueue(playerId) {
    return update(db => {
      if (!db.queue.some(q => q.id === playerId)) {
        db.queue.push({ id: playerId, joinedAt: Date.now(), gamesPlayedToday: 0 });
      }
    });
  }

  function dequeue(playerId) {
    return update(db => {
      db.queue = db.queue.filter(q => q.id !== playerId);
    });
  }

  function clearQueue() {
    return update(db => { db.queue = []; });
  }

  function reorderQueue(newOrder) {
    return update(db => { db.queue = newOrder; });
  }

  // ── Courts ───────────────────────────────────────────
  function initCourts(count) {
    return update(db => {
      db.settings.courtCount = count;
      db.courts = [];
      for (let i = 0; i < count; i++) {
        db.courts.push({
          id: `court-${i + 1}`,
          name: `Court ${i + 1}`,
          status: 'available', // 'available' | 'in-use'
          currentMatchId: null,
        });
      }
    });
  }

  function getAvailableCourts() {
    return load().courts.filter(c => c.status === 'available');
  }

  // ── Matches ──────────────────────────────────────────
  function createMatch(courtId, teamA, teamB) {
    let match = null;
    update(db => {
      match = {
        id: crypto.randomUUID(),
        courtId,
        teamA, // array of player IDs
        teamB, // array of player IDs
        scoreA: 0,
        scoreB: 0,
        startedAt: Date.now(),
        endedAt: null,
        winner: null, // 'A' or 'B'
      };
      db.activeMatches.push(match);
      const court = db.courts.find(c => c.id === courtId);
      if (court) {
        court.status = 'in-use';
        court.currentMatchId = match.id;
      }
      // Remove matched players from queue
      const allPlayers = [...teamA, ...teamB];
      db.queue = db.queue.filter(q => !allPlayers.includes(q.id));
    });
    return match;
  }

  function finishMatch(matchId, scoreA, scoreB) {
    return update(db => {
      const idx = db.activeMatches.findIndex(m => m.id === matchId);
      if (idx === -1) return;

      const match = db.activeMatches[idx];
      match.scoreA = scoreA;
      match.scoreB = scoreB;
      match.endedAt = Date.now();
      match.winner = scoreA > scoreB ? 'A' : 'B';

      // Update player stats & ratings
      const winners = match.winner === 'A' ? match.teamA : match.teamB;
      const losers = match.winner === 'A' ? match.teamB : match.teamA;
      const winScore = Math.max(scoreA, scoreB);
      const loseScore = Math.min(scoreA, scoreB);

      // ELO calculation
      const avgWinnerRating = avg(winners.map(id => db.players.find(p => p.id === id)?.rating || 1200));
      const avgLoserRating = avg(losers.map(id => db.players.find(p => p.id === id)?.rating || 1200));
      const expectedWin = 1 / (1 + Math.pow(10, (avgLoserRating - avgWinnerRating) / 400));
      const kFactor = 32;
      const ratingChange = Math.round(kFactor * (1 - expectedWin));

      for (const pid of winners) {
        const p = db.players.find(pl => pl.id === pid);
        if (!p) continue;
        p.matchesPlayed++;
        p.wins++;
        p.totalPointsScored += winScore;
        p.totalPointsLost += loseScore;
        p.rating += ratingChange;
        p.streak = p.streak >= 0 ? p.streak + 1 : 1;
        p.lastMatchAt = Date.now();
      }
      for (const pid of losers) {
        const p = db.players.find(pl => pl.id === pid);
        if (!p) continue;
        p.matchesPlayed++;
        p.losses++;
        p.totalPointsScored += loseScore;
        p.totalPointsLost += winScore;
        p.rating -= ratingChange;
        p.streak = p.streak <= 0 ? p.streak - 1 : -1;
        p.lastMatchAt = Date.now();
      }

      // Move to history
      db.matches.unshift(match);
      db.activeMatches.splice(idx, 1);

      // Free court
      const court = db.courts.find(c => c.id === match.courtId);
      if (court) {
        court.status = 'available';
        court.currentMatchId = null;
      }
    });
  }

  // ── Export / Import ──────────────────────────────────
  function exportData() {
    return JSON.stringify(load(), null, 2);
  }

  function importData(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      save({ ...structuredClone(DEFAULT_DATA), ...data });
      return true;
    } catch {
      return false;
    }
  }

  function resetAll() {
    save(structuredClone(DEFAULT_DATA));
  }

  // ── Settings ─────────────────────────────────────────
  function updateSettings(changes) {
    return update(db => {
      Object.assign(db.settings, changes);
    });
  }

  // helpers
  function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  // ── Payments ─────────────────────────────────────────
  function chargeMatch(matchId) {
    return update(db => {
      const match = db.matches.find(m => m.id === matchId) || db.activeMatches.find(m => m.id === matchId);
      if (!match) return;
      const allPlayers = [...match.teamA, ...match.teamB];
      const cost = db.settings.shuttleCost;
      for (const pid of allPlayers) {
        db.payments.push({
          id: crypto.randomUUID(),
          playerId: pid,
          matchId: match.id,
          amount: cost,
          type: 'charge',
          createdAt: Date.now(),
          note: 'Shuttle fee',
        });
      }
    });
  }

  function recordPayment(playerId, amount, note) {
    return update(db => {
      db.payments.push({
        id: crypto.randomUUID(),
        playerId,
        matchId: null,
        amount,
        type: 'payment',
        createdAt: Date.now(),
        note: note || 'Payment received',
      });
    });
  }

  function getPlayerBalance(playerId, db) {
    let balance = 0;
    for (const p of db.payments) {
      if (p.playerId !== playerId) continue;
      if (p.type === 'charge') balance += p.amount;
      else if (p.type === 'payment') balance -= p.amount;
    }
    return balance; // positive = owes money, negative = overpaid
  }

  function saveMatchAnalysis(entry) {
    return update(db => {
      if (!db.matchAnalyses) db.matchAnalyses = [];
      db.matchAnalyses.unshift(entry); // newest first
    });
  }

  function clearPlayerBalance(playerId) {
    return update(db => {
      const balance = getPlayerBalance(playerId, db);
      if (balance <= 0) return;
      db.payments.push({
        id: crypto.randomUUID(),
        playerId,
        matchId: null,
        amount: balance,
        type: 'payment',
        createdAt: Date.now(),
        note: 'Settled full balance',
      });
    });
  }

  return {
    get, update, save,
    addPlayer, removePlayer, getPlayer, updatePlayer,
    enqueue, dequeue, clearQueue, reorderQueue,
    initCourts, getAvailableCourts,
    createMatch, finishMatch,
    exportData, importData, resetAll,
    updateSettings, syncFromCloud,
    chargeMatch, recordPayment, getPlayerBalance, clearPlayerBalance,
    saveMatchAnalysis,
    LEVELS, LEVEL_RATINGS,
  };
})();
