/**
 * Supabase Cloud Layer
 * Wraps Supabase client for all CRUD + real-time subscriptions.
 * Falls back gracefully to localStorage if Supabase is unreachable.
 */
const Cloud = (() => {
  const SUPABASE_URL = 'https://uwlmcpcfgoiivzgvnhpa.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_qJPyx2H5VluZlkWyXdUxyg_dctzZgGm';

  let supabase = null;
  let connected = false;
  let _onChangeCallback = null;

  function init() {
    try {
      if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        // Test connection
        testConnection();
      } else {
        console.warn('[Cloud] Supabase client not loaded, using localStorage only');
      }
    } catch (e) {
      console.warn('[Cloud] Init failed:', e.message);
    }
  }

  async function testConnection() {
    try {
      const { error } = await supabase.from('settings').select('key').limit(1);
      if (error) throw error;
      connected = true;
      console.log('[Cloud] ✓ Connected to Supabase');
      return true;
    } catch (e) {
      connected = false;
      console.warn('[Cloud] ✗ Supabase unreachable, using localStorage:', e.message);
      return false;
    }
  }

  function isConnected() { return connected && supabase !== null; }

  function onChange(callback) { _onChangeCallback = callback; }

  // ── Players ──────────────────────────────────────────
  async function getPlayers() {
    if (!isConnected()) return null;
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .order('rating', { ascending: false });
    if (error) { console.error('[Cloud] getPlayers:', error); return null; }
    return data.map(mapPlayerFromDB);
  }

  async function addPlayer(player) {
    if (!isConnected()) return null;
    const row = mapPlayerToDB(player);
    const { data, error } = await supabase.from('players').insert(row).select().single();
    if (error) { console.error('[Cloud] addPlayer:', error); return null; }
    return mapPlayerFromDB(data);
  }

  async function updatePlayer(id, changes) {
    if (!isConnected()) return false;
    const row = {};
    if ('name' in changes) row.name = changes.name;
    if ('rating' in changes) row.rating = changes.rating;
    if ('skillLevel' in changes) row.skill_level = changes.skillLevel;
    if ('matchesPlayed' in changes) row.matches_played = changes.matchesPlayed;
    if ('wins' in changes) row.wins = changes.wins;
    if ('losses' in changes) row.losses = changes.losses;
    if ('totalPointsScored' in changes) row.total_points_scored = changes.totalPointsScored;
    if ('totalPointsLost' in changes) row.total_points_lost = changes.totalPointsLost;
    if ('streak' in changes) row.streak = changes.streak;
    if ('lastMatchAt' in changes) row.last_match_at = changes.lastMatchAt ? new Date(changes.lastMatchAt).toISOString() : null;
    const { error } = await supabase.from('players').update(row).eq('id', id);
    if (error) { console.error('[Cloud] updatePlayer:', error); return false; }
    return true;
  }

  async function removePlayer(id) {
    if (!isConnected()) return false;
    const { error } = await supabase.from('players').delete().eq('id', id);
    if (error) { console.error('[Cloud] removePlayer:', error); return false; }
    return true;
  }

  async function upsertPlayerBatch(players) {
    if (!isConnected()) return false;
    const rows = players.map(mapPlayerToDB);
    const { error } = await supabase.from('players').upsert(rows, { onConflict: 'id' });
    if (error) { console.error('[Cloud] upsertPlayerBatch:', error); return false; }
    return true;
  }

  // ── Courts ───────────────────────────────────────────
  async function getCourts() {
    if (!isConnected()) return null;
    const { data, error } = await supabase.from('courts').select('*').order('id');
    if (error) { console.error('[Cloud] getCourts:', error); return null; }
    return data.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      currentMatchId: c.current_match_id,
    }));
  }

  async function setCourts(courts) {
    if (!isConnected()) return false;
    // Clear existing and insert new
    await supabase.from('courts').delete().neq('id', '');
    const rows = courts.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      current_match_id: c.currentMatchId,
    }));
    const { error } = await supabase.from('courts').insert(rows);
    if (error) { console.error('[Cloud] setCourts:', error); return false; }
    return true;
  }

  async function updateCourt(id, changes) {
    if (!isConnected()) return false;
    const row = {};
    if ('status' in changes) row.status = changes.status;
    if ('currentMatchId' in changes) row.current_match_id = changes.currentMatchId;
    const { error } = await supabase.from('courts').update(row).eq('id', id);
    if (error) { console.error('[Cloud] updateCourt:', error); return false; }
    return true;
  }

  // ── Queue ────────────────────────────────────────────
  async function getQueue() {
    if (!isConnected()) return null;
    const { data, error } = await supabase
      .from('queue')
      .select('player_id')
      .order('position');
    if (error) { console.error('[Cloud] getQueue:', error); return null; }
    return data.map(r => r.player_id);
  }

  async function setQueue(playerIds) {
    if (!isConnected()) return false;
    await supabase.from('queue').delete().gte('id', 0);
    if (playerIds.length === 0) return true;
    const rows = playerIds.map((pid, i) => ({ player_id: pid, position: i }));
    const { error } = await supabase.from('queue').insert(rows);
    if (error) { console.error('[Cloud] setQueue:', error); return false; }
    return true;
  }

  async function enqueue(playerId) {
    if (!isConnected()) return false;
    // Get max position
    const { data } = await supabase.from('queue').select('position').order('position', { ascending: false }).limit(1);
    const nextPos = data && data.length > 0 ? data[0].position + 1 : 0;
    const { error } = await supabase.from('queue').insert({ player_id: playerId, position: nextPos });
    if (error) { console.error('[Cloud] enqueue:', error); return false; }
    return true;
  }

  async function dequeue(playerId) {
    if (!isConnected()) return false;
    const { error } = await supabase.from('queue').delete().eq('player_id', playerId);
    if (error) { console.error('[Cloud] dequeue:', error); return false; }
    return true;
  }

  // ── Matches ──────────────────────────────────────────
  async function getActiveMatches() {
    if (!isConnected()) return null;
    const { data, error } = await supabase
      .from('matches')
      .select('*')
      .eq('is_active', true)
      .order('started_at');
    if (error) { console.error('[Cloud] getActiveMatches:', error); return null; }
    return data.map(mapMatchFromDB);
  }

  async function getMatchHistory(limit = 50) {
    if (!isConnected()) return null;
    const { data, error } = await supabase
      .from('matches')
      .select('*')
      .eq('is_active', false)
      .order('ended_at', { ascending: false })
      .limit(limit);
    if (error) { console.error('[Cloud] getMatchHistory:', error); return null; }
    return data.map(mapMatchFromDB);
  }

  async function createMatch(match) {
    if (!isConnected()) return null;
    const row = mapMatchToDB(match);
    const { data, error } = await supabase.from('matches').insert(row).select().single();
    if (error) { console.error('[Cloud] createMatch:', error); return null; }
    return mapMatchFromDB(data);
  }

  async function finishMatch(id, scoreA, scoreB, winner) {
    if (!isConnected()) return false;
    const { error } = await supabase.from('matches').update({
      score_a: scoreA,
      score_b: scoreB,
      winner,
      is_active: false,
      ended_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) { console.error('[Cloud] finishMatch:', error); return false; }
    return true;
  }

  // ── Settings ─────────────────────────────────────────
  async function getSettings() {
    if (!isConnected()) return null;
    const { data, error } = await supabase.from('settings').select('*');
    if (error) { console.error('[Cloud] getSettings:', error); return null; }
    const settings = {};
    for (const row of data) {
      settings[row.key] = JSON.parse(row.value);
    }
    return settings;
  }

  async function updateSettings(changes) {
    if (!isConnected()) return false;
    for (const [key, value] of Object.entries(changes)) {
      await supabase.from('settings').upsert({ key, value: JSON.stringify(value) });
    }
    return true;
  }

  // ── Full Sync ────────────────────────────────────────
  async function pullAll() {
    if (!isConnected()) return null;
    const [players, courts, queue, activeMatches, matchHistory, settings] = await Promise.all([
      getPlayers(),
      getCourts(),
      getQueue(),
      getActiveMatches(),
      getMatchHistory(200),
      getSettings(),
    ]);
    if (!players || !courts) return null; // connection issue
    return {
      settings: settings || {},
      players: players || [],
      courts: courts || [],
      queue: queue || [],
      activeMatches: activeMatches || [],
      matches: matchHistory || [],
    };
  }

  async function pushAll(db) {
    if (!isConnected()) return false;
    try {
      // Clear and re-insert everything
      await Promise.all([
        supabase.from('queue').delete().gte('id', 0),
        supabase.from('matches').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
        supabase.from('courts').delete().neq('id', ''),
        supabase.from('players').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
      ]);

      // Insert players
      if (db.players.length > 0) {
        await supabase.from('players').insert(db.players.map(mapPlayerToDB));
      }
      // Insert courts
      if (db.courts.length > 0) {
        await setCourts(db.courts);
      }
      // Insert queue
      if (db.queue.length > 0) {
        await setQueue(db.queue);
      }
      // Insert matches (active + history)
      const allMatches = [
        ...db.activeMatches.map(m => mapMatchToDB({ ...m, isActive: true })),
        ...db.matches.map(m => mapMatchToDB({ ...m, isActive: false })),
      ];
      if (allMatches.length > 0) {
        await supabase.from('matches').insert(allMatches);
      }
      // Push settings
      await updateSettings(db.settings);

      console.log('[Cloud] ✓ Full push complete');
      return true;
    } catch (e) {
      console.error('[Cloud] pushAll failed:', e);
      return false;
    }
  }

  // ── Real-time Subscriptions ──────────────────────────
  function subscribe() {
    if (!isConnected()) return;

    supabase.channel('badminton-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => notify('players'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'courts' }, () => notify('courts'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, () => notify('queue'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => notify('matches'))
      .subscribe((status) => {
        console.log('[Cloud] Realtime:', status);
      });
  }

  function notify(table) {
    if (_onChangeCallback) _onChangeCallback(table);
  }

  // ── Mappers: DB ↔ JS ────────────────────────────────
  function mapPlayerFromDB(row) {
    return {
      id: row.id,
      name: row.name,
      rating: row.rating,
      initialRating: row.initial_rating,
      skillLevel: row.skill_level,
      matchesPlayed: row.matches_played,
      wins: row.wins,
      losses: row.losses,
      totalPointsScored: row.total_points_scored,
      totalPointsLost: row.total_points_lost,
      streak: row.streak,
      lastMatchAt: row.last_match_at ? new Date(row.last_match_at).getTime() : null,
      createdAt: new Date(row.created_at).getTime(),
    };
  }

  function mapPlayerToDB(p) {
    return {
      id: p.id,
      name: p.name,
      rating: p.rating,
      initial_rating: p.initialRating,
      skill_level: p.skillLevel,
      matches_played: p.matchesPlayed,
      wins: p.wins,
      losses: p.losses,
      total_points_scored: p.totalPointsScored,
      total_points_lost: p.totalPointsLost,
      streak: p.streak,
      last_match_at: p.lastMatchAt ? new Date(p.lastMatchAt).toISOString() : null,
      created_at: new Date(p.createdAt).toISOString(),
    };
  }

  function mapMatchFromDB(row) {
    return {
      id: row.id,
      courtId: row.court_id,
      teamA: row.team_a,
      teamB: row.team_b,
      scoreA: row.score_a,
      scoreB: row.score_b,
      winner: row.winner,
      startedAt: new Date(row.started_at).getTime(),
      endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
    };
  }

  function mapMatchToDB(m) {
    return {
      id: m.id,
      court_id: m.courtId,
      team_a: m.teamA,
      team_b: m.teamB,
      score_a: m.scoreA || 0,
      score_b: m.scoreB || 0,
      winner: m.winner || null,
      is_active: m.isActive !== undefined ? m.isActive : (m.endedAt ? false : true),
      started_at: new Date(m.startedAt).toISOString(),
      ended_at: m.endedAt ? new Date(m.endedAt).toISOString() : null,
    };
  }

  return {
    init, isConnected, testConnection,
    onChange, subscribe,
    getPlayers, addPlayer, updatePlayer, removePlayer, upsertPlayerBatch,
    getCourts, setCourts, updateCourt,
    getQueue, setQueue, enqueue, dequeue,
    getActiveMatches, getMatchHistory, createMatch, finishMatch,
    getSettings, updateSettings,
    pullAll, pushAll,
  };
})();
