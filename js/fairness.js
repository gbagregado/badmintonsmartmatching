/**
 * FairnessEngine — analyses a proposed 4-player match for fairness violations.
 * Used by both the QM app (js/) and Player PWA (player/js/).
 *
 * FairnessEngine.analyze({ teamA, teamB, allPlayers, recentMatches, queue, exclusions })
 *   teamA / teamB  : array of player IDs
 *   allPlayers     : array of { id, name, rating, skill_level }
 *   recentMatches  : array from Supabase (team_a, team_b, is_active, ended_at, started_at)
 *   queue          : array from Supabase (player_id, queued_at)
 *   exclusions     : { playerId: [excludedId, ...] }
 *
 * Returns { balance, frequency, rest, starvation, exclusions: excl, overall, score }
 */
const FairnessEngine = (() => {
  'use strict';

  const BALANCE_WARN      = 200;  // ELO point gap → warning
  const BALANCE_VIOL      = 400;  // ELO point gap → violation
  const FREQ_SAME_TEAM    = 3;    // times together in last 10 → warning
  const REST_WARN_MS      = 20 * 60 * 1000; // 20 min rest minimum
  const MIN_PLAYERS_4REST = 8;    // only flag rest if there are enough idle players
  const STARVE_RATIO      = 2.5;  // waiting X times longer than any req player → warning
  const STARVE_MIN_MS     = 30 * 60 * 1000; // only flag starvation if waiting > 30 min

  // ── Balance ────────────────────────────────────────────────
  function checkBalance(teamA, teamB, allPlayers) {
    const avg = ids => {
      const rs = ids.map(id => allPlayers.find(p => p.id === id)?.rating ?? 1200);
      return rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
    };
    const avgA = avg(teamA);
    const avgB = avg(teamB);
    const diff = Math.abs(avgA - avgB);
    const base = { diff: Math.round(diff), avgA: Math.round(avgA), avgB: Math.round(avgB) };
    if (diff >= BALANCE_VIOL) return { ...base, ok: false, level: 'violation', message: `Severe imbalance: ${Math.round(diff)} pt gap` };
    if (diff >= BALANCE_WARN) return { ...base, ok: false, level: 'warning',   message: `Team gap: ${Math.round(diff)} pts` };
    return { ...base, ok: true, level: 'ok' };
  }

  // ── Partnership frequency ─────────────────────────────────
  function checkFrequency(teamA, teamB, recentMatches, allPlayers) {
    const pairCount = {};
    const countPair = (a, b) => {
      const key = [a, b].sort().join('|');
      pairCount[key] = (pairCount[key] || 0) + 1;
    };
    for (const m of recentMatches.slice(0, 10)) {
      const ta = m.team_a || [];
      const tb = m.team_b || [];
      for (let i = 0; i < ta.length; i++) for (let j = i + 1; j < ta.length; j++) countPair(ta[i], ta[j]);
      for (let i = 0; i < tb.length; i++) for (let j = i + 1; j < tb.length; j++) countPair(tb[i], tb[j]);
    }
    const warnings = [];
    for (const team of [teamA, teamB]) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const key = [team[i], team[j]].sort().join('|');
          const cnt = pairCount[key] || 0;
          if (cnt >= FREQ_SAME_TEAM) {
            const nA = allPlayers.find(p => p.id === team[i])?.name || team[i];
            const nB = allPlayers.find(p => p.id === team[j])?.name || team[j];
            warnings.push({ a: nA, b: nB, count: cnt, message: `${nA} & ${nB} partnered ${cnt}× recently` });
          }
        }
      }
    }
    return { ok: warnings.length === 0, level: warnings.length ? 'warning' : 'ok', warnings };
  }

  // ── Rest time ─────────────────────────────────────────────
  function checkRest(playerIds, recentMatches, allPlayers, queue) {
    const now = Date.now();
    const finished = recentMatches.filter(m => !m.is_active);
    const totalWaiting = queue.length;
    if (totalWaiting < MIN_PLAYERS_4REST) return { ok: true, level: 'ok', violations: [] };

    const violations = [];
    for (const pid of playerIds) {
      const lastMatch = finished.find(m => [...(m.team_a||[]), ...(m.team_b||[])].includes(pid));
      if (!lastMatch) continue;
      const endedAt = lastMatch.ended_at;
      if (!endedAt) continue;
      const restMs = now - new Date(endedAt).getTime();
      if (restMs < REST_WARN_MS) {
        const name = allPlayers.find(p => p.id === pid)?.name || pid;
        violations.push({ player: name, restMin: Math.round(restMs / 60000), message: `${name} just finished ${Math.round(restMs / 60000)}min ago` });
      }
    }
    return { ok: violations.length === 0, level: violations.length ? 'warning' : 'ok', violations };
  }

  // ── Starvation (queue fairness) ───────────────────────────
  function checkStarvation(playerIds, queue, allPlayers) {
    if (!queue.length) return { ok: true, level: 'ok', warnings: [] };
    const now = Date.now();
    const getWait = pid => {
      const row = queue.find(r => (r.player_id || r.id) === pid);
      return row ? now - new Date(row.queued_at || now).getTime() : 0;
    };
    const reqWaits = playerIds.map(getWait).filter(w => w > 0);
    if (!reqWaits.length) return { ok: true, level: 'ok', warnings: [] };
    const maxReqWait = Math.max(...reqWaits);

    const warnings = [];
    for (const row of queue) {
      const qPid = row.player_id || row.id;
      if (playerIds.includes(qPid)) continue;
      const wait = now - new Date(row.queued_at || now).getTime();
      if (wait > maxReqWait * STARVE_RATIO && wait > STARVE_MIN_MS) {
        const name = allPlayers.find(p => p.id === qPid)?.name || qPid;
        warnings.push({ player: name, waitMin: Math.round(wait / 60000), message: `${name} waiting ${Math.round(wait / 60000)}min and skipped` });
      }
    }
    return { ok: warnings.length === 0, level: warnings.length ? 'warning' : 'ok', warnings };
  }

  // ── Exclusions ────────────────────────────────────────────
  function checkExclusions(playerIds, exclusions, allPlayers) {
    const conflicts = [];
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const a = playerIds[i], b = playerIds[j];
        const aExB = (exclusions[a] || []).includes(b);
        const bExA = (exclusions[b] || []).includes(a);
        if (aExB || bExA) {
          const nA = allPlayers.find(p => p.id === a)?.name || a;
          const nB = allPlayers.find(p => p.id === b)?.name || b;
          const who = aExB ? nA : nB;
          conflicts.push({ a: nA, b: nB, message: `${who} prefers not to play with ${aExB ? nB : nA}` });
        }
      }
    }
    return { ok: conflicts.length === 0, level: conflicts.length ? 'violation' : 'ok', conflicts };
  }

  // ── Main ──────────────────────────────────────────────────
  function analyze({ teamA, teamB, allPlayers = [], recentMatches = [], queue = [], exclusions = {} }) {
    const allInMatch = [...teamA, ...teamB];
    const flags = {
      balance:    checkBalance(teamA, teamB, allPlayers),
      frequency:  checkFrequency(teamA, teamB, recentMatches, allPlayers),
      rest:       checkRest(allInMatch, recentMatches, allPlayers, queue),
      starvation: checkStarvation(allInMatch, queue, allPlayers),
      exclusions: checkExclusions(allInMatch, exclusions, allPlayers),
    };
    const violations = Object.values(flags).filter(f => f.level === 'violation').length;
    const warnings   = Object.values(flags).filter(f => f.level === 'warning').length;
    flags.overall = violations > 0 ? 'violation' : warnings > 0 ? 'warning' : 'ok';
    flags.score   = violations * 10 + warnings * 3;
    return flags;
  }

  /** Render fairness flags as compact HTML for display in QM or player app */
  function renderFlags(flags, compact = false) {
    if (!flags) return '';
    const items = [];
    const add = (f, label) => {
      if (!f || f.level === 'ok') return;
      const icon = f.level === 'violation' ? '🚫' : '⚠️';
      const msgs = [
        ...(f.warnings || []).map(w => w.message),
        ...(f.violations || []).map(v => v.message),
        ...(f.conflicts || []).map(c => c.message),
        ...(f.message ? [f.message] : []),
      ];
      msgs.forEach(m => items.push({ icon, label, msg: m, level: f.level }));
    };
    add(flags.balance,    'Balance');
    add(flags.frequency,  'Frequency');
    add(flags.rest,       'Rest');
    add(flags.starvation, 'Fairness');
    add(flags.exclusions, 'Exclusion');
    if (!items.length) return compact
      ? `<span class="fairness-ok">✅ Looks fair</span>`
      : `<div class="fairness-ok">✅ All checks passed</div>`;
    return items.map(it => `<div class="fairness-flag ${it.level}">${it.icon} <strong>${it.label}:</strong> ${it.msg}</div>`).join('');
  }

  return { analyze, renderFlags };
})();
