/**
 * Seed script — populates the app with realistic test data for demo purposes.
 * Load this AFTER storage.js and BEFORE app.js, or run once manually.
 */
const Seed = (() => {

  const SAMPLE_PLAYERS = [
    { name: 'Alex Chen', level: 'B+' },
    { name: 'Maria Santos', level: 'C' },
    { name: 'Jordan Lee', level: 'A' },
    { name: 'Priya Sharma', level: 'E' },
    { name: 'Tom Wilson', level: 'C+' },
    { name: 'Yuki Tanaka', level: 'B' },
    { name: 'Sam Rodriguez', level: 'C' },
    { name: 'Nina Patel', level: 'B+' },
    { name: 'Chris Morgan', level: 'D+' },
    { name: 'Jasmine Wu', level: 'A+' },
    { name: 'Diego Alvarez', level: 'C+' },
    { name: 'Lily Zhang', level: 'B' },
    { name: 'Ryan O\'Brien', level: 'D' },
    { name: 'Aisha Khan', level: 'E+' },
    { name: 'Ben Harris', level: 'B+' },
    { name: 'Mei Lin', level: 'A' },
  ];

  function run() {
    const db = DB.get();
    // Don't seed if data already exists
    if (db.players.length > 0) {
      console.log('[Seed] Data already exists, skipping. Call Seed.force() to reset & re-seed.');
      return false;
    }
    return seed();
  }

  function force() {
    DB.resetAll();
    return seed();
  }

  function seed() {
    console.log('[Seed] Seeding test data...');

    // 1) Init 4 courts
    DB.initCourts(4);

    // 2) Add all players
    for (const p of SAMPLE_PLAYERS) {
      DB.addPlayer(p.name, p.level);
    }

    let db = DB.get();
    const players = db.players;

    // 3) Simulate some past matches to build history & ratings
    const matchups = generatePastMatches(players, 24);
    for (const m of matchups) {
      // Temporarily create & finish a match
      DB.update(data => {
        const match = {
          id: crypto.randomUUID(),
          courtId: `court-${Math.floor(Math.random() * 4) + 1}`,
          teamA: m.teamA,
          teamB: m.teamB,
          scoreA: m.scoreA,
          scoreB: m.scoreB,
          startedAt: m.time,
          endedAt: m.time + (12 + Math.random() * 18) * 60000, // 12-30 min game
          winner: m.scoreA > m.scoreB ? 'A' : 'B',
        };

        // Update player stats
        const winners = match.winner === 'A' ? match.teamA : match.teamB;
        const losers = match.winner === 'A' ? match.teamB : match.teamA;
        const winScore = Math.max(match.scoreA, match.scoreB);
        const loseScore = Math.min(match.scoreA, match.scoreB);

        const avgWR = avg(winners.map(id => (data.players.find(p => p.id === id)?.rating || 1200)));
        const avgLR = avg(losers.map(id => (data.players.find(p => p.id === id)?.rating || 1200)));
        const expected = 1 / (1 + Math.pow(10, (avgLR - avgWR) / 400));
        const change = Math.round(32 * (1 - expected));

        for (const pid of winners) {
          const p = data.players.find(pl => pl.id === pid);
          if (!p) continue;
          p.matchesPlayed++;
          p.wins++;
          p.totalPointsScored += winScore;
          p.totalPointsLost += loseScore;
          p.rating += change;
          p.streak = p.streak >= 0 ? p.streak + 1 : 1;
          p.lastMatchAt = match.endedAt;
        }
        for (const pid of losers) {
          const p = data.players.find(pl => pl.id === pid);
          if (!p) continue;
          p.matchesPlayed++;
          p.losses++;
          p.totalPointsScored += loseScore;
          p.totalPointsLost += winScore;
          p.rating -= change;
          p.streak = p.streak <= 0 ? p.streak - 1 : -1;
          p.lastMatchAt = match.endedAt;
        }

        data.matches.unshift(match);
      });
    }

    // 4) Put 8 players in queue (the ones not "currently playing")
    db = DB.get();
    const toQueue = db.players.slice(0, 10).map(p => p.id);
    for (const id of toQueue) {
      DB.enqueue(id);
    }

    // 5) Start 2 active matches on courts 1 & 2
    db = DB.get();
    const remaining = db.players.filter(p => !toQueue.includes(p.id));
    if (db.settings.gameMode === 'doubles' && remaining.length >= 4) {
      DB.createMatch('court-1',
        [remaining[0].id, remaining[1].id],
        [remaining[2].id, remaining[3].id]
      );
    } else if (db.settings.gameMode === 'singles' && remaining.length >= 2) {
      DB.createMatch('court-1',
        [remaining[0].id],
        [remaining[1].id]
      );
    }
    if (db.settings.gameMode === 'doubles' && remaining.length >= 8) {
      DB.createMatch('court-2',
        [remaining[4].id, remaining[5].id],
        [remaining[6].id, remaining[7].id]
      );
    } else if (db.settings.gameMode === 'singles' && remaining.length >= 6) {
      DB.createMatch('court-2',
        [remaining[4].id],
        [remaining[5].id]
      );
    }

    console.log('[Seed] Done! 16 players, 24 historical matches, queue + active matches seeded.');
    return true;
  }

  function generatePastMatches(players, count) {
    const matches = [];
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      // Random 4 players for doubles
      const shuffled = [...players].sort(() => Math.random() - 0.5);
      const teamA = [shuffled[0].id, shuffled[1].id];
      const teamB = [shuffled[2].id, shuffled[3].id];

      // Generate realistic scores (game to 21)
      const winnerScore = 21;
      const loserScore = Math.floor(Math.random() * 19) + 2; // 2-20
      const aWins = Math.random() > 0.5;

      matches.push({
        teamA,
        teamB,
        scoreA: aWins ? winnerScore : loserScore,
        scoreB: aWins ? loserScore : winnerScore,
        time: now - (count - i) * 45 * 60000, // spaced ~45min apart going back
      });
    }
    return matches;
  }

  function avg(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  return { run, force };
})();
