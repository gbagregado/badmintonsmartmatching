/**
 * Matchmaker Engine
 * Creates balanced matches with a controlled challenge factor.
 *
 * Algorithm overview:
 *  1. Score each possible pairing based on:
 *     - Skill balance (60%): teams should be close in average rating
 *     - Wait fairness (25%): prioritise players waiting longest
 *     - Variety (15%): avoid repeat pairings from recent matches
 *  2. Add controlled challenge: allow a rating gap up to challengeFactor
 *  3. Pick the best pairing and assign to an available court
 */
const Matchmaker = (() => {

  /**
   * Generate all possible team combinations from a pool of player objects.
   * @param {Array} players – player objects (must have .id, .rating)
   * @param {string} mode – 'singles' | 'doubles'
   * @returns {Array<{teamA: string[], teamB: string[]}>}
   */
  function generatePairings(players, mode) {
    const size = mode === 'doubles' ? 2 : 1;
    const needed = size * 2;
    if (players.length < needed) return [];

    const combos = combinations(players, needed);
    const pairings = [];

    for (const group of combos) {
      if (mode === 'singles') {
        pairings.push({ teamA: [group[0].id], teamB: [group[1].id], players: group });
      } else {
        // For doubles, try all ways to split 4 into 2+2
        const splits = splitIntoTeams(group);
        for (const [a, b] of splits) {
          pairings.push({
            teamA: a.map(p => p.id),
            teamB: b.map(p => p.id),
            players: group,
          });
        }
      }
    }
    return pairings;
  }

  /** All k-combinations of arr */
  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [first, ...rest] = arr;
    const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = combinations(rest, k);
    return [...withFirst, ...withoutFirst];
  }

  /** Split 4 players into all unique 2v2 groupings (3 ways) */
  function splitIntoTeams(group) {
    const results = [];
    const idxs = [0, 1, 2, 3];
    const seen = new Set();
    for (const pair of combinations(idxs, 2)) {
      const other = idxs.filter(i => !pair.includes(i));
      const key = [pair.sort().join(','), other.sort().join(',')].sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        results.push([pair.map(i => group[i]), other.map(i => group[i])]);
      }
    }
    return results;
  }

  /**
   * Score a pairing. Lower = better.
   */
  function scorePairing(pairing, db) {
    const { teamA, teamB, players } = pairing;
    const settings = db.settings;

    // 1) Skill balance score (lower diff = better)
    const avgA = avg(teamA.map(id => getPlayerRating(id, db)));
    const avgB = avg(teamB.map(id => getPlayerRating(id, db)));
    const ratingDiff = Math.abs(avgA - avgB);

    // We WANT some challenge, so the ideal diff is challengeFactor * 200
    const idealDiff = settings.challengeFactor * 200;
    const skillScore = Math.abs(ratingDiff - idealDiff);

    // 2) Wait fairness: prefer players who've been in queue longer
    const queuePositions = players.map(p => {
      const idx = db.queue.indexOf(p.id);
      return idx === -1 ? 999 : idx;
    });
    const avgQueuePos = avg(queuePositions);
    const waitScore = avgQueuePos * 50; // lower queue position = earlier in queue = better

    // 3) Variety: penalize if these players played together recently
    const recentMatches = db.matches.slice(0, 20);
    let repeatPenalty = 0;
    for (const m of recentMatches) {
      const matchPlayers = [...m.teamA, ...m.teamB];
      const overlap = players.filter(p => matchPlayers.includes(p.id)).length;
      if (overlap >= (settings.gameMode === 'doubles' ? 3 : 2)) {
        repeatPenalty += 100;
      }
    }

    // 4) Streak balance: pair winning-streak players against each other
    const streakA = avg(teamA.map(id => {
      const p = db.players.find(pl => pl.id === id);
      return p ? p.streak : 0;
    }));
    const streakB = avg(teamB.map(id => {
      const p = db.players.find(pl => pl.id === id);
      return p ? p.streak : 0;
    }));
    const streakBalance = Math.abs(streakA - streakB) * 10;

    // Weighted total (lower = better)
    return (skillScore * 0.55) + (waitScore * 0.25) + (repeatPenalty * 0.10) + (streakBalance * 0.10);
  }

  function getPlayerRating(id, db) {
    const p = db.players.find(pl => pl.id === id);
    return p ? p.rating : 1200;
  }

  function avg(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  /**
   * Find the best match(es) for available courts.
   * @returns {Array<{courtId, teamA, teamB}>} – matches to create
   */
  function findMatches() {
    const db = DB.get();
    const availableCourts = db.courts.filter(c => c.status === 'available');
    if (availableCourts.length === 0) return [];

    const queuedPlayers = db.queue
      .map(id => db.players.find(p => p.id === id))
      .filter(Boolean);

    const mode = db.settings.gameMode;
    const needed = mode === 'doubles' ? 4 : 2;

    if (queuedPlayers.length < needed) return [];

    const results = [];
    const usedPlayerIds = new Set();
    // Players currently in active matches
    for (const am of db.activeMatches) {
      [...am.teamA, ...am.teamB].forEach(id => usedPlayerIds.add(id));
    }

    for (const court of availableCourts) {
      const available = queuedPlayers.filter(p => !usedPlayerIds.has(p.id));
      if (available.length < needed) break;

      // Limit combo explosion: take top 12 from queue
      const pool = available.slice(0, 12);
      const pairings = generatePairings(pool, mode);

      if (pairings.length === 0) break;

      // Score and pick best
      let bestScore = Infinity;
      let bestPairing = null;
      for (const pairing of pairings) {
        const score = scorePairing(pairing, db);
        if (score < bestScore) {
          bestScore = score;
          bestPairing = pairing;
        }
      }

      if (bestPairing) {
        results.push({
          courtId: court.id,
          teamA: bestPairing.teamA,
          teamB: bestPairing.teamB,
        });
        bestPairing.players.forEach(p => usedPlayerIds.add(p.id));
      }
    }

    return results;
  }

  /**
   * Auto-assign: find matches and create them immediately.
   * @returns {number} number of matches created
   */
  function autoAssign() {
    const proposals = findMatches();
    for (const { courtId, teamA, teamB } of proposals) {
      DB.createMatch(courtId, teamA, teamB);
    }
    return proposals.length;
  }

  return { findMatches, autoAssign, scorePairing, generatePairings };
})();
