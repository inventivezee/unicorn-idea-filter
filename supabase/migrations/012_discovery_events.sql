-- Unicorn Idea Filter — discovery event log. Additive + idempotent.
-- Every claim, turn outcome, phase transition, browser event, and error in
-- a discovery run gets a row here (full untruncated detail), so failures
-- can be diagnosed after the fact without Vercel log access. Service-role
-- only; pruned by age (cron deletes >14 days).
create table if not exists public.discovery_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.discovery_runs (id) on delete cascade,
  task_idx integer,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists discovery_events_run_idx
  on public.discovery_events (run_id, created_at desc);
create index if not exists discovery_events_age_idx
  on public.discovery_events (created_at);

alter table public.discovery_events enable row level security;
