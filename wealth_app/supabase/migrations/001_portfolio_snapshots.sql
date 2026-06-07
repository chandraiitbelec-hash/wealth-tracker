-- Phase 3: User accounts + portfolio snapshots
-- Run this in Supabase SQL editor

-- Portfolio snapshots — one row per saved upload
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                   -- user-given label, e.g. "June 2025"
  broker        TEXT NOT NULL DEFAULT 'Groww',   -- for future multi-broker
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  portfolio     JSONB NOT NULL,                  -- full ParsedPortfolio JSON
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast per-user listing
CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
  ON portfolio_snapshots (user_id, snapshot_date DESC);

-- Row-level security: users see only their own snapshots
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own snapshots"
  ON portfolio_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own snapshots"
  ON portfolio_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own snapshots"
  ON portfolio_snapshots FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own snapshots"
  ON portfolio_snapshots FOR DELETE
  USING (auth.uid() = user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER snapshots_updated_at
  BEFORE UPDATE ON portfolio_snapshots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
