-- Unicorn Idea Filter — initial cloud schema.
-- Run this in the Supabase SQL editor (or `supabase db push`) once per project.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, created automatically on signup.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text not null default '',
  -- Show display_name as the author handle on published ideas.
  show_handle boolean not null default false,
  founder_background text not null default '',
  co_founders jsonb not null default '[]'::jsonb,
  -- Client preferences (provider, models, webSearch, weights, trials).
  prefs jsonb not null default '{}'::jsonb,
  is_admin boolean not null default false,
  stripe_customer_id text unique,
  -- 'none' | 'active' | 'trialing' | 'past_due' | 'canceled'
  subscription_status text not null default 'none',
  subscription_period_end timestamptz,
  -- Free-tier AI analysis quota (calendar-month window).
  analyses_used integer not null default 0,
  analyses_reset_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- ideas — every idea lives here, owned by a user or an anonymous device key.
-- ---------------------------------------------------------------------------
create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete set null,
  -- Anonymous ownership: a random key held in the device's localStorage.
  anon_key text,
  name text not null default '',
  domain text not null default '',
  business_model text not null default '',
  buyer_icp text not null default '',
  initial_wedge text not null default '',
  thesis_notes text not null default '',
  gates jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  confidence numeric,
  validation_test_30d text not null default '',
  top_risk_override_1 text,
  top_risk_override_2 text,
  -- Full AI analysis (per-gate/criterion rationales etc). NEVER public.
  ai jsonb,
  -- Public-safe copy of the AI's summary paragraph.
  ai_summary text not null default '',
  -- Anonymised founding-team profile (AI-written, no identifying details) —
  -- the only founder information that is ever public.
  founder_profile text not null default '',
  -- Premium feature: subscribers can keep an idea out of the public feed.
  is_private boolean not null default false,
  -- True once the idea has scores (AI or manual) — public-feed eligibility.
  published boolean not null default false,
  -- Raw 0-100 score computed with DEFAULT weights (feed ranking only; owners
  -- may use custom weights locally).
  raw_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ideas_has_some_owner check (owner_id is not null or anon_key is not null)
);

create index ideas_feed_idx on public.ideas (created_at desc) where published and not is_private;
create index ideas_top_idx on public.ideas (raw_score desc nulls last) where published and not is_private;
create index ideas_owner_idx on public.ideas (owner_id);
create index ideas_anon_idx on public.ideas (anon_key);

-- ---------------------------------------------------------------------------
-- submission_logs — admin-only telemetry for every create/analyze action,
-- including anonymous submitters' request metadata. Never publicly visible.
-- ---------------------------------------------------------------------------
create table public.submission_logs (
  id bigint generated always as identity primary key,
  idea_id uuid references public.ideas (id) on delete set null,
  user_id uuid,
  anon_key text,
  action text not null, -- 'create' | 'clarify' | 'fill' | 'analyze' | 'admin_analyze' | 'import' | 'claim'
  ip text,
  user_agent text,
  referer text,
  country text,
  city text,
  -- Snapshot of the founder background used for this analysis (admin-only).
  founder_background_snapshot text,
  provider text,
  model text,
  web_searches integer,
  created_at timestamptz not null default now()
);

create index submission_logs_created_idx on public.submission_logs (created_at desc);
create index submission_logs_idea_idx on public.submission_logs (idea_id);

-- ---------------------------------------------------------------------------
-- anon_usage — daily analysis counters per IP and per device key.
-- ---------------------------------------------------------------------------
create table public.anon_usage (
  scope text not null, -- 'ip' | 'device'
  key text not null,
  day date not null default current_date,
  count integer not null default 0,
  primary key (scope, key, day)
);

-- Atomically consume one anonymous analysis; false when either counter is at
-- the limit. Both counters (IP and device key) must be under the cap.
create or replace function public.consume_anon_analysis(
  p_ip text,
  p_device text,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip_count integer;
  v_dev_count integer;
begin
  insert into anon_usage (scope, key, day, count) values ('ip', p_ip, current_date, 0)
    on conflict (scope, key, day) do nothing;
  insert into anon_usage (scope, key, day, count) values ('device', p_device, current_date, 0)
    on conflict (scope, key, day) do nothing;

  select count into v_ip_count from anon_usage
    where scope = 'ip' and key = p_ip and day = current_date for update;
  select count into v_dev_count from anon_usage
    where scope = 'device' and key = p_device and day = current_date for update;

  if v_ip_count >= p_limit or v_dev_count >= p_limit then
    return false;
  end if;

  update anon_usage set count = count + 1
    where scope = 'ip' and key = p_ip and day = current_date;
  update anon_usage set count = count + 1
    where scope = 'device' and key = p_device and day = current_date;
  return true;
end;
$$;

-- Atomically consume one free-tier analysis for a signed-in user; the window
-- resets each calendar month. Returns false when the monthly cap is reached.
create or replace function public.consume_free_analysis(
  p_user uuid,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed boolean := false;
begin
  update profiles
  set
    analyses_used = case
      when date_trunc('month', analyses_reset_at) < date_trunc('month', now()) then 1
      else analyses_used + 1
    end,
    analyses_reset_at = now()
  where id = p_user
    and (
      date_trunc('month', analyses_reset_at) < date_trunc('month', now())
      or analyses_used < p_limit
    );
  if found then
    v_allowed := true;
  end if;
  return v_allowed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security. All writes go through the app's API routes (service
-- role); RLS is defense in depth for direct client access.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.ideas enable row level security;
alter table public.submission_logs enable row level security;
alter table public.anon_usage enable row level security;

-- Profiles: owners can read their own row and update the safe columns.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Column-level guard: authenticated users may only update the safe columns
-- (not is_admin / stripe / subscription / quota fields).
revoke update on public.profiles from authenticated;
grant update (display_name, show_handle, founder_background, co_founders, prefs)
  on public.profiles to authenticated;

-- Ideas: owners get full CRUD on their own rows.
create policy "ideas_select_own" on public.ideas
  for select using (auth.uid() = owner_id);
create policy "ideas_insert_own" on public.ideas
  for insert with check (auth.uid() = owner_id);
create policy "ideas_update_own" on public.ideas
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "ideas_delete_own" on public.ideas
  for delete using (auth.uid() = owner_id);

-- submission_logs / anon_usage: no policies — service role only.

-- ---------------------------------------------------------------------------
-- public_ideas — THE public surface. Safe columns only: no founder data, no
-- AI rationales, no validation plans, no private/unpublished rows, no
-- anonymous telemetry. Runs with owner rights (bypasses ideas RLS) by design.
-- ---------------------------------------------------------------------------
create view public.public_ideas as
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
  i.updated_at
from public.ideas i
left join public.profiles p on p.id = i.owner_id
where i.published and not i.is_private;

grant select on public.public_ideas to anon, authenticated;
