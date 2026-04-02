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
    },
    players: [],
    courts: [],
    queue: [],       // player IDs in queue order
    matches: [],     // match history
    activeMatches: [],
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
    const merged = {
      ...structuredClone(DEFAULT_DATA),
      settings: { ...structuredClone(DEFAULT_DATA).settings, ...remote.settings },
      players: remote.players,
      courts: remote.courts,
      queue: remote.queue,
      activeMatches: remote.activeMatches,
      matches: remote.matches,
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
  function addPlayer(name, skillLevel) {
    return update(db => {
      const rating = skillLevel === 'beginner' ? 900
        : skillLevel === 'intermediate' ? 1200
        : skillLevel === 'advanced' ? 1500
        : skillLevel === 'expert' ? 1800
        : db.settings.defaultRating;

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
      db.queue = db.queue.filter(id => id !== playerId);
      // Remove from active matches? No, let those finish
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
      if (!db.queue.includes(playerId)) {
        db.queue.push(playerId);
      }
    });
  }

  function dequeue(playerId) {
    return update(db => {
      db.queue = db.queue.filter(id => id !== playerId);
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
      db.queue = db.queue.filter(id => !allPlayers.includes(id));
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

  return {
    get, update, save,
    addPlayer, removePlayer, getPlayer, updatePlayer,
    enqueue, dequeue, clearQueue, reorderQueue,
    initCourts, getAvailableCourts,
    createMatch, finishMatch,
    exportData, importData, resetAll,
    updateSettings, syncFromCloud,
  };
})();
