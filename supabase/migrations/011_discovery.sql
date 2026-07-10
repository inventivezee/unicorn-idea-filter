-- Unicorn Idea Filter — autonomous idea-discovery engine.
-- Additive + idempotent. Run AFTER 010.
--
-- A discovery RUN is a subscriber-triggered background job that generates
-- ~10 candidate ideas across model vendors (with Browserbase market
-- research), scores each through the unicorn instrument (cross-vendor),
-- auto-reframes failures once, and publishes every scored idea into the
-- owner's pipeline. Runs/tasks get their own tables (NOT drafts): ten
-- agent-loop states cannot share one drafts row (250k payload cap), and
-- per-task rows give each candidate its own CAS rev so concurrent cron
-- and poller invocations never contend across candidates.

create table if not exists public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  -- Subscriber-only feature: always a signed-in owner, never anon_key.
  owner_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'done', 'failed', 'cancelled')),
  guidelines text not null default '',
  use_founder_background boolean not null default true,
  -- Run-level spend accounting (turn totals, browser minutes) — advanced
  -- via read-merge-retry on rev; per-turn claims live on the TASK rows.
  budget jsonb not null default '{}'::jsonb,
  -- Single-winner email guard (CAS on rev flips this exactly once).
  notified_at timestamptz,
  rev integer not null default 0,
  deadline_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discovery_runs_owner_idx
  on public.discovery_runs (owner_id, created_at desc);
create index if not exists discovery_runs_status_idx
  on public.discovery_runs (status, updated_at desc);
-- One RUNNING run per user, enforced by the database itself (the API's
-- check-then-act would race under concurrent POSTs). Unlimited runs/day
-- is policy; one at a time is state-machine necessity.
create unique index if not exists discovery_one_running_per_owner
  on public.discovery_runs (owner_id)
  where status = 'running';

create table if not exists public.discovery_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.discovery_runs (id) on delete cascade,
  idx integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'researching', 'generated', 'scoring',
                      'reframing', 'rescoring', 'done', 'failed')),
  -- {provider, model} for generation; scorer picked cross-vendor at creation.
  generator jsonb not null default '{}'::jsonb,
  scorer jsonb not null default '{}'::jsonb,
  -- Windowed agent-loop state (messages/notes). Hard per-task char budget
  -- enforced in code (capEscaped) — cleared the moment a phase completes.
  phase_state jsonb not null default '{}'::jsonb,
  -- Turn counters bumped AT CLAIM TIME (before any provider call) — the
  -- spend-safety source of truth: {research, score, reframe, rescore, synth}.
  turns jsonb not null default '{}'::jsonb,
  -- Lease: {token, heartbeat_at}. A task is claimable only when claim is
  -- null/empty OR heartbeat is older than the lease window. The token
  -- guards every persist so a superseded worker can't clobber state.
  claim jsonb,
  -- Browserbase accounting: {sessionId, minutesCharged} — minutes charged
  -- pessimistically (full session timeout) inside the claim CAS.
  bb jsonb not null default '{}'::jsonb,
  -- Deterministic idea ids (uuidv5 of run:idx:kind), assigned at task
  -- creation so crash-retried inserts converge on one row (23505 → existing).
  idea_original_id uuid,
  idea_reframe_id uuid,
  error text,
  phase_started_at timestamptz,
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discovery_tasks_run_idx
  on public.discovery_tasks (run_id, idx);
create index if not exists discovery_tasks_active_idx
  on public.discovery_tasks (status, updated_at desc)
  where status not in ('done', 'failed');
create unique index if not exists discovery_tasks_run_idx_unique
  on public.discovery_tasks (run_id, idx);

-- Service-role only, like drafts: no policies — every read/write goes
-- through API routes that enforce ownership.
alter table public.discovery_runs enable row level security;
alter table public.discovery_tasks enable row level security;

-- Provenance on published ideas. Server-written ONLY (never part of the
-- client-writable whitelist in ideaToWritableRow).
alter table public.ideas add column if not exists discovery_run_id uuid;
alter table public.ideas add column if not exists origin text;

-- Recreate the public view with ONE deliberate widening: `origin`, so
-- Explore can badge/filter AI-discovered ideas. Nothing else changes —
-- still no rationales, no founder data, no lineage ids.
create or replace view public.public_ideas as
select
  i.id,
  i.name,
  i.domain,
  i.business_model,
  i.buyer_icp,
  i.initial_wedge,
  i.thesis_notes,
  i.gates,
  i.scores,
  i.confidence,
  i.raw_score,
  i.ai_summary,
  i.founder_profile,
  case
    when p.show_handle and coalesce(p.display_name, '') <> '' then p.display_name
    else null
  end as author_handle,
  i.created_at,
  i.updated_at,
  i.cashcow->'gates' as cc_gates,
  i.cashcow->'scores' as cc_scores,
  (i.cashcow->>'confidence')::numeric as cc_confidence,
  i.cashcow->'ai'->>'summary' as cc_summary,
  case
    when i.cashcow is null then null
    when jsonb_typeof(i.cashcow->'scores'->'cc_pain') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_wtp') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_reach') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_speed') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_gm') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_ebitda') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_fcf') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_control') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_dist') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_retention') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_pricing') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_ops') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_capital') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_moat') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_exit') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_fmf') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_impact') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_transfer') is distinct from 'number'
      then null
    else (
        (i.cashcow->'scores'->>'cc_pain')::numeric * 6
        + (i.cashcow->'scores'->>'cc_wtp')::numeric * 6
        + (i.cashcow->'scores'->>'cc_reach')::numeric * 5
        + (i.cashcow->'scores'->>'cc_speed')::numeric * 6
        + (i.cashcow->'scores'->>'cc_gm')::numeric * 5
        + (i.cashcow->'scores'->>'cc_ebitda')::numeric * 9
        + (i.cashcow->'scores'->>'cc_fcf')::numeric * 8
        + (i.cashcow->'scores'->>'cc_control')::numeric * 7
        + (i.cashcow->'scores'->>'cc_dist')::numeric * 6
        + (i.cashcow->'scores'->>'cc_retention')::numeric * 6
        + (i.cashcow->'scores'->>'cc_pricing')::numeric * 6
        + (i.cashcow->'scores'->>'cc_ops')::numeric * 4
        + (i.cashcow->'scores'->>'cc_capital')::numeric * 5
        + (i.cashcow->'scores'->>'cc_moat')::numeric * 6
        + (i.cashcow->'scores'->>'cc_exit')::numeric * 4
        + (i.cashcow->'scores'->>'cc_fmf')::numeric * 5
        + (i.cashcow->'scores'->>'cc_impact')::numeric * 2
        + (i.cashcow->'scores'->>'cc_transfer')::numeric * 4
      ) / 5.0
  end as cc_raw_score,
  i.ai->>'model' as ai_model,
  i.ai->>'analyzedAt' as ai_analyzed_at,
  i.cashcow->'ai'->>'model' as cc_model,
  i.cashcow->'ai'->>'analyzedAt' as cc_analyzed_at,
  i.origin
from public.ideas i
left join public.profiles p on p.id = i.owner_id
where i.published and not i.is_private;

grant select on public.public_ideas to anon, authenticated;
