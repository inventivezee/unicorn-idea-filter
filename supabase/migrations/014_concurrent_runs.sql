-- Unicorn Idea Filter — allow multiple concurrent discovery runs per
-- owner (owner decision: batches can overlap). The one-running-per-owner
-- index was a v1 simplification; the engine's per-task claim/lease
-- protocol never depended on it.
drop index if exists public.discovery_one_running_per_owner;
