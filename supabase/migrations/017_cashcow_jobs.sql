-- Unicorn Idea Filter — Cash Cow auto-scoring queue. Additive + idempotent.
-- One row per idea being scored through the Cash Cow instrument. The row is
-- a CLAIM/lock + failure-tracker so concurrent cron invocations never
-- double-bill; the actual verdict lands on ideas.cashcow (via
-- applyCashCowToIdea), and a scored idea drops out of the candidate query
-- once ideas.cashcow->'ai' is set. Service-role only.
create table if not exists public.cashcow_jobs (
  idea_id uuid primary key,
  status text not null default 'pending',
  claim jsonb,
  attempts integer not null default 0,
  error text,
  updated_at timestamptz not null default now()
);

alter table public.cashcow_jobs enable row level security;

-- Atomic claim: win the job iff it isn't done, is under the attempt cap, and
-- is either unclaimed or its lease has expired. Returns true when claimed.
create or replace function public.claim_cashcow_job(
  p_idea uuid,
  p_token text,
  p_lease integer,
  p_max integer
) returns boolean
language plpgsql
as $$
declare
  rc integer;
begin
  insert into public.cashcow_jobs (idea_id, status, claim, attempts, updated_at)
  values (
    p_idea,
    'in_flight',
    jsonb_build_object('token', p_token, 'heartbeat_at', now()),
    1,
    now()
  )
  on conflict (idea_id) do update
    set status = 'in_flight',
        claim = jsonb_build_object('token', p_token, 'heartbeat_at', now()),
        attempts = public.cashcow_jobs.attempts + 1,
        updated_at = now()
    where public.cashcow_jobs.status <> 'done'
      and public.cashcow_jobs.attempts < p_max
      and (
        public.cashcow_jobs.status <> 'in_flight'
        or (public.cashcow_jobs.claim->>'heartbeat_at')::timestamptz
             < now() - make_interval(secs => p_lease)
      );
  get diagnostics rc = row_count;
  return rc > 0;
end;
$$;
