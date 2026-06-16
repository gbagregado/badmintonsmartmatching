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

  // ── Match Requests ─────────────────────────────────────────
  async function createMatchRequest(requesterId, requesterDeviceId, teamA, teamB, inviteDeviceMap) {
    // teamA = [requesterId, partnerId], teamB = [opp1Id, opp2Id]
    // inviteDeviceMap = { playerId: deviceId } for notification
    if (!ready()) return { error: 'Offline' };
    const { data: req, error } = await sb.from('match_requests').insert({
      requester_id: requesterId,
      requester_device_id: requesterDeviceId,
      team_a: teamA,
      team_b: teamB,
      status: 'pending_accepts',
    }).select().single();
    if (error) return { error };

    // Create invites for non-requester players
    const invitees = [...teamA, ...teamB].filter(id => id !== requesterId);
    const inviteRows = invitees.map(pid => ({
      request_id: req.id,
      player_id: pid,
      device_id: inviteDeviceMap[pid] || null,
      status: 'pending',
    }));
    if (inviteRows.length) {
      const { error: invErr } = await sb.from('match_request_invites').insert(inviteRows);
      if (invErr) return { error: invErr };
    }
    return { data: req };
  }

  async function getMyMatchRequest(playerId) {
    if (!ready()) return null;
    const { data } = await sb.from('match_requests')
      .select('*, match_request_invites(*)')
      .eq('requester_id', playerId)
      .in('status', ['pending_accepts', 'ready'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }

  async function getMyInvites(playerId) {
    if (!ready()) return [];
    const { data } = await sb.from('match_request_invites')
      .select('*, match_requests(*)')
      .eq('player_id', playerId)
      .eq('status', 'pending');
    return data || [];
  }

  async function respondToInvite(inviteId, accept) {
    if (!ready()) return { error: 'Offline' };
    const status = accept ? 'accepted' : 'declined';
    const { error } = await sb.from('match_request_invites')
      .update({ status, responded_at: new Date().toISOString() })
      .eq('id', inviteId);
    if (error) return { error };

    // Check if all invites for this request are now accepted
    const { data: invite } = await sb.from('match_request_invites').select('request_id').eq('id', inviteId).maybeSingle();
    if (invite?.request_id) {
      if (!accept) {
        // One declined → whole request is rejected
        await sb.from('match_requests').update({ status: 'rejected' }).eq('id', invite.request_id);
      } else {
        // Check if all accepted
        const { data: allInvites } = await sb.from('match_request_invites').select('status').eq('request_id', invite.request_id);
        if (allInvites && allInvites.every(i => i.status === 'accepted')) {
          await sb.from('match_requests').update({ status: 'ready' }).eq('id', invite.request_id);
        }
      }
    }
    return { ok: true };
  }

  async function cancelMatchRequest(requestId) {
    if (!ready()) return;
    await sb.from('match_requests').update({ status: 'rejected' }).eq('id', requestId);
  }

  function subscribeInvites(playerId, callback) {
    if (!ready()) return null;
    return sb.channel('player-invites-' + playerId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'match_request_invites',
        filter: `player_id=eq.${playerId}`,
      }, callback)
      .subscribe();
  }

  function subscribeMatchRequest(requestId, callback) {
    if (!ready()) return null;
    return sb.channel('matchreq-' + requestId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'match_requests',
        filter: `id=eq.${requestId}`,
      }, callback)
      .subscribe();
  }

  // ── Exclusions ─────────────────────────────────────────────
  async function getExclusions(playerId) {
    if (!ready()) return [];
    const { data } = await sb.from('player_exclusions')
      .select('excluded_player_id')
      .eq('player_id', playerId);
    return (data || []).map(r => r.excluded_player_id);
  }

  async function addExclusion(playerId, excludedId) {
    if (!ready()) return { error: 'Offline' };
    const { error } = await sb.from('player_exclusions').insert({
      player_id: playerId, excluded_player_id: excludedId,
    }).select().single();
    return { error };
  }

  async function removeExclusion(playerId, excludedId) {
    if (!ready()) return;
    await sb.from('player_exclusions')
      .delete()
      .eq('player_id', playerId)
      .eq('excluded_player_id', excludedId);
  }

  // ── Device lookup (for invite notifications) ───────────────
  async function getPlayerDevices(playerIds) {
    if (!ready()) return {};
    const { data } = await sb.from('player_devices').select('player_id, device_id').in('player_id', playerIds);
    const map = {};
    for (const row of (data || [])) map[row.player_id] = row.device_id;
    return map;
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
    createMatchRequest, getMyMatchRequest, getMyInvites, respondToInvite,
    cancelMatchRequest, subscribeInvites, subscribeMatchRequest,
    getExclusions, addExclusion, removeExclusion, getPlayerDevices,
    getPlayer, getAllPlayers,
    getQueue, getActiveMatches, getPlayerMatches, getCompletedMatchCount,
    getRatingHistory,
    subscribeQueue, subscribeMatches, subscribeJoinRequest, subscribeQueueRequest,
  };
})();
