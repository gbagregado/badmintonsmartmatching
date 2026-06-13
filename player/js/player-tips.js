/**
 * Player Tips Engine — rule-based insights from match history
 */
const PlayerTips = (() => {

  const BADGES = [
    { id: 'first-match',   icon: '🏸', label: 'First Match',    desc: 'Played your first game',          check: p => p.matchesPlayed >= 1 },
    { id: 'ten-games',     icon: '🔟', label: '10 Games',        desc: 'Played 10 matches',               check: p => p.matchesPlayed >= 10 },
    { id: 'fifty-games',   icon: '🏆', label: '50 Games',        desc: 'Played 50 matches',               check: p => p.matchesPlayed >= 50 },
    { id: 'century',       icon: '💯', label: 'Century',         desc: 'Played 100 matches',              check: p => p.matchesPlayed >= 100 },
    { id: 'win-streak-3',  icon: '🔥', label: 'Hot Streak',      desc: 'Won 3 in a row',                  check: p => p.streak >= 3 },
    { id: 'win-streak-5',  icon: '⚡', label: 'On Fire',         desc: 'Won 5 in a row',                  check: p => p.streak >= 5 },
    { id: 'iron-player',   icon: '💪', label: 'Iron Player',     desc: 'Played 5+ games in one day',      check: (p, matches) => {
      if (!matches.length) return false;
      const counts = {};
      matches.forEach(m => {
        const d = new Date(m.ended_at || m.started_at).toDateString();
        counts[d] = (counts[d] || 0) + 1;
      });
      return Object.values(counts).some(c => c >= 5);
    }},
    { id: 'comeback',      icon: '🔄', label: 'Comeback Kid',   desc: 'Won after a 3-loss streak',       check: (p, matches) => {
      if (matches.length < 4) return false;
      for (let i = 3; i < matches.length; i++) {
        const prev3 = matches.slice(i-3, i);
        if (prev3.every(m => m._lost) && !matches[i]._lost) return true;
      }
      return false;
    }},
  ];

  function generateTips(player, recentMatches, allMatches) {
    const tips = [];
    if (!player) return tips;

    const last10 = recentMatches.slice(0, 10);
    const wins10 = last10.filter(m => !m._lost).length;
    const winRate10 = last10.length > 0 ? wins10 / last10.length : null;
    const avgDuration = recentMatches.length > 0
      ? recentMatches.reduce((s, m) => s + (m._duration || 0), 0) / recentMatches.length
      : 0;

    // Streak tips
    if (player.streak >= 5) {
      tips.push({ icon: '🔥', type: 'success', title: `${player.streak}-game win streak!`, text: "You're in peak form right now. Keep the pressure up and maintain your consistency." });
    } else if (player.streak >= 3) {
      tips.push({ icon: '⚡', type: 'success', title: `${player.streak} wins in a row`, text: 'Good momentum. Stay focused and trust your game.' });
    } else if (player.streak <= -4) {
      tips.push({ icon: '💙', type: 'info', title: `Tough run (${Math.abs(player.streak)} losses)`, text: 'Take a short break and reset mentally. Focus on placement and net play rather than trying to force winners.' });
    } else if (player.streak <= -2) {
      tips.push({ icon: '🎯', type: 'warning', title: 'Two losses in a row', text: 'Check your serve routine and court positioning. Small adjustments often break a losing streak.' });
    }

    // Win rate trend (last 10)
    if (winRate10 !== null && last10.length >= 5) {
      if (winRate10 >= 0.70) {
        tips.push({ icon: '📈', type: 'success', title: 'Dominant form lately', text: `You've won ${Math.round(winRate10 * 100)}% of your last ${last10.length} games. Consider stepping up to a higher level for a bigger challenge.` });
      } else if (winRate10 <= 0.30) {
        tips.push({ icon: '📉', type: 'warning', title: 'Struggling lately', text: `Only ${Math.round(winRate10 * 100)}% win rate in your last ${last10.length} games. Playing against lower-rated opponents temporarily can help rebuild confidence.` });
      }
    }

    // Short matches
    if (avgDuration > 0 && avgDuration < 15 * 60 * 1000) {
      tips.push({ icon: '⏱', type: 'info', title: 'Matches ending quickly', text: 'Your recent games are finishing fast — this often signals a skill mismatch. Ask your queue master for more balanced pairings.' });
    }

    // Overall win rate
    if (player.matchesPlayed >= 10) {
      const overallRate = player.matchesPlayed > 0 ? player.wins / player.matchesPlayed : 0;
      if (overallRate >= 0.60) {
        tips.push({ icon: '🏅', type: 'success', title: 'Strong overall record', text: `${Math.round(overallRate * 100)}% career win rate. You're a consistent performer at this level.` });
      }
    }

    // ELO level tip
    const rating = player.rating;
    if (rating >= 1850) tips.push({ icon: '👑', type: 'success', title: 'A-level player', text: 'You are among the top players. Focus on consistency and teaching others.' });
    else if (rating >= 1550 && rating < 1700) tips.push({ icon: '💡', type: 'info', title: 'Approaching B+ level', text: 'Work on your deceptive shots and footwork to push into the next tier.' });
    else if (rating < 1000) tips.push({ icon: '🌱', type: 'info', title: 'Building your game', text: 'Focus on basic footwork and net play. Consistency beats power at this stage.' });

    return tips;
  }

  function getBadges(player, matches) {
    if (!player) return [];
    return BADGES.map(b => ({
      ...b,
      earned: b.check(player, matches),
    }));
  }

  // Best partner: player who appeared most often with this player on the same team
  function getBestPartner(playerId, matches, allPlayers) {
    const freq = {};
    const wins = {};
    matches.forEach(m => {
      const inA = (m.team_a || []).includes(playerId);
      const inB = (m.team_b || []).includes(playerId);
      const team = inA ? m.team_a : inB ? m.team_b : [];
      const won = (inA && m.winner === 'A') || (inB && m.winner === 'B');
      team.forEach(id => {
        if (id === playerId) return;
        freq[id] = (freq[id] || 0) + 1;
        if (won) wins[id] = (wins[id] || 0) + 1;
      });
    });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    const [partnerId, games] = sorted[0];
    const w = wins[partnerId] || 0;
    const partner = allPlayers.find(p => p.id === partnerId);
    return partner ? { name: partner.name, games, wins: w } : null;
  }

  // Toughest opponent: player who beat this player most
  function getToughestOpponent(playerId, matches, allPlayers) {
    const lossesTo = {};
    const winsVs = {};
    matches.forEach(m => {
      const inA = (m.team_a || []).includes(playerId);
      const inB = (m.team_b || []).includes(playerId);
      if (!inA && !inB) return;
      const oppTeam = inA ? m.team_b : m.team_a;
      const lost = (inA && m.winner === 'B') || (inB && m.winner === 'A');
      const won  = (inA && m.winner === 'A') || (inB && m.winner === 'B');
      oppTeam.forEach(id => {
        if (lost) lossesTo[id] = (lossesTo[id] || 0) + 1;
        if (won)  winsVs[id]   = (winsVs[id]   || 0) + 1;
      });
    });
    const sorted = Object.entries(lossesTo).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    const [oppId, losses] = sorted[0];
    const w = winsVs[oppId] || 0;
    const opp = allPlayers.find(p => p.id === oppId);
    return opp ? { name: opp.name, losses, wins: w } : null;
  }

  // Peak hour: which hour of day this player wins most
  function getPeakHour(playerId, matches) {
    const hourWins = {};
    const hourGames = {};
    matches.forEach(m => {
      const inA = (m.team_a || []).includes(playerId);
      const inB = (m.team_b || []).includes(playerId);
      if (!inA && !inB) return;
      const won = (inA && m.winner === 'A') || (inB && m.winner === 'B');
      const h = new Date(m.started_at).getHours();
      hourGames[h] = (hourGames[h] || 0) + 1;
      if (won) hourWins[h] = (hourWins[h] || 0) + 1;
    });
    const entries = Object.entries(hourGames).filter(([, g]) => g >= 2);
    if (!entries.length) return null;
    const best = entries.sort((a, b) => (hourWins[b[0]] || 0) - (hourWins[a[0]] || 0))[0];
    const h = parseInt(best[0]);
    const fmt = h2 => `${h2 % 12 || 12}${h2 < 12 ? 'AM' : 'PM'}`;
    return `${fmt(h)}–${fmt(h + 1)}`;
  }

  return { generateTips, getBadges, getBestPartner, getToughestOpponent, getPeakHour };
})();
