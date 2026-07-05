-- Unicorn Idea Filter — drafts (unfinished ideas + filter designs).
-- Additive + idempotent. Run AFTER 001.

-- One row per unfinished thing a user is working on:
--   kind = 'idea'    → an in-progress Quick Add (description, clarify Q&A)
--   kind = 'filter'  → an in-progress custom-filter design (inputs + the
--                      three-model design chain state and, when done, the
--                      finished spec awaiting acceptance)
-- Owned by a signed-in user (owner_id) or an anonymous device (anon_key).
-- Service-role-only access, like ideas: no RLS policies grant anon/authed
-- access — every read/write goes through the API which enforces ownership.
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  anon_key text,
  kind text not null check (kind in ('idea', 'filter')),
  status text not null default 'draft'
    check (status in ('draft', 'designing', 'ready', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  -- Optimistic-lock revision: the design chain advances via compare-and-swap
  -- on this counter so two tabs polling can't double-submit a provider call.
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drafts_owner_idx on public.drafts (owner_id, kind, updated_at desc);
create index if not exists drafts_anon_idx on public.drafts (anon_key, kind, updated_at desc);
-- One running design chain per user, enforced by the database itself — the
-- API's check-then-act would otherwise race under concurrent POSTs.
create unique index if not exists drafts_one_designing_per_owner
  on public.drafts (owner_id)
  where status = 'designing' and owner_id is not null;

alter table public.drafts enable row level security;
