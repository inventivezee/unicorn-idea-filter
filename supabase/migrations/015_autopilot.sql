-- Unicorn Idea Filter — discovery autopilot. Additive + idempotent.
-- One row per owner: when enabled, the quarter-hourly cron starts a new
-- discovery batch automatically (bounded by MAX_CONCURRENT_AUTOPILOT_RUNS
-- in code so a backlog can't grow without bound).
create table if not exists public.discovery_autopilot (
  owner_id uuid primary key,
  enabled boolean not null default false,
  batch integer not null default 20,
  guidelines text not null default '',
  use_founder_background boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.discovery_autopilot enable row level security;
