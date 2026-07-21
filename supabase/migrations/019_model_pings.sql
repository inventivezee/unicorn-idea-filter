-- Unicorn Idea Filter — model-call ledger. Additive + idempotent.
-- One row per provider model call, across EVERY surface (interactive
-- analyze, discovery engine, cash cow auto-scoring): who was pinged, why,
-- token usage, and an estimated price. Service-role only.
create table if not exists public.model_pings (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  provider text not null,
  model text not null,
  purpose text not null,
  ref text,
  in_tokens bigint,
  cached_in_tokens bigint,
  cache_write_tokens bigint,
  out_tokens bigint,
  web_searches integer,
  est_cost_usd numeric(12, 6)
);

create index if not exists model_pings_created_idx on public.model_pings (created_at desc);
create index if not exists model_pings_model_idx on public.model_pings (model, created_at desc);

alter table public.model_pings enable row level security;
