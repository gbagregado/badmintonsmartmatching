/**
 * Matchmaker Engine
 * Creates balanced matches allowing level mixing without ruining games.
 *
 * Algorithm:
 *  1. Prioritize players by a fairness score: wait time + games played today
 *  2. For doubles: pair a high-level with a low-level vs similar combo (balanced teams)
 *  3. Limit max level gap within a match (configurable) so games stay enjoyable
 *  4. Score pairings by: team balance (40%), wait fairness (35%), variety (15%), streak (10%)
 */
const Matchmaker = (() => {

  // Max level gap allowed in a single match (in levels, 1 level = ~150 rating)
  const MAX_RATING_GAP = 600; // ~4 level tiers

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
      // Skip groups where the rating gap is too large
      const ratings = group.map(p => p.rating);
      if (Math.max(...ratings) - Math.min(...ratings) > MAX_RATING_GAP) continue;

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
   * Balanced approach: team skill balance + wait fairness + games played fairness
   */
  function scorePairing(pairing, db) {
    const { teamA, teamB, players } = pairing;

    // 1) Team balance: avg rating of each team should be close
    const avgA = avg(teamA.map(id => getPlayerRating(id, db)));
    const avgB = avg(teamB.map(id => getPlayerRating(id, db)));
    const ratingDiff = Math.abs(avgA - avgB);
    const skillScore = ratingDiff; // lower = more balanced

    // 2) Wait fairness: prioritize players who joined queue earliest
    //    Queue is now array of {id, joinedAt, gamesPlayedToday}
    const now = Date.now();
    let waitScore = 0;
    for (const p of players) {
      const qEntry = db.queue.find(q => q.id === p.id);
      if (qEntry) {
        const waitMins = (now - qEntry.joinedAt) / 60000;
        // Bonus for waiting longer (negative = better score)
        waitScore -= waitMins * 2;
        // Penalty for more games played today (fairness)
        waitScore += (qEntry.gamesPlayedToday || 0) * 30;
      }
    }

    // 3) Variety: penalize if these players played together recently
    const recentMatches = db.matches.slice(0, 20);
    let repeatPenalty = 0;
    for (const m of recentMatches) {
      const matchPlayers = [...m.teamA, ...m.teamB];
      const overlap = players.filter(p => matchPlayers.includes(p.id)).length;
      if (overlap >= (db.settings.gameMode === 'doubles' ? 3 : 2)) {
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
    return (skillScore * 0.40) + (waitScore * 0.35) + (repeatPenalty * 0.15) + (streakBalance * 0.10);
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
   * Queue entries are {id, joinedAt, gamesPlayedToday}.
   * @returns {Array<{courtId, teamA, teamB}>} – matches to create
   */
  function findMatches() {
    const db = DB.get();
    const availableCourts = db.courts.filter(c => c.status === 'available');
    if (availableCourts.length === 0) return [];

    const mode = db.settings.gameMode;
    const needed = mode === 'doubles' ? 4 : 2;

    // Build set of player IDs currently in active matches
    const usedPlayerIds = new Set();
    for (const am of db.activeMatches) {
      [...am.teamA, ...am.teamB].forEach(id => usedPlayerIds.add(id));
    }

    // Get queued players, filtering out anyone already playing (safety check)
    const queuedPlayers = db.queue
      .filter(q => !usedPlayerIds.has(q.id))
      .map(q => db.players.find(p => p.id === q.id))
      .filter(Boolean);

    if (queuedPlayers.length < needed) return [];

    const results = [];

    for (const court of availableCourts) {
      const available = queuedPlayers.filter(p => !usedPlayerIds.has(p.id));
      if (available.length < needed) break;

      // Limit combo explosion: take enough players for this court plus look-ahead buffer
      const pool = available.slice(0, needed * 3);
      const pairings = generatePairings(pool, mode);

      if (pairings.length === 0) {
        // If no valid pairings due to level gap, try with relaxed pool
        // Take all available and try
        const allPairings = generatePairings(available, mode);
        if (allPairings.length === 0) break;

        let bestScore = Infinity;
        let bestPairing = null;
        for (const pairing of allPairings) {
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
        continue;
      }

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
