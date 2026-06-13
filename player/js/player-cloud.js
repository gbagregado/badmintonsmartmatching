/**
 * Player Cloud — Supabase queries scoped to the Player PWA
 */
const PlayerCloud = (() => {
  const SUPABASE_URL = 'https://uwlmcpcfgoiivzgvnhpa.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_qJPyx2H5VluZlkWyXdUxyg_dctzZgGm';

  let sb = null;

  function init() {
    if (window.supabase?.createClient) {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
  }

  function ready() { return sb !== null; }

  // ── Identity ─────────────────────────────────────────────
  async function getLinkedPlayerId(deviceId) {
    if (!ready()) return null;
    const { data } = await sb.from('player_devices').select('player_id').eq('device_id', deviceId).maybeSingle();
    return data?.player_id || null;
  }

  async function linkDevice(deviceId, playerId) {
    if (!ready()) return;
    await sb.from('player_devices').upsert({ device_id: deviceId, player_id: playerId });
  }

  // ── Join Requests ─────────────────────────────────────────
  async function submitJoinRequest(deviceId, profile) {
    if (!ready()) return { error: 'Offline' };
    const { data, error } = await sb.from('join_requests').insert({
      device_id: deviceId,
      display_name: profile.displayName,
      skill_level: profile.skillLevel,
      contact: profile.contact || null,
      gender: profile.gender || null,
      weight_kg: profile.weightKg || null,
      status: 'pending',
      type: 'registration',
    }).select().single();
    return { data, error };
  }

  async function submitQueueRequest(deviceId, playerId, displayName, skillLevel) {
    if (!ready()) return { error: 'Offline' };
    // Remove any previous pending queue request from this device first
    await sb.from('join_requests')
      .delete()
      .eq('device_id', deviceId)
      .eq('type', 'queue_join')
      .eq('status', 'pending');
    const { data, error } = await sb.from('join_requests').insert({
      device_id: deviceId,
      player_id: playerId,
      display_name: displayName,
      skill_level: skillLevel,
      status: 'pending',
      type: 'queue_join',
    }).select().single();
    return { data, error };
  }

  async function getMyRequest(deviceId) {
    if (!ready()) return null;
    const { data } = await sb.from('join_requests')
      .select('*')
      .eq('device_id', deviceId)
      .eq('type', 'registration')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }

  async function getMyQueueRequest(deviceId) {
    if (!ready()) return null;
    const { data } = await sb.from('join_requests')
      .select('*')
      .eq('device_id', deviceId)
      .eq('type', 'queue_join')
      .eq('status', 'pending')
      .maybeSingle();
    return data;
  }

  async function submitLeaveRequest(deviceId, playerId, displayName) {
    if (!ready()) return { error: 'Offline' };
    // Clear any previous pending leave request from this device
    await sb.from('join_requests')
      .delete()
      .eq('device_id', deviceId)
      .eq('type', 'queue_leave')
      .eq('status', 'pending');
    const { data, error } = await sb.from('join_requests').insert({
      device_id: deviceId,
      player_id: playerId,
      display_name: displayName,
      skill_level: '',
      status: 'pending',
      type: 'queue_leave',
    }).select().single();
    return { data, error };
  }

  // ── Player data ───────────────────────────────────────────
  async function getPlayer(playerId) {
    if (!ready()) return null;
    const { data } = await sb.from('players').select('*').eq('id', playerId).maybeSingle();
    return data;
  }

  async function getAllPlayers() {
    if (!ready()) return [];
    const { data } = await sb.from('players').select('id,name,skill_level,rating');
    return data || [];
  }

  // ── Queue ─────────────────────────────────────────────────
  async function getQueue() {
    if (!ready()) return [];
    const { data } = await sb.from('queue')
      .select('player_id, position, queued_at, games_played_today')
      .order('position', { ascending: true });
    return data || [];
  }

  // ── Matches ───────────────────────────────────────────────
  async function getActiveMatches() {
    if (!ready()) return [];
    const { data } = await sb.from('matches')
      .select('*')
      .eq('is_active', true);
    return data || [];
  }

  async function getPlayerMatches(playerId) {
    if (!ready()) return [];
    // matches where player is in team_a or team_b arrays
    const { data } = await sb.from('matches')
      .select('*')
      .eq('is_active', false)
      .or(`team_a.cs.{"${playerId}"},team_b.cs.{"${playerId}"}`)
      .order('ended_at', { ascending: false })
      .limit(100);
    return data || [];
  }

  async function getCompletedMatchCount() {
    if (!ready()) return 0;
    const { count } = await sb.from('matches').select('*', { count: 'exact', head: true }).eq('is_active', false);
    return count || 0;
  }

  // ── Rating history ────────────────────────────────────────
  async function getRatingHistory(playerId) {
    if (!ready()) return [];
    const { data } = await sb.from('player_rating_history')
      .select('rating, recorded_at')
      .eq('player_id', playerId)
      .order('recorded_at', { ascending: true })
      .limit(50);
    return data || [];
  }

  // ── Realtime subscriptions ────────────────────────────────
  function subscribeQueue(callback) {
    if (!ready()) return null;
    return sb.channel('player-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, callback)
      .subscribe();
  }

  function subscribeMatches(callback) {
    if (!ready()) return null;
    return sb.channel('player-matches')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, callback)
      .subscribe();
  }

  function subscribeJoinRequest(deviceId, callback) {
    if (!ready()) return null;
    return sb.channel('player-request-' + deviceId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'join_requests',
        filter: `device_id=eq.${deviceId}`,
      }, callback)
      .subscribe();
  }

  function subscribeQueueRequest(deviceId, callback) {
    if (!ready()) return null;
    return sb.channel('player-qrequest-' + deviceId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'join_requests',
        filter: `device_id=eq.${deviceId}`,
      }, callback)
      .subscribe();
  }

  return {
    init, ready,
    getLinkedPlayerId, linkDevice,
    submitJoinRequest, getMyRequest,
    submitQueueRequest, getMyQueueRequest, submitLeaveRequest,
    getPlayer, getAllPlayers,
    getQueue, getActiveMatches, getPlayerMatches, getCompletedMatchCount,
    getRatingHistory,
    subscribeQueue, subscribeMatches, subscribeJoinRequest, subscribeQueueRequest,
  };
})();
