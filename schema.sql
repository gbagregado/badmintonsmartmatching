-- Badminton Smart Matching — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ═══ Players ═══
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  initial_rating INTEGER NOT NULL DEFAULT 1200,
  skill_level TEXT NOT NULL DEFAULT 'intermediate'
    CHECK (skill_level IN ('beginner', 'intermediate', 'advanced', 'expert')),
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  total_points_scored INTEGER NOT NULL DEFAULT 0,
  total_points_lost INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_match_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══ Courts ═══
CREATE TABLE IF NOT EXISTS courts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'in-use')),
  current_match_id UUID
);

-- ═══ Queue ═══
CREATE TABLE IF NOT EXISTS queue (
  id SERIAL PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_id)
);

-- ═══ Matches (active + history) ═══
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id TEXT REFERENCES courts(id),
  team_a UUID[] NOT NULL,
  team_b UUID[] NOT NULL,
  score_a INTEGER NOT NULL DEFAULT 0,
  score_b INTEGER NOT NULL DEFAULT 0,
  winner TEXT CHECK (winner IN ('A', 'B')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- ═══ Settings ═══
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Insert default settings
INSERT INTO settings (key, value) VALUES
  ('courtCount', '4'),
  ('gameMode', '"doubles"'),
  ('defaultRating', '1200'),
  ('challengeFactor', '0.15'),
  ('maxPointsPerSet', '21'),
  ('setsToWin', '1')
ON CONFLICT (key) DO NOTHING;

-- ═══ Indexes ═══
CREATE INDEX IF NOT EXISTS idx_queue_position ON queue(position);
CREATE INDEX IF NOT EXISTS idx_matches_active ON matches(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at DESC) WHERE is_active = FALSE;
CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC);

-- ═══ Enable Row Level Security (open access for now — tighten later) ═══
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE courts ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Policies: allow all operations with anon key (single-venue setup)
CREATE POLICY "Allow all on players" ON players FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on courts" ON courts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on queue" ON queue FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on matches" ON matches FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on settings" ON settings FOR ALL USING (true) WITH CHECK (true);

-- ═══ Enable Realtime ═══
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE courts;
ALTER PUBLICATION supabase_realtime ADD TABLE queue;
ALTER PUBLICATION supabase_realtime ADD TABLE matches;
